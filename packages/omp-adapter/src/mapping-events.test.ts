import { describe, expect, test } from "bun:test"
import type { SyncEvent } from "@openchamber/ui/lib/agent/events"
import { createOmpEventProjector } from "./mapping-events"
import { ompMessageId, ompPartIds, projectOmpHistory } from "./mapping-messages"
import type { OmpAssistantMessage, OmpEvent, OmpUserMessage } from "./model"

const NOW = 1_000
const STAMP = 1_700_000_000_000
const projector = () => createOmpEventProjector({ now: () => NOW })

const user = (over: Partial<OmpUserMessage> = {}): OmpUserMessage => ({
  role: "user",
  content: "hello",
  timestamp: STAMP,
  ...over,
})

const assistant = (over: Partial<OmpAssistantMessage> = {}): OmpAssistantMessage => ({
  role: "assistant",
  content: [],
  provider: "anthropic",
  model: "claude",
  usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoningTokens: 3, cost: { total: 0.5 } },
  stopReason: "stop",
  timestamp: STAMP,
  ...over,
})

const project = (events: OmpEvent[], sessionId = "ses_a") =>
  events.flatMap((event) => projector().project(sessionId, event))

describe("OMP run boundaries", () => {
  test("agent_start marks the session busy and agent_end idles it", () => {
    const events = project([{ type: "agent_start" }, { type: "agent_end" }])
    expect(events).toEqual([
      { type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } },
      { type: "session.idle", properties: { sessionID: "ses_a" } },
    ])
  })

  test("an unmapped frame yields nothing", () => {
    expect(project([{ type: "turn_start" }, { type: "turn_end" }])).toEqual([])
  })
})

describe("OMP user messages", () => {
  test("message_start projects the record and its parts", () => {
    const message = user({ content: "hi" })
    expect(projector().project("ses_a", { type: "message_start", message })).toEqual([
      {
        type: "message.updated",
        properties: {
          info: { id: ompMessageId("ses_a", "user", STAMP), sessionID: "ses_a", role: "user", time: { created: STAMP } },
        },
      },
      {
        type: "message.parts.replaced",
        properties: {
          sessionID: "ses_a",
          messageID: ompMessageId("ses_a", "user", STAMP),
          parts: [{
            id: ompPartIds.userText(ompMessageId("ses_a", "user", STAMP)),
            sessionID: "ses_a",
            messageID: ompMessageId("ses_a", "user", STAMP),
            type: "text",
            text: "hi",
            time: { start: STAMP, end: STAMP },
          }],
        },
      },
    ])
  })

  test("image content becomes a file part with a data url", () => {
    const message = user({ content: [{ type: "image", data: "AAA", mimeType: "image/png" }] })
    const messageID = ompMessageId("ses_a", "user", STAMP)
    expect(projector().project("ses_a", { type: "message_start", message })).toEqual([
      {
        type: "message.updated",
        properties: { info: { id: messageID, sessionID: "ses_a", role: "user", time: { created: STAMP } } },
      },
      {
        type: "message.parts.replaced",
        properties: {
          sessionID: "ses_a",
          messageID,
          parts: [{ id: ompPartIds.userFile(messageID, 0), sessionID: "ses_a", messageID, type: "file", mime: "image/png", url: "data:image/png;base64,AAA" }],
        },
      },
    ])
  })
})

