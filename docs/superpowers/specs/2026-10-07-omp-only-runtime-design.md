# OMP-only runtime for openany (web + electron)

Status: approved design, 2026-10-07. Owner: maintainer.

## Context

This repository (`openany`) is a fork of OpenChamber. Its agent-host work
(`docs/agent-host/`) added OMP and ACP as optional runtimes next to OpenCode,
with OpenCode staying the default and the OpenCode-only path unchanged.

This design takes the fork in the opposite direction: **OMP becomes the only
agent runtime; OpenCode is removed.** The shared UI in `packages/ui` is kept
as-is; only the runtime underneath it changes. The fork stops syncing from
upstream, so a large, clean deletion is acceptable where the previous rollout
kept the diff small.

Scope is **web** (`packages/web` server + browser UI) and **electron**
(`packages/electron`). `packages/vscode`, `packages/mobile` and hosted
surfaces are out of scope; they are left untouched and are not required to
build or run.

### Why RPC, not the SDK

OMP exposes three surfaces: SDK (in-process), RPC (JSONL stdio), ACP.

- The OMP **SDK requires Bun** and is explicitly not a Node.js SDK. The
  Electron desktop runs the OpenChamber server in-process under **Node**, so
  the SDK cannot load there. This is exactly why commit `5179ff1a0` disabled
  OMP on the desktop.
- OMP **RPC** (`omp --mode rpc`) is language-agnostic, and OMP ships a
  standalone binary per platform that already embeds Bun. It runs identically
  under Bun (web) and Node (electron).
- RPC covers the runtime the UI needs: prompt/abort, event streaming with the
  same event names the existing projector (P5.4) already maps, model catalog
  and selection, thinking level, slash commands and skills, provider login,
  history, compaction and retry, and tool approvals via
  `extension_ui_request`.
- The parts RPC lacks are all **config/state on disk** that the server can
  read and write the same way OMP itself does: session listing/deletion/move
  (JSONL session store) and MCP server management (`mcp.json`).

Decision: **RPC everywhere, with the server owning OMP config and session-store
files.** One integration path for both surfaces, no Bun requirement on the
desktop.

## Goals

- Keep `packages/ui` visually and behaviorally intact; swap the runtime behind
  the `AgentRuntime` contract.
- OMP works on web (Bun server) and electron (Node server) through one
  adapter.
- Remove OpenCode: server process management, proxy, routes, UI client,
  dependencies, and Electron binary bundling.
- Preserve OpenChamber-owned capabilities (fs, git, PTY, relay, tunnel,
  pairing, terminal) untouched.

## Non-goals

- vscode, mobile, hosted surfaces.
- Syncing from upstream OpenChamber.
- Building OMP-native equivalents for OpenCode-only features that have no OMP
  analog (forms, revert, turn-diff) — these are hidden via capability flags.
- MCP server management UI in the first phases (hidden until a later phase).

## Architecture

```
UI (packages/ui, unchanged rendering)
  └─ AgentRuntime contract (kept; single impl: OmpRuntimeClient)
       └─ HTTP  /api/agents/omp/*        (server routes)
            └─ OMP host (server, fork-owned)
                 ├─ RPC manager: one `omp --mode rpc` process per open session
                 ├─ projector: RPC frame -> SyncEvent   (reuse P5.4)
                 └─ session store: read/write ~/.omp/agent/sessions/*.jsonl
       └─ bridge frame `openchamber:omp` -> event-pipeline -> stores
```

The `AgentRuntime` contract stays even though only one runtime implements it.
It is the seam the UI already routes through (`registry.ts`,
`session-capabilities.ts`, `getAgentRuntimeForSession`), so keeping it means
minimal UI churn. The registry collapses to a single `omp` runtime.

## Components

### `packages/omp-adapter` (fork-owned; moved from SDK to RPC)

