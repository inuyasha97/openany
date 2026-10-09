/**
 * Minimal JSONL client for `omp --mode rpc`.
 *
 * `OmpRpcChild` is the child-process seam, so the client is testable with a
 * fake and the real Node spawn lives in `rpc-host.ts`. Commands correlate by
 * `id`; every other stdout frame is an event forwarded to listeners.
 *
 * The protocol is the v1 JSONL framing OMP emits by default: one JSON object
 * per line on stdout, one command per line on stdin. Large-frame protocol v2
 * (chunk reassembly) is not negotiated here, so a single frame stays under
 * OMP's v1 byte ceiling.
 */

export type OmpRpcChild = {
  stdout: { on: (event: "data", listener: (chunk: string | Uint8Array) => void) => unknown }
  stderr: { on: (event: "data", listener: (chunk: string | Uint8Array) => void) => unknown }
  stdin: { write: (chunk: string) => unknown; end?: () => void }
  on: (event: "exit" | "error", listener: (value: unknown) => void) => unknown
  kill: (signal?: string) => unknown
}

export type OmpRpcSpawn = (
  command: string,
  args: string[],
  /** `windowsHide` keeps the console window from flashing on Windows. */
  options: { cwd?: string; env?: Record<string, string | undefined>; windowsHide?: boolean },
) => OmpRpcChild

export type OmpRpcFrame = { type: string; id?: string; [key: string]: unknown }

export type OmpRpcOptions = {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string | undefined>
  spawn: OmpRpcSpawn
}

/** How long `start()` waits for the protocol-v2 negotiation before falling back to v1. */
const NEGOTIATE_TIMEOUT_MS = 5_000

export class OmpRpcError extends Error {
  readonly command: string
  constructor(command: string, message: string) {
    super(message)
    this.name = "OmpRpcError"
    this.command = command
  }
}

