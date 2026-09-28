# M3 runtime owns event translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The runtime translates wire events, so `sync/event-pipeline.ts` stops importing `@/lib/opencode/events` and drops its `payload as OpenCodeEvent` cast.

**Architecture:** The canonical event helpers and the routing constant move to `lib/agent/events.ts`. `lib/opencode/events.ts` gains the wire schema and a `translateWirePayload(payload)` entry point. The adapter exposes `translateEvent` on the contract and delegates. The pipeline calls the runtime.

**Tech Stack:** TypeScript, `zod`, `bun:test`.

**Spec:** `docs/agent-host/M3-RUNTIME-TRANSLATION.md`.

## Global Constraints

- Work on the `develop` branch. Never commit to `main`.
- New code lives only under fork-owned paths. This plan writes to `packages/ui/src/lib/agent/` and edits `lib/opencode/events.ts` and `sync/event-pipeline.ts` thinly.
- No new dependencies.
- `lib/agent/events.ts` imports the domain model from `@/lib/opencode/model` and never from `@/lib/opencode/events`.
- After each task: `bun run --cwd packages/ui type-check`.
- Commit after each task, on `develop`.

## Scope decisions

- OpenChamber's own frames (`openchamber:*`) stay in the pipeline. Only the wire-event branch moves behind the runtime.
- No transport change. SSE, WebSocket, relay, coalescing, batching and reconnect stay in the pipeline.
- `sync-context.tsx` keeps importing the helpers from `@/lib/opencode/events` through the re-export. Migrating it is M5.

---

### Task 1: Move the canonical helpers and the routing constant

**Files:**
- Modify: `packages/ui/src/lib/agent/events.ts`
- Modify: `packages/ui/src/lib/opencode/events.ts`
- Test: `packages/ui/src/lib/opencode/events.test.ts` (existing, unchanged)

**Interfaces:**
- Consumes: `SyncEvent` from `./events` (local to `lib/agent/events.ts`).
- Produces: `GLOBAL_EVENT_DIRECTORY: string`, `syncEventSessionID(event: SyncEvent): string | undefined`, `syncEventMessageID(event: SyncEvent): string | undefined`, `RoutedAgentEvent`, all exported from `@/lib/agent/events` and re-exported from `@/lib/opencode/events`.

- [ ] **Step 1: Run the existing test to establish the baseline**

Run: `bun test src/lib/opencode/events.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 2: Add the constant, the alias and the helpers to `lib/agent/events.ts`**

At the end of `packages/ui/src/lib/agent/events.ts`, add:

```ts
/** Routing key for an event that names no directory. */
export const GLOBAL_EVENT_DIRECTORY = "global"

/** The canonical name for a routed event. `RoutedSyncEvent` is kept as the existing name. */
export type RoutedAgentEvent = RoutedSyncEvent

/** Session an event addresses, when it addresses one. */
export function syncEventSessionID(event: SyncEvent): string | undefined {
  switch (event.type) {
    case "session.created":
      return event.properties.info.id
    case "message.updated":
      return event.properties.info.sessionID
    case "permission.asked":
      return event.properties.sessionID
    case "form.created":
      return event.properties.form.sessionID
    case "session.patched":
    case "session.deleted":
    case "session.forked":
    case "session.revert.committed":
    case "session.status":
    case "session.idle":
    case "session.error":
    case "message.patched":
    case "message.removed":
    case "message.part.updated":
    case "message.part.delta":
    case "message.tool.transition":
    case "message.parts.replaced":
    case "message.compaction.delta":
    case "permission.replied":
    case "form.settled":
      return event.properties.sessionID
    default:
      return undefined
  }
}

