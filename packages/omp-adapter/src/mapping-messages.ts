/**
 * OMP messages and content onto the canonical `Message` / `Part`
 * model.
 *
 * OMP messages carry no id, so identity is derived and reproducible: a message
 * is `(sessionId, role, timestamp)`, a text or reasoning block is
 * `(messageId, contentIndex)`, and a tool call is its provider call id. The
 * session id is part of the message id because parts are stored keyed by
 * message id alone, so ids must be unique across sessions.
 */

import type { MessagePatch } from "@openchamber/ui/lib/agent/events"
import type { AssistantFinish, FilePart, Message, Part, Session, ToolPart, ToolState } from "@openchamber/ui/lib/opencode/model"
import type {
  OmpAssistantMessage,
  OmpContentBlock,
  OmpImageContent,
  OmpStopReason,
  OmpTextContent,
  OmpToolCall,
  OmpToolResultMessage,
  OmpUserMessage,
  OmpUsage,
} from "./model"

const compact = <T extends object>(value: T): T =>
  // SAFETY: only keys with an undefined value are dropped; every remaining key
  // keeps its declared type, so the result still satisfies T.
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T

/** Deterministic message id. `sessionId` keeps ids unique across sessions. */
export const ompMessageId = (sessionId: string, role: string, timestamp: number): string =>
  `omp:${sessionId}:${role}:${timestamp}`

/** The part id convention, mirrored from the UI model so both sides agree. */
export const ompPartIds = {
  text: (messageID: string, ordinal: number) => `${messageID}:text:${ordinal}`,
  reasoning: (messageID: string, ordinal: number) => `${messageID}:reasoning:${ordinal}`,
  tool: (callID: string) => callID,
  userText: (messageID: string) => `${messageID}:text:0`,
  userFile: (messageID: string, index: number) => `${messageID}:file:${index}`,
} as const

const isText = (block: OmpContentBlock): block is OmpTextContent => block.type === "text"
const isImage = (block: OmpContentBlock): block is OmpImageContent => block.type === "image"

const dataUrl = (image: OmpImageContent): string => `data:${image.mimeType};base64,${image.data}`

const toTokens = (usage: OmpUsage) => ({
  input: usage.input,
  output: usage.output,
  reasoning: usage.reasoningTokens ?? 0,
  cache: { read: usage.cacheRead, write: usage.cacheWrite },
})

const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const assistantFinish = (reason: OmpStopReason): AssistantFinish => {
  switch (reason) {
    case "stop":
      return "stop"
    case "length":
      return "length"
    case "toolUse":
      return "tool-calls"
    case "error":
      return "error"
    case "aborted":
      return "unknown"
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export const projectOmpUserMessage = (
  sessionId: string,
  message: OmpUserMessage,
  messageID: string = ompMessageId(sessionId, "user", message.timestamp),
): Message => ({
  id: messageID,
  sessionID: sessionId,
  role: "user",
  time: { created: message.timestamp },
})

/**
 * The base assistant record. `finish`, `cost`, `tokens` and `error` are absent
 * until the message ends; `ompAssistantCompletedPatch` carries them.
 */
export const projectOmpAssistantMessage = (sessionId: string, message: OmpAssistantMessage): Message => ({
  id: ompMessageId(sessionId, "assistant", message.timestamp),
  sessionID: sessionId,
  role: "assistant",
  time: { created: message.timestamp },
  agent: "",
  providerID: message.provider,
  modelID: message.model,
})

/** The fields a finished assistant message settles. */
export const ompAssistantCompletedPatch = (message: OmpAssistantMessage, end: number): MessagePatch =>
  compact({
    time: { completed: end },
    finish: assistantFinish(message.stopReason),
    error: message.stopReason === "error" ? { type: "unknown", message: message.errorMessage ?? "assistant error" } : undefined,
    cost: message.usage.cost.total,
    tokens: toTokens(message.usage),
  })

/** A projected OMP session. Carries its runtime identity from the start. */
export const projectOmpSession = (
  record: { id: string; cwd: string; title: string },
  now: number,
): Session & { runtimeId: string; nativeSessionId: string } => ({
  id: record.id,
  runtimeId: "omp",
  nativeSessionId: record.id,
  projectID: "",
  directory: record.cwd,
  title: record.title,
  cost: 0,
  tokens: { ...ZERO_TOKENS, cache: { ...ZERO_TOKENS.cache } },
  time: { created: now, updated: now },
})

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

export const projectOmpUserParts = (
  sessionId: string,
  message: OmpUserMessage,
  messageID: string = ompMessageId(sessionId, "user", message.timestamp),
): Part[] => {
  const content: readonly OmpContentBlock[] = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }]
  const parts: Part[] = []
  const text = content.filter(isText).map((block) => block.text).join("\n")
  if (text.length > 0) {
    parts.push({
      id: ompPartIds.userText(messageID),
      sessionID: sessionId,
      messageID,
      type: "text",
      text,
      time: { start: message.timestamp, end: message.timestamp },
    })
  }
  content.filter(isImage).forEach((image, index) => {
    parts.push({
      id: ompPartIds.userFile(messageID, index),
      sessionID: sessionId,
      messageID,
      type: "file",
      mime: image.mimeType,
      url: dataUrl(image),
    })
  })
  return parts
}

