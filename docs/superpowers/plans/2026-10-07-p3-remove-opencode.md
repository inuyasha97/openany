# Phase 3: Remove OpenCode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete OpenCode from the tree — server process/proxy/routes, the `@opencode/client` wrapper and its ~93 UI importers, OpenCode-specific settings/i18n and dependencies — while keeping OpenChamber-owned features and the shared UI working on OMP.

**Architecture:** P2 made OMP the runtime for every unbound session. The remaining OpenCode coupling is (a) OpenCode-specific server modules mixed with OpenChamber-owned ones under `packages/web/server/lib/opencode/`, (b) `packages/ui/src/lib/opencode/client.ts` and its importers, and (c) settings/i18n/deps. This plan separates the owned modules from the OpenCode ones, deletes the OpenCode ones, and repoints or deletes every importer.

**Tech Stack:** Node/Express (server), React/TypeScript (UI), Bun/`bun:test` and Vitest.

**Spec:** `docs/superpowers/specs/2026-10-07-omp-only-runtime-design.md`

## Global Constraints

- P1 and P2 are prerequisites.
- Hard fork: no upstream sync. Large deletions are allowed, but **never delete an OpenChamber-owned feature** (fs, git, PTY, relay, tunnel, pairing, terminal, settings, themes, static routes, projects, scheduler) to make removal easier.
- `packages/vscode`, `packages/mobile`, `packages/hosted` are out of scope; they may break. Do not let them block web/electron type-check or tests.
- Gate after every task: `bun run type-check` plus the affected package test suite. Run `bun run dead-code` after deletions and read the report.
- Verified inventories this plan is built from:
  - **Server** (`packages/web/server/lib/opencode/`, 70 non-test files): 36 OpenCode-specific, 28 OpenChamber-owned, 6 shared/composition.
  - **UI**: 93 files import `opencodeClient`; 319 files import `@/lib/opencode/model` types; 51 files import `@opencode/client` directly.
  - `settings-registry.json` is read by `packages/ui/src/lib/settings/registry-snapshot.ts`; `login-shell-env.js` and `path-utils.js` are imported by `packages/electron/main.mjs`; `managed-process-registry.js` etc. by `packages/vscode` (out of scope).

## File Structure (the classification this plan executes)

### Server — OpenCode-specific (DELETE)
`agents.js`, `auth-state-runtime.js`, `auth.js`, `cli-upgrade.js`, `commands.js`, `compatibility.js`, `config-entity-routes.js`, `config-mutation-response.js`, `config-v2.js`, `credential-db.js`, `env-config.js`, `env-runtime.js`, `lifecycle.js`, `managed-process-registry.js`, `mcp.js`, `network-runtime.js`, `opencode-resolution-runtime.js`, `plugin-routes.js`, `plugin-spec.js`, `plugins.js`, `provider-env-aliases.js`, `providers.js`, `proxy.js`, `response-envelope.js`, `routes.js`, `session-activity.js`, `session-runtime.js`, `shared.js`, `skill-routes.js`, `skills.js`, `snippets.js`, `upgrade-capability.js`, `v1-migration-topup.js`, `v2-install.js`, `watcher.js`, `websearch-config.js` (+ their `.test.js`, `.d.ts`).

### Server — OpenChamber-owned (KEEP)
`bootstrap-runtime.js`, `cli-entry-runtime.js`, `cli-options.js`, `claude-cli-auth.js`, `core-routes.js`, `hmr-state-runtime.js`, `input-history-scope.js`, `login-shell-env.js`, `managed-config-file.js`, `managed-plugin-config.js`, `models-metadata.js`, `npm-registry-config.js`, `npm-registry.js`, `openchamber-routes.js`, `path-utils.js`, `project-directory-runtime.js`, `project-icon-routes.js`, `pwa-manifest-routes.js`, `server-startup-runtime.js`, `settings-files.js`, `settings-helpers.js`, `settings-normalization-runtime.js`, `settings-runtime.js`, `startup-performance.js`, `static-routes-runtime.js`, `theme-archive.js`, `theme-catalog.js`, `theme-runtime.js`, `tunnel-auth.js`, `tunnel-wiring-runtime.js`, `settings-registry.json`, `DOCUMENTATION.md`.

