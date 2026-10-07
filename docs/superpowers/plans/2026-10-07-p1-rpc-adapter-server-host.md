# Phase 1: OMP RPC adapter + server host — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the OMP SDK host with an RPC host so the OMP runtime loads under both Bun (web) and Node (electron), without changing the projected event vocabulary the server already consumes.

**Architecture:** `packages/omp-adapter` gains `rpc-client.ts` (spawns `omp --mode rpc`, JSONL request/response + event stream), `session-store.ts` (reads/​writes OMP's JSONL session files for list/delete/move), and `rpc-host.ts` (an `OmpHost` implementation using both). The existing `OmpRuntime`, projector and message mapping are kept. The server host (`omp-runtime-host.js`) is unchanged in shape; only the Bun guard and env flags in `index.js` are removed.

**Tech Stack:** TypeScript (Bun for the adapter package), Node `child_process`, Zod + Express (server), `bun:test` (adapter), Vitest (server).

**Spec:** `docs/superpowers/specs/2026-10-07-omp-only-runtime-design.md`

## Global Constraints

- Pinned OMP version: **18.1.11**. RPC docs describe 18.x; verify each command against the pinned binary while implementing.
- Do not modify `../opencode`.
- The adapter must run under **Bun and Node** — no `bun:*` imports, no OMP SDK import.
- Adapter tests use `bun:test`; server tests use `vitest`.
- Session store root default: `~/.omp/agent/sessions`; project directory names are implementation details — discover files, never construct them.
- Event vocabulary is unchanged: the projector consumes the same event `type`s RPC emits.

## File Structure

- `packages/omp-adapter/src/rpc-client.ts` — create. Spawn + JSONL framing + request correlation + event fan-out.
- `packages/omp-adapter/src/rpc-client.test.ts` — create. Fake child process.
- `packages/omp-adapter/src/session-store.ts` — create. Discover/parse/delete/move OMP JSONL sessions.
- `packages/omp-adapter/src/session-store.test.ts` — create. Temp-dir fixtures.
- `packages/omp-adapter/src/rpc-host.ts` — create. `OmpHost` over `OmpRpcClient` + session store.
- `packages/omp-adapter/src/rpc-host.test.ts` — create. Fake RPC client.
- `packages/omp-adapter/src/runtime.ts` — modify. `OmpSessionHandle.messages` becomes async.
- `packages/omp-adapter/src/runtime.test.ts` — modify. Async `messages`.
- `packages/omp-adapter/src/index.ts` — modify. Export `rpc-host` instead of `sdk-host`.
- `packages/omp-adapter/src/sdk-host.ts` — delete.
- `packages/web/server/lib/agents/index.js` — modify. Drop flags/adaptersRunnable; always enabled.
- `packages/web/server/lib/agents/index.test.js` — modify. New expectations.
- `packages/web/server/lib/agents/index.js` server wiring in `packages/web/server/index.js` — modify. Drop `isSettingEnabled`.

---

### Task 1: RPC client — spawn, ready handshake, request/response correlation

**Files:**
- Create: `packages/omp-adapter/src/rpc-client.ts`
- Test: `packages/omp-adapter/src/rpc-client.test.ts`

**Interfaces:**
- Produces:
  - `type OmpRpcChild` — minimal child surface (`stdout.on`, `stdin.write/end`, `on("exit"|"error")`, `kill`).
  - `type OmpRpcSpawn = (command: string, args: string[], options: { cwd?: string; env?: Record<string, string | undefined> }) => OmpRpcChild`.
  - `type OmpRpcFrame = { type: string; id?: string; [key: string]: unknown }`.
  - `class OmpRpcClient` with `constructor(options: OmpRpcOptions)`, `start(): Promise<void>`, `command<T>(type: string, fields?): Promise<T>`, `onEvent(listener): () => void`, `dispose(): Promise<void>`.
  - `class OmpRpcError extends Error` with `readonly command: string`.

- [ ] **Step 1: Write the failing test**

Create `packages/omp-adapter/src/rpc-client.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { OmpRpcClient, OmpRpcError, type OmpRpcChild } from "./rpc-client"

const createFakeChild = () => {
  const stdoutListeners: Array<(chunk: string | Uint8Array) => void> = []
  const exitListeners: Array<(code: unknown) => void> = []
  const errorListeners: Array<(error: unknown) => void> = []
  const written: string[] = []
  const child: OmpRpcChild = {
    stdout: { on: (_event, listener) => stdoutListeners.push(listener) },
    stderr: { on: () => {} },
    stdin: { write: (chunk) => written.push(chunk), end: () => {} },
    on: (event, listener) => {
      if (event === "exit") exitListeners.push(listener)
      else errorListeners.push(listener)
    },
    kill: () => {},
  }
  const emit = (line: string) => {
    for (const listener of stdoutListeners) listener(`${line}\n`)
  }
  return { child, written, emit, exit: (code: unknown) => { for (const l of exitListeners) l(code) } }
}

const client = (fake: ReturnType<typeof createFakeChild>) =>
  new OmpRpcClient({ command: "omp", spawn: () => fake.child })

describe("OmpRpcClient", () => {
  test("starts when the ready frame arrives", async () => {
    const fake = createFakeChild()
    const rpc = client(fake)
    const started = rpc.start()
    fake.emit(JSON.stringify({ type: "ready", protocolVersion: 1 }))
    await started
  })

  test("correlates a command response by id", async () => {
    const fake = createFakeChild()
    const rpc = client(fake)
    const started = rpc.start()
    fake.emit(JSON.stringify({ type: "ready" }))
    await started

    const pending = rpc.command<{ sessionId: string }>("get_state")
    expect(JSON.parse(fake.written[0] ?? "{}")).toMatchObject({ type: "get_state" })
    const id = (JSON.parse(fake.written[0] ?? "{}") as { id: string }).id
    fake.emit(JSON.stringify({ id, type: "response", command: "get_state", success: true, data: { sessionId: "ses_1" } }))
    expect(await pending).toEqual({ sessionId: "ses_1" })
  })

  test("rejects a failed command with OmpRpcError", async () => {
    const fake = createFakeChild()
    const rpc = client(fake)
    const started = rpc.start()
    fake.emit(JSON.stringify({ type: "ready" }))
    await started

    const pending = rpc.command("set_model", { provider: "x", modelId: "y" })
    const id = (JSON.parse(fake.written[0] ?? "{}") as { id: string }).id
    fake.emit(JSON.stringify({ id, type: "response", command: "set_model", success: false, error: "Model not found" }))
    await expect(pending).rejects.toBeInstanceOf(OmpRpcError)
  })

  test("rejects pending commands when the child exits", async () => {
    const fake = createFakeChild()
    const rpc = client(fake)
    const started = rpc.start()
    fake.emit(JSON.stringify({ type: "ready" }))
    await started

    const pending = rpc.command("prompt", { message: "hi" })
    fake.exit(1)
    await expect(pending).rejects.toThrow("omp rpc exited with code 1")
  })

  test("ignores malformed lines", async () => {
    const fake = createFakeChild()
    const rpc = client(fake)
    const started = rpc.start()
    fake.emit("not json")
    fake.emit(JSON.stringify({ type: "ready" }))
    await started
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/rpc-client.test.ts` (workdir `packages/omp-adapter`)
Expected: FAIL — cannot resolve `./rpc-client`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/omp-adapter/src/rpc-client.ts`:

```ts
/**
 * Minimal JSONL client for `omp --mode rpc`.
 *
 * `OmpRpcChild` is the child-process seam, so the client is testable with a
 * fake and the real Node spawn lives in `rpc-host.ts`. Commands correlate by
 * `id`; every other stdout frame is an event forwarded to listeners.
 */

export type OmpRpcChild = {
  stdout: { on: (event: "data", listener: (chunk: string | Uint8Array) => void) => unknown }
  stderr: { on: (event: "data", listener: (chunk: string | Uint8Array) => void) => unknown }
  stdin: { write: (chunk: string) => unknown; end?: () => void }
  on: (event: "exit" | "error", listener: (value: never) => void) => unknown
  kill: (signal?: string) => unknown
}

export type OmpRpcSpawn = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> },
) => OmpRpcChild

