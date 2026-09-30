# Phase 6: ACP runtime

Status: design proposed 2026-09-29, implementation not started. Follows phase 5 ([PHASE5-OMP.md](PHASE5-OMP.md)) and the program in [ROLLOUT.md](ROLLOUT.md). Owner: the maintainer — the open questions at the end need answers before code.

## Goal

OpenChamber can run any ACP-compatible agent (OMP, Claude, Gemini, ...) as a runtime behind the same `AgentRuntime` contract, without a second copy of the UI.

## What ACP is

The Agent Client Protocol is JSON-RPC 2.0 over newline-delimited stdio: the client launches the agent as a subprocess and speaks requests, responses and notifications with it ([transports](https://agentclientprotocol.com/protocol/v1/transports)).

- Client to agent methods: `initialize`, `authenticate`, `session/new`, `session/prompt`, `session/cancel` (notification), and optional `session/load`, `session/set_mode`, `logout`.
- Agent to client notifications: `session/update`, carrying `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan` and other kinds. A prompt turn ends with the `session/prompt` response and its stop reason.
- Agent to client requests (the client must answer): `session/request_permission` (baseline), plus the optional `fs/read_text_file`, `fs/write_text_file` and `terminal/*` surface.

So ACP is both a session API and a **bidirectional client role**: unlike OpenCode (HTTP we proxy) and OMP (SDK we host), OpenChamber has to be the ACP client and answer the agent's own requests.

## Decisions (proposed)

1. **A new fork-owned package `packages/acp-adapter/` (`@openchamber/acp-adapter`)** holds the ACP client and the wire types. It mirrors `packages/omp-adapter/`: an `AcpRuntime` over an `AcpHost` seam, with the real stdio client behind `acp-host.ts`, so the runtime is testable with a fake.
2. **The server hosts the client**, like OMP. A fork-owned `packages/web/server/lib/agents/acp-*` module spawns the agent process, runs the ACP client, projects ACP updates onto `SyncEvent`s, and pushes `openchamber:acp` frames. Reuse the OMP host shape (`omp-runtime-host.js`) and the same routes family (`/api/agents/acp/*`).
3. **The event mapping stays server-side and canonical.** ACP `session/update` kinds map onto the existing vocabulary (table below). The UI never sees raw ACP.
4. **The UI gets `AcpRuntimeClient`** over the ACP routes, registered with `runtimeId = "acp"`; the runtime resolution, capability gating and entry-point work from phase 5 already generalise, so the UI change is a client plus one frame branch.
5. **`session/request_permission` maps to the existing permission flow.** This is the piece OMP lacked: an agent-initiated request becomes `permission.asked`, the user's answer becomes `permission.replied`, and the client resolves the pending JSON-RPC request. ACP therefore declares `permissions: true`.
6. **The `fs/*` and `terminal/*` client surface is not implemented in the first milestone.** The agent runs as its own subprocess with its own filesystem access; delegating file and terminal access through OpenChamber is a privilege decision, not a requirement. The client answers those methods with "method not found" until a milestone needs them.
7. **Feature flag `OPENCHAMBER_ACP_RUNTIME`, off by default**, and the adapter's dependency lives in the fork-owned package's `package.json` (no shared `package.json` gains one), exactly as phase 5.

## Milestones

| # | What it does |
|---|---|
| P6.1 | `packages/acp-adapter/` with `AcpRuntime` over an `AcpHost` seam (list/create/get session, prompt, cancel, permission reply, subscribe) and unit tests. Done. |
| P6.2 | The ACP JSON-RPC client over an injectable transport: `initialize`, `session/new`, `session/prompt`, `session/cancel`, normalized `session/update`, `session/request_permission` replies, and method-not-found for the unimplemented client surface. Done (`acp-host.ts`). |
| P6.3 | The server hosts it: the stdio process transport (spawn the agent), ACP routes, the process registry, and `openchamber:acp` frames on the shared bridge. The routes are always registered; each request is served only when enabled — `OPENCHAMBER_ACP_RUNTIME=1` forces it on, otherwise the `acpRuntimeEnabled` setting decides, read per request. Done (`acp-transport.js`, `acp-runtime-host.js`, `acp-routes.js`). |
| P6.4 | `AcpRuntimeClient` in the UI, registered with `runtimeId = "acp"`, plus the shared `openchamber:omp`/`openchamber:acp` frame branch in `event-pipeline.ts` and an ACP option in the composer's runtime control. Done. |
| P6.5 | The full ACP `session/update` to `SyncEvent` mapping. Done (`mapping-events.ts`). |

Order: P6.1, P6.2, P6.3, P6.4, P6.5. Each milestone follows the phase 5 rules: fork-owned code first, thin edits to shared files, sync often.

Progress: all five milestones landed on 2026-09-29 (`packages/acp-adapter`, `packages/web/server/lib/agents/acp-*`, `packages/ui/src/lib/agent/acp-runtime.ts`, 18 adapter tests, 31 server tests). The stdio process transport lives with the server so the adapter stays free of Node-only types. The handshake (`initialize` + `session/new`) was verified against a real `omp acp` subprocess on 2026-09-29 (session id returned); a full prompt round-trip was not run because it needs model credentials. The default command is `omp acp` (`OPENCHAMBER_ACP_COMMAND` overrides it).

## Event mapping (P6.5 sketch)

| ACP `session/update` | `SyncEvent` |
|---|---|
| `user_message_chunk` | `message.part.delta` (field `text`) on the user message |
| `agent_message_chunk` | `message.part.delta` (field `text`) on the assistant message |
| `agent_thought_chunk` | `message.part.delta` on a reasoning part |
| `tool_call` | `message.part.updated` (tool part, `pending`/`in_progress`) |
| `tool_call_update` | `message.tool.transition` (`progress`/`success`/`failed`) |
| `plan` | not modelled yet (no canonical `SyncEvent`) |
| prompt response stop reason | `session.idle` |
| `session/request_permission` | `permission.asked`; reply -> `permission.replied` |

Message and part identity follows the phase 5 convention: ACP carries a `sessionId` but no message ids in v1, so ids are derived the same way (`acp:<sessionId>:<role>:<timestamp>`), and a client-supplied prompt id reconciles the optimistic message.

## Capabilities for ACP

`permissions: true`, `attachments: true` (ACP prompts carry content blocks, including images), `modelSelection`/`agentSelection`/`forms`/`revert`/`turnDiff`/`fork`/`mcp`/`skills`/`commands`/`rename`/`delete`/`move`: false until the agent advertises the matching capability or a milestone maps it.

## Open questions

- **Which agent first.** ACP reaches OMP, Claude and Gemini; OMP already has a native SDK runtime from phase 5. Targeting a different agent (e.g. Gemini) exercises ACP's value, while targeting OMP proves parity. The maintainer picks.
- **Process lifecycle.** One agent process per session, or one per runtime with many sessions? ACP `session/new` is cheap; a shared process costs less memory but couples failures across sessions.
- **`session/load` and history.** v1 `session/load` is optional and carries its own replay notifications; without it, reopening a session has no history. Decide whether to require it or keep our own history.
- **`fs/*` and `terminal/*`.** Answer "method not found" (proposed) or delegate to OpenChamber's filesystem/PTY. Delegation is a privilege boundary the isolated-space work already reasons about; do not add it without that review.
- **Permission round-trip transport.** `session/request_permission` is a pending JSON-RPC request while the user decides; it needs a request id that survives the server bridge and comes back on `permission.replied`.
- **Packaging and runtime.** The adapter and the agent CLI are process-spawning code; confirm the Bun requirement the way phase 5 did for OMP, and where the agent binary comes from.
