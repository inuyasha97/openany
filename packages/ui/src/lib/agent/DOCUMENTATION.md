# lib/agent

Fork-owned agent runtime seam. See `docs/agent-host/DESIGN.md` and `docs/agent-host/ROLLOUT.md`.

## Files

- `contract.ts` holds `AgentRuntime`, `AgentCapabilities`, and the parameter types. Runtime-neutral.
- `opencode-runtime.ts` holds `OpenCodeRuntime`, the adapter over `opencodeClient`, and `SessionClient`, the structural client type it depends on.
- `registry.ts` holds `getAgentRuntime()` and `setAgentRuntime()`. The active runtime is resolved at call time, never cached across endpoints.

## Rules

- Callers use `getAgentRuntime()`, not `opencodeClient`, for agent-domain operations.
- The adapter is the only file here that imports `opencodeClient`.
- The contract grows only when a caller migrates; do not add methods no one uses.
