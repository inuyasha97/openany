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

  test("rejects a command issued after the child exited", async () => {
    const fake = createFakeChild()
    const rpc = client(fake)
    const started = rpc.start()
    fake.emit(JSON.stringify({ type: "ready" }))
    await started

    fake.exit(0)
    await expect(rpc.command("get_state")).rejects.toThrow("omp rpc client is closed")
  })

  test("rejects a command issued after dispose", async () => {
    const fake = createFakeChild()
    const rpc = client(fake)
    const started = rpc.start()
    fake.emit(JSON.stringify({ type: "ready" }))
    await started

    await rpc.dispose()
    await expect(rpc.command("get_state")).rejects.toThrow("omp rpc client is closed")
  })

  test("writes an outbound frame without registering a pending command", async () => {
    const fake = createFakeChild()
    const rpc = client(fake)
    const started = rpc.start()
    fake.emit(JSON.stringify({ type: "ready" }))
    await started

    rpc.send({ type: "extension_ui_response", id: "ui_1", confirmed: true })
    expect(JSON.parse(fake.written[0] ?? "{}")).toEqual({ type: "extension_ui_response", id: "ui_1", confirmed: true })
  })

  test("negotiates protocol v2 when the server advertises it", async () => {
    const fake = createFakeChild()
    const rpc = client(fake)
    const started = rpc.start()
    fake.emit(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2] }))
    await Promise.resolve()

    const negotiate = JSON.parse(fake.written[0] ?? "{}") as { id: string; type: string; protocolVersion: number }
    expect(negotiate).toMatchObject({ type: "negotiate_protocol", protocolVersion: 2 })
    fake.emit(JSON.stringify({ id: negotiate.id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } }))
    await started
  })

  test("stays on protocol v1 when the server does not advertise v2", async () => {
    const fake = createFakeChild()
    const rpc = client(fake)
    const started = rpc.start()
    fake.emit(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }))
    await started
    expect(fake.written).toEqual([])
  })

  test("reassembles a chunked logical frame", async () => {
    const fake = createFakeChild()
    const rpc = client(fake)
    const started = rpc.start()
    fake.emit(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2] }))
    await Promise.resolve()
    const negotiate = JSON.parse(fake.written[0] ?? "{}") as { id: string }
    fake.emit(JSON.stringify({ id: negotiate.id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } }))
    await started

    const pending = rpc.command<{ sessionId: string }>("get_state")
    const id = (JSON.parse(fake.written.at(-1) ?? "{}") as { id: string }).id
    const json = JSON.stringify({ id, type: "response", command: "get_state", success: true, data: { sessionId: "ses_chunked" } })
    const bytes = Buffer.from(json, "utf8")
    const half = Math.ceil(bytes.length / 2)
    ;[bytes.subarray(0, half), bytes.subarray(half)].forEach((part, index) => {
      fake.emit(JSON.stringify({ type: "rpc_chunk", chunkId: "c1", index, count: 2, byteLength: bytes.length, data: part.toString("base64") }))
    })

    expect(await pending).toEqual({ sessionId: "ses_chunked" })
  })
})