describe("OMP assistant messages", () => {
  test("message_start opens the assistant record", () => {
    expect(projector().project("ses_a", { type: "message_start", message: assistant() })).toEqual([
      {
        type: "message.updated",
        properties: {
          info: {
            id: ompMessageId("ses_a", "assistant", STAMP),
            sessionID: "ses_a",
            role: "assistant",
            time: { created: STAMP },
            agent: "",
            providerID: "anthropic",
            modelID: "claude",
          },
        },
      },
    ])
  })

  test("text streams through part, delta and snapshot events", () => {
    const p = projector()
    const message = assistant()
    const sid = "ses_a"
    const id = ompMessageId(sid, "assistant", STAMP)
    expect(p.project(sid, { type: "message_update", message, assistantMessageEvent: { type: "text_start", contentIndex: 0 } })).toEqual([
      { type: "message.part.updated", properties: { sessionID: sid, part: { id: ompPartIds.text(id, 0), sessionID: sid, messageID: id, type: "text", text: "", time: { start: STAMP } } } },
    ])
    expect(p.project(sid, { type: "message_update", message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "he" } })).toEqual([
      { type: "message.part.delta", properties: { sessionID: sid, messageID: id, partID: ompPartIds.text(id, 0), field: "text", delta: "he" } },
    ])
    expect(p.project(sid, { type: "message_update", message, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "hello" } })).toEqual([
      { type: "message.part.updated", properties: { sessionID: sid, part: { id: ompPartIds.text(id, 0), sessionID: sid, messageID: id, type: "text", text: "hello", time: { start: STAMP, end: NOW } } } },
    ])
  })

  test("thinking streams into a reasoning part", () => {
    const message = assistant()
    const id = ompMessageId("ses_a", "assistant", STAMP)
    expect(projector().project("ses_a", { type: "message_update", message, assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "hmm" } })).toEqual([
      { type: "message.part.delta", properties: { sessionID: "ses_a", messageID: id, partID: ompPartIds.reasoning(id, 1), field: "text", delta: "hmm" } },
    ])
  })

  test("message_end settles the record and reconciles every part", () => {
    const call = { type: "toolCall" as const, id: "call_1", name: "bash", arguments: { command: "ls" } }
    const message = assistant({
      content: [{ type: "text", text: "done" }, { type: "thinking", thinking: "why" }, call],
      stopReason: "toolUse",
      completedAt: STAMP + 5,
    })
    const sid = "ses_a"
    const id = ompMessageId(sid, "assistant", STAMP)
    expect(projector().project(sid, { type: "message_end", message })).toEqual([
      {
        type: "message.patched",
        properties: {
          sessionID: sid,
          messageID: id,
          patch: {
            time: { completed: STAMP + 5 },
            finish: "tool-calls",
            cost: 0.5,
            tokens: { input: 10, output: 5, reasoning: 3, cache: { read: 2, write: 1 } },
          },
        },
      },
      {
        type: "message.parts.replaced",
        properties: {
          sessionID: sid,
          messageID: id,
          parts: [
            { id: ompPartIds.text(id, 0), sessionID: sid, messageID: id, type: "text", text: "done", time: { start: STAMP, end: STAMP + 5 } },
            { id: ompPartIds.reasoning(id, 1), sessionID: sid, messageID: id, type: "reasoning", text: "why", time: { start: STAMP, end: STAMP + 5 } },
            { id: ompPartIds.tool("call_1"), sessionID: sid, messageID: id, type: "tool", callID: "call_1", tool: "bash", state: { status: "pending", input: { command: "ls" }, raw: JSON.stringify({ command: "ls" }) } },
          ],
        },
      },
    ])
  })
})

