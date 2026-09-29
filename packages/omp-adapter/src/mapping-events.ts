/**
 * OMP session events onto the canonical `SyncEvent` vocabulary.
 *
 * OMP carries no message ids and speaks in whole message snapshots, so the
 * mapping spans events: the projector remembers the assistant message it is
 * streaming into and the run boundaries drive the session status. Text,
 * reasoning and tool calls become parts; tool execution becomes transitions on
 * the tool part. An event with no mapping yields nothing.
 *
 * The mapping is stateful per session (the session id is not on OMP events),
 * which is why it is a projector rather than a pure function.
 */

import type { JsonValue, Part } from "@openchamber/ui/lib/opencode/model"
import type { SyncEvent, ToolTransition } from "@openchamber/ui/lib/agent/events"
import {
  ompAssistantCompletedPatch,
  ompMessageId,
  ompPartIds,
  projectOmpAssistantMessage,
  projectOmpAssistantParts,
  projectOmpToolCall,
  projectOmpUserMessage,
  projectOmpUserParts,
  toolAttachments,
  toolOutputText,
} from "./mapping-messages"
import type { OmpAssistantMessage, OmpAssistantStreamEvent, OmpEvent, OmpMessage, OmpToolCall, OmpToolResult } from "./model"

export type OmpEventProjector = {
  project: (sessionId: string, event: OmpEvent) => SyncEvent[]
  /**
   * Declares the id the next user message should carry, so a client's
   * optimistic message reconciles in place instead of duplicating. OMP derives
   * message ids so a prompt cannot pass one through; the server supplies it
   * before prompting.
   */
  expectUserMessage: (sessionId: string, messageID: string) => void
}

type SessionState = {
  /** The assistant message the current stream belongs to. */
  assistantMessageID?: string
  /** The client-supplied id awaiting the next user message. */
  pendingUserMessageID?: string
}

const partUpdated = (sessionId: string, part: Part): SyncEvent => ({
  type: "message.part.updated",
  properties: { sessionID: sessionId, part },
})

const partDelta = (sessionId: string, messageID: string, partID: string, field: "text" | "raw", delta: string): SyncEvent => ({
  type: "message.part.delta",
  properties: { sessionID: sessionId, messageID, partID, field, delta },
})

const toolTransition = (sessionId: string, messageID: string, callID: string, transition: ToolTransition): SyncEvent => ({
  type: "message.tool.transition",
  properties: { sessionID: sessionId, messageID, partID: ompPartIds.tool(callID), transition },
})

const toolCallAt = (message: OmpAssistantMessage, index: number): OmpToolCall | undefined => {
  const block = message.content[index]
  return block && block.type === "toolCall" ? block : undefined
}

// ---------------------------------------------------------------------------
// Message lifecycle
// ---------------------------------------------------------------------------

const projectMessageStart = (sessionId: string, state: SessionState, message: OmpMessage): SyncEvent[] => {
  if (message.role === "assistant") {
    state.assistantMessageID = ompMessageId(sessionId, "assistant", message.timestamp)
    return [{ type: "message.updated", properties: { info: projectOmpAssistantMessage(sessionId, message) } }]
  }
  if (message.role === "user") {
    const messageID = state.pendingUserMessageID ?? ompMessageId(sessionId, "user", message.timestamp)
    state.pendingUserMessageID = undefined
    return [
      { type: "message.updated", properties: { info: projectOmpUserMessage(sessionId, message, messageID) } },
      {
        type: "message.parts.replaced",
        properties: { sessionID: sessionId, messageID, parts: projectOmpUserParts(sessionId, message, messageID) },
      },
    ]
  }
  // Tool results fold into the tool part through `tool_execution_end`.
  return []
}

const projectMessageUpdate = (
  sessionId: string,
  state: SessionState,
  message: OmpAssistantMessage,
  stream: OmpAssistantStreamEvent,
  now: number,
): SyncEvent[] => {
  const messageID = state.assistantMessageID ?? ompMessageId(sessionId, "assistant", message.timestamp)
  state.assistantMessageID = messageID
  const start = message.timestamp
  switch (stream.type) {
    case "text_start":
      return [partUpdated(sessionId, {
        id: ompPartIds.text(messageID, stream.contentIndex),
        sessionID: sessionId,
        messageID,
        type: "text",
        text: "",
        time: { start },
      })]
    case "text_delta":
      return [partDelta(sessionId, messageID, ompPartIds.text(messageID, stream.contentIndex), "text", stream.delta)]
    case "text_end":
      return [partUpdated(sessionId, {
        id: ompPartIds.text(messageID, stream.contentIndex),
        sessionID: sessionId,
        messageID,
        type: "text",
        text: stream.content,
        time: { start, end: now },
      })]
    case "thinking_start":
      return [partUpdated(sessionId, {
        id: ompPartIds.reasoning(messageID, stream.contentIndex),
        sessionID: sessionId,
        messageID,
        type: "reasoning",
        text: "",
        time: { start },
      })]
    case "thinking_delta":
      return [partDelta(sessionId, messageID, ompPartIds.reasoning(messageID, stream.contentIndex), "text", stream.delta)]
    case "thinking_end":
      return [partUpdated(sessionId, {
        id: ompPartIds.reasoning(messageID, stream.contentIndex),
        sessionID: sessionId,
        messageID,
        type: "reasoning",
        text: stream.content,
        time: { start, end: now },
      })]
    case "toolcall_start": {
      const call = toolCallAt(message, stream.contentIndex)
      return call ? [partUpdated(sessionId, projectOmpToolCall(sessionId, messageID, call))] : []
    }
    case "toolcall_delta": {
      const call = toolCallAt(message, stream.contentIndex)
      return call ? [partDelta(sessionId, messageID, ompPartIds.tool(call.id), "raw", stream.delta)] : []
    }
    case "toolcall_end":
      return [
        toolTransition(sessionId, messageID, stream.toolCall.id, { kind: "input", raw: JSON.stringify(stream.toolCall.arguments) }),
      ]
    default:
      return []
  }
}

