# Phase 3: Remove OpenCode — Implementation Program

> **For agentic workers:** This is a PROGRAM, not a single bite-sized plan. Each
> sub-phase below is large enough to be its own bite-sized plan (superpowers
> writing-plans) and its own review gate. Execute one sub-phase at a time;
> before starting a sub-phase, write its detailed TDD plan against the exact
> files its discovery step lists.

**Goal:** Delete OpenCode from the tree — server process management, proxy,
routes, the `@opencode/client` wrapper, OpenCode-specific settings, i18n and
dependencies — while keeping OpenChamber-owned features and the shared UI
working on OMP.

**Architecture:** The shared UI already routes the agent domain through the
`AgentRuntime` contract (P2 made OMP the default). What remains is (a) removing
the now-unused OpenCode runtime adapters from the UI, (b) repointing
OpenChamber-owned callers that borrowed `opencodeClient` onto OpenChamber-owned
routes or the OMP runtime, (c) separating OpenChamber-owned server modules from
OpenCode-specific ones, and (d) deleting the OpenCode-specific modules and
dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-omp-only-runtime-design.md`

## Global Constraints

- P1 and P2 are prerequisites.
- Hard fork: upstream sync is abandoned, so large deletions are allowed — but
  OpenChamber-owned features (fs, git, PTY, relay, tunnel, pairing, terminal,
  settings, themes, static routes) must keep working. Never delete one of those
  to make a removal easier.
- `packages/vscode`, `packages/mobile`, `packages/hosted` are out of scope and
  may be left broken; do not spend effort keeping them green, but do not let
  them block the web/electron type-check and tests that are in scope.
- Validate at each sub-phase gate: `bun run --cwd packages/web test`,
  `bun run --cwd packages/ui test`, `bun run type-check`.

## The teardown this is built from

`docs/agent-host/DESIGN.md` already inventories `packages/ui/src/lib/opencode/client.ts`
into four buckets: keep-in-runtime, move-to-agent-domain, OpenChamber-owned,
and OpenCode-specific. Use that inventory. The server directory
`packages/web/server/lib/opencode/` is a **mix**: some files are OpenCode
process/proxy/API concerns, others are OpenChamber-owned runtimes that merely
live there. Sub-phase B classifies them before deleting.

## Sub-phase A — Retire the OpenCode and ACP UI runtimes

Discovery:

```bash
grep -rln "OpenCodeRuntime\|AcpRuntimeClient\|acp-runtime\|omp-availability\|acp-availability" packages/ui/src
```

Tasks (each with its own TDD plan):
1. Delete `packages/ui/src/lib/agent/opencode-runtime.ts` and its test;
   remove its import from `registry.ts` (already unused after P2).
2. Delete `packages/ui/src/lib/agent/acp-runtime.ts`, `acp-availability.ts`, and
   their tests; remove `AcpRuntimeClient` from `registry.ts`
   (`registry.ts` from P2 must not reference it).
3. Delete `packages/ui/src/lib/agent/additional-sessions.ts` and its OpenCode
   merge callers if nothing else uses it; audit with
   `grep -rln "listAdditionalRuntimeSessions\|additional-sessions" packages/ui/src`.
4. Keep `omp-availability.ts` only if the composer still needs to probe; with
   OMP always on, replace its body with `Promise.resolve(true)` /
   `useOmpRuntimeAvailable = () => true`, or delete it and its callers
   (discover with `grep -rln "omp-availability\|useOmpRuntimeAvailable" packages/ui/src`).

Gate: `bun run --cwd packages/ui type-check && bunx vitest run src/lib/agent`.

## Sub-phase B — Separate and delete the server OpenCode layer

Discovery (classify every file; record the bucket in the sub-plan):

```bash
ls packages/web/server/lib/opencode | grep -v test
grep -n "from './lib/opencode/" packages/web/server/index.js
```

Classification rule: a module is **OpenChamber-owned** if it serves an
OpenChamber feature with no OpenCode dependency (settings, theme, static
routes, tunnel auth, server utils, feature routes, openchamber routes,
bootstrap, managed config, credential db, auth/claude-cli-auth used by
OpenChamber login). It is **OpenCode-specific** if it boots, proxies, configures
or speaks the OpenCode server (`lifecycle`, `env-runtime`, `env-config`,
`core-routes`, `config-v2`, `compatibility`, `opencode-resolution`,
`cli-upgrade`, `network-runtime` if OpenCode-only, `agents`, `commands`, `mcp`,
`providers`, `models-metadata` — verify each against its DOCUMENTATION.md).

Tasks (each its own TDD/gate plan):
1. Move OpenChamber-owned modules out of `lib/opencode/` into a new
   `packages/web/server/lib/openchamber/` (or keep them and only delete the
   OpenCode ones — record the choice). Update imports in `server/index.js`.
2. Stop booting OpenCode: remove the lifecycle/env-runtime/core-routes wiring
   and the `/api/opencode` proxy from `server/index.js`.
3. Remove `@opencode/client` and `@opencode/schema` from `packages/web/package.json`
   and delete the OpenCode-specific modules.
4. Delete the UI `lib/opencode/client.ts` wrapper and, for each of its ~109
   importers, repoint or delete:
   ```bash
   grep -rln "lib/opencode/client\|opencodeClient" packages/ui/src
   ```
   OpenChamber-owned callers move to `RuntimeAPIs`/`runtimeFetch`; agent-domain
   callers move to the OMP runtime; OpenCode-specific callers are deleted with
   their UI.
5. Delete `packages/ui/src/lib/agent/opencode-runtime.ts` import left-overs and
   the `lib/opencode/events.ts` re-export if nothing needs it; keep
   `lib/opencode/model.ts` only as long as the OMP mapping imports it, then
   move it to `lib/agent/model.ts`.

Gate: `bun run type-check` (web + ui) and both test suites. Run
`bun run dead-code` and read the report.

## Sub-phase C — Settings, i18n and dependencies

Tasks:
1. Remove OpenCode-specific settings from
   `packages/ui/src/lib/settings/registry.ts` and its search index
   (`lib/settings/search.ts`); discover with
   `grep -rn "opencode" packages/ui/src/lib/settings`.
2. Remove the now-dead `ompRuntimeEnabled`/`acpRuntimeEnabled` settings and the
   `RuntimeControl` composer picker (there is one runtime), plus
   `OpenChamberToolsSettings.tsx` rows for them. Keep unrelated rows.
3. Remove the runtime-setting i18n keys for all locale dictionaries
   (`packages/ui/src/lib/i18n/messages/*.settings.ts`) for the keys deleted in
   1 and 2. Follow `locale-ui-patterns` before editing.
4. Remove `@opencode/client` and `@opencode/schema` from every in-scope
   `package.json`; `bun install` and confirm `bun.lock` no longer references
   them for in-scope packages.

Gate: `bun run type-check && bun run --cwd packages/ui test && bun run --cwd packages/web test`.

## Sub-phase D — Hand off to P4

P4 (electron) removes the OpenCode CLI bundling. Sub-phase B already removed the
server's OpenCode spawn path, so P4 only touches `packages/electron`.

Gate: the web app runs a full session on OMP with no OpenCode module present
(`grep -rn "@opencode/" packages/web packages/ui` returns nothing in scope).

## Self-Review

- **Spec coverage:** spec P3 lists server deletion, UI client deletion, deps,
  settings, and repointing app-level callers — sub-phases A–D map to these.
- **Placeholder scan:** no TBD; classification is specified by rule with a
  per-file verification step rather than left open.
- **Scope honesty:** each sub-phase is explicitly its own plan with its own
  discovery step, because the exact task list depends on files not yet read.
