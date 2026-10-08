# lib/agent

Fork-owned agent runtime seam. See `docs/agent-host/DESIGN.md` and `docs/agent-host/ROLLOUT.md`.

## Files

- `contract.ts` holds `AgentRuntime`, `AgentCapabilities`, and the parameter types. Runtime-neutral. It also defines `AgentSession`, a `Session` that names its runtime and native session id.
- `events.ts` holds the canonical event vocabulary: `AgentEvent` (alias `SyncEvent`) and the payload types. Runtime-neutral; `@openchamber/omp-adapter` projects OMP's own events onto these server-side, so the UI never sees a raw OMP event.
- `omp-runtime.ts` holds `OmpRuntimeClient`, the only `AgentRuntime` implementation: `id = "omp"`, one method per contract operation, and every capability OMP cannot back declared `false` with its reason beside it. Sessions, messages, prompts, commands, skills, permissions, forms, MCP, model and thinking control, and fork are implemented; the rest reject through `unsupported(...)`. `sendPrompt` forwards the client's `messageId` so the optimistic message reconciles, and folds `skills` into the prompt text because OMP cannot attach a skill by id. OMP events arrive already projected on the `openchamber:omp` bridge frame, so `translateEvent` returns nothing.
- `registry.ts` holds the runtime manager: `getAgentRuntime(runtimeId?)`, `registerAgentRuntime()`, `clearAgentRuntimes()`. OMP is the default and the only built-in runtime; a registered runtime wins by id, which is how tests inject a double. It also binds a session to its runtime: `registerSessionRuntime`/`forgetSessionRuntime` and `getAgentRuntimeForSession(sessionId)`, which defaults to OMP. Resolved at call time, never cached across endpoints.
- `use-agent-runtime.ts` holds `useAgentRuntime()`, the React access to the active runtime.
- `session-capabilities.ts` (`resolveSessionCapabilities`) answers what a session's runtime supports, from its `AgentCapabilities`; components gate controls on it instead of testing a runtime name.

## Rules

- Callers use `getAgentRuntime()` for agent-domain operations and `@/lib/openchamber/client` for the OpenChamber-owned surface.
- The adapter is the only file here that talks to a runtime; OpenChamber-owned calls never pass through it.
- The event vocabulary is defined here and re-exported from `lib/opencode/events.ts`. Do not define event types in the OpenCode module.
- The runtime owns wire translation: the adapter exposes `translateEvent`, and the sync pipeline calls it instead of importing `lib/opencode/events`.
- `contract.ts` carries the session, message, permission, form, revert and catalog operations. Every method is required; `AgentCapabilities` gates which ones a caller uses.
- React callers use `useAgentRuntime()`; plain modules use `getAgentRuntime()`. Agent-domain calls go through the runtime; OpenChamber-owned calls stay on `openChamberClient`.
- A projected session carries `runtimeId` and `nativeSessionId`. Stores keep the base `Session` type; code that needs the runtime identity types as `AgentSession`.
- `AgentMessage` and `AgentPart` are the contract's names for messages and parts. They equal the domain model while one runtime exists.
- The contract grows only when a caller migrates; do not add methods no one uses.
- A capability that is `false` means no caller may reach the operation. Gate the caller on it (`useAgentsStore.loadAgents` stops before its retry loop this way) rather than letting it hit the `unsupported` rejection.
- The server imports the built adapter (`@openchamber/omp-adapter` → `dist/index.js`), never the `.ts` sources: the same module is loaded by Node inside Electron, which can resolve neither extensionless specifiers nor TypeScript. `bun run --cwd packages/omp-adapter build` produces it; the web and Electron build steps run that first.