/**
 * Every part of a finished assistant message. Text and reasoning are addressed
 * by their content index, tool calls by their call id; the call is `pending`
 * until `tool_execution_start` reports it began.
 */
export const projectOmpAssistantParts = (
  sessionId: string,
  message: OmpAssistantMessage,
  end: number,
  results?: ReadonlyMap<string, OmpToolResultMessage>,
): Part[] => {
  const messageID = ompMessageId(sessionId, "assistant", message.timestamp)
  return message.content.flatMap((block, index): Part[] => {
    if (isText(block)) {
      return [{
        id: ompPartIds.text(messageID, index),
        sessionID: sessionId,
        messageID,
        type: "text",
        text: block.text,
        time: { start: message.timestamp, end },
      }]
    }
    if (block.type === "thinking") {
      return [{
        id: ompPartIds.reasoning(messageID, index),
        sessionID: sessionId,
        messageID,
        type: "reasoning",
        text: block.thinking,
        time: { start: message.timestamp, end },
      }]
    }
    if (block.type === "toolCall") {
      const part = projectOmpToolCall(sessionId, messageID, block)
      const result = results?.get(block.id)
      return [result ? { ...part, state: toolResultState(block, result, sessionId, messageID) } : part]
    }
    return []
  })
}

export const projectOmpToolCall = (sessionId: string, messageID: string, call: OmpToolCall): ToolPart => ({
  id: ompPartIds.tool(call.id),
  sessionID: sessionId,
  messageID,
  type: "tool",
  callID: call.id,
  tool: call.name,
  state: { status: "pending", input: call.arguments, raw: JSON.stringify(call.arguments) },
})

/** The settled state of a tool call, from the result that answered it. */
const toolResultState = (
  call: OmpToolCall,
  result: OmpToolResultMessage,
  sessionId: string,
  messageID: string,
): ToolState => {
  const output = toolOutputText(result.content)
  const time = { start: result.timestamp, end: result.timestamp }
  if (result.isError) {
    return { status: "error", input: call.arguments, error: output || `${call.name} failed`, time }
  }
  return {
    status: "completed",
    input: call.arguments,
    output,
    time,
    attachments: toolAttachments(result.content, { sessionID: sessionId, messageID, callID: call.id }),
  }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const projectOmpAssistantHistoryMessage = (sessionId: string, message: OmpAssistantMessage): Message => {
  const time = message.completedAt !== undefined
    ? { created: message.timestamp, completed: message.completedAt }
    : { created: message.timestamp }
  const error = message.stopReason === "error"
    ? { type: "unknown", message: message.errorMessage ?? "assistant error" }
    : undefined
  return {
    id: ompMessageId(sessionId, "assistant", message.timestamp),
    sessionID: sessionId,
    role: "assistant",
    time,
    agent: "",
    providerID: message.provider,
    modelID: message.model,
    finish: assistantFinish(message.stopReason),
    cost: message.usage.cost.total,
    tokens: toTokens(message.usage),
    error,
  }
}

/**
 * A full OMP history as a message page. Tool results are not messages in the
 * UI model, so each is folded into the tool part of the call it answered.
 */
export const projectOmpHistory = (
  sessionId: string,
  messages: readonly (OmpUserMessage | OmpAssistantMessage | OmpToolResultMessage)[],
) => {
  const results = new Map<string, OmpToolResultMessage>()
  for (const message of messages) {
    if (message.role === "toolResult") results.set(message.toolCallId, message)
  }
  const items: Array<{ info: Message; parts: Part[] }> = []
  for (const message of messages) {
    if (message.role === "user") {
      items.push({ info: projectOmpUserMessage(sessionId, message), parts: projectOmpUserParts(sessionId, message) })
    } else if (message.role === "assistant") {
      const end = message.completedAt ?? message.timestamp
      items.push({ info: projectOmpAssistantHistoryMessage(sessionId, message), parts: projectOmpAssistantParts(sessionId, message, end, results) })
    }
  }
  return { items, cursor: {} }
}

// ---------------------------------------------------------------------------
// Tool results
// ---------------------------------------------------------------------------

export const toolOutputText = (content: readonly OmpContentBlock[] | undefined): string => {
  if (!content) return ""
  return content.filter(isText).map((block) => block.text).join("\n")
}

export const toolAttachments = (
  content: readonly OmpContentBlock[] | undefined,
  owner: { sessionID: string; messageID: string; callID: string },
): FilePart[] | undefined => {
  if (!content) return undefined
  const files = content.filter(isImage).map((image, index) => ({
    id: `${owner.callID}:file:${index}`,
    sessionID: owner.sessionID,
    messageID: owner.messageID,
    type: "file" as const,
    mime: image.mimeType,
    url: dataUrl(image),
  }))
  return files.length > 0 ? files : undefined
}