/** Message an event addresses, when it addresses one. */
export function syncEventMessageID(event: SyncEvent): string | undefined {
  switch (event.type) {
    case "message.updated":
      return event.properties.info.id
    case "message.part.updated":
      return event.properties.part.messageID
    case "message.patched":
    case "message.removed":
    case "message.part.delta":
    case "message.tool.transition":
    case "message.parts.replaced":
      return event.properties.messageID
    default:
      return undefined
  }
}
```

- [ ] **Step 3: Remove the moved definitions from `lib/opencode/events.ts`**

Delete the line `export const GLOBAL_EVENT_DIRECTORY = "global"`.

Delete the `syncEventSessionID` function (the block starting `/** Session an event addresses, when it addresses one. */` through its closing brace) and the `syncEventMessageID` function (the block starting `/** Message an event addresses, when it addresses one. */` through its closing brace).

Then add this import next to the existing `@/lib/agent/events` import at the top:

```ts
import { GLOBAL_EVENT_DIRECTORY } from "@/lib/agent/events"
```

And add this re-export where `GLOBAL_EVENT_DIRECTORY` used to be:

```ts
export { GLOBAL_EVENT_DIRECTORY, syncEventMessageID, syncEventSessionID } from "@/lib/agent/events"
```

- [ ] **Step 4: Run the existing test to verify nothing broke**

Run: `bun test src/lib/opencode/events.test.ts`
Expected: PASS, 19 tests. The test imports `syncEventMessageID` and `syncEventSessionID` from `./events`, which now re-exports them.

- [ ] **Step 5: Type-check the package**

Run: `bun run --cwd packages/ui type-check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/lib/agent/events.ts packages/ui/src/lib/opencode/events.ts
git commit -m "refactor(agent): move event helpers into the agent module"
```

---

### Task 2: The adapter owns translation

**Files:**
- Modify: `packages/ui/src/lib/opencode/events.ts`
- Modify: `packages/ui/src/lib/agent/contract.ts`
- Modify: `packages/ui/src/lib/agent/opencode-runtime.ts`
- Test: `packages/ui/src/lib/agent/opencode-runtime.test.ts`

**Interfaces:**
- Consumes: `routeWireEvent` (local to `lib/opencode/events.ts`), `RoutedAgentEvent` from `./events`.
- Produces: `translateWirePayload(payload: unknown): RoutedSyncEvent[]` from `@/lib/opencode/events`; `translateEvent(payload: unknown): RoutedAgentEvent[]` on `AgentRuntime`; `type TranslateWirePayload = (payload: unknown) => RoutedSyncEvent[]` from `./opencode-runtime`.

- [ ] **Step 1: Write the failing test**

Add this test to `packages/ui/src/lib/agent/opencode-runtime.test.ts`, inside the `describe("OpenCodeRuntime", ...)` block:

```ts
  test("delegates event translation to the injected translator", () => {
    const routed = [{ directory: "global", event: { type: "server.connected", properties: {} } }]
    const runtime = new OpenCodeRuntime(recordingClient().client, () => routed)
    expect(runtime.translateEvent({ anything: true })).toBe(routed)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/lib/agent/opencode-runtime.test.ts`
Expected: FAIL. `translateEvent` does not exist and the constructor takes one argument.

- [ ] **Step 3: Add the wire schema and the entry point to `lib/opencode/events.ts`**

Add `import { z } from "zod"` to the imports.

Add near the top of the file, after the imports:

```ts
// The wire event contract is generated from the server; the stream is trusted
// once its shape matches. Only the discriminator and location are checked here
// because the translator narrows on `type` for everything else.
const wireEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  location: z.object({ directory: z.string() }).partial().optional(),
})
```

Add next to `routeWireEvent`:

```ts
/** Validates a raw stream payload and routes it, or returns nothing when it is not a wire event. */
export function translateWirePayload(payload: unknown): RoutedSyncEvent[] {
  if (!wireEventSchema.safeParse(payload).success) return []
  // SAFETY: the discriminator and location were validated above; the rest of
  // the shape is the server's generated contract, narrowed per `type` by the
  // translator.
  return routeWireEvent(payload as OpenCodeEvent)
}
```

- [ ] **Step 4: Add `translateEvent` to the contract**

In `packages/ui/src/lib/agent/contract.ts`, add to the imports:

```ts
import type { RoutedAgentEvent } from "./events"
```

Add to the `AgentRuntime` type, after `moveSession`:

```ts
  /** Validates a raw stream payload and returns the canonical events it carries. */
  translateEvent(payload: unknown): RoutedAgentEvent[]