> Note: `credential-db.js` and `managed-config-file.js` read OpenCode-owned files — verify each keeps a purpose (OpenChamber credential store / plugin layer) before keeping; if it exists only to serve OpenCode, move it to the DELETE list in Task B2.

### Server — shared/composition (EDIT, do not delete)
`feature-routes-runtime.js`, `server-utils-runtime.js`, `shutdown-runtime.js`, `startup-pipeline-runtime.js`.

---

## Sub-phase A — Retire the OpenCode and ACP UI runtimes

### Task A1: Delete the OpenCode adapter

**Files:**
- Delete: `packages/ui/src/lib/agent/opencode-runtime.ts`
- Delete: `packages/ui/src/lib/agent/opencode-runtime.test.ts`

- [ ] **Step 1: Confirm no live importer**

Run: `grep -rn "opencode-runtime\|OpenCodeRuntime" packages/ui/src --include=*.ts --include=*.tsx`
Expected: only `registry.ts` (already removed in P2) and the file itself. If a test imports it, that test is deleted with it.

- [ ] **Step 2: Delete both files**

```bash
git rm packages/ui/src/lib/agent/opencode-runtime.ts packages/ui/src/lib/agent/opencode-runtime.test.ts
```

- [ ] **Step 3: Type-check**

Run: `bun run --cwd packages/ui type-check`
Expected: PASS (no references remain).

- [ ] **Step 4: Commit** — `refactor(ui): delete the opencode runtime adapter`.

### Task A2: Delete the ACP adapter and availability

**Files:**
- Delete: `packages/ui/src/lib/agent/acp-runtime.ts`, `acp-availability.ts`, and their tests.
- Modify: any `RuntimeControl`/composer references (handled in Sub-phase C).

- [ ] **Step 1: Find importers**

Run: `grep -rln "acp-runtime\|AcpRuntimeClient\|acp-availability\|useAcpRuntimeAvailable\|isAcpRuntimeAvailable\|resetAcpRuntimeAvailable" packages/ui/src`
Known: `registry.ts` (P2 removed it), `RuntimeControl.tsx`, `OpenChamberToolsSettings.tsx`, `additional-sessions.ts`, `DOCUMENTATION.md`.

- [ ] **Step 2: Delete the two modules + tests, and `additional-sessions.ts`** (it only merges non-default runtimes; nothing else uses it — verify with `grep -rln "listAdditionalRuntimeSessions\|additional-sessions" packages/ui/src`).

- [ ] **Step 3: Fix the leaf references left for Sub-phase C** — leave `RuntimeControl.tsx` / `OpenChamberToolsSettings.tsx` broken until Sub-phase C deletes them; type-check will be red between A2 and C2 only if those files are not edited in the same task. To keep the tree green, either (a) do A2 and C2 in one task, or (b) in A2 replace the `useAcpRuntimeAvailable` import in those two files with a local `false`. Choose (b) so each task gates green.

- [ ] **Step 4: Gate + commit** — `bun run --cwd packages/ui type-check && bunx vitest run src/lib/agent`; `refactor(ui): delete the acp runtime and availability probes`.

### Task A3: Collapse `omp-availability`

**Files:**
- Modify: `packages/ui/src/lib/agent/omp-availability.ts`
- Modify: `RuntimeControl.tsx`, `OpenChamberToolsSettings.tsx` (imports), or delete after C2.

- [ ] **Step 1:** With OMP always mounted, make the probe constant:

```ts
export const isOmpRuntimeAvailable = (): Promise<boolean> => Promise.resolve(true)
export const resetOmpRuntimeAvailable = (): void => {}
export const useOmpRuntimeAvailable = (): boolean => true
```

