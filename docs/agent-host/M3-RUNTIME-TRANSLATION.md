# M3: runtime owns event translation

Status: design agreed on 2026-09-27. Third milestone of the program in [ROLLOUT.md](ROLLOUT.md). Follows the M1 rule: establish the seam with zero behavior change.

## Goal

The runtime translates its own wire events into the canonical vocabulary. After M3, `sync/event-pipeline.ts` no longer imports `@/lib/opencode/events`, and the unsafe cast `payload as OpenCodeEvent` leaves the pipeline.

## Current state

`sync/event-pipeline.ts` turns one raw stream payload into routed events:

1. OpenChamber's own frames first (`openchamber:*`), which stay OpenChamber-owned.
2. `wireEventSchema.safeParse(payload)`, where `wireEventSchema` is defined in the pipeline (line 186).
3. `routeWireEvent(payload as OpenCodeEvent)`, imported from `@/lib/opencode/events`.

So the pipeline holds both the wire validation and the OpenCode translation. This is the coupling M3 removes.

## What changes

### `lib/opencode/events.ts`

- Add `import { z } from "zod"`.
- Move `wireEventSchema` here verbatim from `event-pipeline.ts`. The wire shape is OpenCode's.
- Add the validate-and-route entry point the adapter calls:

```ts
export function translateWirePayload(payload: unknown): RoutedSyncEvent[] {
  if (!wireEventSchema.safeParse(payload).success) return []
  return routeWireEvent(payload as OpenCodeEvent)
}
```

- Import `GLOBAL_EVENT_DIRECTORY`, `syncEventSessionID` and `syncEventMessageID` from `@/lib/agent/events`, and re-export them so `events.test.ts` and `sync-context.tsx` keep compiling unchanged.

### `lib/agent/events.ts`

- Add `RoutedAgentEvent` as an alias of `RoutedSyncEvent`.
- Move `GLOBAL_EVENT_DIRECTORY`, `syncEventSessionID` and `syncEventMessageID` here. They operate on the canonical event and the canonical routing key, not on OpenCode wire shapes.

### `lib/agent/contract.ts`

- Add `translateEvent(payload: unknown): RoutedAgentEvent[]` to `AgentRuntime`. The `unknown` is a parse boundary: the adapter validates before it trusts anything.

### `lib/agent/opencode-runtime.ts`

- Implement `translateEvent` by delegating to `translateWirePayload`.
- Add an optional constructor parameter for the translator, so the adapter test injects a fake instead of mocking a module.

### `sync/event-pipeline.ts`

- Delete `wireEventSchema`.
- In `translatePayload`, replace the validation and `routeWireEvent` call with `const routed = getAgentRuntime().translateEvent(payload)`.
- Import `GLOBAL_EVENT_DIRECTORY` and `syncEventSessionID` from `@/lib/agent/events`, and `getAgentRuntime` from `@/lib/agent/registry`.
- Remove the `@/lib/opencode/events` import.

## Dependency direction

```
lib/agent/events.ts  -->  lib/opencode/model.ts          (domain model, valid)
lib/opencode/events.ts  -->  lib/agent/events.ts         (translation uses the vocabulary)
lib/agent/opencode-runtime.ts  -->  lib/opencode/events.ts  (adapter owns translation)
sync/event-pipeline.ts  -->  lib/agent/*                 (runtime-neutral)
```

## What does not change

- OpenChamber's own frames stay in the pipeline, unchanged.
- `sync-context.tsx` keeps importing the helpers from `@/lib/opencode/events` through the re-export. Migrating it is M5, not M3.
- No transport change: SSE, WebSocket, relay, coalescing, batching and reconnect stay in the pipeline.
- No behavior change. Same payloads produce the same routed events.

## Verification

- `packages/ui/src/lib/opencode/events.test.ts` still passes.
- `packages/ui/src/sync/event-pipeline.test.ts` still passes, proving the payload path is unchanged.
- New adapter test: `translateEvent` delegates to the injected translator and returns its result.
- `bun run --cwd packages/ui type-check` passes.
- `bun run --cwd packages/ui test` shows the same known upstream failures, none new.

## Risks

- `sync/event-pipeline.ts` (985 lines) and `lib/opencode/events.ts` (824 lines) are upstream-tracked and heavily edited. The pipeline edit is small (one branch plus imports); the `events.ts` edit adds a schema and a function and re-exports moved helpers.
- Moving `GLOBAL_EVENT_DIRECTORY`, `syncEventSessionID` and `syncEventMessageID` touches three consumers (`events.test.ts`, `sync-context.tsx`, `event-pipeline.ts`). The re-export keeps two of them unchanged.