describe("OMP tool execution", () => {
  test("a tool call streams, runs and succeeds on the tool part", () => {
    const p = projector()
    const sid = "ses_a"
    const call = { type: "toolCall" as const, id: "call_1", name: "bash", arguments: { command: "ls" } }
    const message = assistant({ content: [call] })
    const id = ompMessageId(sid, "assistant", STAMP)
    p.project(sid, { type: "message_start", message })

    expect(p.project(sid, { type: "message_update", message, assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 } })).toEqual([
      { type: "message.part.updated", properties: { sessionID: sid, part: { id: "call_1", sessionID: sid, messageID: id, type: "tool", callID: "call_1", tool: "bash", state: { status: "pending", input: { command: "ls" }, raw: JSON.stringify({ command: "ls" }) } } } },
    ])
    expect(p.project(sid, { type: "message_update", message, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "}" } })).toEqual([
      { type: "message.part.delta", properties: { sessionID: sid, messageID: id, partID: "call_1", field: "raw", delta: "}" } },
    ])
    expect(p.project(sid, { type: "message_update", message, assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: call } })).toEqual([
      { type: "message.tool.transition", properties: { sessionID: sid, messageID: id, partID: "call_1", transition: { kind: "input", raw: JSON.stringify({ command: "ls" }) } } },
    ])
    expect(p.project(sid, { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls" } })).toEqual([
      { type: "message.part.updated", properties: { sessionID: sid, part: { id: "call_1", sessionID: sid, messageID: id, type: "tool", callID: "call_1", tool: "bash", state: { status: "running", input: { command: "ls" }, time: { start: NOW } } } } },
    ])
    expect(p.project(sid, {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "a\nb" }, { type: "image", data: "AAA", mimeType: "image/png" }] },
    })).toEqual([
      {
        type: "message.tool.transition",
        properties: {
          sessionID: sid,
          messageID: id,
          partID: "call_1",
          transition: {
            kind: "success",
            output: "a\nb",
            attachments: [{ id: "call_1:file:0", sessionID: sid, messageID: id, type: "file", mime: "image/png", url: "data:image/png;base64,AAA" }],
            executed: true,
            end: NOW,
          },
        },
      },
    ])
  })

  test("a failed tool carries the error text", () => {
    const p = projector()
    const sid = "ses_a"
    const message = assistant()
    const id = ompMessageId(sid, "assistant", STAMP)
    p.project(sid, { type: "message_start", message })
    expect(p.project(sid, { type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", result: undefined, isError: true })).toEqual([
      {
        type: "message.tool.transition",
        properties: {
          sessionID: sid,
          messageID: id,
          partID: "call_1",
          transition: { kind: "failed", error: "bash failed", output: undefined, executed: true, end: NOW },
        },
      },
    ])
  })

  test("tool execution without a known assistant message is dropped", () => {
    expect(projector().project("ses_a", { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: {} })).toEqual([])
  })
})

describe("OMP retries and compaction", () => {
  test("auto_retry_start reports a retry status with the next attempt time", () => {
    expect(project([{ type: "auto_retry_start", attempt: 2, maxAttempts: 5, delayMs: 400, errorMessage: "rate limited" }])).toEqual([
      {
        type: "session.status",
        properties: { sessionID: "ses_a", status: { type: "retry", attempt: 2, message: "rate limited", next: NOW + 400 } },
      },
    ])
  })

  test("auto_retry_end recovers to busy or ends in error", () => {
    expect(project([{ type: "auto_retry_end", success: true, attempt: 1 }])).toEqual([
      { type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } },
    ])
    expect(project([{ type: "auto_retry_end", success: false, attempt: 5, finalError: "auth" }])).toEqual([
      { type: "session.error", properties: { sessionID: "ses_a", error: { type: "retry", message: "auth" } } },
    ])
  })

  test("compaction opens a running record and settles it with the summary", () => {
    const sid = "ses_a"
    const id = ompMessageId(sid, "compaction", NOW)
    expect(project([{ type: "auto_compaction_start", reason: "threshold", action: "context-full" }])).toEqual([
      {
        type: "message.updated",
        properties: { info: { id, sessionID: sid, role: "compaction", time: { created: NOW }, status: "running", reason: "auto", summary: "" } },
      },
    ])
    expect(project([{ type: "auto_compaction_end", action: "context-full", result: { summary: "folded" }, aborted: false, willRetry: false }])).toEqual([
      {
        type: "message.updated",
        properties: { info: { id, sessionID: sid, role: "compaction", time: { created: NOW }, status: "completed", reason: "auto", summary: "folded" } },
      },
    ])
  })

  test("a failed compaction carries its error and a skipped one is dropped", () => {
    const sid = "ses_a"
    const id = ompMessageId(sid, "compaction", NOW)
    expect(project([{ type: "auto_compaction_end", action: "remote", result: undefined, aborted: false, willRetry: true, errorMessage: "boom" }])).toEqual([
      {
        type: "message.updated",
        properties: { info: { id, sessionID: sid, role: "compaction", time: { created: NOW }, status: "failed", reason: "auto", summary: "", error: { type: "unknown", message: "boom" } } },
      },
    ])
    expect(project([{ type: "auto_compaction_end", action: "context-full", result: undefined, aborted: true, willRetry: false, skipped: true }])).toEqual([])
  })
})

