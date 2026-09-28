/**
 * Canonical agent event vocabulary.
 *
 * These types name what a runtime tells the sync layer: a session changed, a
 * message grew, a tool call changed state. They are runtime-neutral; each
 * adapter translates its own wire events into them. The OpenCode adapter does
 * that in `@/lib/opencode/events`.
 */

import type {
  FilePart,
  FormRequest,
  JsonValue,
  Message,
  Metadata,
  ModelRef,
  Part,
  PermissionRequest,
  PermissionRuleset,
  Session,
  SessionStatus,
  StructuredError,
  TokenUsageInfo,
} from "@/lib/opencode/model"

/** Fields of a session that change after creation. `null` clears a value. */
export type SessionPatch = {
  title?: string
  directory?: string
  projectID?: string
  subpath?: string | null
  agent?: string
  model?: ModelRef
  cost?: number
  tokens?: TokenUsageInfo
  permissions?: PermissionRuleset
  revert?: Session["revert"] | null
  outcome?: Session["outcome"]
  /** Full replacement of the session's metadata. */
  metadata?: Metadata
  /** `archived: null` restores an archived session. */
  time?: Partial<Omit<Session["time"], "archived">> & { archived?: number | null }
}

/** Fields of a message that change after it appeared. */
export type MessagePatch = {
  time?: { created?: number; streamed?: number; completed?: number }
  finish?: Extract<Message, { role: "assistant" }>["finish"]
  error?: StructuredError
  cost?: number
  tokens?: TokenUsageInfo
  snapshot?: { start?: string; end?: string; files?: string[] }
  retry?: Extract<Message, { role: "assistant" }>["retry"] | null
  /** Shell messages: exit status and captured output. */
  shell?: { status: "running" | "exited" | "timeout" | "killed"; exit?: number; signal?: string; output?: Extract<Message, { role: "shell" }>["output"] }
}

/** State transitions of a tool call that need the part's existing state to apply. */
export type ToolTransition =
  | { kind: "input"; raw: string }
  | { kind: "called"; input: Record<string, JsonValue>; executed: boolean; start: number }
  | { kind: "progress"; metadata: Metadata }
  | { kind: "success"; output: string; attachments?: FilePart[]; metadata?: Metadata; executed: boolean; end: number }
  | { kind: "failed"; error: string; output?: string; metadata?: Metadata; executed: boolean; end: number }

/**
 * What OpenCode rebuilt. v2 watches its own config files and announces the
 * rebuilt slice without saying which entry changed, so each kind names the
 * lists that have to be re-read.
 */
export type CatalogKind =
  | "config"
  | "agent"
  | "command"
  | "skill"
  | "plugin"
  | "provider"
  | "model"
  | "credential"
  | "project"
  /** Web search providers or the default choice changed (`websearch.updated`). */
  | "websearch"

export type SyncEvent =
  | { type: "server.connected"; properties: Record<never, never> }
  | { type: "installation.update-available"; properties: { version: string } }
  | { type: "session.created"; properties: { info: Session } }
  | { type: "session.patched"; properties: { sessionID: string; patch: SessionPatch } }
  | { type: "session.deleted"; properties: { sessionID: string } }
  /**
   * A session was forked. OpenCode 2.x publishes no `session.created` for the
   * fork and this event carries ids only, so the sync layer reads the fork's
   * record and applies it as a `session.created`.
   */
  | { type: "session.forked"; properties: { sessionID: string; parentID: string } }
  /**
   * A staged revert became permanent: OpenCode deleted the boundary message
   * `to` and everything after it. The reducer trims the same range locally,
   * because no `message.removed` follows and a later fetch keeps whatever the
   * store still holds.
   */
  | { type: "session.revert.committed"; properties: { sessionID: string; to: string } }
  | { type: "session.status"; properties: { sessionID: string; status: SessionStatus } }
  | { type: "session.idle"; properties: { sessionID: string } }
  | { type: "session.error"; properties: { sessionID: string; error: StructuredError } }
  | { type: "message.updated"; properties: { info: Message } }
  | { type: "message.patched"; properties: { sessionID: string; messageID: string; patch: MessagePatch } }
  | { type: "message.removed"; properties: { sessionID: string; messageID: string } }
  | { type: "message.part.updated"; properties: { sessionID: string; part: Part } }
  | { type: "message.part.delta"; properties: { sessionID: string; messageID: string; partID: string; field: "text" | "raw"; delta: string } }
  | { type: "message.tool.transition"; properties: { sessionID: string; messageID: string; partID: string; transition: ToolTransition } }
  | { type: "message.parts.replaced"; properties: { sessionID: string; messageID: string; parts: Part[] } }
  /** Text appended to the summary of the compaction currently running in the session. */
  | { type: "message.compaction.delta"; properties: { sessionID: string; delta: string } }
  | { type: "permission.asked"; properties: PermissionRequest }
  | { type: "permission.replied"; properties: { sessionID: string; requestID: string } }
  | { type: "form.created"; properties: { form: FormRequest } }
  | { type: "form.settled"; properties: { sessionID: string; formID: string } }
  | { type: "vcs.branch.updated"; properties: { branch?: string } }
  | { type: "mcp.status.changed"; properties: { server: string } }
  | { type: "catalog.updated"; properties: { kind: CatalogKind } }
  /**
   * OpenCode dropped the cached services for this directory (idle eviction or
   * an explicit reload). Everything read from it is now suspect.
   */
  | { type: "location.shutdown"; properties: Record<never, never> }
  // OpenChamber's own server frames that ride the same stream.
  | { type: "openchamber.notification"; properties: OpenchamberNotification }
  // `modes` is the policy; `sessions` is its on/off view for clients from before the modes.
  | { type: "openchamber.permission-auto-accept"; properties: { sessions: Record<string, boolean>; modes?: Record<string, "ask" | "safety" | "auto">; revision?: number } }

/** The canonical name for the event union. `SyncEvent` is kept as the existing name. */
export type AgentEvent = SyncEvent

/** Agent-completion / restart notices the OpenChamber server publishes for non-web runtimes. */
export type OpenchamberNotification = {
  kind?: string
  sessionId?: string
  directory?: string
  title?: string
  body?: string
  tag?: string
  requireHidden?: boolean
  desktopNotificationDelivered?: boolean
  desktopStdoutActive?: boolean
}

export type SyncEventType = SyncEvent["type"]

/** A translated event together with the directory it belongs to. */
export type RoutedSyncEvent = {
  directory: string
  event: SyncEvent
}
