# M7: canonical AgentMessage and AgentPart

Status: design agreed on 2026-09-27. Seventh milestone of the program in [ROLLOUT.md](ROLLOUT.md). Zero behavior change.

## Goal

The canonical vocabulary names messages and parts. After M7, `AgentMessage` and `AgentPart` are the contract's names for them, and `MessagePage` carries those names.

## Shape

`AgentMessage` and `AgentPart` are aliases of the existing domain types:

```ts
export type AgentMessage = Message
export type AgentPart = Part
```

They are names, not new shapes. A later runtime that needs different message or part semantics gives these names their own shape; until then they equal the domain model.

`MessagePage` changes to use them:

```ts
export type MessagePage = {
  items: Array<{ info: AgentMessage; parts: AgentPart[] }>
  cursor: { previous?: string; next?: string }
}
```

## What does not change

- `Message` and `Part` and every store typed with them.
- `projection.ts` and the message projection. Moving it behind the adapter is out of scope.
- No behavior change: aliases are the same types.

## Verification

- `bun run --cwd packages/ui type-check` passes, proving every consumer still compiles.
- `bun run --cwd packages/ui test` holds at the two known upstream failures.

## Risks

- None material. The change is two aliases and one field type.

## Deferred

Moving message and part projection into the adapter (the original M7 intent) is deferred: it would make `opencodeClient` return raw wire shapes and touch every message consumer, a risk larger than M6's. Revisit when a second runtime needs a different message projection.
