# Phase 5: Config-file management and gap fill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the OMP-vs-OpenCode gaps P1–P4 left hidden: tool approvals, MCP management, provider/model setup, agent selection and image attachments.

**Architecture:** Tool approvals are an RPC frame (`extension_ui_request`) projected into the existing permission flow. MCP/provider setup are **config files** the server reads and writes the way OMP does. Each task flips a capability flag only after its route + client method + UI path work.

**Tech Stack:** Node `fs`, JSON/YAML, Express + Zod, the P1 RPC client (adds an outbound `send`), React.

**Spec:** `docs/superpowers/specs/2026-10-07-omp-only-runtime-design.md`

## Global Constraints

- P1–P4 are prerequisites.
- Follow `enterprise-boundary` before adding any path that stores or transmits provider keys; write only OMP-managed files, never another application's config.
- Verified shapes this plan is built from:
  - `SyncEvent` permission members (`packages/ui/src/lib/agent/events.ts:115-118`):
    `{ type: "permission.asked"; properties: PermissionRequest }`,
    `{ type: "permission.replied"; properties: { sessionID: string; requestID: string } }`.
  - `PermissionRequest` = `{ id; sessionID; action: string; resources: string[]; save?: string[]; metadata?: Record<string, JsonValue>; source?: { type: "tool"; messageID; id }; message?: string }`.
  - `PermissionReply = "once" | "always" | "reject"`.
  - Reducer: `packages/ui/src/sync/event-reducer.ts` `applyDirectoryEvent` cases at lines 681-707 (binary-insert by `permission.id`; splice on `permission.replied` by `requestID`).
  - Global index: `packages/ui/src/sync/global-blocking-requests.ts` (`applyGlobalBlockingRequestEvents`, `useGlobalBlockingRequestsStore`).
  - Reply path: `usePermissionResponse.ts` -> `sessionActions.respondToPermission` (`packages/ui/src/sync/session-actions.ts:2122`) -> `getAgentRuntimeForSession(sessionId).replyPermission(...)`.
  - UI dialogs: `PermissionCard.tsx`, `PermissionDock.tsx`.
  - OMP has no permission route/host method today (`omp-routes.js`, `omp-runtime-host.js`).

## File Structure

- Create: `packages/web/server/lib/agents/omp-approvals.js` (+ `.test.js`)
- Create: `packages/web/server/lib/agents/omp-config.js` (+ `.test.js`)
- Modify: `packages/omp-adapter/src/rpc-client.ts` (outbound `send`), `rpc-host.ts` (expose `send`, `onRawEvent`, permission state)
- Modify: `packages/web/server/lib/agents/omp-runtime-host.js`, `omp-routes.js`, `omp-routes.test.js`
- Modify: `packages/ui/src/lib/agent/omp-runtime.ts` (+ test)

---

### Task 1: Tool approvals → permission flow

**Interfaces:**
- Produces:
  - `createOmpApprovals({ broadcast, now? })` with `handleRequest(sessionId, frame)`, `resolve(sessionId, requestId, reply)`, `pending(sessionId)`.
  - Adapter: `OmpRpcClient.send(frame)`, and `OmpRpcClient.onRawEvent` already exists (`onEvent`); the host forwards `extension_ui_request` to `send` responses.
  - Routes: `GET /api/agents/omp/sessions/:id/permissions`, `POST /api/agents/omp/sessions/:id/permissions/:requestId` body `{ reply: "once"|"always"|"reject" }`.
- Consumes: RPC request frame `{ type: "extension_ui_request", id, method, title, message?, options?, placeholder?, prefill? }`; RPC reply `{ type: "extension_ui_response", id, value }` | `{ ..., confirmed }` | `{ ..., cancelled: true }`.

- [ ] **Step 1: Write the failing test** (create `omp-approvals.test.js`)

