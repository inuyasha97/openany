/**
 * OMP agent runtime client.
 *
 * Implements the `AgentRuntime` contract over the OMP server routes
 * (`packages/web/server/lib/agents/`) and the `openchamber:omp` bridge frame.
 * OMP supports sessions, prompts and cancels; every other contract method is
 * declared unsupported and rejects, so a caller gated by `capabilities` never
 * reaches it, and a caller that does gets a clear failure rather than a silent
 * empty result.
 *
 * Events do not flow through `translateEvent`: the server projects OMP events
 * into canonical `SyncEvent`s and pushes them on the shared bridge, which the
 * event pipeline routes. `translateEvent` therefore handles no wire payload.
 */

import { z } from "zod"
import { runtimeFetch } from "@/lib/runtime-fetch"
import type { FileDiffInfo, FormInfo, SessionRevert } from "@opencode/client"
import type {
  Agent,
  Command,
  McpServerStatus,
  ModelRef,
  PermissionReply,
  PermissionRequest,
  SessionStatus,
  Skill,
} from "@/lib/opencode/model"
import type {
  AgentCapabilities,
  AgentRuntime,
  AgentSession,
  CreateSessionParams,
  FetchPermissionResult,
  MessagePage,
  MoveSessionOptions,
  PendingRequestListOptions,
  SendPromptParams,
  SessionListOptions,
  SessionPage,
} from "./contract"
import type { RoutedAgentEvent } from "./events"

const CAPABILITIES: AgentCapabilities = {
  fork: false,
  commands: true,
  mcp: true,
  agents: false,
  permissions: true,
  modelSelection: true,
  agentSelection: false,
  forms: false,
  revert: false,
  turnDiff: false,
  skills: true,
  rename: true,
  delete: true,
  move: true,
  attachments: false,
}

const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const sessionRecordSchema = z.object({
  id: z.string().min(1),
  sessionPath: z.string(),
  cwd: z.string(),
  title: z.string(),
})

const sessionListSchema = z.object({ sessions: z.array(sessionRecordSchema) })
const sessionCreatedSchema = z.object({ session: z.object({ id: z.string().min(1), sessionFile: z.string().nullable().optional() }) })
const okSchema = z.object({ ok: z.boolean() })
const commandSchema = z.object({ name: z.string(), source: z.string(), description: z.string().optional() })
const commandsSchema = z.object({ commands: z.array(commandSchema) })
const statusSchema = z.object({ busy: z.boolean() })
const permissionSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  action: z.string(),
  resources: z.array(z.string()),
  message: z.string().optional(),
})
const permissionsSchema = z.object({ permissions: z.array(permissionSchema) })
const mcpServersSchema = z.object({
  servers: z.array(
    z.object({
      name: z.string(),
      scope: z.enum(["user", "project"]),
      enabled: z.boolean(),
      type: z.string(),
      command: z.string().optional(),
      url: z.string().optional(),
    }),
  ),
})

type OmpSessionRecord = z.infer<typeof sessionRecordSchema>

const toAgentSession = (record: OmpSessionRecord): AgentSession => ({
  id: record.id,
  runtimeId: "omp",
  nativeSessionId: record.id,
  projectID: "",
  directory: record.cwd,
  title: record.title,
  cost: 0,
  tokens: { ...ZERO_TOKENS, cache: { ...ZERO_TOKENS.cache } },
  time: { created: 0, updated: 0 },
})

const unsupported = (operation: string): Promise<never> =>
  Promise.reject(new Error(`OMP runtime does not support ${operation}`))

const readJson = async <T>(response: Response, schema: z.ZodType<T>): Promise<T> => {
  if (!response.ok) {
    throw new Error(`OMP request failed: ${response.status}`)
  }
  return schema.parse(await response.json())
}

export class OmpRuntimeClient implements AgentRuntime {
  readonly id = "omp"
  readonly capabilities = CAPABILITIES

  private readonly basePath = "/api/agents/omp"

