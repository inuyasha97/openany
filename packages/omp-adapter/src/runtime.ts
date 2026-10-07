/**
 * The OMP runtime host.
 *
 * `OmpRuntime` owns the session map, the event fan-out and the lifecycle. The
 * `OmpHost` it is built with is the seam to the OMP SDK, so the runtime is
 * testable with a fake and the real SDK binding stays in one place.
 */

import type { OmpEvent, OmpImageContent, OmpMessage } from "./model"

export type { OmpEvent }

export type OmpSessionInfo = {
  id: string
  /** On-disk path `SessionManager` opens the session from. */
  sessionPath: string
  cwd: string
  title: string
}

export type OmpOutboundFrame = { type: string; id?: string; [key: string]: unknown }

/** One OAuth provider OMP can log in to (`get_login_providers`). */
export type OmpLoginProvider = {
  id: string
  name: string
  available: boolean
  authenticated: boolean
}

export type OmpLoginResult = { providerId: string }

/**
 * Called for every unsolicited frame the login process emits; `reply` writes a
 * response frame back to that same process. OMP answers `input` (its manual
 * code prompt) and waits for one; `open_url`, `notify` and the presentation
 * frames expect none, so replying to those would write a frame the server
 * never reads.
 */
export type OmpLoginFrameHandler = (frame: OmpOutboundFrame, reply: (frame: OmpOutboundFrame) => void) => void

export type OmpLoginOptions = {
  onFrame?: OmpLoginFrameHandler
}

/**
 * What a prompt may carry beyond its text. OMP's `prompt` command takes
 * `images?: ImageContent[]` (`modes/rpc/rpc-types.ts`); the block shape is the
 * one `model.ts` already uses for a user message's image content.
 */
export type OmpPromptOptions = {
  /** Images sent with the prompt, in order. */
  images?: readonly OmpImageContent[]
}

export type OmpSessionHandle = {
  id: string
  prompt: (text: string, options?: OmpPromptOptions) => Promise<boolean>
  abort: () => Promise<void>
  subscribe: (listener: (event: OmpEvent) => void) => () => void
  dispose: () => Promise<void>
  sessionFile: string | undefined
  /** The session's current message history, oldest first. */
  messages: () => Promise<readonly OmpMessage[]>
  /** Writes an unsolicited frame to this session's RPC process (e.g. an extension-UI reply). */
  send: (frame: OmpOutboundFrame) => void
}

export type OmpHost = {
  listSessions: () => Promise<OmpSessionInfo[]>
  openSession: (input: { sessionPath?: string; cwd?: string }) => Promise<OmpSessionHandle>
  renameSession: (id: string, title: string) => Promise<void>
  deleteSession: (id: string) => Promise<boolean>
  moveSession: (id: string, toDirectory: string) => Promise<void>
  setModel: (id: string, provider: string, modelId: string) => Promise<void>
  listModels: () => Promise<unknown[]>
  listCommands: () => Promise<unknown[]>
  listLoginProviders: () => Promise<OmpLoginProvider[]>
  login: (providerId: string, options?: OmpLoginOptions) => Promise<OmpLoginResult>
  getSessionStatus: (id: string) => Promise<{ busy: boolean }>
}

export class OmpRuntime {
  private readonly sessions = new Map<string, OmpSessionHandle>()
  private readonly unsubscribes = new Map<string, () => void>()
  private readonly lastUsedAt = new Map<string, number>()
  private readonly cwdBySession = new Map<string, string>()
  private readonly listeners = new Set<(sessionId: string, event: OmpEvent) => void>()

  constructor(private readonly host: OmpHost) {}

  listSessions(): Promise<OmpSessionInfo[]> {
    return this.host.listSessions()
  }

  async createSession(input: { cwd?: string } = {}): Promise<OmpSessionHandle> {
    const handle = this.attach(await this.host.openSession({ cwd: input.cwd }))
    if (input.cwd) this.cwdBySession.set(handle.id, input.cwd)
    return handle
  }