```js
import { describe, expect, it } from 'vitest';
import { createOmpApprovals } from './omp-approvals.js';

describe('createOmpApprovals', () => {
  it('broadcasts permission.asked for a confirm frame and records it', () => {
    const frames = [];
    const approvals = createOmpApprovals({ broadcast: (f) => frames.push(f) });
    approvals.handleRequest('ses_1', { type: 'extension_ui_request', id: 'ui_1', method: 'confirm', title: 'Run bash?', message: 'rm -rf build' });
    expect(approvals.pending('ses_1')).toHaveLength(1);
    expect(frames[0].type).toBe('openchamber:omp');
    expect(frames[0].properties.events[0]).toMatchObject({
      type: 'permission.asked',
      properties: { id: 'ui_1', sessionID: 'ses_1', resources: ['rm -rf build'] },
    });
  });

  it('maps a reply to an extension_ui_response', () => {
    const approvals = createOmpApprovals({ broadcast: () => {} });
    approvals.handleRequest('ses_1', { type: 'extension_ui_request', id: 'ui_1', method: 'confirm', title: 't', message: 'm' });
    expect(approvals.resolve('ses_1', 'ui_1', 'once')).toEqual({ type: 'extension_ui_response', id: 'ui_1', confirmed: true });
    expect(approvals.resolve('ses_1', 'ui_2', 'reject')).toBe(null);
    expect(approvals.pending('ses_1')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `bunx vitest run server/lib/agents/omp-approvals.test.js` (workdir `packages/web`).

- [ ] **Step 3: Implement `omp-approvals.js`**

Mapping (record this in the module docblock):
- `confirm` -> `PermissionRequest { action: "tool", resources: [message ?? title], message: title }`; reply `once`/`always` -> `{ confirmed: true }`, `reject` -> `{ confirmed: false }`.
- `select` -> `{ action: "select", resources: options }`; reply `once` -> `{ value: options[0] }` (the UI should send a value; extend the route body with optional `value`), `reject` -> `{ cancelled: true }`.
- `input`/`editor` -> `{ action: "input", resources: [] }`; reply maps `value` through (add optional `value` to the route body), `reject` -> `{ cancelled: true }`.
- On `handleRequest`, keep `{ frame }` in `Map<sessionId, Map<id, frame>>`; broadcast `permission.asked` (via a passed `broadcast` that wraps one `openchamber:omp` frame). On `resolve`, delete and return the envelope; also broadcast `permission.replied`.
- `pending(sessionId)` returns the mapped `PermissionRequest[]`.

- [ ] **Step 4: Add `send` to the RPC client**

In `packages/omp-adapter/src/rpc-client.ts`:

```ts
  send(frame: OmpRpcFrame): void {
    this.write(frame)
  }
```

- [ ] **Step 5: Wire the host**

In `omp-runtime-host.js`, before projecting each event, check `event.type === 'extension_ui_request'`: call `approvals.handleRequest(sessionId, event)` and do not project it. Expose host methods `replyPermission(id, requestId, reply, value?)` and `listPermissions(id)`; `replyPermission` calls `approvals.resolve` and then `client.send(envelope)` (needs the client reachable by session id — the P2 `clients` map on the host, or a `sendToSession(id, frame)` callback passed into the host).

- [ ] **Step 6: Routes**

Add:
```js
  const replySchema = z.object({ reply: z.enum(['once', 'always', 'reject']), value: z.string().optional() });
  app.get('/api/agents/omp/sessions/:id/permissions', async (req, res) => { /* host.listPermissions */ });
  app.post('/api/agents/omp/sessions/:id/permissions/:requestId', parseJsonBody, async (req, res) => { /* host.replyPermission */ });