```

- [ ] **Step 5: Implement it in the adapter**

In `packages/ui/src/lib/agent/opencode-runtime.ts`, add to the imports:

```ts
import { translateWirePayload } from "@/lib/opencode/events"
import type { RoutedAgentEvent, RoutedSyncEvent } from "./events"
```

Add the translator type after `SessionClient`:

```ts
export type TranslateWirePayload = (payload: unknown) => RoutedSyncEvent[]
```

Change the constructor to take the translator, and add the method:

```ts
  constructor(
    private readonly client: SessionClient = opencodeClient,
    private readonly translateWire: TranslateWirePayload = translateWirePayload,
  ) {}

  translateEvent(payload: unknown): RoutedAgentEvent[] {
    return this.translateWire(payload)
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test src/lib/agent/opencode-runtime.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Type-check the package**

Run: `bun run --cwd packages/ui type-check`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/ui/src/lib/opencode/events.ts packages/ui/src/lib/agent/contract.ts packages/ui/src/lib/agent/opencode-runtime.ts packages/ui/src/lib/agent/opencode-runtime.test.ts
git commit -m "feat(agent): let the runtime own wire event translation"
```

---

### Task 3: The pipeline calls the runtime

**Files:**
- Modify: `packages/ui/src/sync/event-pipeline.ts`
- Test: `packages/ui/src/sync/event-pipeline.test.ts` (existing, unchanged)

**Interfaces:**
- Consumes: `getAgentRuntime` from `@/lib/agent/registry`; `GLOBAL_EVENT_DIRECTORY`, `syncEventSessionID`, `SyncEvent` from `@/lib/agent/events`.
- Produces: no new exports. `translatePayload` keeps its signature.

- [ ] **Step 1: Run the existing test to establish the baseline**

Run: `bun test src/sync/event-pipeline.test.ts`
Expected: PASS. Note the pass count.

- [ ] **Step 2: Update the imports**

Change line 17 from:

```ts
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client"
```

to:

```ts
import type { OpenCodeClient } from "@opencode/client"
```

Change line 20 from:

```ts
import { GLOBAL_EVENT_DIRECTORY, routeWireEvent, syncEventSessionID, type SyncEvent } from "@/lib/opencode/events"
```

to:

```ts
import { GLOBAL_EVENT_DIRECTORY, syncEventSessionID, type SyncEvent } from "@/lib/agent/events"
import { getAgentRuntime } from "@/lib/agent/registry"
```

- [ ] **Step 3: Remove the wire schema**

Delete this block:

```ts
// The wire event contract is generated from the server; the stream is trusted
// once its shape matches. Only the discriminator and location are checked here
// because the translator narrows on `type` for everything else.
const wireEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  location: z.object({ directory: z.string() }).partial().optional(),
})
```

- [ ] **Step 4: Route the wire branch through the runtime**

In `translatePayload`, replace:

```ts
  if (!wireEventSchema.safeParse(payload).success) return []
  // SAFETY: the discriminator and location were validated above; the rest of
  // the shape is the server's generated contract, narrowed per `type` by the
  // translator.
  const routed = routeWireEvent(payload as OpenCodeEvent)
```

with:

```ts
  const routed = getAgentRuntime().translateEvent(payload)
```

- [ ] **Step 5: Run the existing test to verify the payload path is unchanged**

Run: `bun test src/sync/event-pipeline.test.ts`
Expected: PASS, same count as Step 1.

- [ ] **Step 6: Type-check the package**

Run: `bun run --cwd packages/ui type-check`
Expected: no errors.

- [ ] **Step 7: Run the full UI suite**

Run: `bun run --cwd packages/ui test`
Expected: same known upstream failures only, none new.

- [ ] **Step 8: Commit**

```bash
git add packages/ui/src/sync/event-pipeline.ts
git commit -m "refactor(sync): translate stream events through the agent runtime"
```

---

### Task 4: Update the module documentation

**Files:**
- Modify: `packages/ui/src/lib/agent/DOCUMENTATION.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Record the translation ownership**

In `packages/ui/src/lib/agent/DOCUMENTATION.md`, add to the `## Rules` list:

```markdown
- The runtime owns wire translation: the adapter exposes `translateEvent`, and the sync pipeline calls it instead of importing `lib/opencode/events`.
```

- [ ] **Step 2: Commit**

```bash
git add packages/ui/src/lib/agent/DOCUMENTATION.md
git commit -m "docs(agent): note runtime-owned event translation"
```

---

## Self-Review

- Spec coverage: the spec asks for the schema and `translateWirePayload` in `events.ts`, the helper and constant move, `translateEvent` on the contract, the adapter delegation with an injectable translator, and the pipeline switch. Tasks 1 to 3 cover each; Task 4 documents it. OpenChamber frames, transport and `sync-context.tsx` stay untouched, matching the spec.
- Placeholder scan: no TBD; every step carries the exact code and the exact anchors for the edits.
- Type consistency: `translateWirePayload`, `TranslateWirePayload`, `translateEvent`, `RoutedAgentEvent`, `GLOBAL_EVENT_DIRECTORY`, `syncEventSessionID` and `syncEventMessageID` keep the same names and shapes across tasks.
