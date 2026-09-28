import type { FileDiffInfo, FormAnswer, FormInfo, SessionInboxDelivery, SessionRevert } from "@opencode/client"
import type {
  Agent,
  Command,
  McpServerStatus,
  Message,
  Metadata,
  ModelRef,
  Part,
  PermissionReply,
  PermissionRequest,
  Session,
  SessionStatus,
  Skill,
} from "@/lib/opencode/model"
import type { RoutedAgentEvent } from "./events"

export type AgentCapabilities = {
  fork: boolean
  commands: boolean
  mcp: boolean
  agents: boolean
  permissions: boolean
  modelSelection: boolean
  agentSelection: boolean
  forms: boolean
  revert: boolean
  turnDiff: boolean
  skills: boolean
}

export type CreateSessionParams = {
  id?: string
  title?: string
  agent?: string
  model?: ModelRef
  metadata?: Metadata
}

export type MoveSessionOptions = { delivery?: SessionInboxDelivery }

export type MessagePage = {
  items: Array<{ info: Message; parts: Part[] }>
  cursor: { previous?: string; next?: string }
}

export type FetchPermissionResult =
  | { state: "ok"; permission: PermissionRequest }
  | { state: "resolved" }
  | { state: "unknown" }

export type PendingRequestListOptions = {
  directories?: Array<string | null | undefined>
  includeGlobal?: boolean
}

export type AgentRuntime = {
  readonly id: string
  readonly capabilities: AgentCapabilities

  createSession(params?: CreateSessionParams, directory?: string | null): Promise<Session>
  getSession(id: string, directory?: string | null): Promise<Session>
  listSessions(directory?: string | null): Promise<Session[]>
  deleteSession(id: string, directory?: string | null): Promise<boolean>
  renameSession(id: string, title: string, directory?: string | null): Promise<void>
  moveSession(id: string, toDirectory: string, options?: MoveSessionOptions): Promise<void>

  getMessages(id: string, options?: { limit?: number; cursor?: string; order?: "asc" | "desc" }, directory?: string | null): Promise<MessagePage>
  cancel(id: string, directory?: string | null): Promise<boolean>
  replyPermission(sessionID: string, requestID: string, reply: PermissionReply, options?: { message?: string; directory?: string | null }): Promise<boolean>
  getPermission(sessionID: string, requestID: string, directory?: string | null): Promise<FetchPermissionResult>
  listPermissions(options?: PendingRequestListOptions): Promise<PermissionRequest[]>
  selectModel(id: string, model: ModelRef, directory?: string | null): Promise<void>
  selectAgent(id: string, agent: string, directory?: string | null): Promise<void>
  getActiveStatus(directory?: string | null): Promise<Record<string, SessionStatus> | null>

  forkSession?(sessionId: string, options?: { before?: string; directory?: string | null }): Promise<Session>
  listAgents?(directory?: string | null): Promise<Agent[]>
  listCommands?(directory?: string | null, signal?: AbortSignal): Promise<Command[]>
  listMcpServers?(directory?: string | null): Promise<McpServerStatus[]>
  connectMcpServer?(server: string, directory?: string | null): Promise<void>
  disconnectMcpServer?(server: string, directory?: string | null): Promise<void>
  listSkills?(directory?: string | null): Promise<Skill[]>
  replyForm?(sessionID: string, formID: string, answer: FormAnswer, directory?: string | null): Promise<boolean>
  cancelForm?(sessionID: string, formID: string, directory?: string | null): Promise<boolean>
  listPendingForms?(options?: PendingRequestListOptions): Promise<FormInfo[]>
  stageRevert?(sessionId: string, messageId: string, options?: { files?: boolean; directory?: string | null }): Promise<SessionRevert>
  commitRevert?(sessionId: string, directory?: string | null): Promise<void>
  clearRevert?(sessionId: string, directory?: string | null): Promise<void>
  getSessionTurnDiff?(sessionId: string, options?: { from?: string; to?: string; context?: number; directory?: string | null }): Promise<FileDiffInfo[]>

  /** Validates a raw stream payload and returns the canonical events it carries. */
  translateEvent(payload: unknown): RoutedAgentEvent[]
}
