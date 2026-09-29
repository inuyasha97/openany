/**
 * ACP session events onto the canonical `SyncEvent` vocabulary.
 *
 * ACP streams chunks without message ids and a turn ends with the prompt
 * response, so the mapping spans events: the projector opens one assistant
 * message per turn on the first chunk, streams text, thought and tool parts
 * into it, and settles it on `turn_ended`. A session id is not on the event;
 * the runtime supplies it. Text and reasoning use one part per turn; tools use
 * their ACP call id.
 */

import type { SyncEvent, ToolTransition } from "@openchamber/ui/lib/agent/events"
import type { MessagePatch } from "@openchamber/ui/lib/agent/events"
import type { Part, Session } from "@openchamber/ui/lib/opencode/model"
import type { AcpEvent } from "./model"

export const acpMessageId = (sessionId: string, role: string, timestamp: number): string =>
  `acp:${sessionId}:${role}:${timestamp}`

export const acpPartIds = {
  text: (messageID: string, ordinal: number) => `${messageID}:text:${ordinal}`,
  reasoning: (messageID: string, ordinal: number) => `${messageID}:reasoning:${ordinal}`,
  tool: (callID: string) => callID,
} as const

const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

/** A projected ACP session, carrying its runtime identity from the start. */
export const projectAcpSession = (
  record: { id: string; cwd: string; title?: string },
  now: number,
): Session & { runtimeId: string; nativeSessionId: string } => ({
  id: record.id,
  runtimeId: "acp",
  nativeSessionId: record.id,
  projectID: "",
  directory: record.cwd,
  title: record.title ?? "",
  cost: 0,
  tokens: { ...ZERO_TOKENS, cache: { ...ZERO_TOKENS.cache } },
  time: { created: now, updated: now },
})

type TurnState = {
  assistantMessageID: string
  created: number
  textStarted: boolean
  reasoningStarted: boolean
}

type SessionState = { turn?: TurnState }

const assistantFinish = (stopReason: string | undefined): "stop" | "length" | "content-filter" | "unknown" => {
  switch (stopReason) {
    case "max_tokens":
    case "max_turn_requests":
      return "length"
    case "refusal":
      return "content-filter"
    case "end_turn":
    case "stop":
      return "stop"
    default:
      return "unknown"
  }
}

export type AcpEventProjector = {
  project: (sessionId: string, event: AcpEvent) => SyncEvent[]
}

const partUpdated = (sessionId: string, part: Part): SyncEvent => ({ type: "message.part.updated", properties: { sessionID: sessionId, part } })
const partDelta = (sessionId: string, messageID: string, partID: string, field: "text" | "raw", delta: string): SyncEvent => ({
  type: "message.part.delta",
  properties: { sessionID: sessionId, messageID, partID, field, delta },
})
const toolTransition = (sessionId: string, messageID: string, callID: string, transition: ToolTransition): SyncEvent => ({
  type: "message.tool.transition",
  properties: { sessionID: sessionId, messageID, partID: acpPartIds.tool(callID), transition },
})

export const createAcpEventProjector = (options: { now?: () => number } = {}): AcpEventProjector => {
  const now = options.now ?? Date.now
  const sessions = new Map<string, SessionState>()
  const stateFor = (sessionId: string): SessionState => {
    let state = sessions.get(sessionId)
    if (!state) {
      state = {}
      sessions.set(sessionId, state)
    }
    return state
  }

  const openTurn = (sessionId: string, state: SessionState, at: number): SyncEvent[] => {
    if (state.turn) return []
    const assistantMessageID = acpMessageId(sessionId, "assistant", at)
    state.turn = { assistantMessageID, created: at, textStarted: false, reasoningStarted: false }
    return [
      { type: "message.updated", properties: { info: { id: assistantMessageID, sessionID: sessionId, role: "assistant", time: { created: at }, agent: "", providerID: "", modelID: "" } } },
      { type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } },
    ]
  }

  const project = (sessionId: string, event: AcpEvent): SyncEvent[] => {
    const state = stateFor(sessionId)
    switch (event.type) {
      case "message_delta": {
        if (event.role === "user") return []
        const at = state.turn?.created ?? now()
        const opened = openTurn(sessionId, state, at)
        const turn = state.turn
        if (!turn) return opened
        if (event.role === "thought") {
          const start = opened.length > 0 || !turn.reasoningStarted
            ? [partUpdated(sessionId, { id: acpPartIds.reasoning(turn.assistantMessageID, 0), sessionID: sessionId, messageID: turn.assistantMessageID, type: "reasoning", text: "", time: { start: turn.created } })]
            : []
          turn.reasoningStarted = true
          return [...opened, ...start, partDelta(sessionId, turn.assistantMessageID, acpPartIds.reasoning(turn.assistantMessageID, 0), "text", event.text)]
        }
        const start = opened.length > 0 || !turn.textStarted
          ? [partUpdated(sessionId, { id: acpPartIds.text(turn.assistantMessageID, 0), sessionID: sessionId, messageID: turn.assistantMessageID, type: "text", text: "", time: { start: turn.created } })]
          : []
        turn.textStarted = true
        return [...opened, ...start, partDelta(sessionId, turn.assistantMessageID, acpPartIds.text(turn.assistantMessageID, 0), "text", event.text)]
      }

      case "tool_call": {
        const at = state.turn?.created ?? now()
        const opened = openTurn(sessionId, state, at)
        const turn = state.turn
        if (!turn) return opened
        const status = event.status === "in_progress" ? "running" : "pending"
        return [
          ...opened,
          partUpdated(sessionId, {
            id: acpPartIds.tool(event.toolCallId),
            sessionID: sessionId,
            messageID: turn.assistantMessageID,
            type: "tool",
            callID: event.toolCallId,
            tool: event.title ?? event.kind ?? "tool",
            state: status === "running"
              ? { status: "running", input: {}, time: { start: at } }
              : { status: "pending", input: {}, raw: "" },
          }),
        ]
      }

      case "tool_call_update": {
        const turn = state.turn
        if (!turn) return []
        const messageID = turn.assistantMessageID
        if (event.status === "completed") {
          return [toolTransition(sessionId, messageID, event.toolCallId, { kind: "success", output: event.text ?? "", executed: true, end: now() })]
        }
        if (event.status === "failed") {
          return [toolTransition(sessionId, messageID, event.toolCallId, { kind: "failed", error: event.text || "tool failed", output: event.text, executed: true, end: now() })]
        }
        return [toolTransition(sessionId, messageID, event.toolCallId, { kind: "progress", metadata: {} })]
      }

      case "turn_ended": {
        const turn = state.turn
        state.turn = undefined
        if (!turn) return [{ type: "session.idle", properties: { sessionID: sessionId } }]
        const at = now()
        const patch: MessagePatch = { time: { completed: at }, finish: assistantFinish(event.stopReason) }
        return [
          { type: "message.patched", properties: { sessionID: sessionId, messageID: turn.assistantMessageID, patch } },
          { type: "session.idle", properties: { sessionID: sessionId } },
        ]
      }

      case "permission_request": {
        const request = { id: event.requestId, sessionID: sessionId, action: "tool", resources: [], message: event.toolCallId }
        return [{ type: "permission.asked", properties: request }]
      }

      default:
        return []
    }
  }

  return { project }
}
