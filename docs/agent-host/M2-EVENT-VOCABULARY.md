# M2: canonical event vocabulary

Status: design agreed on 2026-09-27. Implements the event part of [DESIGN.md](DESIGN.md) under the M1-style rule in [ROLLOUT.md](ROLLOUT.md): establish the seam with zero behavior change. The implementation plan is in `plans/`.

## Goal

The canonical event vocabulary belongs to the agent module, not to the OpenCode module. After M2, `lib/agent/` owns the event types and `lib/opencode/events.ts` owns only the wire translation.

## What already exists

The sync layer already reduces a domain vocabulary, not wire shapes. `lib/opencode/events.ts` defines `SyncEvent` and translates OpenCode wire events into it (`translateWireEvent`). The reducer and every store consume `SyncEvent`. Only `events.ts` imports the wire type `OpenCodeEvent`.

So M2 is not a new event model. It is a move: the vocabulary types leave the OpenCode module and the translation stays.

## What moves

These pure type definitions move verbatim from `lib/opencode/events.ts` to a new `lib/agent/events.ts`:

- `SessionPatch`
- `MessagePatch`
- `ToolTransition`
- `CatalogKind`
- `SyncEvent`
- `OpenchamberNotification`
- `SyncEventType`
- `RoutedSyncEvent`

They reference only domain types from `lib/opencode/model.ts` (`Session`, `Message`, `Part`, `ModelRef`, `Metadata`, `TokenUsageInfo`, `PermissionRuleset`, `PermissionRequest`, `FormRequest`, `SessionStatus`, `StructuredError`, `JsonValue`, `FilePart`). The domain model import is valid; the event vocabulary is domain, and the domain model is where the shapes live.

The canonical name `AgentEvent` is added in `lib/agent/events.ts` as an alias of the moved `SyncEvent`. The union keeps its current name and members, so no member or reference churns.

## What does not change

- `lib/opencode/events.ts` keeps every function: `translateWireEvent`, `routeWireEvent`, `syncEventSessionID`, `syncEventMessageID`, `messageIdFromEvent`, and the value `GLOBAL_EVENT_DIRECTORY`. It imports the moved types and re-exports them under their current names.
- Every existing consumer keeps compiling without an edit, because `events.ts` re-exports `SyncEvent` and the rest.
- No `subscribe` on the contract. The stream is owned by `event-pipeline.ts` and wiring it is M3.
- No behavior change. The move is type-only.

## Dependency direction

```
lib/agent/events.ts  -->  lib/opencode/model.ts     (domain model, valid)
lib/opencode/events.ts  -->  lib/agent/events.ts    (translation uses the vocabulary)
lib/agent/events.ts  --X  lib/opencode/events.ts    (never)
```

## Verification

- `packages/ui/src/lib/opencode/events.test.ts` still passes, proving the translation is untouched.
- `bun run --cwd packages/ui type-check` passes, proving every consumer still compiles against the re-exported types.
- `bun run --cwd packages/ui test` passes (same known upstream failures as before the change, none new).

## Risks

- `lib/opencode/events.ts` is upstream-tracked and heavily edited (933 lines). The edit removes type blocks and adds an import plus a re-export; it is mechanical but not thin. The re-export keeps every other file unchanged, so the conflict surface stays inside one file.
- The moved union still carries OpenCode-specific members (`catalog.updated`, `session.inbox.*`, `session.execution.*`). M2 moves the whole union; splitting the OpenCode-only members out is a later milestone.
- M2 changes nothing observable. Its value is structural: it puts the vocabulary where M3 needs it.
