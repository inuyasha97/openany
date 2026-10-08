/**
 * The OMP runtime host.
 *
 * `OmpRuntime` owns the session map, the event fan-out and the lifecycle. The
 * `OmpHost` it is built with is the seam to the OMP SDK, so the runtime is
 * testable with a fake and the real SDK binding stays in one place.
 */

import type { OmpEvent, OmpImageContent, OmpMessage, OmpModelInfo, OmpThinkingLevel } from "./model"

export type { OmpEvent }

export type OmpSessionInfo = {
  id: string
  /** On-disk path `SessionManager` opens the session from. */
  sessionPath: string
  cwd: string
  title: string
  /** On-disk path of the session this one was branched from, when OMP recorded one. */
  parentSessionPath?: string
}

export type OmpOutboundFrame = { type: string; id?: string; [key: string]: unknown }

/** How full a session's context window is (`get_state.contextUsage`). */
export type OmpContextUsage = { tokens: number; contextWindow: number; percent: number }

/**
 * The full `get_state` reading. `busy` folds streaming and compaction together:
 * a compactor is a running turn, so the composer must queue rather than send.
 */
export type OmpSessionStatus = {
  busy: boolean
  compacting: boolean
  queuedCount: number
  tokensPerSecond: number | null
  contextUsage: OmpContextUsage | null
}

/**
 * One `extension_ui_request` the model is still waiting on. `select` and
 * `editor` are the `ask` tool's questions; `confirm` and `input` are tool
 * approvals. OMP's `cancel` frame (and our own `extension_ui_response`) clears
 * the entry.
 */
export type OmpPendingRequest = {
  requestId: string
  sessionId: string
  method: "select" | "confirm" | "input" | "editor"
  title: string
  /** The choices an `ask` tool's `select` offers. */
  options?: readonly string[]
  /** Positional descriptions for `options`, when OMP supplied any. */
  optionDetails?: readonly { description?: string }[]
  /** The prompt text a `confirm` carries. */
  message?: string
  /** Placeholder for an `input`. */
  placeholder?: string
  /** Pre-filled text for an `editor`. */
  prefill?: string
}


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
  /**
   * The directory the caller believes the session runs in. OMP pins the
   * process cwd when the session is opened, so the host does not re-apply it;
   * it is carried so a command send passes the same options a prompt takes.
   */
  cwd?: string
}

/** What `sendCommand` takes; the command is expanded by OMP inside `prompt`. */
export type OmpSendCommandParams = {
  id: string
  /** The command name without its leading slash. */
  command: string
  arguments?: string
  directory?: string
  images?: readonly OmpImageContent[]
}

/** What `forkSession` takes: the session to branch and the entry to branch at. */
export type OmpForkParams = {
  id: string
  /** The entry (a user message) OMP branches the transcript at. */
  entryId: string
  directory?: string
}