describe("OMP optimistic reconciliation", () => {
  test("the next user message carries the declared client id", () => {
    const p = projector()
    p.expectUserMessage("ses_a", "client-1")
    expect(p.project("ses_a", { type: "message_start", message: user({ content: "hi" }) })).toEqual([
      {
        type: "message.updated",
        properties: { info: { id: "client-1", sessionID: "ses_a", role: "user", time: { created: STAMP } } },
      },
      {
        type: "message.parts.replaced",
        properties: {
          sessionID: "ses_a",
          messageID: "client-1",
          parts: [{ id: ompPartIds.userText("client-1"), sessionID: "ses_a", messageID: "client-1", type: "text", text: "hi", time: { start: STAMP, end: STAMP } }],
        },
      },
    ])
    // Only one message consumes the pending id.
    const [second] = p.project("ses_a", { type: "message_start", message: user({ timestamp: STAMP + 1 }) })
    expect(second).toEqual({
      type: "message.updated",
      properties: { info: { id: ompMessageId("ses_a", "user", STAMP + 1), sessionID: "ses_a", role: "user", time: { created: STAMP + 1 } } },
    })
  })
})

describe("OMP history", () => {
  test("pairs a tool result into the assistant tool part", () => {
    const call = { type: "toolCall" as const, id: "call_1", name: "bash", arguments: { command: "ls" } }
    const message = assistant({ content: [call], stopReason: "toolUse", completedAt: STAMP + 5 })
    const result = { role: "toolResult" as const, toolCallId: "call_1", toolName: "bash", content: [{ type: "text" as const, text: "out" }], isError: false, timestamp: STAMP + 6 }
    const page = projectOmpHistory("ses_a", [user({ content: "hi" }), message, result])

    expect(page.cursor).toEqual({})
    expect(page.items.length).toBe(2)
    const info = page.items[1].info
    if (info.role !== "assistant") throw new Error("expected an assistant message")
    expect(info.finish).toBe("tool-calls")
    expect(info.cost).toBe(0.5)
    expect(page.items[1].parts).toEqual([
      {
        id: "call_1",
        sessionID: "ses_a",
        messageID: ompMessageId("ses_a", "assistant", STAMP),
        type: "tool",
        callID: "call_1",
        tool: "bash",
        state: { status: "completed", input: { command: "ls" }, output: "out", time: { start: STAMP + 6, end: STAMP + 6 } },
      },
    ])
  })

  test("a tool call without a result stays pending and tool results are not messages", () => {
    const call = { type: "toolCall" as const, id: "call_2", name: "read", arguments: {} }
    const page = projectOmpHistory("ses_a", [assistant({ content: [call] })])
    expect(page.items.length).toBe(1)
    expect(page.items[0].parts[0]).toEqual({
      id: "call_2",
      sessionID: "ses_a",
      messageID: ompMessageId("ses_a", "assistant", STAMP),
      type: "tool",
      callID: "call_2",
      tool: "read",
      state: { status: "pending", input: {}, raw: "{}" },
    })
  })

  // A page that named the timestamp-derived id while the live stream named the
  // client's own id put one prompt in the store twice.
  test("projects a user message under the client id its prompt declared", () => {
    const page = projectOmpHistory("ses_a", [user({ content: "hi" })], {
      userMessageId: (message) => (message.timestamp === STAMP ? "client-1" : undefined),
    })

    expect(page.items[0].info.id).toBe("client-1")
    expect(page.items[0].parts[0].id).toBe(ompPartIds.userText("client-1"))
  })

  test("falls back to the timestamp-derived id when the caller knows none", () => {
    const page = projectOmpHistory("ses_a", [user({ content: "hi" })], { userMessageId: () => undefined })
    expect(page.items[0].info.id).toBe(ompMessageId("ses_a", "user", STAMP))
  })
})