  constructor(private readonly fetchImpl: typeof runtimeFetch = runtimeFetch) {}

  async createSession(params?: CreateSessionParams, directory?: string | null): Promise<AgentSession> {
    void params
    const cwd = directory?.trim()
    const response = await this.fetchImpl(`${this.basePath}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cwd ? { cwd } : {}),
    })
    const parsed = await readJson(response, sessionCreatedSchema)
    return toAgentSession({ id: parsed.session.id, sessionPath: parsed.session.sessionFile ?? "", cwd: cwd ?? "", title: "" })
  }

  async getSession(id: string, directory?: string | null): Promise<AgentSession> {
    void directory
    const record = (await this.fetchSessions()).find((session) => session.id === id)
    if (!record) throw new Error(`unknown omp session: ${id}`)
    return toAgentSession(record)
  }

  async listSessions(directory?: string | null): Promise<AgentSession[]> {
    void directory
    return (await this.fetchSessions()).map(toAgentSession)
  }

  async listSessionsPage(options?: SessionListOptions): Promise<SessionPage> {
    void options
    return { sessions: await this.listSessions(), cursor: {} }
  }

  async getMessages(id: string, options?: { limit?: number; cursor?: string; order?: "asc" | "desc" }, directory?: string | null): Promise<MessagePage> {
    void options
    void directory
    const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(id)}/messages`)
    if (!response.ok) {
      throw new Error(`OMP request failed: ${response.status}`)
    }
    // SAFETY: the server projects these items from the canonical Message/Part
    // model; the body is trusted JSON from OpenChamber's own server.
    return (await response.json()) as MessagePage
  }