  async getSession(id: string): Promise<OmpSessionHandle> {
    const existing = this.sessions.get(id)
    if (existing) {
      this.lastUsedAt.set(id, Date.now())
      return existing
    }
    const info = (await this.host.listSessions()).find((session) => session.id === id)
    if (!info) throw new Error(`unknown omp session: ${id}`)
    // OMP declines a switch that changes the working directory, so the process
    // has to start in the session's own cwd.
    const handle = this.attach(await this.host.openSession({ sessionPath: info.sessionPath, cwd: info.cwd }))
    if (info.cwd) this.cwdBySession.set(handle.id, info.cwd)
    return handle
  }

  /**
   * Disposes every session process idle for at least `maxIdleMs`. Each open
   * session is one `omp` process, so an unbounded pool would grow with every
   * session the user opens; a later call re-opens the session on demand.
   */
  async disposeIdle(maxIdleMs: number, now: number = Date.now()): Promise<string[]> {
    const idle = [...this.lastUsedAt]
      .filter(([id, at]) => now - at >= maxIdleMs && this.sessions.has(id))
      .map(([id]) => id)
    for (const id of idle) await this.disposeSession(id)
    return idle
  }

  /**
   * Disposes every open session process started in `directory`. A worktree
   * cannot be removed while a process still holds its folder, so the worktree
   * removal path releases them first.
   */
  async disposeSessionsInDirectory(directory: string): Promise<string[]> {
    const target = directory.replace(/\/+$/, "")
    const ids = [...this.cwdBySession]
      .filter(([id, cwd]) => cwd.replace(/\/+$/, "") === target && this.sessions.has(id))
      .map(([id]) => id)
    for (const id of ids) await this.disposeSession(id)
    return ids
  }

  private async disposeSession(id: string): Promise<void> {
    const handle = this.sessions.get(id)
    this.sessions.delete(id)
    this.lastUsedAt.delete(id)
    this.cwdBySession.delete(id)
    try {
      this.unsubscribes.get(id)?.()
    } catch {
      /* ignore */
    }
    this.unsubscribes.delete(id)
    try {
      await handle?.dispose()
    } catch {
      /* best-effort teardown */
    }
  }

  async prompt(id: string, text: string, options?: OmpPromptOptions): Promise<boolean> {
    return (await this.getSession(id)).prompt(text, options)
  }

  async getMessages(id: string): Promise<readonly OmpMessage[]> {
    return (await this.getSession(id)).messages()
  }

  async abort(id: string): Promise<void> {
    return (await this.getSession(id)).abort()
  }

  renameSession(id: string, title: string): Promise<void> {
    return this.host.renameSession(id, title)
  }

  deleteSession(id: string): Promise<boolean> {
    return this.host.deleteSession(id)
  }

  moveSession(id: string, toDirectory: string): Promise<void> {
    return this.host.moveSession(id, toDirectory)
  }

  setModel(id: string, provider: string, modelId: string): Promise<void> {
    return this.host.setModel(id, provider, modelId)
  }

  listModels(): Promise<unknown[]> {
    return this.host.listModels()
  }

  listCommands(): Promise<unknown[]> {
    return this.host.listCommands()
  }

  listLoginProviders(): Promise<OmpLoginProvider[]> {
    return this.host.listLoginProviders()
  }

  login(providerId: string, options?: OmpLoginOptions): Promise<OmpLoginResult> {
    return this.host.login(providerId, options)
  }

  getSessionStatus(id: string): Promise<{ busy: boolean }> {
    return this.host.getSessionStatus(id)
  }

  async sendToSession(id: string, frame: OmpOutboundFrame): Promise<void> {
    const handle = await this.getSession(id)
    handle.send(frame)
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
    this.lastUsedAt.clear()
    this.cwdBySession.clear()
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
    this.lastUsedAt.set(handle.id, Date.now())
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
