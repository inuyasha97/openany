# P5.1 OmpRuntime Implementation Plan

Status: implemented on 2026-09-27. First milestone of [PHASE5-OMP.md](../PHASE5-OMP.md).

**Goal:** `packages/omp-adapter/` holds the OMP runtime's session map, event fan-out and lifecycle, behind a host seam. No server or UI wiring.

**Architecture:** `OmpRuntime` owns a session map, a listener set and an unsubscribe map. The OMP SDK sits behind `OmpHost`, so the runtime is testable with a fake and the SDK binding lives in one place (P5.2).

## Files

- `packages/omp-adapter/src/runtime.ts` — `OmpRuntime` and the `OmpHost`, `OmpSessionHandle`, `OmpSessionInfo`, `OmpEvent` types.
- `packages/omp-adapter/src/runtime.test.ts` — the runtime against a fake host.
- `packages/omp-adapter/src/index.ts` — the package entrypoint.
- `packages/omp-adapter/src/types/bun-test.d.ts` — the minimal `bun:test` declarations `tsc` needs (the repo ships one per package).
- `packages/omp-adapter/tsconfig.json`, `packages/omp-adapter/package.json`.

## The host seam

`OmpHost` is what the real SDK binding implements in P5.2:

```ts
type OmpHost = {
  listSessions: () => Promise<OmpSessionInfo[]>
  openSession: (input: { sessionPath?: string; cwd?: string }) => Promise<OmpSessionHandle>
}
```

The real binding maps to the OMP SDK: `SessionManager.listAll()` for `listSessions`, and `createAgentSession({ cwd })` plus `session.switchSession(path)` for `openSession`. The handle wraps `AgentSession`: `sessionId`, `prompt`, `abort`, `subscribe`, `dispose`, `sessionFile`.

## The runtime

- `listSessions()` delegates to the host.
- `createSession({ cwd })` opens a fresh session and attaches it.
- `getSession(id)` reuses an attached session, else opens the listed session by path, else throws.
- `prompt(id, text)` and `abort(id)` route through `getSession`.
- `subscribe(listener)` fans every attached session's events out to one listener set; returns an unsubscribe.
- `dispose()` clears listeners, unsubscribes every handle, and disposes them best-effort.

## Verification

- `bun test packages/omp-adapter/src/runtime.test.ts` — 6 tests: list, create+prompt, reuse, open-by-path and unknown throw, event fan-out and unsubscribe, abort and dispose.
- `bun run --cwd packages/omp-adapter type-check`.

## Deferred to P5.2

- The real `OmpHost` binding to `@oh-my-pi/pi-coding-agent`.
- OMP event to `SyncEvent` mapping.
- Server routes and the bridge frame.
