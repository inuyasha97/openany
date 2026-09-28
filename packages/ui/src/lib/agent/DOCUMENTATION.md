# lib/agent

Fork-owned agent runtime seam. See `docs/agent-host/DESIGN.md` and `docs/agent-host/ROLLOUT.md`.

## Files

- `contract.ts` holds `AgentRuntime`, `AgentCapabilities`, and the parameter types. Runtime-neutral.
- `events.ts` holds the canonical event vocabulary: `AgentEvent` (alias `SyncEvent`) and the payload types. Runtime-neutral; the OpenCode adapter translates wire events into these in `lib/opencode/events.ts`.
- `opencode-runtime.ts` holds `OpenCodeRuntime`, the adapter over `opencodeClient`, and `SessionClient`, the structural client type it depends on.
- `registry.ts` holds `getAgentRuntime()` and `setAgentRuntime()`. The active runtime is resolved at call time, never cached across endpoints.

## Rules

- Callers use `getAgentRuntime()`, not `opencodeClient`, for agent-domain operations.
- The adapter is the only file here that imports `opencodeClient`.
- The event vocabulary is defined here and re-exported from `lib/opencode/events.ts`. Do not define event types in the OpenCode module.
- The runtime owns wire translation: the adapter exposes `translateEvent`, and the sync pipeline calls it instead of importing `lib/opencode/events`.
- The contract grows only when a caller migrates; do not add methods no one uses.
