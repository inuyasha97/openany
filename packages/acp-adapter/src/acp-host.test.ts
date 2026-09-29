import { describe, expect, test } from "bun:test"
import { createAcpHost, type AcpTransport } from "./acp-host"

type Fake = {
  transport: AcpTransport
  agentSend: (message: unknown) => void
  written: Array<Record<string, unknown>>
}

const createFakeTransport = (handlers: Record<string, (params: unknown) => unknown> = {}): Fake => {
  let lineHandler: ((line: string) => void) | null = null
  const written: Array<Record<string, unknown>> = []
  const transport: AcpTransport = {
    write: (line) => {
      const message = JSON.parse(line) as { id?: number; method?: string; params?: unknown }
      written.push(message as Record<string, unknown>)
      queueMicrotask(() => {
        if (message.method && message.id !== undefined) {
          const handler = handlers[message.method]
          lineHandler?.(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: handler ? handler(message.params) : {} }))
        }
      })
    },
    onLine: (listener) => {
      lineHandler = listener
      return () => {
        lineHandler = null
      }
    },
    close: () => {
      lineHandler = null
    },
  }
  return { transport, agentSend: (message) => lineHandler?.(JSON.stringify(message)), written }
}

const createHost = (handlers?: Record<string, (params: unknown) => unknown>) => {
  const fake = createFakeTransport(handlers ?? { initialize: () => ({}), "session/new": () => ({ sessionId: "sess_1" }) })
  return { host: createAcpHost({ createTransport: () => fake.transport }), fake }
}

const update = (sessionUpdate: string, extra: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: { sessionId: "sess_1", update: { sessionUpdate, ...extra } },
})

describe("createAcpHost", () => {
  test("initializes the client, creates a session and exposes its id", async () => {
    const { host } = createHost()
    const handle = await host.openSession({ cwd: "/repo" })
    expect(handle.id).toBe("sess_1")
    expect(await host.listSessions()).toEqual([])
  })

  test("refuses to reopen a session (no session/load)", async () => {
    const { host } = createHost()
    await expect(host.openSession({ sessionId: "sess_1" })).rejects.toThrow("unknown acp session: sess_1")
  })

  test("normalizes agent message chunks and tool updates", async () => {
    const { host, fake } = createHost()
    const handle = await host.openSession({ cwd: "/repo" })
    const seen: unknown[] = []
    handle.subscribe((event) => seen.push(event))
    fake.agentSend(update("agent_message_chunk", { content: [{ type: "text", text: "he" }] }))
    fake.agentSend(update("agent_thought_chunk", { content: { type: "text", text: "why" } }))
    fake.agentSend(update("tool_call", { toolCallId: "call_1", title: "Read", kind: "read", status: "pending" }))
    fake.agentSend(update("plan", {}))
    expect(seen).toEqual([
      { type: "message_delta", role: "assistant", text: "he" },
      { type: "message_delta", role: "thought", text: "why" },
      { type: "tool_call", toolCallId: "call_1", title: "Read", kind: "read", status: "pending" },
    ])
  })

  test("prompts and reports the turn's stop reason", async () => {
    const { host, fake } = createHost({ initialize: () => ({}), "session/new": () => ({ sessionId: "sess_1" }), "session/prompt": () => ({ stopReason: "end_turn" }) })
    const handle = await host.openSession({ cwd: "/repo" })
    const seen: unknown[] = []
    handle.subscribe((event) => seen.push(event))
    expect(await handle.prompt("hi")).toBe(true)
    // The turn ends asynchronously, when the prompt response lands.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fake.written.some((message) => message.method === "session/prompt")).toBe(true)
    expect(seen).toEqual([{ type: "turn_ended", stopReason: "end_turn" }])
  })

  test("answers a permission request with the chosen option", async () => {
    const { host, fake } = createHost()
    const handle = await host.openSession({ cwd: "/repo" })
    const seen: unknown[] = []
    handle.subscribe((event) => seen.push(event))
    fake.agentSend({
      jsonrpc: "2.0",
      id: 5,
      method: "session/request_permission",
      params: { sessionId: "sess_1", toolCall: { toolCallId: "call_1" }, options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }] },
    })
    expect(seen).toEqual([{ type: "permission_request", requestId: "5", toolCallId: "call_1", options: [{ optionId: "allow-once", kind: "allow_once", name: "Allow once" }] }])
    expect(await handle.replyPermission({ requestId: "5", optionId: "allow-once" })).toBe(true)
    expect(fake.written).toContainEqual({ jsonrpc: "2.0", id: 5, result: { outcome: { outcome: "selected", optionId: "allow-once" } } })
    expect(await handle.replyPermission({ requestId: "5", optionId: "allow-once" })).toBe(false)
  })

  test("refuses the optional client methods it does not implement", async () => {
    const { host, fake } = createHost()
    await host.openSession({ cwd: "/repo" })
    fake.agentSend({ jsonrpc: "2.0", id: 7, method: "fs/read_text_file", params: { path: "/etc/passwd" } })
    expect(fake.written).toContainEqual({ jsonrpc: "2.0", id: 7, error: { code: -32601, message: "Unsupported client method: fs/read_text_file" } })
  })
})
