# Phase 4: AgentManager

Status: design agreed on 2026-09-27. First milestone of phase 4. Zero behavior change.

## Goal

The registry resolves a runtime by id, so a session can be handled by the runtime it belongs to. Until a second runtime exists, the manager resolves everything to the OpenCode runtime.

## Shape

`packages/ui/src/lib/agent/registry.ts` becomes a manager:

```ts
export const getAgentRuntime = (runtimeId: string = DEFAULT_RUNTIME_ID): AgentRuntime
export const registerAgentRuntime = (runtime: AgentRuntime): void
export const clearAgentRuntimes = (): void
```

- `DEFAULT_RUNTIME_ID` is `"opencode"`.
- `getAgentRuntime()` resolves the default id. A registered runtime for that id wins; otherwise a lazily built `OpenCodeRuntime` is returned.
- `getAgentRuntime("omp")` returns the runtime registered under `"omp"`, or the default runtime when nothing is registered. A future manager can turn the unknown-id fallback into an error.
- `registerAgentRuntime` keys by `runtime.id`.
- `clearAgentRuntimes` empties the map, for tests.

`setAgentRuntime` is removed; the registry test switches to `registerAgentRuntime` and `clearAgentRuntimes`.

## What does not change

- The contract. No `subscribe` in phase 4; it belongs to phase 5, where OMP owns its own event stream. The OpenCode runtime does not own a stream, and OpenChamber owns the transport.
- `event-pipeline.ts` and the transport.
- `useAgentRuntime()` and every migrated caller, which call `getAgentRuntime()` with no id.

## Verification

- The registry test covers the default, a registered id, and the fallback for an unregistered id.
- `bun run --cwd packages/ui type-check` and `bun run --cwd packages/ui test`, holding at the two known upstream failures.

## Risks

- The manager is preparatory while one runtime exists. Its value arrives with the second runtime.
