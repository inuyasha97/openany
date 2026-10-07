# Phase 5: Config-file management and gap fill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the OMP-vs-OpenCode gaps that P1–P4 left hidden: tool approvals, MCP management, provider/model setup, agent selection and attachments.

**Architecture:** Three of the four gaps are **config/state on disk**, which the server reads and writes the same way OMP does. Tool approvals are an **RPC frame** (`extension_ui_request`) that must be projected into the existing permission flow. Each task flips a capability flag only after its route and UI path work.

**Tech Stack:** Node `fs` + JSON/YAML (config), Express routes, `extension_ui_request`/`extension_ui_response` over RPC, React UI.

**Spec:** `docs/superpowers/specs/2026-10-07-omp-only-runtime-design.md`

## Global Constraints

- P1–P4 are prerequisites.
- Never write another application's config; write only OMP-managed files (`.omp/mcp.json`, `~/.omp/agent/mcp.json`, `~/.omp/agent/config.yml`) and follow `enterprise-boundary` before adding any path that stores or transmits provider keys.
- Resolve runtime paths from OMP's own rules (`~/.omp/agent`, profiles, XDG), not hardcoded assumptions; `/session info` and OMP docs are authoritative.
- Flip a capability flag to `true` in the same task that implements and tests the route + UI path.

## File Structure

- `packages/web/server/lib/agents/omp-config.js` — create. Read/write OMP MCP + provider config.
- `packages/web/server/lib/agents/omp-approvals.js` — create. Map `extension_ui_request` to permission events and route replies back.
- `packages/web/server/lib/agents/omp-runtime-host.js` — modify. Wire approvals.
- `packages/web/server/lib/agents/omp-routes.js` — modify. MCP, providers, approvals routes.
- `packages/ui/src/lib/agent/omp-runtime.ts` — modify. Capabilities + methods.
- UI MCP/provider/permission surfaces — find and wire in the discovery step of each task.

---

### Task 1: Tool approvals → permission flow

The largest gap and the most user-visible: an OMP approval must surface as a permission request and the user's answer must resolve the pending `extension_ui_request`.

**Files:**
- Create: `packages/web/server/lib/agents/omp-approvals.js`
- Modify: `packages/web/server/lib/agents/omp-runtime-host.js`, `omp-routes.js`
- Modify: `packages/ui/src/lib/agent/omp-runtime.ts`

**Interfaces:**
- Produces:
  - `createOmpApprovals({ broadcast })` with `handleRequest(sessionId, frame)`, `resolve(sessionId, requestId, reply)`, `pending(sessionId)`.
  - Permission events: reuse the canonical `permission.asked`/`permission.replied` `SyncEvent`s.
  - Routes: `GET /api/agents/omp/sessions/:id/permissions`, `POST /api/agents/omp/sessions/:id/permissions/:requestId`.
- Consumes: `extension_ui_request` (`select`/`confirm`/`input`/`editor`) and the reply envelope `extension_ui_response` (`value`, `confirmed`, or `cancelled: true`).

- [ ] **Step 1: Discovery — read the permission flow**

```bash
grep -rln "permission.asked\|permission.replied\|PermissionRequest\|replyPermission\|listPendingPermissions" packages/web/server packages/ui/src
```
Read the store and event shapes it produces for OpenCode permissions. Record the exact `SyncEvent` payload the UI expects.

- [ ] **Step 2: Write the failing test**

Create `packages/web/server/lib/agents/omp-approvals.test.js` (Vitest, fake broadcast):