  async sendPrompt(params: SendPromptParams): Promise<string> {
    const body = params.messageId ? { text: params.text, messageId: params.messageId } : { text: params.text }
    const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(params.id)}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    await readJson(response, okSchema)
    // OMP has no message id of its own; the id is the client's when it supplied
    // one, so the optimistic message reconciles in place.
    return params.messageId ?? ""
  }

  async cancel(id: string, directory?: string | null): Promise<boolean> {
    void directory
    const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(id)}/abort`, { method: "POST" })
    return (await readJson(response, okSchema)).ok
  }

  translateEvent(): RoutedAgentEvent[] {
    return []
  }

  async renameSession(id: string, title: string, directory?: string | null): Promise<void> {
    void directory
    const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    })
    await readJson(response, okSchema)
  }

  async deleteSession(id: string, directory?: string | null): Promise<boolean> {
    void directory
    const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(id)}`, { method: "DELETE" })
    return (await readJson(response, okSchema)).ok
  }

  async moveSession(id: string, toDirectory: string, options?: MoveSessionOptions): Promise<void> {
    void options
    const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(id)}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory: toDirectory }),
    })
    await readJson(response, okSchema)
  }

  async listCommands(directory?: string | null, signal?: AbortSignal): Promise<Command[]> {
    void directory
    void signal
    const response = await this.fetchImpl(`${this.basePath}/commands`)
    return (await readJson(response, commandsSchema)).commands.map((command) => ({
      name: command.name,
      description: command.description,
    }))
  }

  async listSkills(directory?: string | null): Promise<Skill[]> {
    void directory
    const response = await this.fetchImpl(`${this.basePath}/commands`)
    return (await readJson(response, commandsSchema)).commands
      .filter((command) => command.source === "skill")
      .map((command) => ({
        id: command.name,
        name: command.name,
        description: command.description,
        path: "",
        content: "",
      }))
  }

  async getActiveStatus(directory?: string | null): Promise<Record<string, SessionStatus> | null> {
    try {
      const sessions = await this.fetchSessions()
      const scoped = directory ? sessions.filter((session) => session.cwd === directory) : sessions
      const entries = await Promise.all(
        scoped.map(async (session) => {
          const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(session.id)}/status`)
          const status = await readJson(response, statusSchema)
          return [session.id, status.busy ? ({ type: "busy" } as const) : ({ type: "idle" } as const)] as const
        }),
      )
      return Object.fromEntries(entries)
    } catch {
      // A failed snapshot is `null`, never an empty authoritative result.
      return null
    }
  }

  async replyPermission(sessionID: string, requestID: string, reply: PermissionReply, options?: { message?: string; directory?: string | null }): Promise<boolean> {
    void options
    const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(sessionID)}/permissions/${encodeURIComponent(requestID)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reply }),
    })
    return (await readJson(response, okSchema)).ok
  }

  async getPermission(sessionID: string, requestID: string, directory?: string | null): Promise<FetchPermissionResult> {
    void directory
    const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(sessionID)}/permissions`)
    const permission = (await readJson(response, permissionsSchema)).permissions.find((entry) => entry.id === requestID)
    return permission ? { state: "ok", permission } : { state: "unknown" }
  }

  async listPermissions(options?: PendingRequestListOptions): Promise<PermissionRequest[]> {
    const sessions = await this.fetchSessions()
    const directories = options?.directories?.filter((value): value is string => Boolean(value))
    const scoped = directories && directories.length > 0
      ? sessions.filter((session) => directories.includes(session.cwd))
      : sessions
    const lists = await Promise.all(
      scoped.map(async (session) => {
        const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(session.id)}/permissions`)
        return (await readJson(response, permissionsSchema)).permissions
      }),
    )
    return lists.flat()
  }

  async listMcpServers(directory?: string | null): Promise<McpServerStatus[]> {
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : ""
    const response = await this.fetchImpl(`${this.basePath}/mcp${query}`)
    return (await readJson(response, mcpServersSchema)).servers.map((server) => ({
      name: server.name,
      status: { status: server.enabled ? ("connected" as const) : ("disabled" as const) },
    }))
  }

  async connectMcpServer(server: string, directory?: string | null): Promise<void> {
    void directory
    await this.setMcpEnabled(server, true)
  }

  async disconnectMcpServer(server: string, directory?: string | null): Promise<void> {
    void directory
    await this.setMcpEnabled(server, false)
  }

  private async setMcpEnabled(server: string, enabled: boolean): Promise<void> {
    const response = await this.fetchImpl(`${this.basePath}/mcp/${encodeURIComponent(server)}/enabled`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    })
    await readJson(response, okSchema)
  }

  async selectModel(id: string, model: ModelRef, directory?: string | null): Promise<void> {
    void directory
    const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(id)}/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: model.providerID, modelId: model.id }),
    })
    await readJson(response, okSchema)
  }

  private async fetchSessions(): Promise<OmpSessionRecord[]> {
    const response = await this.fetchImpl(`${this.basePath}/sessions`)
    return (await readJson(response, sessionListSchema)).sessions
  }

  // --- Unsupported: the capability above is `false`, so no caller reaches these.
  // The parameters are omitted (a narrower signature still satisfies the
  // contract), so an implemented method is the only place that reads them.

  selectAgent(): Promise<void> {
    return unsupported("selectAgent")
  }

  forkSession(): Promise<AgentSession> {
    return unsupported("forkSession")
  }

  listAgents(): Promise<Agent[]> {
    return unsupported("listAgents")
  }

  replyForm(): Promise<boolean> {
    return unsupported("replyForm")
  }

  cancelForm(): Promise<boolean> {
    return unsupported("cancelForm")
  }

  listPendingForms(): Promise<FormInfo[]> {
    return unsupported("listPendingForms")
  }

  stageRevert(): Promise<SessionRevert> {
    return unsupported("stageRevert")
  }

  commitRevert(): Promise<void> {
    return unsupported("commitRevert")
  }

  clearRevert(): Promise<void> {
    return unsupported("clearRevert")
  }

  getSessionTurnDiff(): Promise<FileDiffInfo[]> {
    return unsupported("getSessionTurnDiff")
  }

  sendCommand(): Promise<void> {
    return unsupported("sendCommand")
  }
}