- [ ] **Step 2: Gate + commit** — `refactor(ui): omp runtime is always available`.

### Task A4: Gate** — `bun run --cwd packages/ui type-check && bunx vitest run src/lib/agent`. RED is not allowed past this point.

---

## Sub-phase B — Separate and delete the server OpenCode layer

### Task B1: Create the OpenChamber-owned module home

**Files:**
- Create: `packages/web/server/lib/openchamber/` (new directory).
- Move (git mv) the KEEP list from `lib/opencode/` into `lib/openchamber/`, preserving names.

- [ ] **Step 1:** `git mv` each KEEP file. Move `DOCUMENTATION.md` and `settings-registry.json` too.
- [ ] **Step 2:** Update all imports. Run `grep -rn "lib/opencode/" packages/web/server` and rewrite each KEEP-target path to `lib/openchamber/`. Update `packages/web/server/index.js` imports (33 lines) accordingly.
- [ ] **Step 3:** Keep the `packages/ui/src/lib/settings/registry-snapshot.ts` reference to `settings-registry.json` valid (update its path).
- [ ] **Step 4: Gate** — `bun run --cwd packages/web type-check` (server JS is validated by tests, not tsc; run `bunx vitest run server`).
- [ ] **Step 5: Commit** — `refactor(server): move openchamber-owned modules out of lib/opencode`.

### Task B2: Delete the OpenCode-specific server modules

**Files:** delete the DELETE list (from File Structure) plus their tests and `.d.ts`.

- [ ] **Step 1:** `git rm` the DELETE list.
- [ ] **Step 2:** Remove their wiring from `packages/web/server/index.js`: the lifecycle (`createOpenCodeLifecycleRuntime`), env runtime (`createOpenCodeEnvRuntime`), core routes, proxy, watcher, session-runtime, network-runtime, auth-state, resolution, upgrade, v2-install, compatibility, and the `/api/opencode` proxy registration. Delete the corresponding route/runtime variables and shutdown entries.
- [ ] **Step 3:** Fix the shared composition files (`feature-routes-runtime.js`, `server-utils-runtime.js`, `shutdown-runtime.js`, `startup-pipeline-runtime.js`): remove OpenCode ports/readiness/proxy wiring and the managed-OpenCode teardown; keep terminal/static/feature/listen/guest/realtime.
- [ ] **Step 4:** `grep -rn "@opencode/client\|@opencode/schema" packages/web/server` — remove every remaining hit.
- [ ] **Step 5: Gate** — `bunx vitest run server` and boot `bun run --cwd packages/web dev:server` (may fail on missing OpenCode absent until UI paths are updated; record and proceed).
- [ ] **Step 6: Commit** — `refactor(server): delete the opencode server layer`.

### Task B3: Delete the UI client wrapper

**Files:**
- Delete: `packages/ui/src/lib/opencode/client.ts` (+ `client.test.ts`, `client.status.test.ts`).
- Delete or relocate: `projection.ts`, `session-stats.ts`, `websearch.ts`, `plugins.ts` if they only serve the wrapper (verify importers).

- [ ] **Step 1:** Confirm nothing outside the wrapper relies on `createRuntimeOpencodeClient`/`normalizeOpencodeError`/`OpencodeApiError`/`OPENCODE_DIRECTORY_HEADER` except files scheduled for deletion.
- [ ] **Step 2:** Delete and fix `lib/opencode/events.ts` re-export: if it only re-exports from `lib/agent/events`, keep it as the re-export (cheap) or repoint importers to `lib/agent/events`. Repoint if it also imports `@opencode/client`.

- [ ] **Step 3: Commit** — `refactor(ui): delete the opencode client wrapper`.

### Task B4: Repoint or delete the ~93 UI importers

**Files:** the 93 files grouped in the plan's discovery. Process **one feature area per task**, so each gates green.

