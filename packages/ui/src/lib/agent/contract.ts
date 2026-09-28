import type { SessionInboxDelivery } from "@opencode/client"
import type { Metadata, ModelRef, Session } from "@/lib/opencode/model"

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

export type AgentRuntime = {
  readonly id: string
  readonly capabilities: AgentCapabilities

  createSession(params?: CreateSessionParams, directory?: string | null): Promise<Session>
  getSession(id: string, directory?: string | null): Promise<Session>
  listSessions(directory?: string | null): Promise<Session[]>
  deleteSession(id: string, directory?: string | null): Promise<boolean>
  renameSession(id: string, title: string, directory?: string | null): Promise<void>
  moveSession(id: string, toDirectory: string, options?: MoveSessionOptions): Promise<void>
}
