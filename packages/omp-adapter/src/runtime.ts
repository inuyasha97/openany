/**
 * The OMP runtime host.
 *
 * `OmpRuntime` owns the session map, the event fan-out and the lifecycle. The
 * `OmpHost` it is built with is the seam to the OMP SDK, so the runtime is
 * testable with a fake and the real SDK binding stays in one place.
 */

import type { OmpEvent, OmpMessage } from "./model"

export type { OmpEvent }

export type OmpSessionInfo = {
  id: string
  /** On-disk path `SessionManager` opens the session from. */
  sessionPath: string
  cwd: string
  title: string
}

export type OmpSessionHandle = {
  id: string
  prompt: (text: string) => Promise<boolean>
  abort: () => Promise<void>
  subscribe: (listener: (event: OmpEvent) => void) => () => void
  dispose: () => Promise<void>
  sessionFile: string | undefined
  /** The session's current message history, oldest first. */
  messages: () => readonly OmpMessage[]
}

export type OmpHost = {
  listSessions: () => Promise<OmpSessionInfo[]>
  openSession: (input: { sessionPath?: string; cwd?: string }) => Promise<OmpSessionHandle>
}

export class OmpRuntime {
  private readonly sessions = new Map<string, OmpSessionHandle>()
  private readonly unsubscribes = new Map<string, () => void>()
  private readonly listeners = new Set<(sessionId: string, event: OmpEvent) => void>()

  constructor(private readonly host: OmpHost) {}

  listSessions(): Promise<OmpSessionInfo[]> {
    return this.host.listSessions()
  }

  async createSession(input: { cwd?: string } = {}): Promise<OmpSessionHandle> {
    return this.attach(await this.host.openSession({ cwd: input.cwd }))
  }

  async getSession(id: string): Promise<OmpSessionHandle> {
    const existing = this.sessions.get(id)
    if (existing) return existing
    const info = (await this.host.listSessions()).find((session) => session.id === id)
    if (!info) throw new Error(`unknown omp session: ${id}`)
    return this.attach(await this.host.openSession({ sessionPath: info.sessionPath }))
  }

  async prompt(id: string, text: string): Promise<boolean> {
    return (await this.getSession(id)).prompt(text)
  }

  async getMessages(id: string): Promise<readonly OmpMessage[]> {
    return (await this.getSession(id)).messages()
  }

  async abort(id: string): Promise<void> {
    return (await this.getSession(id)).abort()
  }

  subscribe(listener: (sessionId: string, event: OmpEvent) => void): () => void {
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

  private attach(handle: OmpSessionHandle): OmpSessionHandle {
    this.sessions.set(handle.id, handle)
    this.unsubscribes.set(handle.id, handle.subscribe((event) => this.emit(handle.id, event)))
    return handle
  }

  private emit(sessionId: string, event: OmpEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(sessionId, event)
      } catch {
        /* listener errors must not break other subscribers */
      }
    }
  }
}