- `rpc-client.ts` — spawn `omp --mode rpc`, wait for the `ready` frame, frame
  JSONL, correlate responses by `id`, keep stderr separate from the protocol
  stream, negotiate protocol v2 with a v1 fallback, dispose cleanly (close
  stdin, await exit).
- `rpc-host.ts` — one RPC client per open session, spawned on demand and
  disposed when idle; fans events out to the projector. Replaces `sdk-host.ts`.
- `runtime.ts` — session lifecycle over RPC: `new_session`, `switch_session`,
  `prompt`, `abort`, `set_model`, `set_thinking_level`, `get_messages_page`,
  `set_session_name`, `get_available_models`, `get_available_commands`,
  `get_login_providers`, `login`.
- `session-store.ts` — scan `~/.omp/agent/sessions/**/*.jsonl`, parse the
  optional fixed-width `title` record and the `session` header
  (`id`, `cwd`, `title`, `timestamp`) for listing and `getSession`; delete and
  move by file operation. Respect the documented format (discover files, do
  not construct project paths).
- `model.ts`, `mapping-messages.ts`, `mapping-events.ts` — kept; the projector
  already consumes the same event vocabulary RPC emits
  (`message_update`, `message_start/end`, `tool_execution_*`, `agent_start/end`,
  `auto_retry_*`, `auto_compaction_*`), so the change is expected to be small.
- Removed: `sdk-host.ts`.

### `packages/web/server/lib/agents/` (fork-owned)

- `omp-runtime-host.js` — owns the RPC session pool and the per-session
  projector; broadcasts one `openchamber:omp` frame per projected batch on the
  shared control stream (same shape as today).
- `omp-routes.js` — routes over the host: sessions (list/create/get/messages/
  prompt/abort/rename/delete/move), models, commands, providers/login,
  approvals, status.
- `omp-config.js` — read/write OMP config files (`.omp/mcp.json`,
  `~/.omp/agent/mcp.json`, and `config.yml` where needed).
- `index.js` — installs routes; no Bun guard, so it works under Node.

### `packages/ui`

- `lib/agent/registry.ts` — single runtime `omp`; remove `OpenCodeRuntime` and
  `AcpRuntimeClient`.
- `lib/agent/omp-runtime.ts` — expand `OmpRuntimeClient` to cover models,
  commands, providers/login, approvals, history, and the session mutations
  now supported.
- `lib/agent/session-capabilities.ts` — OMP capability set.
- `lib/agent/contract.ts` — unchanged.
- Stores and `event-pipeline.ts` — drop the OpenCode branch once no caller
  resolves to it; `openchamber:omp` branch stays.
- Settings — remove OpenCode-specific settings; OMP is the default and there
  is no runtime toggle.
- Remove `lib/opencode/client.ts` and the `@opencode/client` /
  `@opencode/schema` dependencies; keep `lib/opencode/model.ts` and
  `events.ts` as the domain types.

### `packages/electron`

- `scripts/prepare-omp-cli.mjs` — download `omp-<platform>-<arch>` (pinned
  version) from `can1357/oh-my-pi` GitHub releases, verify and stage into
  `resources/omp-cli/`, mirroring `prepare-opencode-cli.mjs`.
- `extraResources` — add `resources/omp-cli`.
- Remove `prepare-opencode-cli.mjs`, `opencode-cwd.mjs`,
  `opencode-readiness.mjs`, and the OpenCode spawn/readiness path.
- Binary resolution in the server, mirroring `env-runtime.js`:
  `OPENCHAMBER_OMP_PATH` / `OMP_BINARY` -> bundled
  `process.resourcesPath/omp-cli/omp` -> `PATH`.

## Data flow

1. UI calls `OmpRuntimeClient` over `/api/agents/omp/*`.
2. A route asks the host for the session's RPC process; the host spawns
   `omp --mode rpc` with the session cwd if none exists.
3. The host sends the RPC command, correlates the response by `id`, and
   independently forwards stdout events.
