# Phase 5: OMP runtime

Status: decisions agreed on 2026-09-27, implementation not started beyond the package skeleton. Depends on phase 4 ([PHASE4-AGENT-MANAGER.md](PHASE4-AGENT-MANAGER.md)).

## Goal

OpenChamber can run Oh My Pi (OMP) as a second agent runtime, alongside OpenCode.

## How OpenCode is handled today

The OpenChamber server spawns and manages the OpenCode process (`packages/web/server/lib/opencode/lifecycle.js`), proxies its HTTP API under `/api`, and bridges its event stream (`/api/event` SSE, `/api/global/event/ws`). The UI reaches OpenCode only through the OpenChamber server. OpenCode is out-of-process and reached over HTTP.

## How OMP differs

OMP has no HTTP server API. Its surfaces are the SDK (in-process), RPC (JSONL stdio) and ACP (JSON-RPC stdio). So the server cannot proxy OMP; it has to host it.

## Decisions

1. **OMP SDK, in-process, in the OpenChamber server.** Chosen over ACP or RPC for the fullest OMP feature set. Reference: Grove's `packages/omp-adapter/src/sdk.ts` (`SdkAdapter`), which hosts OMP in-process and emits a canonical event stream.
2. **A separate fork-owned package `packages/omp-adapter/` (`@openchamber/omp-adapter`)** holds the OMP dependency. The root `package.json` uses `workspaces: ["packages/*"]`, so no root edit is needed; `bun.lock` changes and will conflict on upstream sync, which is unavoidable for a new dependency. Pinned to `@oh-my-pi/pi-coding-agent@18.1.11`, the version Grove uses.
3. **Event mapping OMP to `SyncEvent` happens server-side.** The adapter emits canonical events; the UI never sees raw OMP events. The UI reaches them over the existing bridge as an OpenChamber frame.
4. **No shared contract package.** The contract, event vocabulary and domain model stay in `packages/ui` (moving `lib/opencode/model.ts`, which upstream edits, would make every upstream edit a conflict forever). The server-side adapter and `packages/web` reference the canonical types **type-only** through deep imports into `@openchamber/ui/src/...`. `packages/vscode` already depends on `@openchamber/ui`, so the dependency direction has precedent.
5. **The UI gets `OmpRuntimeClient`**, an `AgentRuntime` implementation over the OMP server routes, registered in the manager with `runtimeId = "omp"`. `OpenCodeRuntime` stays the default.

## Milestones

