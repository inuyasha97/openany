import { opencodeClient } from "@/lib/opencode/client"
import type { Session } from "@/lib/opencode/model"
import type { AgentCapabilities, AgentRuntime, CreateSessionParams, MoveSessionOptions } from "./contract"

export type SessionClient = Pick<
  typeof opencodeClient,
  "createSession" | "getSession" | "listSessions" | "deleteSession" | "renameSession" | "moveSession"
>

const OPENCODE_CAPABILITIES: AgentCapabilities = {
  fork: true,
  commands: true,
  mcp: true,
  agents: true,
  permissions: true,
  modelSelection: true,
  agentSelection: true,
}

export class OpenCodeRuntime implements AgentRuntime {
  readonly id = "opencode"
  readonly capabilities = OPENCODE_CAPABILITIES

  constructor(private readonly client: SessionClient = opencodeClient) {}

  createSession(params?: CreateSessionParams, directory?: string | null): Promise<Session> {
    return this.client.createSession(params, directory)
  }

  getSession(id: string, directory?: string | null): Promise<Session> {
    return this.client.getSession(id, directory)
  }

  listSessions(directory?: string | null): Promise<Session[]> {
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
}