type Pending = {
  command: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

type PendingChunks = {
  chunkId: string
  count: number
  byteLength: number
  nextIndex: number
  chunks: Buffer[]
  receivedBytes: number
}

export class OmpRpcClient {
  private child: OmpRpcChild | null = null
  private buffer = ""
  private nextId = 0
  private closed = false
  private readonly pending = new Map<string, Pending>()
  private readonly listeners = new Set<(frame: OmpRpcFrame) => void>()
  private ready: Promise<void> | null = null
  private resolveReady: (() => void) | null = null
  private rejectReady: ((error: Error) => void) | null = null
  private negotiated = false
  private pendingChunks: PendingChunks | null = null
  private readonly decoder = new TextDecoder()

  constructor(private readonly options: OmpRpcOptions) {}

  start(): Promise<void> {
    this.ready ??= new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    if (!this.child) {
      const args = this.options.args ?? ["--mode", "rpc"]
      // `windowsHide` is what keeps a console window from flashing on Windows
      // for a process the user never asked to see — one per open session.
      const child = this.options.spawn(this.options.command, args, {
        cwd: this.options.cwd,
        env: this.options.env,
        windowsHide: true,
      })
      this.child = child
      child.stdout.on("data", (chunk) => this.ingest(chunk))
      // stderr is OMP's log stream, never protocol; drain it so a full pipe
      // cannot stall the child.
      child.stderr.on("data", () => {})
      child.on("error", (error) => {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      })
      child.on("exit", (code) => {
        if (!this.closed) this.fail(new Error(`omp rpc exited with code ${String(code)}`))
      })
    }
    return this.ready
  }

  command<T = unknown>(type: string, fields: Record<string, unknown> = {}): Promise<T> {
    if (this.closed || !this.child) {
      return Promise.reject(new OmpRpcError(type, "omp rpc client is closed"))
    }
    const id = `rpc-${++this.nextId}`
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { command: type, resolve: (value) => resolve(value as T), reject })
      this.write({ id, type, ...fields })
    })
  }

  onEvent(listener: (frame: OmpRpcFrame) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Writes a frame the client is not waiting on: a reply to an unsolicited server request. */
  send(frame: OmpRpcFrame): void {
    this.write(frame)
  }

  async dispose(): Promise<void> {
    this.closed = true
    for (const entry of this.pending.values()) entry.reject(new OmpRpcError(entry.command, "omp rpc client disposed"))
    this.pending.clear()
    this.listeners.clear()
    const child = this.child
    this.child = null
    if (!child) return
    try {
      child.stdin.end?.()
    } catch {
      /* best-effort teardown */
    }
  }

  private write(frame: OmpRpcFrame): void {
    this.child?.stdin.write(`${JSON.stringify(frame)}\n`)
  }

  private ingest(chunk: string | Uint8Array): void {
    // One streaming decoder: a multi-byte character split across two stdout
    // reads must survive, which a per-chunk decode would turn into U+FFFD.
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true })
    let index: number
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line) this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    let frame: OmpRpcFrame
    try {
      frame = JSON.parse(line) as OmpRpcFrame
    } catch {
      return // malformed lines are recoverable per the protocol
    }
    if (frame.type === "rpc_chunk") {
      this.handleChunk(frame)
      return
    }
    if (frame.type === "ready") {
      void this.settleReady(frame)
      return
    }
    if (frame.type === "response" && typeof frame.id === "string") {
      const entry = this.pending.get(frame.id)
      if (!entry) return
      this.pending.delete(frame.id)
      if (frame.success === false) entry.reject(new OmpRpcError(entry.command, String(frame.error ?? "omp rpc command failed")))
      else entry.resolve(frame.data)
      return
    }
    for (const listener of this.listeners) listener(frame)
  }

  /**
   * Protocol v2 lets OMP split a logical frame larger than the v1 transport
   * ceiling into `rpc_chunk` frames. The server advertises it in the ready
   * frame; negotiate it before any command so a large `get_messages` is not
   * elided, and stay on v1 when negotiation fails.
   */
  private async settleReady(frame: OmpRpcFrame): Promise<void> {
    const supported = Array.isArray(frame.supportedProtocolVersions) ? frame.supportedProtocolVersions : []
    if (!this.negotiated && supported.includes(2)) {
      this.negotiated = true
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("omp rpc negotiate timed out")), NEGOTIATE_TIMEOUT_MS)
      })
      try {
        await Promise.race([this.command("negotiate_protocol", { protocolVersion: 2 }), timeout])
      } catch {
        // The server refused, died, or never answered; v1 framing still works.
      } finally {
        clearTimeout(timer)
      }
    }
    this.resolveReady?.()
    this.resolveReady = null
    this.rejectReady = null
  }

  /** Reassembles one logical frame from its `rpc_chunk` sequence, in order. */
  private handleChunk(frame: OmpRpcFrame): void {
    const { chunkId, index, count, byteLength, data } = frame
    if (typeof chunkId !== "string" || typeof index !== "number" || typeof count !== "number" || typeof byteLength !== "number" || typeof data !== "string") {
      return
    }
    if (!this.pendingChunks) {
      if (index !== 0) return
      this.pendingChunks = { chunkId, count, byteLength, nextIndex: 0, chunks: [], receivedBytes: 0 }
    }
    const pending = this.pendingChunks
    if (pending.chunkId !== chunkId || pending.count !== count || pending.byteLength !== byteLength || pending.nextIndex !== index) {
      this.pendingChunks = null
      return
    }
    const bytes = Buffer.from(data, "base64")
    pending.chunks.push(bytes)
    pending.receivedBytes += bytes.byteLength
    pending.nextIndex += 1
    if (pending.nextIndex < pending.count) return
    this.pendingChunks = null
    this.handleLine(new TextDecoder("utf-8").decode(Buffer.concat(pending.chunks)))
  }

  private fail(error: Error): void {
    // The child is gone: mark the client closed so a later `command` rejects
    // instead of writing into a dead stdin and never settling.
    this.closed = true
    this.child = null
    this.rejectReady?.(error)
    this.resolveReady = null
    this.rejectReady = null
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
  }
}
