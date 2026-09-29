import { describe, expect, test } from "bun:test"
import { acpMessageId, acpPartIds, createAcpEventProjector } from "./mapping-events"

const NOW = 1_000
const projector = () => createAcpEventProjector({ now: () => NOW })

describe("ACP event mapping", () => {
  test("the first assistant chunk opens a turn, a busy status and a text part", () => {
    const p = projector()
    const events = p.project("ses_a", { type: "message_delta", role: "assistant", text: "he" })
    const id = acpMessageId("ses_a", "assistant", NOW)
    expect(events).toEqual([
      { type: "message.updated", properties: { info: { id, sessionID: "ses_a", role: "assistant", time: { created: NOW }, agent: "", providerID: "", modelID: "" } } },
      { type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } },
      { type: "message.part.updated", properties: { sessionID: "ses_a", part: { id: acpPartIds.text(id, 0), sessionID: "ses_a", messageID: id, type: "text", text: "", time: { start: NOW } } } },
      { type: "message.part.delta", properties: { sessionID: "ses_a", messageID: id, partID: acpPartIds.text(id, 0), field: "text", delta: "he" } },
    ])
    // The next chunk is only a delta; the part already exists.
    expect(p.project("ses_a", { type: "message_delta", role: "assistant", text: "llo" })).toEqual([
      { type: "message.part.delta", properties: { sessionID: "ses_a", messageID: id, partID: acpPartIds.text(id, 0), field: "text", delta: "llo" } },
    ])
  })

  test("a thought chunk streams into a reasoning part", () => {
    const p = projector()
    p.project("ses_a", { type: "message_delta", role: "assistant", text: "hi" })
    const id = acpMessageId("ses_a", "assistant", NOW)
    expect(p.project("ses_a", { type: "message_delta", role: "thought", text: "why" })).toEqual([
      { type: "message.part.updated", properties: { sessionID: "ses_a", part: { id: acpPartIds.reasoning(id, 0), sessionID: "ses_a", messageID: id, type: "reasoning", text: "", time: { start: NOW } } } },
      { type: "message.part.delta", properties: { sessionID: "ses_a", messageID: id, partID: acpPartIds.reasoning(id, 0), field: "text", delta: "why" } },
    ])
  })

  test("tool calls stream as parts and settle on update", () => {
    const p = projector()
    p.project("ses_a", { type: "message_delta", role: "assistant", text: "hi" })
    const id = acpMessageId("ses_a", "assistant", NOW)
    expect(p.project("ses_a", { type: "tool_call", toolCallId: "call_1", title: "Read", kind: "read", status: "pending" })).toEqual([
      { type: "message.part.updated", properties: { sessionID: "ses_a", part: { id: "call_1", sessionID: "ses_a", messageID: id, type: "tool", callID: "call_1", tool: "Read", state: { status: "pending", input: {}, raw: "" } } } },
    ])
    expect(p.project("ses_a", { type: "tool_call_update", toolCallId: "call_1", status: "completed", text: "out" })).toEqual([
      { type: "message.tool.transition", properties: { sessionID: "ses_a", messageID: id, partID: "call_1", transition: { kind: "success", output: "out", executed: true, end: NOW } } },
    ])
  })

  test("turn end settles the message and idles the session", () => {
    const p = projector()
    p.project("ses_a", { type: "message_delta", role: "assistant", text: "hi" })
    const id = acpMessageId("ses_a", "assistant", NOW)
    expect(p.project("ses_a", { type: "turn_ended", stopReason: "end_turn" })).toEqual([
      { type: "message.patched", properties: { sessionID: "ses_a", messageID: id, patch: { time: { completed: NOW }, finish: "stop" } } },
      { type: "session.idle", properties: { sessionID: "ses_a" } },
    ])
    // A second turn end with no open turn still idles.
    expect(p.project("ses_a", { type: "turn_ended" })).toEqual([{ type: "session.idle", properties: { sessionID: "ses_a" } }])
  })

  test("a permission request becomes permission.asked", () => {
    const events = projector().project("ses_a", { type: "permission_request", requestId: "5", toolCallId: "call_1", options: [] })
    expect(events).toEqual([{ type: "permission.asked", properties: { id: "5", sessionID: "ses_a", action: "tool", resources: [], message: "call_1" } }])
  })
})