export type OmpRpcFrame = { type: string; id?: string; [key: string]: unknown }

export type OmpRpcOptions = {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string | undefined>
  spawn: OmpRpcSpawn
}

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

  constructor(private readonly options: OmpRpcOptions) {}

  start(): Promise<void> {
    this.ready ??= new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    if (!this.child) {
      const args = this.options.args ?? ["--mode", "rpc"]
      const child = this.options.spawn(this.options.command, args, { cwd: this.options.cwd, env: this.options.env })
      this.child = child
      child.stdout.on("data", (chunk) => this.ingest(chunk))
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

  async dispose(): Promise<void> {
    this.closed = true
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
    this.buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
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
    if (frame.type === "ready") {
      this.resolveReady?.()
      this.resolveReady = null
      this.rejectReady = null
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

  private fail(error: Error): void {
    this.rejectReady?.(error)
    this.resolveReady = null
    this.rejectReady = null
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/rpc-client.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/omp-adapter/src/rpc-client.ts packages/omp-adapter/src/rpc-client.test.ts
git commit -m "feat(omp): add JSONL rpc client"
```

---

### Task 2: RPC client — event stream and dispose

**Files:**
- Modify: `packages/omp-adapter/src/rpc-client.ts`
- Test: `packages/omp-adapter/src/rpc-client.test.ts`

**Interfaces:**
- Consumes: `OmpRpcClient` from Task 1.
- Produces: `onEvent` forwards non-response frames and unsubscribes; `dispose` ends stdin and stops forwarding.

- [ ] **Step 1: Write the failing test**

Append to `packages/omp-adapter/src/rpc-client.test.ts`:

```ts
describe("OmpRpcClient events", () => {
  test("forwards non-response frames to event listeners", async () => {
    const fake = createFakeChild()
    const rpc = client(fake)
    const started = rpc.start()
    fake.emit(JSON.stringify({ type: "ready" }))
    await started

    const seen: unknown[] = []
    const unsubscribe = rpc.onEvent((frame) => seen.push(frame))
    fake.emit(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } }))
    unsubscribe()
    fake.emit(JSON.stringify({ type: "agent_end", isTerminal: true }))
    expect(seen).toEqual([{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } }])
  })

  test("stops forwarding after dispose", async () => {
    const fake = createFakeChild()
    const rpc = client(fake)
    const started = rpc.start()
    fake.emit(JSON.stringify({ type: "ready" }))
    await started

    const seen: unknown[] = []
    rpc.onEvent((frame) => seen.push(frame))
    await rpc.dispose()
    fake.emit(JSON.stringify({ type: "agent_end", isTerminal: true }))
    expect(seen).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/rpc-client.test.ts`
Expected: FAIL — `onEvent`/`dispose` behavior missing (the "stops forwarding" test fails because `handleLine` still iterates listeners after `dispose` cleared them only if `dispose` did not run; both tests should pass already for forwarding — confirm the second fails).

- [ ] **Step 3: Run the full client test to confirm current state**

Run: `bun test src/rpc-client.test.ts`
Expected: If both pass, no code change is needed; the Task 1 implementation already satisfies them. If the dispose test fails, continue to Step 4.

- [ ] **Step 4: Adjust `dispose` if needed**

If Step 3 shows the dispose test failing, ensure `dispose()` clears listeners before returning (already present in Task 1). No other change.

- [ ] **Step 5: Commit (only if Step 4 changed code)**

```bash
git add packages/omp-adapter/src/rpc-client.ts packages/omp-adapter/src/rpc-client.test.ts
git commit -m "test(omp): cover rpc event stream and dispose"
```

---

### Task 3: Session store — parse and list OMP sessions

**Files:**
- Create: `packages/omp-adapter/src/session-store.ts`
- Test: `packages/omp-adapter/src/session-store.test.ts`

**Interfaces:**
- Consumes: `OmpSessionInfo` from `./runtime`.
- Produces:
  - `type OmpSessionStore` with `list(): Promise<OmpSessionInfo[]>`, `delete(sessionPath: string): Promise<void>`, `move(sessionPath: string, toDirectory: string): Promise<OmpSessionInfo>`.
  - `createSessionStore(options?: { root?: string; fs?: OmpSessionFs }): OmpSessionStore`.
  - `defaultSessionsRoot(): string` — `~/.omp/agent/sessions`.
  - `parseSessionFile(text: string): { id: string; cwd: string; title: string } | null`.

- [ ] **Step 1: Write the failing test**

Create `packages/omp-adapter/src/session-store.test.ts`:

```ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createSessionStore, parseSessionFile } from "./session-store"

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sessions-"))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const writeSession = (project: string, file: string, lines: string[]) => {
  fs.mkdirSync(path.join(root, project), { recursive: true })
  const full = path.join(root, project, file)
  fs.writeFileSync(full, `${lines.join("\n")}\n`)
  return full
}

describe("parseSessionFile", () => {
  test("reads the session header and overlays the title record", () => {
    const text = [
      JSON.stringify({ type: "title", v: 1, title: "refactor importer", source: "user", updatedAt: "2026-05-14T10:14:22.000Z", pad: " " }),
      JSON.stringify({ type: "session", version: 3, id: "ses_1", timestamp: "2026-05-14T10:12:03.000Z", cwd: "/repo/api", title: "old" }),
    ].join("\n")
    expect(parseSessionFile(text)).toEqual({ id: "ses_1", cwd: "/repo/api", title: "refactor importer" })
  })

  test("falls back to the header title when there is no title record", () => {
    const text = JSON.stringify({ type: "session", version: 3, id: "ses_2", timestamp: "2026-05-14T10:12:03.000Z", cwd: "/repo/web", title: "from header" })
    expect(parseSessionFile(text)).toEqual({ id: "ses_2", cwd: "/repo/web", title: "from header" })
  })

  test("returns null for a file without a session header", () => {
    expect(parseSessionFile("")).toBeNull()
  })
})

describe("createSessionStore.list", () => {
  test("lists sessions discovered under the root", async () => {
    writeSession("repo-api", "20260514101203_ses_1.jsonl", [
      JSON.stringify({ type: "title", v: 1, title: "importer", source: "user", updatedAt: "t", pad: " " }),
      JSON.stringify({ type: "session", version: 3, id: "ses_1", timestamp: "2026-05-14T10:12:03.000Z", cwd: "/repo/api", title: "importer" }),
    ])
    writeSession("repo-web", "20260514101204_ses_2.jsonl", [
      JSON.stringify({ type: "session", version: 3, id: "ses_2", timestamp: "2026-05-14T10:12:04.000Z", cwd: "/repo/web", title: "web" }),
    ])
    const store = createSessionStore({ root })
    const sessions = await store.list()
    expect(sessions.map((s) => s.id).sort()).toEqual(["ses_1", "ses_2"])
    expect(sessions.find((s) => s.id === "ses_1")).toMatchObject({ cwd: "/repo/api", title: "importer" })
  })

  test("skips malformed files instead of failing the listing", async () => {
    writeSession("repo-api", "broken.jsonl", ["not json"])
    const store = createSessionStore({ root })
    expect(await store.list()).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/session-store.test.ts`
Expected: FAIL — cannot resolve `./session-store`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/omp-adapter/src/session-store.ts`:

```ts
/**
 * OMP session store reader.
 *
 * OMP persists each session as JSONL under `~/.omp/agent/sessions`. The
 * optional first physical record is a fixed-width `title`; the first logical
 * record is the `session` header. Project directory names are implementation
 * details, so files are discovered by walking the root rather than
 * constructed from an id.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { OmpSessionInfo } from "./runtime"

export type OmpSessionFs = {
  readdir: (dir: string, options: { recursive: true }) => string[]
  readFile: (file: string, encoding: "utf8") => string
  rm: (file: string, options: { force: true }) => void
  mkdir: (dir: string, options: { recursive: true }) => void
  rename: (from: string, to: string) => void
}

export const defaultSessionsRoot = (): string => path.join(os.homedir(), ".omp", "agent", "sessions")

export const parseSessionFile = (text: string): { id: string; cwd: string; title: string } | null => {
  let header: { id?: unknown; cwd?: unknown; title?: unknown } | null = null
  let title = ""
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let record: { type?: unknown; id?: unknown; cwd?: unknown; title?: unknown; v?: unknown }
    try {
      record = JSON.parse(trimmed) as typeof record
    } catch {
      continue
    }
    if (record.type === "title" && record.v === 1) {
      if (typeof record.title === "string") title = record.title
      continue
    }
    if (record.type === "session") {
      header = record
      break
    }
  }
  if (!header || typeof header.id !== "string" || typeof header.cwd !== "string") return null
  const headerTitle = typeof header.title === "string" ? header.title : ""
  return { id: header.id, cwd: header.cwd, title: title || headerTitle }
}

export type OmpSessionStore = {
  list: () => Promise<OmpSessionInfo[]>
  delete: (sessionPath: string) => Promise<void>
  move: (sessionPath: string, toDirectory: string) => Promise<OmpSessionInfo>
}

const defaultFs: OmpSessionFs = {
  readdir: (dir, options) => fs.readdirSync(dir, options),
  readFile: (file, encoding) => fs.readFileSync(file, encoding),
  rm: (file, options) => fs.rmSync(file, options),
  mkdir: (dir, options) => {
    fs.mkdirSync(dir, options)
  },
  rename: (from, to) => fs.renameSync(from, to),
}

export const createSessionStore = (options: { root?: string; fs?: OmpSessionFs } = {}): OmpSessionStore => {
  const root = options.root ?? defaultSessionsRoot()
  const io = options.fs ?? defaultFs

  const discover = (): string[] => {
    try {
      return io
        .readdir(root, { recursive: true })
        .filter((entry) => entry.endsWith(".jsonl"))
        .map((entry) => path.join(root, entry))
    } catch {
      return []
    }
  }

  return {
    async list() {
      const sessions: OmpSessionInfo[] = []
      for (const file of discover()) {
        try {
          const parsed = parseSessionFile(io.readFile(file, "utf8"))
          if (parsed) sessions.push({ id: parsed.id, sessionPath: file, cwd: parsed.cwd, title: parsed.title })
        } catch {
          // a single unreadable file must not drop the rest
        }
      }
      return sessions
    },

    async delete(sessionPath) {
      io.rm(sessionPath, { force: true })
    },

    async move(sessionPath, toDirectory) {
      const parsed = parseSessionFile(io.readFile(sessionPath, "utf8"))
      if (!parsed) throw new Error(`not an omp session file: ${sessionPath}`)
      const targetDir = path.join(toDirectory, ".omp-sessions")
      io.mkdir(targetDir, { recursive: true })
      const target = path.join(targetDir, path.basename(sessionPath))
      io.rename(sessionPath, target)
      return { id: parsed.id, sessionPath: target, cwd: toDirectory, title: parsed.title }
    },
  }
}
```

> Note: the `move` target layout is a first cut. OMP's own `/move` updates the header `cwd` and relocates artifacts; tightening this is deferred to P5 (config/session phase). Marked with a `ponytail:` comment in a follow-up if kept.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/session-store.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/omp-adapter/src/session-store.ts packages/omp-adapter/src/session-store.test.ts
git commit -m "feat(omp): read list/delete/move from the omp session store"
```

---

### Task 4: Make `OmpSessionHandle.messages` async

**Files:**
- Modify: `packages/omp-adapter/src/runtime.ts`
- Modify: `packages/omp-adapter/src/runtime.test.ts`

**Interfaces:**
- Consumes: existing `OmpRuntime`.
- Produces: `OmpSessionHandle.messages: () => Promise<readonly OmpMessage[]>`; `OmpRuntime.getMessages` awaits it. `sdk-host.ts` (deleted later) is the only current implementer.

- [ ] **Step 1: Write the failing test**

In `packages/omp-adapter/src/runtime.test.ts`, change the fake handle's `messages` to async and add an assertion:

```ts
// in makeHandle: replace `messages: () => [],` with:
    messages: async () => [],

// add a test inside describe("OmpRuntime"):
  test("awaits async handle messages", async () => {
    const { host, handles } = makeHost([info("ses_a")])
    const runtime = new OmpRuntime(host)
    await runtime.getSession("ses_a")
    expect(await runtime.getMessages("ses_a")).toEqual([])
    expect(typeof handles.get("ses_a")?.messages).toBe("function")
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/runtime.test.ts`
Expected: FAIL/type error — the `messages` return type is still sync and `await` on a non-promise is allowed, so instead expect a TypeScript mismatch when the fake returns a Promise against a sync signature. Run `bun run type-check` to confirm the error.

- [ ] **Step 3: Update the interface and call sites**

In `packages/omp-adapter/src/runtime.ts`:

```ts
export type OmpSessionHandle = {
  id: string
  prompt: (text: string) => Promise<boolean>
  abort: () => Promise<void>
  subscribe: (listener: (event: OmpEvent) => void) => () => void
  dispose: () => Promise<void>
  sessionFile: string | undefined
  /** The session's current message history, oldest first. */
  messages: () => Promise<readonly OmpMessage[]>
}
```

And `getMessages`:

```ts
  async getMessages(id: string): Promise<readonly OmpMessage[]> {
    return (await this.getSession(id)).messages()
  }
```

- [ ] **Step 4: Run tests and type-check**

Run: `bun test src/runtime.test.ts && bun run type-check` (workdir `packages/omp-adapter`)
Expected: PASS + no type errors. (`sdk-host.ts` still implements sync `messages`; if type-check flags it, proceed to Task 5 which deletes it.)

- [ ] **Step 5: Commit**

```bash
git add packages/omp-adapter/src/runtime.ts packages/omp-adapter/src/runtime.test.ts
git commit -m "refactor(omp): make session messages async"
```

---

### Task 5: RPC host — `OmpHost` over the RPC client and session store

**Files:**
- Create: `packages/omp-adapter/src/rpc-host.ts`
- Create: `packages/omp-adapter/src/rpc-host.test.ts`
- Modify: `packages/omp-adapter/src/index.ts`
- Delete: `packages/omp-adapter/src/sdk-host.ts`

**Interfaces:**
- Consumes: `OmpRpcClient`, `OmpRpcSpawn`, `OmpRpcChild` (Task 1), `OmpSessionStore`/`createSessionStore`/`defaultSessionsRoot` (Task 3), `OmpHost`/`OmpSessionHandle`/`OmpEvent`/`OmpMessage` (`runtime.ts`).
- Produces: `createOmpHost(options?: { command?; args?; env?; spawn?; store? }): OmpHost`. Default `spawn` uses `node:child_process`; default `command` is `OPENCHAMBER_OMP_PATH ?? OMP_BINARY ?? "omp"`.

- [ ] **Step 1: Write the failing test**

Create `packages/omp-adapter/src/rpc-host.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import type { OmpRpcChild, OmpRpcClient } from "./rpc-client"
import { createOmpHost } from "./rpc-host"

const fakeChild = () => {
  const stdoutListeners: Array<(chunk: string | Uint8Array) => void> = []
  const written: string[] = []
  const child: OmpRpcChild = {
    stdout: { on: (_e, l) => stdoutListeners.push(l) },
    stderr: { on: () => {} },
    stdin: { write: (chunk) => written.push(chunk), end: () => {} },
    on: () => {},
    kill: () => {},
  }
  const emit = (line: string) => {
    for (const l of stdoutListeners) l(`${line}\n`)
  }
  return { child, written, emit }
}

const respondTo = (fake: ReturnType<typeof fakeChild>) => {
  // Answer every command with a ready frame and a get_state response.
  const calls = fake.written
  return calls
}

describe("createOmpHost", () => {
  test("opens a session, fans out events and answers prompts", async () => {
    const fake = fakeChild()
    const store = { list: async () => [], delete: async () => {}, move: async () => { throw new Error("unused") } }
    const host = createOmpHost({ spawn: () => fake.child, store })
    const handlePromise = host.openSession({ cwd: "/repo" })
    fake.emit(JSON.stringify({ type: "ready" }))
    // openSession awaits get_state after ready
    await Promise.resolve()
    const stateReq = JSON.parse(fake.written.at(-1) ?? "{}") as { id: string; type: string }
    expect(stateReq.type).toBe("get_state")
    fake.emit(JSON.stringify({ id: stateReq.id, type: "response", command: "get_state", success: true, data: { sessionId: "ses_1", sessionFile: "/s/ses_1.jsonl" } }))
    const handle = await handlePromise
    expect(handle.id).toBe("ses_1")

    const seen: unknown[] = []
    const unsubscribe = handle.subscribe((event) => seen.push(event))
    fake.emit(JSON.stringify({ type: "turn_start" }))
    unsubscribe()
    expect(seen).toEqual([{ type: "turn_start" }])

    const prompted = handle.prompt("hello")
    const promptReq = JSON.parse(fake.written.at(-1) ?? "{}") as { id: string; type: string }
    expect(promptReq.type).toBe("prompt")
    fake.emit(JSON.stringify({ id: promptReq.id, type: "response", command: "prompt", success: true, data: { agentInvoked: true } }))
    expect(await prompted).toBe(true)

    await handle.dispose()
  })

  test("lists sessions through the store", async () => {
    const store = {
      list: async () => [{ id: "ses_1", sessionPath: "/s/ses_1.jsonl", cwd: "/repo", title: "t" }],
      delete: async () => {},
      move: async () => { throw new Error("unused") },
    }
    const host = createOmpHost({ spawn: () => fakeChild().child, store })
    expect(await host.listSessions()).toEqual([{ id: "ses_1", sessionPath: "/s/ses_1.jsonl", cwd: "/repo", title: "t" }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/rpc-host.test.ts`
Expected: FAIL — cannot resolve `./rpc-host`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/omp-adapter/src/rpc-host.ts`:

```ts
/**
 * The real OMP host: `omp --mode rpc` behind `OmpRuntime`.
 *
 * One RPC process per open session. `openSession` spawns, waits for `ready`,
 * optionally switches onto an on-disk session, then reads `get_state` for the
 * live id and session file. Events are forwarded verbatim; the caller owns
 * the projector.
 */

import { spawn as nodeSpawn } from "node:child_process"
import { OmpRpcClient, type OmpRpcChild, type OmpRpcSpawn } from "./rpc-client"
import { createSessionStore, type OmpSessionStore } from "./session-store"
import type { OmpEvent, OmpHost, OmpMessage, OmpSessionHandle } from "./runtime"

export type OmpHostOptions = {
  command?: string
  args?: string[]
  env?: Record<string, string | undefined>
  spawn?: OmpRpcSpawn
  store?: OmpSessionStore
}

const defaultSpawn: OmpRpcSpawn = (command, args, options) => {
  const child = nodeSpawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ["pipe", "pipe", "pipe"] })
  return child as unknown as OmpRpcChild
}

const resolveCommand = (options: OmpHostOptions): string =>
  options.command ?? process.env.OPENCHAMBER_OMP_PATH ?? process.env.OMP_BINARY ?? "omp"

export const createOmpHost = (options: OmpHostOptions = {}): OmpHost => {
  const command = resolveCommand(options)
  const args = options.args ?? ["--mode", "rpc"]
  const spawn = options.spawn ?? defaultSpawn
  const store = options.store ?? createSessionStore()

  return {
    listSessions: () => store.list(),

    openSession: async (input) => {
      const client = new OmpRpcClient({ command, args, cwd: input.cwd, env: options.env, spawn })
      await client.start()
      if (input.sessionPath) {
        await client.command("switch_session", { sessionPath: input.sessionPath })
      }
      const state = await client.command<{ sessionId: string; sessionFile?: string }>("get_state")
      const listeners = new Set<(event: OmpEvent) => void>()
      client.onEvent((frame) => {
        for (const listener of listeners) listener(frame as OmpEvent)
      })
      const handle: OmpSessionHandle = {
        id: state.sessionId,
        prompt: async (text) => {
          const result = await client.command<{ agentInvoked?: boolean } | undefined>("prompt", { message: text })
          return result?.agentInvoked !== false
        },
        abort: async () => {
          await client.command("abort")
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        dispose: () => client.dispose(),
        sessionFile: state.sessionFile,
        messages: async () => {
          const result = await client.command<{ messages: OmpMessage[] }>("get_messages")
          return result.messages
        },
      }
      return handle
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/rpc-host.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Swap the exports and delete the SDK host**

In `packages/omp-adapter/src/index.ts`:
- Remove: `export { createOmpHost } from "./sdk-host"`.
- Add: `export { createOmpHost } from "./rpc-host"` and `export type { OmpHostOptions } from "./rpc-host"`.

Delete `packages/omp-adapter/src/sdk-host.ts`.

Remove the `@oh-my-pi/pi-coding-agent` dependency from `packages/omp-adapter/package.json` (its only importer was `sdk-host.ts`).

- [ ] **Step 6: Verify the package**

Run: `bun test && bun run type-check` (workdir `packages/omp-adapter`)
Expected: all adapter tests pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/omp-adapter/src/rpc-host.ts packages/omp-adapter/src/rpc-host.test.ts packages/omp-adapter/src/index.ts packages/omp-adapter/package.json
git rm packages/omp-adapter/src/sdk-host.ts
git commit -m "feat(omp): host omp over rpc, drop the sdk host"
```

---

### Task 6: Server — always-on OMP runtime (remove Bun guard and flags)

**Files:**
- Modify: `packages/web/server/lib/agents/index.js`
- Modify: `packages/web/server/lib/agents/index.test.js`
- Modify: `packages/web/server/index.js` (the `installOmpAgentRuntime` call site)

**Interfaces:**
- Consumes: `createOmpHost` (Task 5).
- Produces: `installOmpAgentRuntime({ app, broadcast, adapter? })` — no `env`, `isSettingEnabled`, or `adaptersRunnable`. Routes always serve; `createOmpHost()` is called once on first request.

- [ ] **Step 1: Write the failing test**

Replace `packages/web/server/lib/agents/index.test.js` with:

```js
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { installOmpAgentRuntime } from './index.js';

const createAdapter = () => {
  let subscriber = null;
  const runtime = {
    async listSessions() {
      return [];
    },
    async createSession() {
      return { id: 'ses_new', sessionFile: '/s/new.json' };
    },
    async prompt() {
      return true;
    },
    async abort() {},
    async getMessages() {
      return [];
    },
    async dispose() {},
    subscribe(listener) {
      subscriber = listener;
      return () => {
        subscriber = null;
      };
    },
  };
  return {
    OmpRuntime: class {
      constructor() {
        return runtime;
      }
    },
    createOmpHost: vi.fn(() => ({})),
    createOmpEventProjector: vi.fn(() => ({ project: () => [] })),
  };
};

describe('installOmpAgentRuntime', () => {
  it('registers routes and serves them with no flag', async () => {
    const app = express();
    await installOmpAgentRuntime({ app, broadcast: () => {}, adapter: createAdapter() });

    const response = await request(app).get('/api/agents/omp/sessions');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ sessions: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run server/lib/agents/index.test.js` (workdir `packages/web`)
Expected: FAIL — the current implementation requires a flag/setting, so the route answers 404.

- [ ] **Step 3: Simplify the installer**

Replace `packages/web/server/lib/agents/index.js` with:

```js
/**
 * Fork-owned OMP agent runtime.
 *
 * OpenCode is gone in this fork; OMP is the only runtime. The routes are
 * registered once and always served. The adapter loads lazily on the first
 * request. The host is a thin controller so shutdown can dispose it.
 */

import { createOmpRuntimeHost } from './omp-runtime-host.js';
import { registerOmpRoutes } from './omp-routes.js';

const loadOmpAdapter = () => import('../../../../omp-adapter/src/index.ts');

const createHostController = (loadHost) => {
  let hostPromise = null;
  return {
    getHost: () => {
      hostPromise ??= Promise.resolve().then(loadHost);
      return hostPromise;
    },
    async dispose() {
      const host = await Promise.resolve(hostPromise).catch(() => null);
      await host?.dispose?.();
    },
  };
};

export const installOmpAgentRuntime = async ({ app, broadcast, adapter } = {}) => {
  const controller = createHostController(async () => {
    const resolved = adapter ?? (await loadOmpAdapter());
    return createOmpRuntimeHost({ adapter: resolved, broadcast });
  });
  registerOmpRoutes(app, { getHost: controller.getHost, isEnabled: async () => true });
  return controller;
};
```

- [ ] **Step 4: Update the server wiring**

In `packages/web/server/index.js`, change the `installOmpAgentRuntime({...})` call to drop `isSettingEnabled`:

```js
  ompAgentRuntime = await installOmpAgentRuntime({
    app,
    broadcast: broadcastOpenChamberUiEvent,
  });
```

Leave the ACP installer untouched for now (P3 removes it with the rest of the non-OpenCode runtimes if not wanted; it does not block this task).

- [ ] **Step 5: Run tests to verify they pass**

Run: `bunx vitest run server/lib/agents` (workdir `packages/web`)
Expected: PASS — `index.test.js`, `omp-routes.test.js`, `omp-runtime-host.test.js`.

- [ ] **Step 6: Commit**

```bash
git add packages/web/server/lib/agents/index.js packages/web/server/lib/agents/index.test.js packages/web/server/index.js
git commit -m "feat(server): serve the omp runtime unconditionally"
```

---

### Task 7: Manual smoke test on web

**Files:** none (verification task).

- [ ] **Step 1: Confirm `omp` is reachable**

Run: `omp --version`
Expected: prints a version. If missing, install it (`curl -fsSL https://omp.sh/install | sh`) or set `OPENCHAMBER_OMP_PATH`.

- [ ] **Step 2: Start the web server**

Run: `bun run --cwd packages/web dev:server`
Expected: server boots without touching OpenCode for OMP routes.

- [ ] **Step 3: Exercise the OMP routes**

Run:
```bash
curl -s localhost:3001/api/agents/omp/status
curl -s -X POST localhost:3001/api/agents/omp/sessions -H 'content-type: application/json' -d '{"cwd":"'"$PWD"'"}'
```
Expected: `{"enabled":true}` and a created session id.

- [ ] **Step 4: Observe an event frame**

Send a prompt through the created session id and confirm an `openchamber:omp` frame arrives on the UI control stream (browser devtools or the SSE/WS frame log). Expected: projected `SyncEvent`s, not raw RPC frames.

- [ ] **Step 5: Report**

Record what was verified (status, create, prompt, frame) and what was not (UI wiring lands in P2). No commit.

---

## Self-Review

- **Spec coverage:** P1 items "rpc-client.ts", "rpc-host.ts", "runtime.ts over RPC",
  "session-store.ts", "rework omp-runtime-host.js / omp-routes.js to drive RPC",
  and "remove the Bun guard" are covered by Tasks 1–6. `omp-config.js` and the
  MCP/provider gap fill are P5. UI client expansion is P2.
- **Placeholder scan:** no TBD/TODO in steps. Task 2 is a verification-only task
  because the Task 1 implementation may already satisfy the event/dispose
  behavior; it explicitly allows "no change needed". Task 3 `move` layout is
  flagged as a first cut with a deferred note, not a hidden gap.
- **Type consistency:** `OmpSessionHandle.messages` is async from Task 4 onward
  and Task 5's RPC host returns a Promise; the server host `getMessages` already
  awaits `runtime.getMessages`. `OmpSessionInfo`/`OmpRpcFrame`/`OmpHost` names
  match their definitions in Tasks 1, 3 and `runtime.ts`.
