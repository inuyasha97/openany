import type { FileDiffInfo, FormAnswer, FormInfo, SessionInboxDelivery, SessionRevert } from "@/lib/opencode/wire"
import type { ContextPartMetadata } from "@/lib/messages/contextParts"
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
import type { SpaceMark } from "@/lib/spaces/spaces-store"
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
  rename: boolean
  delete: boolean
  move: boolean
  /** The runtime accepts file attachments on a prompt. */
  attachments: boolean
  /**
   * Which files the composer may offer when `attachments` is on. `"any"`
   * (absent) is the composer's full list; `"images"` means only images survive
   * the send, because the runtime takes every other file as a path mention
   * rather than as bytes.
   */
  attachmentKinds?: "any" | "images"
}

export type CreateSessionParams = {
  id?: string
  title?: string
  agent?: string
  model?: ModelRef
  metadata?: Metadata
}

export type MoveSessionOptions = { delivery?: SessionInboxDelivery }

/** A session together with the runtime that owns it and that runtime's own session id. */
export type AgentSession = Session & {
  runtimeId: string
  nativeSessionId: string
}

/** The canonical name for a message. Equals the domain model while one runtime exists. */
export type AgentMessage = Message
/** The canonical name for a message part. Equals the domain model while one runtime exists. */
export type AgentPart = Part

export type MessagePage = {
  items: Array<{ info: AgentMessage; parts: AgentPart[] }>
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

/**
 * Skills the user named inline with `/name`, in order of appearance. They are
 * attached to the prompt by id so the runtime loads each one with the message,
 * whatever the session is doing; a name that cannot be attached falls back to
 * the instruction the caller builds for it.
 */
export type SkillMentions = {
  names: readonly string[]
  instructionFor: (names: readonly string[]) => string | null
}

export type FileInputLite = {
  id?: string
  type: "file"
  mime: string
  filename?: string
  url: string
}

export type SessionPage = {
  sessions: AgentSession[]
  cursor: { previous?: string; next?: string }
  /**
   * The isolated spaces the host merged into a global page, one mark per space, when the
   * feature is on. Absent on a per-directory page and while the feature is off.
   */
  spaces?: SpaceMark[]
}

export type SessionListOptions = {
  directory?: string | null
  /** No directory filter at all: every session the server knows. */
  global?: boolean
  limit?: number
  order?: "asc" | "desc"
  search?: string
  cursor?: string
  parentID?: string | null
}

export type SendPromptParams = {
  runtimeKey?: string
  id: string
  /** Switch the session to this model before sending; omit when unchanged. */
  model?: ModelRef
  /** Switch the session to this agent before sending; omit when unchanged. */
  agent?: string
  /** Provider the prompt will run on, for the provider circuit breaker. */
  providerID: string
  text: string
  files?: Array<FileInputLite>
  /** Context items sent ahead of the prompt as synthetic messages. */
  context?: Array<{ text: string; metadata?: ContextPartMetadata; description?: string }>
  messageId?: string
  agentMentions?: Array<{ name: string; source?: { value: string; start: number; end: number } }>
  metadata?: Metadata
  delivery?: SessionInboxDelivery
  directory?: string | null
  /** Skills named inline; attached to the prompt so the runtime loads them with it. */
  skills?: SkillMentions
}

export type SendCommandParams = {
  runtimeKey?: string
  id: string
  model?: ModelRef
  agent?: string
  command: string
  arguments?: string
  files?: Array<FileInputLite>
  context?: Array<{ text: string; metadata?: ContextPartMetadata; description?: string }>
  delivery?: SessionInboxDelivery
  directory?: string | null
}

export type AgentRuntime = {
  readonly id: string
  readonly capabilities: AgentCapabilities

  createSession(params?: CreateSessionParams, directory?: string | null): Promise<AgentSession>
  getSession(id: string, directory?: string | null): Promise<AgentSession>
  listSessions(directory?: string | null): Promise<AgentSession[]>
  deleteSession(id: string, directory?: string | null): Promise<boolean>
  renameSession(id: string, title: string, directory?: string | null): Promise<void>
  moveSession(id: string, toDirectory: string, options?: MoveSessionOptions): Promise<void>

  getMessages(id: string, options?: { limit?: number; cursor?: string; order?: "asc" | "desc" }, directory?: string | null): Promise<MessagePage>
  cancel(id: string, directory?: string | null): Promise<boolean>
  replyPermission(sessionID: string, requestID: string, reply: PermissionReply, options?: { message?: string; directory?: string | null }): Promise<boolean>
  getPermission(sessionID: string, requestID: string, directory?: string | null): Promise<FetchPermissionResult>
  listPermissions(options?: PendingRequestListOptions): Promise<PermissionRequest[]>
  selectModel(id: string, model: ModelRef, directory?: string | null): Promise<void>
  getActiveStatus(directory?: string | null): Promise<Record<string, SessionStatus> | null>

  forkSession(sessionId: string, options?: { before?: string; directory?: string | null }): Promise<AgentSession>
  listAgents(directory?: string | null): Promise<Agent[]>
  listCommands(directory?: string | null, signal?: AbortSignal): Promise<Command[]>
  listMcpServers(directory?: string | null): Promise<McpServerStatus[]>
  connectMcpServer(server: string, directory?: string | null): Promise<void>
  disconnectMcpServer(server: string, directory?: string | null): Promise<void>
  listSkills(directory?: string | null): Promise<Skill[]>
  replyForm(sessionID: string, formID: string, answer: FormAnswer, directory?: string | null): Promise<boolean>
  cancelForm(sessionID: string, formID: string, directory?: string | null): Promise<boolean>
  listPendingForms(options?: PendingRequestListOptions): Promise<FormInfo[]>
  stageRevert(sessionId: string, messageId: string, options?: { files?: boolean; directory?: string | null }): Promise<SessionRevert>
  commitRevert(sessionId: string, directory?: string | null): Promise<void>
  clearRevert(sessionId: string, directory?: string | null): Promise<void>
  getSessionTurnDiff(sessionId: string, options?: { from?: string; to?: string; context?: number; directory?: string | null }): Promise<FileDiffInfo[]>

  sendPrompt(params: SendPromptParams): Promise<string>
  sendCommand(params: SendCommandParams): Promise<void>
  listSessionsPage(options?: SessionListOptions): Promise<SessionPage>

  /** Validates a raw stream payload and returns the canonical events it carries. */
  translateEvent(payload: unknown): RoutedAgentEvent[]
}
