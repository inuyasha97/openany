import { opencodeClient } from "@/lib/opencode/client"
import { translateWirePayload } from "@/lib/opencode/events"
import type { FileDiffInfo, FormAnswer, FormInfo, SessionRevert } from "@opencode/client"
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
  SendCommandParams,
  SendPromptParams,
  SessionListOptions,
  SessionPage,
} from "./contract"
import type { RoutedAgentEvent, RoutedSyncEvent } from "./events"

export type SessionClient = Pick<
  typeof opencodeClient,
  | "createSession" | "getSession" | "listSessions" | "deleteSession" | "renameSession" | "moveSession"
  | "getSessionMessages" | "abortSession" | "replyToPermission" | "fetchPermission" | "listPendingPermissions"
  | "switchSessionModel" | "switchSessionAgent" | "getActiveSessionStatuses"
  | "forkSession" | "listAgents" | "listCommands" | "listMcpServers" | "connectMcpServer" | "disconnectMcpServer" | "listSkills"
  | "replyToForm" | "cancelForm" | "listPendingForms"
  | "stageRevert" | "commitRevert" | "clearRevert" | "getSessionTurnDiff"
  | "sendMessage" | "sendCommand" | "listSessionsPage"
>

export type TranslateWirePayload = (payload: unknown) => RoutedSyncEvent[]

const OPENCODE_CAPABILITIES: AgentCapabilities = {
  fork: true,
  commands: true,
  mcp: true,
  agents: true,
  permissions: true,
  modelSelection: true,
  agentSelection: true,
  forms: true,
  revert: true,
  turnDiff: true,
  skills: true,
  rename: true,
  delete: true,
  move: true,
  attachments: true,
}

export class OpenCodeRuntime implements AgentRuntime {
  readonly id = "opencode"
  readonly capabilities = OPENCODE_CAPABILITIES

  constructor(
    private readonly client: SessionClient = opencodeClient,
    private readonly translateWire: TranslateWirePayload = translateWirePayload,
  ) {}

  createSession(params?: CreateSessionParams, directory?: string | null): Promise<AgentSession> {
    return this.client.createSession(params, directory)
  }

  getSession(id: string, directory?: string | null): Promise<AgentSession> {
    return this.client.getSession(id, directory)
  }

  listSessions(directory?: string | null): Promise<AgentSession[]> {
    return this.client.listSessions(directory)
  }

  deleteSession(id: string, directory?: string | null): Promise<boolean> {
    return this.client.deleteSession(id, directory)
  }

  renameSession(id: string, title: string, directory?: string | null): Promise<void> {
    return this.client.renameSession(id, title, directory)
  }

  moveSession(id: string, toDirectory: string, options?: MoveSessionOptions): Promise<void> {
    return this.client.moveSession(id, toDirectory, options)
  }

  getMessages(id: string, options?: { limit?: number; cursor?: string; order?: "asc" | "desc" }, directory?: string | null): Promise<MessagePage> {
    return this.client.getSessionMessages(id, options, directory)
  }

  cancel(id: string, directory?: string | null): Promise<boolean> {
    return this.client.abortSession(id, directory)
  }

  replyPermission(sessionID: string, requestID: string, reply: PermissionReply, options?: { message?: string; directory?: string | null }): Promise<boolean> {
    return this.client.replyToPermission(sessionID, requestID, reply, options)
  }

  getPermission(sessionID: string, requestID: string, directory?: string | null): Promise<FetchPermissionResult> {
    return this.client.fetchPermission(sessionID, requestID, directory)
  }

  listPermissions(options?: PendingRequestListOptions): Promise<PermissionRequest[]> {
    return this.client.listPendingPermissions(options)
  }

  selectModel(id: string, model: ModelRef, directory?: string | null): Promise<void> {
    return this.client.switchSessionModel(id, model, directory)
  }

  selectAgent(id: string, agent: string, directory?: string | null): Promise<void> {
    return this.client.switchSessionAgent(id, agent, directory)
  }

  getActiveStatus(directory?: string | null): Promise<Record<string, SessionStatus> | null> {
    return this.client.getActiveSessionStatuses(directory)
  }

  forkSession(sessionId: string, options?: { before?: string; directory?: string | null }): Promise<AgentSession> {
    return this.client.forkSession(sessionId, options)
  }

  listAgents(directory?: string | null): Promise<Agent[]> {
    return this.client.listAgents(directory)
  }

  listCommands(directory?: string | null, signal?: AbortSignal): Promise<Command[]> {
    return this.client.listCommands(directory, signal)
  }

  listMcpServers(directory?: string | null): Promise<McpServerStatus[]> {
    return this.client.listMcpServers(directory)
  }

  connectMcpServer(server: string, directory?: string | null): Promise<void> {
    return this.client.connectMcpServer(server, directory)
  }

  disconnectMcpServer(server: string, directory?: string | null): Promise<void> {
    return this.client.disconnectMcpServer(server, directory)
  }

  listSkills(directory?: string | null): Promise<Skill[]> {
    return this.client.listSkills(directory)
  }

  replyForm(sessionID: string, formID: string, answer: FormAnswer, directory?: string | null): Promise<boolean> {
    return this.client.replyToForm(sessionID, formID, answer, directory)
  }

  cancelForm(sessionID: string, formID: string, directory?: string | null): Promise<boolean> {
    return this.client.cancelForm(sessionID, formID, directory)
  }

  listPendingForms(options?: PendingRequestListOptions): Promise<FormInfo[]> {
    return this.client.listPendingForms(options)
  }

  stageRevert(sessionId: string, messageId: string, options?: { files?: boolean; directory?: string | null }): Promise<SessionRevert> {
    return this.client.stageRevert(sessionId, messageId, options)
  }

  commitRevert(sessionId: string, directory?: string | null): Promise<void> {
    return this.client.commitRevert(sessionId, directory)
  }

  clearRevert(sessionId: string, directory?: string | null): Promise<void> {
    return this.client.clearRevert(sessionId, directory)
  }

  getSessionTurnDiff(sessionId: string, options?: { from?: string; to?: string; context?: number; directory?: string | null }): Promise<FileDiffInfo[]> {
    return this.client.getSessionTurnDiff(sessionId, options)
  }

  sendPrompt(params: SendPromptParams): Promise<string> {
    return this.client.sendMessage(params)
  }

  sendCommand(params: SendCommandParams): Promise<void> {
    return this.client.sendCommand(params)
  }

  listSessionsPage(options?: SessionListOptions): Promise<SessionPage> {
    return this.client.listSessionsPage(options)
  }

  translateEvent(payload: unknown): RoutedAgentEvent[] {
    return this.translateWire(payload)
  }
}
