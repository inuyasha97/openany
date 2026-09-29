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
  SendPromptParams,
  SessionListOptions,
  SessionPage,
} from "./contract"
import type { RoutedAgentEvent } from "./events"

const CAPABILITIES: AgentCapabilities = {
  fork: false,
  commands: false,
  mcp: false,
  agents: false,
  permissions: false,
  modelSelection: false,
  agentSelection: false,
  forms: false,
  revert: false,
  turnDiff: false,
  skills: false,
  rename: false,
  delete: false,
  move: false,
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

  private async fetchSessions(): Promise<OmpSessionRecord[]> {
    const response = await this.fetchImpl(`${this.basePath}/sessions`)
    return (await readJson(response, sessionListSchema)).sessions
  }

  // --- Unsupported: the capability above is `false`, so no caller reaches these.
  // The parameters are omitted (a narrower signature still satisfies the
  // contract), so an implemented method is the only place that reads them.

  deleteSession(): Promise<boolean> {
    return unsupported("deleteSession")
  }

  renameSession(): Promise<void> {
    return unsupported("renameSession")
  }

  moveSession(): Promise<void> {
    return unsupported("moveSession")
  }

  replyPermission(): Promise<boolean> {
    return unsupported("replyPermission")
  }

  getPermission(): Promise<FetchPermissionResult> {
    return unsupported("getPermission")
  }

  listPermissions(): Promise<PermissionRequest[]> {
    return unsupported("listPermissions")
  }

  selectModel(): Promise<void> {
    return unsupported("selectModel")
  }

  selectAgent(): Promise<void> {
    return unsupported("selectAgent")
  }

  getActiveStatus(): Promise<Record<string, SessionStatus> | null> {
    return unsupported("getActiveStatus")
  }

  forkSession(): Promise<AgentSession> {
    return unsupported("forkSession")
  }

  listAgents(): Promise<Agent[]> {
    return unsupported("listAgents")
  }

  listCommands(): Promise<Command[]> {
    return unsupported("listCommands")
  }

  listMcpServers(): Promise<McpServerStatus[]> {
    return unsupported("listMcpServers")
  }

  connectMcpServer(): Promise<void> {
    return unsupported("connectMcpServer")
  }

  disconnectMcpServer(): Promise<void> {
    return unsupported("disconnectMcpServer")
  }

  listSkills(): Promise<Skill[]> {
    return unsupported("listSkills")
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