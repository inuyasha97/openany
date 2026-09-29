/**
 * The ACP runtime host.
 *
 * `AcpRuntime` owns the session map, the event fan-out, the permission replies
 * and the lifecycle. The `AcpHost` it is built with is the seam to the ACP
 * client over stdio, so the runtime is testable with a fake and the process and
 * JSON-RPC mechanics stay in one place.
 *
 * ACP is bidirectional: the agent can ask the client to approve a tool call
 * (`session/request_permission`). `replyPermission` carries the user's answer
 * back to the pending request the host is holding.
 */

import type { AcpEvent } from "./model"

export type { AcpEvent }

export type AcpSessionInfo = {
  id: string
  cwd: string
  title?: string
}

export type AcpPermissionReply = {
  requestId: string
  /** The `optionId` of the chosen permission option, or `"cancelled"`. */
  optionId: string
}

export type AcpSessionHandle = {
  id: string
  prompt: (text: string) => Promise<boolean>
  cancel: () => Promise<void>
  replyPermission: (reply: AcpPermissionReply) => Promise<boolean>
  subscribe: (listener: (event: AcpEvent) => void) => () => void
  dispose: () => Promise<void>
}

export type AcpHost = {
  listSessions: () => Promise<AcpSessionInfo[]>
  openSession: (input: { sessionId?: string; cwd?: string }) => Promise<AcpSessionHandle>
}

export class AcpRuntime {
  private readonly sessions = new Map<string, AcpSessionHandle>()
  private readonly unsubscribes = new Map<string, () => void>()
  private readonly listeners = new Set<(sessionId: string, event: AcpEvent) => void>()

  constructor(private readonly host: AcpHost) {}

  listSessions(): Promise<AcpSessionInfo[]> {
    return this.host.listSessions()
  }

  async createSession(input: { cwd?: string } = {}): Promise<AcpSessionHandle> {
    return this.attach(await this.host.openSession({ cwd: input.cwd }))
  }

  async getSession(id: string): Promise<AcpSessionHandle> {
    const existing = this.sessions.get(id)
    if (existing) return existing
    return this.attach(await this.host.openSession({ sessionId: id }))
  }

  async prompt(id: string, text: string): Promise<boolean> {
    return (await this.getSession(id)).prompt(text)
  }

  async cancel(id: string): Promise<void> {
    return (await this.getSession(id)).cancel()
  }

  async replyPermission(id: string, reply: AcpPermissionReply): Promise<boolean> {
    return (await this.getSession(id)).replyPermission(reply)
  }

  subscribe(listener: (sessionId: string, event: AcpEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async dispose(): Promise<void> {
    this.listeners.clear()
    const handles = [...this.sessions.values()]
    this.sessions.clear()
    for (const unsubscribe of this.unsubscribes.values()) {
      try {
        unsubscribe()
      } catch {
        /* ignore */
      }
    }
    this.unsubscribes.clear()
    for (const handle of handles) {
      try {
        await handle.dispose()
      } catch {
        /* best-effort teardown */
      }
    }
  }

  private attach(handle: AcpSessionHandle): AcpSessionHandle {
    this.sessions.set(handle.id, handle)
    this.unsubscribes.set(handle.id, handle.subscribe((event) => this.emit(handle.id, event)))
    return handle
  }

  private emit(sessionId: string, event: AcpEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(sessionId, event)
      } catch {
        /* listener errors must not break other subscribers */
      }
    }
  }
}
