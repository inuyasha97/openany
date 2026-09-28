import type { SessionInboxDelivery } from "@opencode/client"
import type { Message, Metadata, ModelRef, Part, PermissionRequest, Session } from "@/lib/opencode/model"
import type { RoutedAgentEvent } from "./events"

export type AgentCapabilities = {
  fork: boolean
  commands: boolean
  mcp: boolean
  agents: boolean
  permissions: boolean
  modelSelection: boolean
  agentSelection: boolean
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

export type AgentRuntime = {
  readonly id: string
  readonly capabilities: AgentCapabilities

  createSession(params?: CreateSessionParams, directory?: string | null): Promise<Session>
  getSession(id: string, directory?: string | null): Promise<Session>
  listSessions(directory?: string | null): Promise<Session[]>
  deleteSession(id: string, directory?: string | null): Promise<boolean>
  renameSession(id: string, title: string, directory?: string | null): Promise<void>
  moveSession(id: string, toDirectory: string, options?: MoveSessionOptions): Promise<void>

  /** Validates a raw stream payload and returns the canonical events it carries. */
  translateEvent(payload: unknown): RoutedAgentEvent[]
}