For each group, decide per file:
- **Agent-domain caller** (session/message/permission/chat/composer model controls) -> route through `getAgentRuntime*` (already the default OMP) or delete with the feature.
- **OpenChamber-owned caller** (fs, git, pty, relay, projects, terminal) -> replace `opencodeClient.*` with the OpenChamber-owned route call via `runtimeFetch` (the same endpoint the wrapper used).
- **OpenCode-specific caller** (providers, OAuth, MCP sign-in, plugins, forms, revert, turn-diff, agent/command/skill config, `getSdkClient`/`getScopedSdkClient` users) -> delete the caller and the UI it feeds, or move it to the OMP equivalent if P5 covers it.

Order (one task each, gate + commit per group):
1. `lib/` (debug, openCodeStatus, session-stats, gitApi, multirun, chatDirectories, runtime-refetch).
2. `sync/` (bootstrap, sync-context, session-actions, session-ui-store, event-pipeline, host-session-status-seed) — these are the agent-domain core; most calls resolve through the runtime already, so remove the direct `opencodeClient` calls and rely on the runtime.
3. `stores/` (useConfigStore, useAgentsStore, useCommandsStore, useDirectoryStore, useFileSearchStore, useGlobalSessionsStore, useMcpConfigStore, useMultiRunStore, usePluginsStore, useProjectsStore, useSkillsStore, useSkillsCatalogStore, useSnippetsStore, useWebSearchStore, permissionStore).
   - Keep the OpenChamber-owned ones (directory, projects, file search) by repointing to `runtimeFetch`.
   - Delete OpenCode-only stores (agents config, commands config, mcp config, plugins, skills catalog, snippets, web search) with the settings pages that use them, or keep the UI reading OMP routes added in P5 (do not delete UI that P5 will rewire — coordinate: if P5 Task 2/3 keeps MCP/providers, keep those stores and leave them on a TODO only for P5).
4. `components/session`, `components/layout`, `components/views` (filesystem, directory explorer) — repoint to `runtimeFetch`.
5. `components/sections/providers`, `components/sections/mcp` — keep only if P5 rewires them; otherwise delete with the pages.
6. `components/chat` (ChatInput, attachments, FormCard/FormDock/FormFieldControl, ModelControls) — forms/model controls depend on the runtime; keep ModelControls for P5, delete forms (no OMP analog).

- [ ] **Per group: Step 1** `grep -rln "opencodeClient" <subdir>`; **Step 2** edit each; **Step 3** `bun run --cwd packages/ui type-check && bunx vitest run <affected>`;
  **Step 4** commit.

### Task B5: Delete `lib/opencode/model.ts` or move it

**Files:**
- Modify/Delete: `packages/ui/src/lib/opencode/model.ts` (319 importers).

- [ ] **Step 1:** These are **types** — the domain model. Do not delete it. Instead:
  - If `lib/agent/events.ts` and the OMP mapping import it, move it to `packages/ui/src/lib/agent/model.ts` and update imports (mechanical, 319 files) — or keep the path and drop only the `@opencode/client` re-exports.
  - Remove `PermissionRequestWire = PermissionRequest from @opencode/client` and replace with a local `PermissionRequest` type (shape from the spec/SDK: `{ id; sessionID; action; resources; save?; metadata?; source?; message? }`).
- [ ] **Step 2:** `grep -rn "@opencode/client" packages/ui/src/lib/opencode/model.ts` — remove.
- [ ] **Step 3: Gate + commit.**

### Task B6: Remove direct `@opencode/client` imports (51 files)

- [ ] **Step 1:** `grep -rln "@opencode/client" packages/ui/src` and delete/repoint each; most are in files already deleted by B4. The survivors are the model/events/sync type files, fixed in B5.
- [ ] **Step 2: Gate + commit.**

### Task B7: Sub-phase gate — `grep -rn "@opencode/" packages/ui/src packages/web/server` returns nothing in scope; `bun run type-check`; both test suites green.

---

## Sub-phase C — Settings, i18n, dependencies

### Task C1: Remove runtime-toggle settings