```

- [ ] **Step 7: UI client** — implement `replyPermission`, `getPermission` (from `listPermissions` by id), `listPermissions` in `OmpRuntimeClient` and set `permissions: true`. `replyPermission` POSTs `{ reply, value }`; `listPermissions` GETs `/sessions/:id/permissions` for each option-directory session (mirror P2 `getActiveStatus` fan-out).

- [ ] **Step 8: Gate** — `bunx vitest run server/lib/agents` + `bun run --cwd packages/ui type-check && bunx vitest run src/lib/agent`.

- [ ] **Step 9: Manual** — trigger a tool that needs approval; confirm `PermissionDock` shows it and the answer resumes the run.

- [ ] **Step 10: Commit** — `feat(omp): surface tool approvals as permissions`.

---

### Task 2: MCP management via config files

**Interfaces:** `createOmpConfig({ home? })` -> `{ listMcp(), setMcpEnabled(name, enabled), removeMcp(name, scope), addMcp(definition, scope) }`; routes `GET /api/agents/omp/mcp`, `POST /api/agents/omp/mcp/:name/enabled` `{ enabled }`, `DELETE /api/agents/omp/mcp/:name` `?scope=project|user`.

- [ ] **Step 1: Discovery** — read OMP's `mcp.json` shape (project `.omp/mcp.json`, user `~/.omp/agent/mcp.json`) and `disabledServers`/`enabledServers`. Find the UI consumer (`grep -rln "listMcpServers\|McpServerStatus" packages/ui/src`).
- [ ] **Step 2: Failing test** — `omp-config.test.js` using an injected temp `home`: list merges project < user, `disabledServers` wins; enable/disable/remove/add mutate only OMP-managed files.
- [ ] **Step 3: Implement `omp-config.js`** with an injectable `fs`/`home` for tests.
- [ ] **Step 4: Routes + host + client** — implement `listMcpServers` (map config entries to `McpServerStatus`), `connectMcpServer`/`disconnectMcpServer` (toggle enabled), flip `mcp: true`.
- [ ] **Step 5: Gate** — tests + `type-check`; manual list/toggle.
- [ ] **Step 6: Commit** — `feat(omp): manage mcp servers through config files`.

---

### Task 3: Provider and model setup

- [ ] **Step 1: Discovery** — read the provider settings UI (`grep -rln "getProviders\|ProviderCatalog\|ProvidersPage" packages/ui/src`) and OMP auth storage / `custom-models` config (`~/.omp/agent/agent.db`, `~/.omp/agent/config.yml`).
- [ ] **Step 2: OAuth login** — add RPC `get_login_providers`/`login` routes; map the `open_url` + `input` `extension_ui_request` frames to the login dialog using Task 1's approvals plumbing.
- [ ] **Step 3: Model picker** — implement `selectModel(id, model)` in the client over the P2 `/sessions/:id/model` route, populate from `GET /models`, flip `modelSelection: true`. Route must call RPC `set_model { provider, modelId }`.
- [ ] **Step 4: Manual API key / custom provider** — write to OMP config/auth storage only; load `enterprise-boundary` first.
- [ ] **Step 5: Gate + commit** — `feat(omp): provider and model setup`.

---

### Task 4: Agent selection (model roles)

- [ ] **Step 1: Discovery** — determine whether RPC exposes OMP model roles for a session (`get_state`, config `roles`). 
- [ ] **Step 2:** If exposed, implement `selectAgent`/`listAgents` and flip `agentSelection: true`; otherwise keep `false`, hide the picker, and record the finding in `docs/agent-host/PHASE5-OMP.md`.
- [ ] **Step 3: Commit** — `feat(omp): agent selection` or `docs(omp): agent selection stays off (no rpc surface)`.

---

### Task 5: Attachments (images)

- [ ] **Step 1: Discovery** — the attach path (`ChatInput.tsx`, `components/chat/composer/attachments/inlineMentionAttachments.ts`, `fileMentionResults.ts`).
- [ ] **Step 2:** Map image file parts to the RPC prompt `images[]` (`{ type: "image", data, mimeType }`); decide non-image policy (path mention vs drop) and encode it in `sendPrompt`. Flip `attachments: true` only for images, or keep a narrower flag.
- [ ] **Step 3: Gate + commit** — tests + manual image attach; `feat(omp): image attachments`.

---

## Self-Review

- **Spec coverage:** remaining capability gaps (permissions, mcp, agentSelection,
  attachments) and the config/provider phase item each have a task.
  `forms`/`revert`/`turnDiff` stay `false` (no OMP analog).
- **Placeholder scan:** no TBD; discovery steps name exact commands and the
  decision each task records.
- **Type consistency:** `createOmpApprovals`/`createOmpConfig` names consistent;
  `PermissionRequest`/`PermissionReply` match `events.ts`/`model.ts`; capability
  keys match `AgentCapabilities`.