describe("OMP command output and notices", () => {
  const shellInfo = (event: SyncEvent) => {
    if (event.type !== "message.updated" || event.properties.info.role !== "shell") {
      throw new Error("expected a shell message")
    }
    return event.properties.info
  }

  // OMP runs `/name` inside the session process and answers on `command_output`;
  // dropping the frame left every command the composer offers with no visible
  // answer at all.
  test("a command's output becomes a row naming the command", () => {
    const p = projector()
    p.expectCommand("ses_a", "/usage")

    expect(p.project("ses_a", { type: "command_output", text: "Usage (1m ago)" })).toEqual([
      {
        type: "message.updated",
        properties: {
          info: {
            id: ompMessageId("ses_a", "shell", NOW),
            sessionID: "ses_a",
            role: "shell",
            time: { created: NOW, completed: NOW },
            shellID: ompMessageId("ses_a", "shell", NOW),
            command: "/usage",
            status: "exited",
            exit: 0,
            output: { output: "Usage (1m ago)", cursor: 14, size: 14, truncated: false },
          },
        },
      },
    ])
  })

  test("two outputs inside one millisecond keep distinct ids", () => {
    const p = projector()
    const first = p.project("ses_a", { type: "command_output", text: "one" })[0]
    const second = p.project("ses_a", { type: "command_output", text: "two" })[0]

    expect(shellInfo(first).id).not.toBe(shellInfo(second).id)
  })

  test("an empty output opens no row", () => {
    expect(project([{ type: "command_output", text: "   " }])).toEqual([])
  })

  test("a user message drops a command text that produced no output", () => {
    const p = projector()
    p.expectCommand("ses_a", "/usage")
    p.project("ses_a", { type: "message_start", message: user({ content: "hi" }) })

    const [later] = p.project("ses_a", { type: "command_output", text: "later" })

    expect(shellInfo(later).command).toBe("")
  })

  test("an informational notice becomes a system row", () => {
    expect(project([{ type: "notice", level: "info", message: "Fast mode disabled.", source: "priority" }])).toEqual([
      {
        type: "message.updated",
        properties: {
          info: {
            id: ompMessageId("ses_a", "system", NOW),
            sessionID: "ses_a",
            role: "system",
            time: { created: NOW },
            text: "Fast mode disabled.",
            description: "priority",
          },
        },
      },
    ])
  })

  test("an error notice becomes a session error", () => {
    expect(project([{ type: "notice", level: "error", message: "boom" }])).toEqual([
      { type: "session.error", properties: { sessionID: "ses_a", error: { type: "notice", message: "boom" } } },
    ])
  })

  test("an empty notice opens nothing", () => {
    expect(project([{ type: "notice", level: "info", message: "  " }])).toEqual([])
  })
})

describe("OMP message identity", () => {
  test("the same timestamp in two sessions yields distinct message ids", () => {
    const message = assistant()
    const a = projector().project("ses_a", { type: "message_start", message })
    const b = projector().project("ses_b", { type: "message_start", message })
    const idOf = (events: SyncEvent[]) => {
      const event = events[0]
      if (event?.type !== "message.updated") throw new Error("expected message.updated")
      return event.properties.info.id
    }
    expect(idOf(a) === idOf(b)).toBe(false)
  })
})
