# M2 canonical event vocabulary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the canonical event vocabulary types out of `lib/opencode/events.ts` into a new `lib/agent/events.ts`, with zero behavior change.

**Architecture:** The eight pure type definitions move verbatim to `lib/agent/events.ts`, which also gains `AgentEvent` as an alias of `SyncEvent`. `lib/opencode/events.ts` imports the five it uses internally and re-exports all eight, so no other file changes. All translation functions stay in `lib/opencode/events.ts`.

**Tech Stack:** TypeScript only. No runtime code changes.

**Spec:** `docs/agent-host/M2-EVENT-VOCABULARY.md`.

## Global Constraints

- Work on the `develop` branch. Never commit to `main`.
- New code lives only under fork-owned paths. This plan writes only to `packages/ui/src/lib/agent/` and edits one shared file (`lib/opencode/events.ts`).
- No new dependencies.
- `lib/agent/events.ts` imports the domain model from `@/lib/opencode/model` and never from `@/lib/opencode/events`.
- After each task: `bun run --cwd packages/ui type-check`.
- Commit after each task, on `develop`.

## Scope decisions

- Type-only move. No `subscribe` on the contract; that is M3.
- The union keeps its name `SyncEvent` and its members. `AgentEvent` is added as an alias. No member or reference churns.
- `GLOBAL_EVENT_DIRECTORY` is a value, not a type, so it stays in `lib/opencode/events.ts`.

---

### Task 1: Move the vocabulary types

**Files:**
- Create: `packages/ui/src/lib/agent/events.ts`
- Modify: `packages/ui/src/lib/opencode/events.ts`
- Test: `packages/ui/src/lib/opencode/events.test.ts` (existing, unchanged)

**Interfaces:**
- Consumes: domain types from `@/lib/opencode/model` (`FilePart`, `FormRequest`, `JsonValue`, `Message`, `Metadata`, `ModelRef`, `Part`, `PermissionRequest`, `PermissionRuleset`, `Session`, `SessionStatus`, `StructuredError`, `TokenUsageInfo`).
- Produces: `AgentEvent`, `SyncEvent`, `SessionPatch`, `MessagePatch`, `ToolTransition`, `CatalogKind`, `OpenchamberNotification`, `SyncEventType`, `RoutedSyncEvent`, all exported from `@/lib/agent/events` and re-exported from `@/lib/opencode/events`.

- [ ] **Step 1: Run the existing test to establish the baseline**

Run: `bun test src/lib/opencode/events.test.ts`
Expected: PASS. Note the pass count; it must be identical after the move.

- [ ] **Step 2: Create `packages/ui/src/lib/agent/events.ts`**

```ts
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
```

- [ ] **Step 3: Point `packages/ui/src/lib/opencode/events.ts` at the moved types**

Add this import after the existing `./model` import block (after line 34):

```ts
import type {
  MessagePatch,
  RoutedSyncEvent,
  SessionPatch,
  SyncEvent,
  ToolTransition,
} from "@/lib/agent/events"
```

Then delete the whole `Event vocabulary` type block: from the line `/** Fields of a session that change after creation. `null` clears a value. */` through the closing brace of `export type RoutedSyncEvent = { ... }`, and replace it with this re-export:

```ts
// ---------------------------------------------------------------------------
// Event vocabulary (defined in @/lib/agent/events, re-exported for consumers)
// ---------------------------------------------------------------------------

export type {
  CatalogKind,
  MessagePatch,
  OpenchamberNotification,
  RoutedSyncEvent,
  SessionPatch,
  SyncEvent,
  SyncEventType,
  ToolTransition,
} from "@/lib/agent/events"
```

Keep `export const GLOBAL_EVENT_DIRECTORY = "global"` where it is. Leave every function below unchanged.

Note: `CatalogKind`, `OpenchamberNotification`, and `SyncEventType` are re-exported but not imported, because after the move `events.ts` no longer references them in its own code.

- [ ] **Step 4: Run the existing test to verify the translation is untouched**

Run: `bun test src/lib/opencode/events.test.ts`
Expected: PASS, same count as Step 1.

- [ ] **Step 5: Type-check the package**

Run: `bun run --cwd packages/ui type-check`
Expected: no errors. This proves every consumer still compiles against the re-exported types.

- [ ] **Step 6: Run the full UI suite**

Run: `bun run --cwd packages/ui test`
Expected: same result as before the change (the known upstream failures only, none new).

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/lib/agent/events.ts packages/ui/src/lib/opencode/events.ts
git commit -m "refactor(agent): move the event vocabulary into the agent module"
```

---

### Task 2: Update the module documentation

**Files:**
- Modify: `packages/ui/src/lib/agent/DOCUMENTATION.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Add the events file to the module docs**

In `packages/ui/src/lib/agent/DOCUMENTATION.md`, add to the `## Files` list:

```markdown
- `events.ts` holds the canonical event vocabulary: `AgentEvent` (alias `SyncEvent`) and the payload types. Runtime-neutral; the OpenCode adapter translates wire events into these in `lib/opencode/events.ts`.
```

And add to the `## Rules` list:

```markdown
- The event vocabulary is defined here and re-exported from `lib/opencode/events.ts`. Do not define event types in the OpenCode module.
```

- [ ] **Step 2: Commit**

```bash
git add packages/ui/src/lib/agent/DOCUMENTATION.md
git commit -m "docs(agent): document the canonical event vocabulary"
```

---

## Self-Review

- Spec coverage: the spec says move the eight pure types, keep the translation and all consumers, add `AgentEvent`, and change nothing observable. Task 1 does exactly that; Task 2 documents it. `subscribe` is deferred, matching the spec.
- Placeholder scan: no TBD; the new file is given in full, the `events.ts` edit is given with exact anchors and replacement text.
- Type consistency: the moved names are identical to the originals; `AgentEvent` is an alias; the re-export list matches the eight moved types; the import list matches the five `events.ts` still uses.