export type OmpSessionHandle = {
  /** The session's current id; a `branch` re-keys the live handle, so this can change. */
  id: string
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
  openSession: (input: { sessionPath?: string; cwd?: string; parentSession?: string }) => Promise<OmpSessionHandle>
  prompt: (id: string, text: string, options?: OmpPromptOptions) => Promise<boolean>
  branch: (id: string, entryId: string) => Promise<OmpSessionInfo>
  renameSession: (id: string, title: string) => Promise<void>
  deleteSession: (id: string) => Promise<boolean>
  moveSession: (id: string, toDirectory: string) => Promise<void>
  setModel: (id: string, provider: string, modelId: string) => Promise<void>
  listModels: () => Promise<OmpModelInfo[]>
  listCommands: () => Promise<unknown[]>
  setThinkingLevel: (id: string, level: OmpThinkingLevel) => Promise<boolean>
  cycleThinkingLevel: (id: string) => Promise<OmpThinkingLevel | null>
  setFastMode: (id: string, enabled: boolean) => Promise<{ enabled: boolean; active: boolean }>
  listLoginProviders: () => Promise<OmpLoginProvider[]>
  login: (providerId: string, options?: OmpLoginOptions) => Promise<OmpLoginResult>
  getSessionStatus: (id: string) => Promise<OmpSessionStatus>
  /** The askable frames this session has not answered yet, oldest first. */
  listPendingRequests: (id: string) => OmpPendingRequest[]
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

  async createSession(input: { cwd?: string; parentSession?: string } = {}): Promise<OmpSessionHandle> {
    const handle = this.attach(await this.host.openSession({ cwd: input.cwd, parentSession: input.parentSession }))
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

  /**
   * Moves a session's handle and its bookkeeping from the id it had to the id
   * OMP reports after a `branch`. Without this the old id would keep the handle
   * for a process that now serves the branched session, and a prompt to the
   * original would land in the fork.
   */
  private rekey(from: string, to: string, cwd: string): void {
    if (from === to) {
      if (cwd) this.cwdBySession.set(to, cwd)
      return
    }
    const handle = this.sessions.get(from)
    if (handle) {
      this.sessions.delete(from)
      this.sessions.set(to, handle)
      const unsubscribe = this.unsubscribes.get(from)
      this.unsubscribes.delete(from)
      if (unsubscribe) this.unsubscribes.set(to, unsubscribe)
      const usedAt = this.lastUsedAt.get(from)
      this.lastUsedAt.delete(from)
      if (usedAt !== undefined) this.lastUsedAt.set(to, usedAt)
    }
    this.cwdBySession.delete(from)
    if (cwd) this.cwdBySession.set(to, cwd)
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
    // The session must be open before the host can write to its process.
    await this.getSession(id)
    return this.host.prompt(id, text, options)
  }

  /**
   * Sends a slash command. OMP expands `/name args` itself, for file commands,
   * `/skill:<name>` and extension commands alike, so the command travels as an
   * ordinary prompt and the raw text is never special-cased here.
   */
  async sendCommand(params: OmpSendCommandParams): Promise<void> {
    const text = params.arguments?.trim() ? `/${params.command} ${params.arguments.trim()}` : `/${params.command}`
    const options: OmpPromptOptions = {}
    if (params.directory !== undefined) options.cwd = params.directory
    if (params.images && params.images.length > 0) options.images = params.images
    await this.prompt(params.id, text, options)
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

  listModels(): Promise<OmpModelInfo[]> {
    return this.host.listModels()
  }

  listCommands(): Promise<unknown[]> {
    return this.host.listCommands()
  }

  async setThinkingLevel(id: string, level: OmpThinkingLevel): Promise<boolean> {
    await this.getSession(id)
    return this.host.setThinkingLevel(id, level)
  }

  async cycleThinkingLevel(id: string): Promise<OmpThinkingLevel | null> {
    await this.getSession(id)
    return this.host.cycleThinkingLevel(id)
  }

  async setFastMode(id: string, enabled: boolean): Promise<{ enabled: boolean; active: boolean }> {
    await this.getSession(id)
    return this.host.setFastMode(id, enabled)
  }

  /**
   * Branches the session at `entryId` and follows the branched session. OMP
   * swaps the live session inside the same process, so the handle is re-keyed
   * to the new id and the branch's own directory is remembered.
   */
  async forkSession(params: OmpForkParams): Promise<OmpSessionInfo> {
    await this.getSession(params.id)
    const info = await this.host.branch(params.id, params.entryId)
    const cwd = info.cwd || this.cwdBySession.get(params.id) || params.directory || ""
    this.rekey(params.id, info.id, cwd)
    return { ...info, cwd }
  }

  async listPendingRequests(id: string): Promise<OmpPendingRequest[]> {
    return this.host.listPendingRequests(id)
  }

  listLoginProviders(): Promise<OmpLoginProvider[]> {
    return this.host.listLoginProviders()
  }

  login(providerId: string, options?: OmpLoginOptions): Promise<OmpLoginResult> {
    return this.host.login(providerId, options)
  }

  getSessionStatus(id: string): Promise<OmpSessionStatus> {
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