| # | What it does |
|---|---|
| P5.1 | `packages/omp-adapter/` with a minimal `OmpRuntime` (list/create/get session, prompt, abort) and unit tests. No server or UI wiring. |
| P5.2 | The server hosts the adapter: OMP routes, and canonical events pushed onto the existing bridge as a new `openchamber:*` frame. |
| P5.3 | `OmpRuntimeClient` in the UI over the OMP routes, registered with `runtimeId = "omp"`; one new frame branch in `event-pipeline.ts`. |
| P5.4 | The full OMP event to `SyncEvent` mapping (the largest piece, comparable to Grove's `mapping.ts`). |

Order: P5.1, then P5.2, then P5.3, then P5.4.

## Status

Phase 5 complete on 2026-09-29. All four milestones are implemented and tested; the one remaining item is a product decision (a UI affordance to create and select OMP sessions), which is the maintainer's call and is not part of the milestones.

Done so far:

- P5.1: `packages/omp-adapter/` holds `OmpRuntime` over an `OmpHost` seam, with 6 tests (`runtime.ts`, `runtime.test.ts`, `index.ts`). See `plans/2026-09-27-p5-1-omp-runtime.md`.
- The real SDK binding: `sdk-host.ts` (`createOmpHost()`), using `SessionManager.listAll()`, `createAgentSession({ cwd })`, `session.switchSession(path)`, and the handle's `sessionId`/`prompt`/`abort`/`subscribe`/`dispose`/`sessionFile`.
- The package resolves the canonical types through the UI path alias (`@openchamber/ui/*` and `@/*` -> `../ui/src/*` in `packages/omp-adapter/tsconfig.json`), so `SyncEvent` is imported type-only from `@openchamber/ui/lib/agent/events`. Verified working.
- P5.4: `model.ts` holds the fork-owned OMP shapes; `mapping-messages.ts` projects OMP messages and content onto `Message`/`Part`; `mapping-events.ts` holds `createOmpEventProjector()`, a per-session stateful projector. 24 adapter tests, all green.

### P5.4: what the projector covers

- Run boundaries: `agent_start` -> `session.status busy`, `agent_end` -> `session.idle`.
- User messages: `message_start` -> `message.updated` plus `message.parts.replaced` (text and image files as data URLs).
- Assistant messages: `message_start` -> `message.updated`; `text_*`/`thinking_*` -> `message.part.updated` and `message.part.delta` on `partIds`-style ids; `toolcall_*` -> the pending tool part, its raw argument delta and the `input` transition; `message_end` -> `message.patched` (finish, cost, tokens, error) plus `message.parts.replaced` to reconcile parts the stream skipped.
- Tool execution: `tool_execution_start` -> the tool part updated to `running` (so a late subscriber still gets the part); `tool_execution_end` -> a `success`/`failed` transition with output text and image attachments.
- Retries: `auto_retry_start` -> `session.status retry` with `next = now + delayMs`; `auto_retry_end` -> `session.status busy` on recovery or `session.error` on exhaustion.
- Compaction: `auto_compaction_start` -> a running `compaction` message; `auto_compaction_end` -> the settled record with the summary (failed when the event carries an error); a skipped compaction emits nothing.

### P5.4: identity convention (was an open question)

- Message id: `omp:<sessionId>:<role>:<timestamp>`. OMP messages carry no id, so it is derived from the message timestamp. The session id is included because the UI keys parts by message id alone, which must be unique across sessions.
- Part id: text and reasoning use the content index (`<messageId>:text:<index>`, `<messageId>:reasoning:<index>`), tool calls use the provider call id. Both match the `partIds` convention in `lib/opencode/model.ts`; the adapter keeps a local copy because it may not import UI values.

### Intentionally unmapped OMP events

The projector's `default` branch drops them; none has a canonical `SyncEvent` today.

- Tool progress: `tool_execution_update` (its `partialResult` is not the UI's tool-progress metadata) and `tool_execution_stream`.
- Notices and advisory frames: `notice`, `goal_updated`, `todo_reminder`, `todo_auto_clear`, `advisor_cost_changed`, `advisor_yielded`, `irc_message`, `ttsr_triggered`.
- Session-shape changes the UI cannot act on yet: `model_changed`, `config_warnings_changed`, `thinking_level_changed`, `retry_fallback_applied`, `retry_fallback_succeeded`.
- Permissions and forms do not exist in OMP's event stream (it has tool approval gates instead), so those `SyncEvent`s have no source. Not "deferred": not applicable.

### P5.2: the server hosts the adapter

Fork-owned `packages/web/server/lib/agents/` holds three modules, all unit-tested against a fake adapter (`bunx vitest run server/lib/agents`):

- `omp-runtime-host.js` (`createOmpRuntimeHost`): owns one `OmpRuntime` and one projector per session, and broadcasts each projected batch as a single `openchamber:omp` frame `{ sessionID, directory, events }` on the shared control stream. `directory` is the session cwd when known.
- `omp-routes.js` (`registerOmpRoutes`): `GET /api/agents/omp/sessions`, `POST /api/agents/omp/sessions`, `POST /api/agents/omp/sessions/:id/prompt`, `POST /api/agents/omp/sessions/:id/abort`. Bodies are parsed per route, and an unknown session is a 404.
- `index.js` (`installOmpAgentRuntime`): the flag gate and the lazy adapter import.

The adapter's `OmpRuntime.subscribe` now passes `(sessionId, event)`; the projector is stateful per session and OMP events carry no session id, so the runtime supplies it.

Wiring: thin edits to `packages/web/server/index.js` (one import, one mount call after the feature routes register and before the generic proxy, plus a shutdown getter) and one cleanup step in `packages/web/server/lib/opencode/shutdown-runtime.js` that disposes the host. The routes are always registered; each request is served only when the runtime is enabled — `OPENCHAMBER_OMP_RUNTIME=1` forces it on, otherwise the `ompRuntimeEnabled` setting decides, read per request so a settings toggle needs no restart. With neither on the adapter is never imported and the OpenCode-only path is unchanged.

Packaging decision: `packages/web/package.json` gained no dependency. The fork-owned server module imports the adapter by relative path (`../../../../omp-adapter/src/index.ts`), resolved when the flag is on. The adapter and the OMP SDK are TypeScript-only, so the OMP path requires the server to run under Bun; the default path does not.

### P5.3: the UI client and the bridge branch

- `packages/ui/src/lib/agent/omp-runtime.ts` (`OmpRuntimeClient`) implements `AgentRuntime` over the OMP routes with `id = "omp"` and every optional capability `false`. Sessions, prompts and cancels are implemented; every unsupported method rejects with `OMP runtime does not support <operation>` rather than returning an empty result. `translateEvent` returns nothing: OMP events arrive already projected on the bridge, not as raw wire payloads. The fetch implementation is injected, so the client is tested without a network (`bun test src/lib/agent/omp-runtime.test.ts`).
- `packages/ui/src/lib/agent/registry.ts` resolves `"omp"` to a built-in `OmpRuntimeClient` (built once, like the OpenCode default). This is inert: no caller requests the `"omp"` id until the UI gains OMP affordances, so the OpenCode path is unchanged.
- `packages/ui/src/sync/event-pipeline.ts` gains an `openchamber:omp` branch: the envelope is validated, the events are routed to the frame's `directory` (session cwd), falling back to the global queue. Tested in `event-pipeline.test.ts`.

Surfaces: the client reaches the server through `runtimeFetch`, so it works wherever the OMP routes and the control stream are reachable (web, Electron, hosted, Capacitor). It is **inert** on every surface until a UI affordance creates an OMP session; VS Code additionally needs the new `/api/agents/omp/*` paths forwarded by its webview bridge before it can be used there.

### Post-phase: groundwork a UI affordance needs

Done after the milestones, so an affordance can be built without further server or mapping work.

- Session discovery: the host announces each newly seen OMP session once as `session.created` (on create and on list), so the UI store holds the session before its messages arrive. The global session list also merges sessions from other runtimes: `listAdditionalRuntimeSessions()` lists the mounted ones after the OpenCode snapshot, and the merge is additive, so a reload keeps them and an unavailable or failed listing preserves what is already known instead of dropping it.
- History: `OmpSessionHandle.messages()` reads the SDK's current history; `projectOmpHistory` projects it to a `MessagePage`, folding each `toolResult` into the tool part of the call it answered. Exposed as `GET /api/agents/omp/sessions/:id/messages`, and `OmpRuntimeClient.getMessages` now calls it instead of rejecting.
- Optimistic reconciliation: the client supplies its own `messageId` to `sendPrompt`; the route forwards it and the host declares it to the projector, which gives the next user `message_start` that id. `sendPrompt` returns the same id. The optimistic message reconciles in place; no duplicate.
- Runtime resolution by session: `registry.ts` exposes `registerSessionRuntime`/`forgetSessionRuntime`/`getAgentRuntimeForSession(sessionId)`. `createSession` accepts an optional `runtimeId`, uses it, and registers the binding; an `openchamber:omp` `session.created` frame registers the binding for a session found on list; the binding is dropped on confirmed deletion. The chat send path (`session-ui-store`), the abort path, the session reload path (`session-actions`), and the history loader (`sync-context`'s `messagePageSource`) now resolve the runtime per session. An OpenCode session resolves to the exact same client call as before, so this is inert until something creates an OMP session.
- Entry point: the OMP runtime is offered in the new-session composer via `RuntimeControl`, shown only while a session is drafting and only when the server reports the runtime enabled. It is switched on in Settings (the `ompRuntimeEnabled` row under OpenChamber tools), not only by the env flag; off by default. The choice is stored on the draft (`NewSessionDraftState.runtimeId`) and passed to `createSession`. A drafted OMP session uses the current project directory as its cwd; it appears in the same sidebar/project list; model/agent stay empty (OMP defaults). The label is translated in all locale dictionaries.

Still needed for a general affordance (Chặng 2): directory-scoped and app-level callers (catalog, providers, directory status, permission/form lists) still assume OpenCode, so an OMP session's other controls may still reflect OpenCode. VS Code already forwards `/api/*` through its existing webview proxy, so the OMP routes need no allowlist change there (not yet verified in a running VS Code instance). Session-scoped actions (rename, delete, move, fork, revert, reply-permission/form, session read, messages, cancel) now resolve `getAgentRuntimeForSession`, so they reach the owning runtime; an unsupported one rejects instead of silently hitting OpenCode.

Capability gating (Chặng 2, started): `resolveSessionCapabilities(sessionId, draftRuntimeId?)` answers what a session's runtime supports. `AgentCapabilities` gained `rename`, `delete`, `move` and `attachments` so session mutations and prompt attachments can be gated like the rest. The composer hides the model/agent pickers when the runtime does not own selection (OMP uses its own default, so no separate picker is built), hides the permission auto-accept control when `permissions` is false, and hides the attach menu (files, issues, PRs, guests) when `attachments` is false, so an attachment is never silently dropped; the sidebar session menu hides rename, hard-delete and the worktree move submenu; message and timeline actions hide fork and revert, and the assistant turn-diff pills hide when `turnDiff` is false. The send path resolves commands and skills through the session's runtime and skips slash-command resolution entirely when `commands` and `skills` are both unsupported, so `/name` travels as plain text instead of reaching OpenCode. OpenCode sessions resolve all-true, so the OpenCode UI is unchanged. Forms and goal have no capability and are not gated.

## Open questions

- No UI affordance creates or lists OMP sessions, so nothing user-reachable uses the client. That affordance is a product decision for the maintainer; the phase's engineering is complete without it. The four questions it has to answer are in the proposal: entry point, whether OMP sessions share the OpenCode sidebar/project list, directory scoping, and model/agent selection.


