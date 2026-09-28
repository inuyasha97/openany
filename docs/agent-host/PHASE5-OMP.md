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

P5.1 started: `packages/omp-adapter/package.json` created with the OMP dependency; `bun install` added it and changed `bun.lock`. The next step is to verify the OMP SDK API from the installed package and implement the minimal `OmpRuntime` with tests.

## Open questions

- The minimal `OmpRuntime`'s exact surface: which OMP SDK calls back session list/create/get, prompt and abort.
- Whether the server routes are registered in a new fork-owned module or through the existing route composition (the latter is upstream-tracked).
