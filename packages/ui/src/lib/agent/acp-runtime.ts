/**
 * ACP agent runtime client.
 *
 * Implements the `AgentRuntime` contract over the ACP server routes
 * (`packages/web/server/lib/agents/acp-*`) and the `openchamber:acp` bridge
 * frame. ACP supports sessions, prompts, cancels and the permission reply
 * round-trip; everything else is declared unsupported and rejects, so a caller
 * gated by `capabilities` never reaches it.
 *
 * ACP v1 has no message history, so `getMessages` answers an empty page rather
 * than failing — a reopened session has no transcript yet. Events arrive
 * already projected on the bridge, so `translateEvent` handles no wire payload.
 */

import { z } from "zod"
import { runtimeFetch } from "@/lib/runtime-fetch"
import type { FileDiffInfo, FormInfo, SessionRevert } from "@opencode/client"
import type { Agent, Command, McpServerStatus, PermissionReply, PermissionRequest, SessionStatus, Skill } from "@/lib/opencode/model"
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
  permissions: true,
  modelSelection: false,
  agentSelection: false,
  forms: false,
  revert: false,
  turnDiff: false,
  skills: false,
  rename: false,
  delete: false,
  move: false,
  attachments: true,
}

const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const sessionRecordSchema = z.object({ id: z.string().min(1), cwd: z.string(), title: z.string() })
const sessionListSchema = z.object({ sessions: z.array(sessionRecordSchema) })
const sessionCreatedSchema = z.object({ session: z.object({ id: z.string().min(1) }) })
const okSchema = z.object({ ok: z.boolean() })

type AcpSessionRecord = z.infer<typeof sessionRecordSchema>

const toAgentSession = (record: AcpSessionRecord): AgentSession => ({
  id: record.id,
  runtimeId: "acp",
  nativeSessionId: record.id,
  projectID: "",
  directory: record.cwd,
  title: record.title,
  cost: 0,
  tokens: { ...ZERO_TOKENS, cache: { ...ZERO_TOKENS.cache } },
  time: { created: 0, updated: 0 },
})

const unsupported = (operation: string): Promise<never> =>
  Promise.reject(new Error(`ACP runtime does not support ${operation}`))

const readJson = async <T>(response: Response, schema: z.ZodType<T>): Promise<T> => {
  if (!response.ok) {
    throw new Error(`ACP request failed: ${response.status}`)
  }
  return schema.parse(await response.json())
}

export class AcpRuntimeClient implements AgentRuntime {
  readonly id = "acp"
  readonly capabilities = CAPABILITIES

  private readonly basePath = "/api/agents/acp"

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
    return toAgentSession({ id: parsed.session.id, cwd: cwd ?? "", title: "" })
  }

  async getSession(id: string, directory?: string | null): Promise<AgentSession> {
    void directory
    const record = (await this.fetchSessions()).find((session) => session.id === id)
    if (!record) throw new Error(`unknown acp session: ${id}`)
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

  async getMessages(): Promise<MessagePage> {
    // ACP v1 has no history; a reopened session starts empty by design.
    return { items: [], cursor: {} }
  }

  async sendPrompt(params: SendPromptParams): Promise<string> {
    const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(params.id)}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: params.text }),
    })
    await readJson(response, okSchema)
    return params.messageId ?? ""
  }

  async cancel(id: string, directory?: string | null): Promise<boolean> {
    void directory
    const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(id)}/abort`, { method: "POST" })
    return (await readJson(response, okSchema)).ok
  }

  async replyPermission(sessionID: string, requestID: string, reply: PermissionReply): Promise<boolean> {
    const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(sessionID)}/permission`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: requestID, reply }),
    })
    return (await readJson(response, okSchema)).ok
  }

  translateEvent(): RoutedAgentEvent[] {
    return []
  }

  private async fetchSessions(): Promise<AcpSessionRecord[]> {
    const response = await this.fetchImpl(`${this.basePath}/sessions`)
    return (await readJson(response, sessionListSchema)).sessions
  }

  // --- Unsupported: the capability above is `false`, so no caller reaches these.

  deleteSession(): Promise<boolean> {
    return unsupported("deleteSession")
  }

  renameSession(): Promise<void> {
    return unsupported("renameSession")
  }

  moveSession(): Promise<void> {
    return unsupported("moveSession")
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