4. The per-session projector maps each event to `SyncEvent`s and the host
   broadcasts one `openchamber:omp` frame.
5. The UI event pipeline routes the frame to the session's directory (or the
   global queue) and the stores update.

## Capability matrix (initial)

| Capability | OMP | Source |
|---|---|---|
| permissions | true | tool approval via `extension_ui_request` -> permission flow |
| modelSelection | true | `get_available_models` / `set_model` |
| rename | true | `set_session_name` |
| delete | true | session store |
| move | true | session store |
| commands | true | `get_available_commands` |
| skills | true | `get_available_commands` (source `skill`) |
| attachments | images only | RPC `images[]` |
| agentSelection | false (initially) | model roles not exposed cleanly over RPC |
| mcp | false (initially) | no RPC command; config-file phase later |
| forms | false | OMP has no equivalent |
| revert | false | OMP uses a different edit model |
| turnDiff | false | OMP uses a different edit model |

## Phases

### P1 — RPC adapter + server host
- `rpc-client.ts`, `rpc-host.ts`, `runtime.ts` over RPC; `session-store.ts`.
- Rework `omp-runtime-host.js` / `omp-routes.js` to drive RPC; remove the Bun
  guard.
- Web runs with `omp` on `PATH`.
- Validation: adapter tests against a fake RPC child (scripted JSONL);
  server host tests; manual `bun run --cwd packages/web dev:server`.

### P2 — UI client + default OMP
- Expand `OmpRuntimeClient`; registry resolves only `omp`.
- Migrate agent-domain callers (chat send, abort, session reload, history).
- Validation: UI client unit tests; focused store/pipeline tests.

### P3 — Remove OpenCode
- Delete `packages/web/server/lib/opencode/*` (replacing needed parts with OMP
  modules), `lib/opencode/client.ts`, `@opencode/client` and
  `@opencode/schema` deps, OpenCode-specific settings, and the `/api/opencode`
  proxy.
- Repoint OpenChamber-owned and app-level callers (catalog, providers,
  directory status, fs/git/pty/relay) to OpenChamber-owned routes or the OMP
  runtime.
- Apply capability gating for the hidden features.
- Validation: `bun run type-check`, `bun run test`, `bun run dead-code`; full
  manual pass of the chat/session/sidebar flows on web.

### P4 — Electron
- `prepare-omp-cli.mjs` + `extraResources`; remove OpenCode CLI bundling and
  readiness.
- Validation: `bun run --cwd packages/electron package` (or dev flow) and a
  manual run of a session on the desktop build.

### P5 — Config-file management and gap fill
- MCP panel via `omp-config.js` (list/add/remove/enable/disable).
- Manual provider API-key / custom-provider entry via OMP config/auth storage.
- Validation: focused tests for config read/write; manual MCP panel.

## Testing strategy

- Adapter: fake RPC child process with scripted stdin/stdout — lifecycle,
  correlation, event projection, abort, dispose.
- Server host: routes + frame broadcast against a fake adapter (as today).
- UI: `OmpRuntimeClient` with injected fetch; capability resolution.
- No static check counts as runtime proof: web and desktop sessions are
  exercised manually in P1, P3 and P4.

## Risks

- Pinned OMP is `18.1.11`; the RPC docs describe 18.x. Verify each command
  against the pinned version before relying on it.
- Concurrency: multiple streaming sessions mean multiple `omp` processes; the
  pool needs on-demand spawn and idle disposal to bound process count.
- Tool approval -> permission UI mapping is a real shape conversion, not a
  rename; it is the largest single mapping task in P1/P3.
- Removing OpenCode touches many shared files; phases are ordered so the tree
  stays compilable at each step.

## Open questions

- Where the tool-approval UI state lives once mapped from
  `extension_ui_request` (reuse the permission store vs a new approval store).
- Whether `agentSelection` (OMP model roles) can be surfaced well enough over
  RPC to enable the picker.
- Attachment policy: images only, or convert files to path mentions.
