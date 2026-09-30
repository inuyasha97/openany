/**
 * The normalized ACP session events the host emits.
 *
 * `acp-host.ts` unpacks raw JSON-RPC `session/update` notifications and the
 * agent's `session/request_permission` requests into this closed union, so the
 * server-side mapping (`openchamber:acp` frames) narrows on `type` and never
 * sees raw ACP. ACP carries a session id on the wire; the runtime supplies it,
 * so it is not on the event.
 */

type AcpMessageDelta = {
  type: "message_delta"
  role: "user" | "assistant" | "thought"
  text: string
}

type AcpToolCall = {
  type: "tool_call"
  toolCallId: string
  title?: string
  kind?: string
  status?: string
}

type AcpToolCallUpdate = {
  type: "tool_call_update"
  toolCallId: string
  status?: string
  text?: string
}

export type AcpPermissionOption = {
  optionId: string
  kind: string
  name?: string
}

type AcpPermissionRequest = {
  type: "permission_request"
  requestId: string
  toolCallId?: string
  options: AcpPermissionOption[]
}

type AcpTurnEnded = {
  type: "turn_ended"
  stopReason?: string
}

export type AcpEvent =
  | AcpMessageDelta
  | AcpToolCall
  | AcpToolCallUpdate
  | AcpPermissionRequest
  | AcpTurnEnded