const projectMessageEnd = (sessionId: string, state: SessionState, message: OmpMessage, now: number): SyncEvent[] => {
  if (message.role !== "assistant") return []
  const messageID = ompMessageId(sessionId, "assistant", message.timestamp)
  state.assistantMessageID = messageID
  const end = message.completedAt ?? now
  return [
    { type: "message.patched", properties: { sessionID: sessionId, messageID, patch: ompAssistantCompletedPatch(message, end) } },
    {
      type: "message.parts.replaced",
      properties: { sessionID: sessionId, messageID, parts: projectOmpAssistantParts(sessionId, message, end) },
    },
  ]
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

const projectToolStart = (
  sessionId: string,
  state: SessionState,
  toolCallId: string,
  toolName: string,
  args: Record<string, JsonValue>,
  now: number,
): SyncEvent[] => {
  const messageID = state.assistantMessageID
  if (!messageID) return []
  // Re-emitting the part as `running` (rather than a `called` transition)
  // creates it when the stream was joined after `toolcall_start`.
  return [partUpdated(sessionId, {
    id: ompPartIds.tool(toolCallId),
    sessionID: sessionId,
    messageID,
    type: "tool",
    callID: toolCallId,
    tool: toolName,
    state: { status: "running", input: args, time: { start: now } },
  })]
}

const projectToolEnd = (
  sessionId: string,
  state: SessionState,
  toolCallId: string,
  toolName: string,
  result: OmpToolResult | undefined,
  isError: boolean | undefined,
  now: number,
): SyncEvent[] => {
  const messageID = state.assistantMessageID
  if (!messageID) return []
  const output = toolOutputText(result?.content)
  if (isError || result?.isError) {
    return [toolTransition(sessionId, messageID, toolCallId, {
      kind: "failed",
      error: output || `${toolName} failed`,
      output: output || undefined,
      executed: true,
      end: now,
    })]
  }
  return [toolTransition(sessionId, messageID, toolCallId, {
    kind: "success",
    output,
    attachments: toolAttachments(result?.content, { sessionID: sessionId, messageID, callID: toolCallId }),
    executed: true,
    end: now,
  })]
}

// ---------------------------------------------------------------------------
// Compaction and retries
// ---------------------------------------------------------------------------

const compactionMessage = (
  sessionId: string,
  event: Extract<OmpEvent, { type: "auto_compaction_end" }>,
  created: number,
): SyncEvent => {
  const summary = event.result?.summary ?? ""
  const errorMessage = event.errorMessage
  return {
    type: "message.updated",
    properties: {
      info: errorMessage
        ? {
            id: ompMessageId(sessionId, "compaction", created),
            sessionID: sessionId,
            role: "compaction",
            time: { created },
            status: "failed",
            reason: "auto",
            summary,
            error: { type: "unknown", message: errorMessage },
          }
        : {
            id: ompMessageId(sessionId, "compaction", created),
            sessionID: sessionId,
            role: "compaction",
            time: { created },
            status: "completed",
            reason: "auto",
            summary,
          },
    },
  }
}

// ---------------------------------------------------------------------------
// Projector
// ---------------------------------------------------------------------------

export const createOmpEventProjector = (options: { now?: () => number } = {}): OmpEventProjector => {
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

  const project = (sessionId: string, event: OmpEvent): SyncEvent[] => {
    const state = stateFor(sessionId)
    switch (event.type) {
      case "agent_start":
        return [{ type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } }]
      case "agent_end":
        return [{ type: "session.idle", properties: { sessionID: sessionId } }]
      case "message_start":
        return projectMessageStart(sessionId, state, event.message)
      case "message_update":
        return projectMessageUpdate(sessionId, state, event.message, event.assistantMessageEvent, now())
      case "message_end":
        return projectMessageEnd(sessionId, state, event.message, now())
      case "tool_execution_start":
        return projectToolStart(sessionId, state, event.toolCallId, event.toolName, event.args, now())
      case "tool_execution_end":
        return projectToolEnd(sessionId, state, event.toolCallId, event.toolName, event.result, event.isError, now())
      case "auto_retry_start":
        return [{
          type: "session.status",
          properties: {
            sessionID: sessionId,
            status: { type: "retry", attempt: event.attempt, message: event.errorMessage, next: now() + event.delayMs },
          },
        }]
      case "auto_retry_end":
        if (!event.success) {
          return [{
            type: "session.error",
            properties: { sessionID: sessionId, error: { type: "retry", message: event.finalError ?? "retry failed" } },
          }]
        }
        return [{ type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } }]
      case "auto_compaction_start": {
        const created = now()
        return [{
          type: "message.updated",
          properties: {
            info: {
              id: ompMessageId(sessionId, "compaction", created),
              sessionID: sessionId,
              role: "compaction",
              time: { created },
              status: "running",
              reason: "auto",
              summary: "",
            },
          },
        }]
      }
      case "auto_compaction_end":
        // A skipped compaction changed nothing and must not open a record.
        if (event.skipped) return []
        return [compactionMessage(sessionId, event, now())]
      default:
        // Turn boundaries, tool progress and the other OMP frames the sync
        // layer does not model.
        return []
    }
  }

  const expectUserMessage = (sessionId: string, messageID: string): void => {
    stateFor(sessionId).pendingUserMessageID = messageID
  }

  return { project, expectUserMessage }
}
