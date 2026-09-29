# lib/agent

Fork-owned agent runtime seam. See `docs/agent-host/DESIGN.md` and `docs/agent-host/ROLLOUT.md`.

## Files

- `contract.ts` holds `AgentRuntime`, `AgentCapabilities`, and the parameter types. Runtime-neutral. It also defines `AgentSession`, a `Session` that names its runtime and native session id.
- `events.ts` holds the canonical event vocabulary: `AgentEvent` (alias `SyncEvent`) and the payload types. Runtime-neutral; the OpenCode adapter translates wire events into these in `lib/opencode/events.ts`.
- `opencode-runtime.ts` holds `OpenCodeRuntime`, the adapter over `opencodeClient`, and `SessionClient`, the structural client type it depends on.
- `omp-runtime.ts` holds `OmpRuntimeClient`, the OMP adapter over the server's `/api/agents/omp/*` routes. It has `id = "omp"`, no optional capabilities, and rejects every unsupported operation. Sessions (create/list/get), messages and prompts are implemented; `sendPrompt` forwards the client's `messageId` so the optimistic message reconciles. OMP events reach the UI already projected on the `openchamber:omp` bridge frame, so its `translateEvent` returns nothing.
- `registry.ts` holds the runtime manager: `getAgentRuntime(runtimeId?)`, `registerAgentRuntime()`, `clearAgentRuntimes()`. A registered runtime wins by id; otherwise a built-in runtime is built once (`"opencode"` or `"omp"`). It also binds a session to its runtime: `registerSessionRuntime`/`forgetSessionRuntime` and `getAgentRuntimeForSession(sessionId)`, which defaults to OpenCode so it is inert until a second runtime creates sessions. Resolved at call time, never cached across endpoints.
- `use-agent-runtime.ts` holds `useAgentRuntime()`, the React access to the active runtime.
- `omp-availability.ts` probes `GET /api/agents/omp/status` (404 means the server has the runtime off) and exposes `useOmpRuntimeAvailable(enabled)` so the affordance only appears when OMP can be served.
- `session-capabilities.ts` (`resolveSessionCapabilities`) answers what a session's runtime supports, from its `AgentCapabilities`; components gate controls on it instead of testing a runtime name. OpenCode resolves all-true.

## Rules

- Callers use `getAgentRuntime()`, not `opencodeClient`, for agent-domain operations.
- The adapter is the only file here that imports `opencodeClient`.
- The event vocabulary is defined here and re-exported from `lib/opencode/events.ts`. Do not define event types in the OpenCode module.
- The runtime owns wire translation: the adapter exposes `translateEvent`, and the sync pipeline calls it instead of importing `lib/opencode/events`.
- `contract.ts` carries the session, message, permission, form, revert and catalog operations. Every method is required; `AgentCapabilities` gates which ones a caller uses.
- React callers use `useAgentRuntime()`; plain modules use `getAgentRuntime()`. Agent-domain calls go through the runtime; OpenChamber-owned and OpenCode-specific calls stay on `opencodeClient`.
- A projected session carries `runtimeId` and `nativeSessionId`. Stores keep the base `Session` type; code that needs the runtime identity types as `AgentSession`.
- `AgentMessage` and `AgentPart` are the contract's names for messages and parts. They equal the domain model while one runtime exists.
- The contract grows only when a caller migrates; do not add methods no one uses.