```js
import { describe, expect, it } from 'vitest';
import { createOmpApprovals } from './omp-approvals.js';

describe('createOmpApprovals', () => {
  it('broadcasts permission.asked for an extension_ui_request and records it', () => {
    const frames = [];
    const approvals = createOmpApprovals({ broadcast: (f) => frames.push(f) });
    approvals.handleRequest('ses_1', { type: 'extension_ui_request', id: 'ui_1', method: 'confirm', title: 'Run bash?', message: 'rm -rf build' });
    expect(approvals.pending('ses_1')).toHaveLength(1);
    expect(frames[0].type).toBe('openchamber:omp');
    expect(frames[0].properties.events[0].type).toBe('permission.asked');
  });

  it('builds the extension_ui_response for a reply', () => {
    const approvals = createOmpApprovals({ broadcast: () => {} });
    approvals.handleRequest('ses_1', { type: 'extension_ui_request', id: 'ui_1', method: 'confirm', title: 't', message: 'm' });
    const reply = approvals.resolve('ses_1', 'ui_1', { confirmed: true });
    expect(reply).toEqual({ type: 'extension_ui_response', id: 'ui_1', confirmed: true });
    expect(approvals.pending('ses_1')).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `bunx vitest run server/lib/agents/omp-approvals.test.js` (workdir `packages/web`)
Expected: FAIL — module missing.

- [ ] **Step 4: Implement `omp-approvals.js`**

Map each method:
- `confirm` -> a yes/no permission (`{ confirmed }` reply).
- `select` -> a single-choice permission (`{ value }` reply).
- `input`/`editor` -> a free-text request (`{ value }` reply).
Broadcast `permission.asked` with the mapped shape (requestId = `frame.id`), keep the frame in a per-session map, and return the correct response envelope on `resolve`.

- [ ] **Step 5: Wire into the host and routes**

- In `omp-runtime-host.js`, the RPC event forwarder must detect `extension_ui_request` before projection and call `approvals.handleRequest(sessionId, frame)`; it must also send the `extension_ui_response` back on the RPC client's stdin (add a `send(frame)` passthrough on the handle/client).
- Add the two routes and a `replyPermission`/`listPendingPermissions` on the adapter host, then implement them in `OmpRuntimeClient` and flip `permissions: true`.

- [ ] **Step 6: Run tests + full gate**

Run: `bun run --cwd packages/web test && bun run --cwd packages/ui type-check`
Expected: PASS.

- [ ] **Step 7: Manual check** — trigger an OMP tool that needs approval in a web session and confirm the dialog appears and the answer resumes the run.

- [ ] **Step 8: Commit**

```bash
git add packages/web/server/lib/agents/omp-approvals.js packages/web/server/lib/agents/omp-approvals.test.js packages/web/server/lib/agents/omp-runtime-host.js packages/web/server/lib/agents/omp-routes.js packages/ui/src/lib/agent/omp-runtime.ts
git commit -m "feat(omp): surface tool approvals as permissions"
```

---

### Task 2: MCP management via config files

**Files:**
- Create: `packages/web/server/lib/agents/omp-config.js`
- Modify: `omp-routes.js`, `omp-runtime.ts`

**Interfaces:**
- Produces: `createOmpConfig({ home? })` with `listMcp()`, `setMcpEnabled(name, enabled)`, `removeMcp(name, scope)`, `addMcp(definition, scope)`; routes `GET/POST/DELETE /api/agents/omp/mcp`.

- [ ] **Step 1: Discovery**

```bash
grep -rln "listMcpServers\|connectMcpServer\|mcpServers\|McpServerStatus" packages/ui/src
```
Read OMP's `mcp.json` schema (project `.omp/mcp.json`, user `~/.omp/agent/mcp.json`) and which OMP-managed fields the UI needs.

- [ ] **Step 2–6: TDD** — write `omp-config.test.js` for read (parse `mcpServers`, merge project < user, apply `disabledServers`/`enabledServers`) and write (enable/disable/remove/add only to OMP-managed files); implement `omp-config.js`; add routes; implement `OmpRuntimeClient.listMcpServers`/`connectMcpServer`/`disconnectMcpServer`; flip `mcp: true`.
- [ ] **Step 7: Gate** — `bun run --cwd packages/web test && bun run --cwd packages/ui type-check`; manual MCP list/enable in the UI.
- [ ] **Step 8: Commit** — `feat(omp): manage mcp servers through config files`.

---

### Task 3: Provider and model setup

**Files:** `omp-config.js`, `omp-routes.js`, `omp-runtime.ts`, provider settings UI.

- [ ] **Step 1: Discovery** — find the provider/model settings UI (`grep -rln "getProviders\|providers" packages/ui/src`) and OMP's auth storage / `custom-models` config shape.
- [ ] **Step 2: OAuth login** — add routes for `get_login_providers`/`login` over RPC and map the `open_url` + `input` frames to the existing login dialog (reuse `extension_ui_request` handling from Task 1).
- [ ] **Step 3: Manual API key / custom provider** — write to OMP's config/auth storage only; follow `enterprise-boundary`.
- [ ] **Step 4: Model picker** — implement `selectModel` fully (route from P2 Task 3) and confirm `get_available_models` populates the picker; `modelSelection` stays `true`.
- [ ] **Step 5: Gate + commit** — tests + `type-check`; `feat(omp): provider and model setup`.

---

### Task 4: Agent selection (model roles) — investigate, then enable or keep off

**Files:** `omp-runtime.ts`, agent picker UI.

- [ ] **Step 1: Discovery** — determine whether RPC can set/read OMP model roles for a session (`get_state`, config `roles`). If not exposed, keep `agentSelection: false` and hide the picker; record the finding in `docs/agent-host/PHASE5-OMP.md` or the spec.
- [ ] **Step 2:** If exposed, implement `selectAgent`/`listAgents` over the RPC role commands and flip `agentSelection: true`; else close the task with the recorded finding.
- [ ] **Step 3: Commit** — `feat(omp): agent selection` or `docs(omp): agent selection stays off (no rpc surface)`.

---

### Task 5: Attachments policy

**Files:** `omp-runtime.ts`, composer attach UI.

- [ ] **Step 1: Discovery** — find the attach path (`grep -rln "FileInputLite\|attachments\|attach" packages/ui/src/lib/agent packages/ui/src/components/chat/composer`).
- [ ] **Step 2:** Support images by mapping file parts to RPC `images[]` (`{ type: "image", data, mimeType }`); decide the non-image policy (path mention vs drop) and encode it. Flip `attachments: true` only for the supported cases, or keep a narrower capability.
- [ ] **Step 3: Gate + commit** — tests + manual image attach; `feat(omp): image attachments`.

---

## Self-Review

- **Spec coverage:** the spec's remaining capability gaps (permissions, mcp,
  agentSelection, attachments) and the "config/provider" phase item each have a
  task. `forms`/`revert`/`turnDiff` remain intentionally `false` (no OMP analog)
  and need no task.
- **Placeholder scan:** no TBD; the discovery-first steps name the exact
  commands and the decision each task must record.
- **Type consistency:** `createOmpApprovals`/`createOmpConfig` names are used
  consistently; capability keys match `AgentCapabilities`.