**Files:**
- `packages/ui/src/lib/settings/registry.ts` (lines 264-268: `ompRuntimeEnabled`, `acpRuntimeEnabled`).
- `packages/ui/src/lib/settings/search.ts` (lines 680-697: `sessions.runtime-omp`, `sessions.runtime-acp`).
- `packages/ui/src/stores/useUIStore.ts` (1028-1031, 1260-1261, 1455-1456, 2831-2836, 3325-3326).
- `packages/web/server/lib/openchamber/settings-helpers.js` (moved in B1; lines 630-635).
- `packages/web/server/lib/openchamber/settings-registry.json` (lines 143-148) — regenerate or edit.
- `packages/web/server/index.js` (2332/2337 references already removed in B2).

- [ ] **Step 1:** Delete the fields, setters, defaults, persisted projections, search items and sanitize copies.
- [ ] **Step 2:** Gate + commit — `refactor: drop the runtime toggle settings`.

### Task C2: Delete `RuntimeControl` and its rows

**Files:**
- Delete: `packages/ui/src/components/chat/composer/ui/RuntimeControl.tsx`.
- Modify: `ComposerFooter.tsx` (remove import line 26 and both render sites 183, 276; the `draftRuntimeId` reads at 90/140 can stay, defaulting to omp, or be removed).
- Modify: `OpenChamberToolsSettings.tsx` (remove imports 24-25, 101-104, handlers 126-137, render 276-301).

- [ ] **Step 1:** Edit; **Step 2:** `grep -rn "RuntimeControl\|ompRuntimeEnabled\|acpRuntimeEnabled" packages/ui/src` returns nothing; **Step 3:** gate + commit — `refactor(ui): remove the runtime picker`.

### Task C3: Remove runtime i18n keys

**Files:** 13 `packages/ui/src/lib/i18n/messages/*.settings.ts` — keys `settings.openchamber.tools.field.ompRuntime`, `ompRuntimeInfo`, `acpRuntime`, `acpRuntimeInfo`; and `chat.chatInput.runtime.label` in `routing.i18n.ts` (13 locales).
- [ ] **Step 1:** Load `locale-ui-patterns`. **Step 2:** delete the keys from every locale. **Step 3:** gate + commit.

### Task C4: Drop the dependencies

**Files:** `packages/web/package.json`, `packages/ui/package.json`, `packages/omp-adapter/package.json`.
- [ ] **Step 1:** Remove `@opencode/client` and `@opencode/schema` from in-scope packages; also remove `@oh-my-pi/pi-coding-agent` if P1 removed it from `omp-adapter` already.
- [ ] **Step 2:** `bun install`; confirm no in-scope `package.json` references remain; update `bun.lock` (regenerated).
- [ ] **Step 3:** gate + commit — `chore: drop opencode dependencies`.

### Task C5: Remove `settings-registry.json` regeneration references to OpenCode settings; run `bun run dead-code` and read the report.

---

## Sub-phase D — Handoff to P4

- [ ] **Step 1:** Confirm the leaf grep: `grep -rn "@opencode/\|opencodeClient\|OpenCodeRuntime" packages/web/server packages/ui/src` returns nothing (except comments, which are fixed at the end).
- [ ] **Step 2:** Boot web, run one full session end to end on OMP.
- [ ] **Step 3:** Proceed to P4 (electron binary), which finishes the removal.

## Self-Review

- **Spec coverage:** spec P3 items (delete server layer, delete UI client,
  repoint app-level callers, settings, deps) map to Sub-phases A-D. Delegated
  features (MCP provider/panel) are explicitly kept for P5 rather than deleted.
- **Placeholder scan:** no TBD. Where a decision is conditional
  (`credential-db.js`, whether to keep MCP/providers stores), the exact check
  and the two outcomes are stated.
- **Type consistency:** `OmpRuntimeClient` from P2 is the default the repointed
  callers use; `PermissionRequest` replacement shape is pinned to the SDK wire
  fields.
