/**
 * The OMP shapes the adapter consumes.
 *
 * Structural mirrors of the SDK frames the mapping reads, not the SDK types
 * themselves: `OmpRuntime` stays free of the SDK dependency and the tests build
 * plain objects. The SDK types are structurally assignable to these at the
 * `sdk-host` seam.
 *
 * The unions are closed. OMP emits more content block and event kinds than the
 * mapping handles; those fall through the `default` branches. A closed union
 * keeps the discriminator narrowing sound (a catch-all `{ type: string }`
 * member would defeat it).
 */

import type { JsonValue } from "@openchamber/ui/lib/opencode/model"

export type OmpTextContent = { type: "text"; text: string }
export type OmpImageContent = { type: "image"; data: string; mimeType: string }
export type OmpThinkingContent = { type: "thinking"; thinking: string }
export type OmpToolCall = { type: "toolCall"; id: string; name: string; arguments: Record<string, JsonValue> }

export type OmpContentBlock = OmpTextContent | OmpImageContent | OmpThinkingContent | OmpToolCall

/** Token and cost accounting on an assistant message. */
export type OmpUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoningTokens?: number
  cost: { total: number }
}

export type OmpStopReason = "stop" | "length" | "toolUse" | "error" | "aborted"

export type OmpUserMessage = {
  role: "user"
  content: string | readonly OmpContentBlock[]
  timestamp: number
}

export type OmpAssistantMessage = {
  role: "assistant"
  content: readonly OmpContentBlock[]
  provider: string
  model: string
  usage: OmpUsage
  stopReason: OmpStopReason
  errorMessage?: string
  timestamp: number
  completedAt?: number
}

export type OmpToolResultMessage = {
  role: "toolResult"
  toolCallId: string
  toolName: string
  content: readonly OmpContentBlock[]
  isError: boolean
  timestamp: number
}

export type OmpMessage = OmpUserMessage | OmpAssistantMessage | OmpToolResultMessage

/** The assistant streaming sub-events carried by `message_update`. */
export type OmpAssistantStreamEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_start"; contentIndex: number }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: OmpToolCall }
  | { type: "image_end"; contentIndex: number }
  | { type: "done" }
  | { type: "error" }

/** What a tool returns; only the content and error flag are read. */
export type OmpToolResult = {
  content?: readonly OmpContentBlock[]
  isError?: boolean
}

/** The summary of an automatic compaction; only the text is read. */
export type OmpCompactionResult = { summary: string }

/** A raw OMP session event. Narrowed into `SyncEvent` by the mapping. */
export type OmpEvent =
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "message_start"; message: OmpMessage }
  | { type: "message_update"; message: OmpAssistantMessage; assistantMessageEvent: OmpAssistantStreamEvent }
  | { type: "message_end"; message: OmpMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, JsonValue> }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: Record<string, JsonValue>; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: OmpToolResult | undefined; isError?: boolean }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string; errorId?: number }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | {
      type: "auto_compaction_start"
      reason: "threshold" | "overflow" | "idle" | "incomplete"
      action: "context-full" | "remote" | "handoff" | "shake" | "snapcompact"
    }
  | {
      type: "auto_compaction_end"
      action: "context-full" | "remote" | "handoff" | "shake" | "snapcompact"
      result: OmpCompactionResult | undefined
      aborted: boolean
      willRetry: boolean
      errorMessage?: string
      /** True when compaction was skipped for a benign reason. */
      skipped?: boolean
    }
