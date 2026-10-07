# Phase 2: OMP UI client + default runtime — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OMP the default agent runtime in the shared UI and give `OmpRuntimeClient` the session-management, model, command and status methods the UI already calls, over the server routes added in P1.

**Architecture:** P1 gave the server a working RPC host for sessions/prompt/abort/messages. P2 extends the adapter (`runtime.ts`) and server host with rename, delete, move, `/status`, models and commands, exposes them as routes, implements them in `OmpRuntimeClient`, sets the registry default to `omp`, and updates the capability matrix. OpenCode code still exists (removed in P3), but no agent-domain UI path resolves to it once the default flips.

**Tech Stack:** TypeScript (adapter, `bun:test`), Express + Zod (server, Vitest), React client (`OmpRuntimeClient`, Vitest).

**Spec:** `docs/superpowers/specs/2026-10-07-omp-only-runtime-design.md`

## Global Constraints

- Builds on P1 (`docs/superpowers/plans/2026-10-07-p1-rpc-adapter-server-host.md`); all P1 tasks are prerequisites.
- `OmpRuntimeClient.id` is `"omp"`; every method either works or rejects via the `unsupported` helper — never a silent empty result.
- Capability flags gate the UI; a flag is `true` only when the method is implemented and its route exists.
- Adapter tests use `bun:test`; server and UI tests use Vitest.
- Do not modify `../opencode`.

## File Structure

- `packages/omp-adapter/src/runtime.ts` — modify. Add host methods to `OmpRuntime`: `renameSession`, `deleteSession`, `moveSession`, `listModels`, `listCommands`.
- `packages/omp-adapter/src/rpc-host.ts` — modify. Implement the new `OmpHost` methods over RPC + store.
- `packages/omp-adapter/src/runtime.test.ts`, `rpc-host.test.ts` — modify.
- `packages/web/server/lib/agents/omp-runtime-host.js` — modify. Expose the new host calls.
- `packages/web/server/lib/agents/omp-routes.js` — modify. New routes.
- `packages/web/server/lib/agents/omp-routes.test.js` — modify.
- `packages/ui/src/lib/agent/omp-runtime.ts` — modify. Implement methods, update `CAPABILITIES`.
- `packages/ui/src/lib/agent/omp-runtime.test.ts` — modify.
- `packages/ui/src/lib/agent/registry.ts` — modify. Default runtime `omp`.
- `packages/ui/src/lib/agent/registry.test.ts` — modify.

---

### Task 1: Adapter — rename, delete, move, models, commands

**Files:**
- Modify: `packages/omp-adapter/src/runtime.ts`
- Modify: `packages/omp-adapter/src/rpc-host.ts`
- Test: `packages/omp-adapter/src/runtime.test.ts`, `packages/omp-adapter/src/rpc-host.test.ts`

**Interfaces:**
- Produces on `OmpHost` and `OmpRuntime`:
  - `renameSession(id: string, title: string): Promise<void>`
  - `deleteSession(id: string): Promise<boolean>`
  - `moveSession(id: string, toDirectory: string): Promise<void>`
  - `listModels(): Promise<unknown[]>` — the RPC `Model[]`, opaque to the adapter.
  - `listCommands(): Promise<unknown[]>` — the RPC `RpcAvailableSlashCommand[]`.
- Consumes: `OmpSessionStore.modify`, RPC `set_session_name`, `get_available_models`, `get_available_commands`.

- [ ] **Step 1: Write the failing test**

In `packages/omp-adapter/src/runtime.test.ts`, extend the fake host and add tests:

```ts
// makeHost gains:
    renameSession: async (id, title) => { renamed.push([id, title]) },
    deleteSession: async (id) => { deleted.push(id); return true },
    moveSession: async (id, to) => { moved.push([id, to]) },
    listModels: async () => models,
    listCommands: async () => commands,
```

Add tests inside `describe("OmpRuntime")`:

```ts
  test("delegates rename, delete and move to the host", async () => {
    const { host } = makeHost([info("ses_a")])
    const runtime = new OmpRuntime(host)
    await runtime.renameSession("ses_a", "New title")
    await runtime.deleteSession("ses_a")
    await runtime.moveSession("ses_a", "/repo/b")
    // assertions on the captured arrays from makeHost
  })

  test("reads models and commands from the host", async () => {
    const { host } = makeHost([])
    const runtime = new OmpRuntime(host)
    expect(await runtime.listModels()).toEqual([{ provider: "anthropic", id: "claude" }])
    expect(await runtime.listCommands()).toEqual([{ name: "goal", source: "builtin" }])
  })
```

(Extend `makeHost` to return the captured `renamed`/`deleted`/`moved` arrays and the two fixture arrays.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/runtime.test.ts` (workdir `packages/omp-adapter`)
Expected: FAIL — methods missing.

- [ ] **Step 3: Implement `OmpRuntime` delegates**

In `packages/omp-adapter/src/runtime.ts`, extend `OmpHost` and `OmpRuntime`:

```ts
export type OmpHost = {
  listSessions: () => Promise<OmpSessionInfo[]>
  openSession: (input: { sessionPath?: string; cwd?: string }) => Promise<OmpSessionHandle>
  renameSession: (id: string, title: string) => Promise<void>
  deleteSession: (id: string) => Promise<boolean>
  moveSession: (id: string, toDirectory: string) => Promise<void>
  listModels: () => Promise<unknown[]>
  listCommands: () => Promise<unknown[]>
}

// on OmpRuntime:
  renameSession(id: string, title: string): Promise<void> {
    return this.host.renameSession(id, title)
  }
  deleteSession(id: string): Promise<boolean> {
    return this.host.deleteSession(id)
  }
  moveSession(id: string, toDirectory: string): Promise<void> {
    return this.host.moveSession(id, toDirectory)
  }
  listModels(): Promise<unknown[]> {
    return this.host.listModels()
  }
  listCommands(): Promise<unknown[]> {
    return this.host.listCommands()
  }
```

- [ ] **Step 4: Implement the RPC host methods**

In `packages/omp-adapter/src/rpc-host.ts`, inside `createOmpHost`, add helpers that open a session's client and run a command, then:

```ts
    renameSession: async (id, title) => {
      const client = await sessionClient(id)
      await client.command("set_session_name", { name: title })
    },
    deleteSession: async (id) => {
      const info = (await store.list()).find((s) => s.id === id)
      if (!info) return false
      await store.delete(info.sessionPath)
      return true
    },
    moveSession: async (id, toDirectory) => {
      const info = (await store.list()).find((s) => s.id === id)
      if (!info) throw new Error(`unknown omp session: ${id}`)
      await store.move(info.sessionPath, toDirectory)
    },
    listModels: async () => {
      const client = await hostClient()
      const result = await client.command<{ models: unknown[] }>("get_available_models")
      return result.models
    },
    listCommands: async () => {
      const client = await hostClient()
      const result = await client.command<{ commands: unknown[] }>("get_available_commands")
      return result.commands
    },
```

Where `hostClient()` spawns a client in the default cwd (models and commands are process-scoped), and `sessionClient(id)` reuses an attached handle's client (add a private `clients` map keyed by session id, populated in `openSession`, removed on dispose).

- [ ] **Step 5: Update `rpc-host.test.ts`**

Add a test that `deleteSession` removes the file via a fake store and `renameSession` issues `set_session_name`:

```ts
  test("renames over rpc and deletes through the store", async () => {
    const fake = fakeChild()
    const deleted: string[] = []
    const store = {
      list: async () => [{ id: "ses_1", sessionPath: "/s/ses_1.jsonl", cwd: "/repo", title: "t" }],
      delete: async (p: string) => { deleted.push(p) },
      move: async () => { throw new Error("unused") },
    }
    const host = createOmpHost({ spawn: () => fake.child, store })
    const opening = host.openSession({ cwd: "/repo" })
    fake.emit(JSON.stringify({ type: "ready" }))
    await Promise.resolve()
    const stateReq = JSON.parse(fake.written.at(-1) ?? "{}") as { id: string }
    fake.emit(JSON.stringify({ id: stateReq.id, type: "response", command: "get_state", success: true, data: { sessionId: "ses_1" } }))
    await opening
    const renaming = host.renameSession("ses_1", "Renamed")
    const renameReq = JSON.parse(fake.written.at(-1) ?? "{}") as { id: string; type: string; name: string }
    expect(renameReq).toMatchObject({ type: "set_session_name", name: "Renamed" })
    fake.emit(JSON.stringify({ id: renameReq.id, type: "response", command: "set_session_name", success: true }))
    await renaming
    expect(await host.deleteSession("ses_1")).toBe(true)
    expect(deleted).toEqual(["/s/ses_1.jsonl"])
  })
```

- [ ] **Step 6: Run tests**

Run: `bun test && bun run type-check` (workdir `packages/omp-adapter`)
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/omp-adapter/src/runtime.ts packages/omp-adapter/src/runtime.test.ts packages/omp-adapter/src/rpc-host.ts packages/omp-adapter/src/rpc-host.test.ts
git commit -m "feat(omp): session rename/delete/move and model/command listing"
```

---

### Task 2: Server — host plumbing and routes

**Files:**
- Modify: `packages/web/server/lib/agents/omp-runtime-host.js`
- Modify: `packages/web/server/lib/agents/omp-routes.js`
- Test: `packages/web/server/lib/agents/omp-routes.test.js`

**Interfaces:**
- Produces routes:
  - `PATCH /api/agents/omp/sessions/:id` `{ title }` -> `{ ok }`
  - `DELETE /api/agents/omp/sessions/:id` -> `{ ok }`
  - `POST /api/agents/omp/sessions/:id/move` `{ directory }` -> `{ session }`
  - `GET /api/agents/omp/models` -> `{ models }`
  - `GET /api/agents/omp/commands` -> `{ commands }`
- Consumes: the adapter host from Task 1.

- [ ] **Step 1: Write the failing tests**

Add to `packages/web/server/lib/agents/omp-routes.test.js` (mirror the existing fake-adapter style):

```js
  it('renames, deletes and moves a session', async () => {
    const adapter = createAdapter(); // existing helper; extend with renameSession/deleteSession/moveSession
    const app = express();
    await installOmpAgentRuntime({ app, broadcast: () => {}, adapter });
    expect((await request(app).patch('/api/agents/omp/sessions/ses_1').send({ title: 'Renamed' })).status).toBe(200);
    expect((await request(app).delete('/api/agents/omp/sessions/ses_1')).status).toBe(200);
    expect((await request(app).post('/api/agents/omp/sessions/ses_1/move').send({ directory: '/repo/b' })).status).toBe(200);
  });

  it('lists models and commands', async () => {
    const adapter = createAdapter();
    const app = express();
    await installOmpAgentRuntime({ app, broadcast: () => {}, adapter });
    expect((await request(app).get('/api/agents/omp/models')).body).toEqual({ models: [] });
    expect((await request(app).get('/api/agents/omp/commands')).body).toEqual({ commands: [] });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run server/lib/agents/omp-routes.test.js` (workdir `packages/web`)
Expected: FAIL — 404 on the new routes.

- [ ] **Step 3: Expose the host calls**

In `packages/web/server/lib/agents/omp-runtime-host.js`, add to the returned object:

```js
    renameSession: (id, title) => runtime.renameSession(id, title),
    deleteSession: (id) => runtime.deleteSession(id),
    moveSession: (id, toDirectory) => runtime.moveSession(id, toDirectory),
    listModels: () => runtime.listModels(),
    listCommands: () => runtime.listCommands(),
```

- [ ] **Step 4: Register the routes**

In `packages/web/server/lib/agents/omp-routes.js`, add (after the abort route):

```js
  const renameBodySchema = z.object({ title: z.string().min(1) });
  const moveBodySchema = z.object({ directory: z.string().min(1) });

  app.patch('/api/agents/omp/sessions/:id', parseJsonBody, async (req, res) => {
    const parsed = renameBodySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'title must be a non-empty string' });
    try {
      await (await getHost()).renameSession(req.params.id, parsed.data.title);
      return res.json({ ok: true });
    } catch (error) {
      return respondWithError(res, error, 'Failed to rename OMP session');
    }
  });

  app.delete('/api/agents/omp/sessions/:id', async (req, res) => {
    try {
      return res.json({ ok: await (await getHost()).deleteSession(req.params.id) });
    } catch (error) {
      return respondWithError(res, error, 'Failed to delete OMP session');
    }
  });

  app.post('/api/agents/omp/sessions/:id/move', parseJsonBody, async (req, res) => {
    const parsed = moveBodySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'directory must be a non-empty string' });
    try {
      await (await getHost()).moveSession(req.params.id, parsed.data.directory);
      return res.json({ ok: true });
    } catch (error) {
      return respondWithError(res, error, 'Failed to move OMP session');
    }
  });

  app.get('/api/agents/omp/models', async (_req, res) => {
    try {
      return res.json({ models: await (await getHost()).listModels() });
    } catch (error) {
      return respondWithError(res, error, 'Failed to list OMP models');
    }
  });

  app.get('/api/agents/omp/commands', async (_req, res) => {
    try {
      return res.json({ commands: await (await getHost()).listCommands() });
    } catch (error) {
      return respondWithError(res, error, 'Failed to list OMP commands');
    }
  });
```

Register these **before** the generic `/:id/messages` route is irrelevant (paths differ), but keep them above any catch-all proxy.

- [ ] **Step 5: Run tests**

Run: `bunx vitest run server/lib/agents` (workdir `packages/web`)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/server/lib/agents/omp-runtime-host.js packages/web/server/lib/agents/omp-routes.js packages/web/server/lib/agents/omp-routes.test.js
git commit -m "feat(server): omp session mutations and model/command routes"
```

---

### Task 3: UI client — implement methods and capabilities

**Files:**
- Modify: `packages/ui/src/lib/agent/omp-runtime.ts`
- Test: `packages/ui/src/lib/agent/omp-runtime.test.ts`

**Interfaces:**
- Produces: implemented `renameSession`, `deleteSession`, `moveSession`, `selectModel`, `getActiveStatus`, `listCommands`, `listSkills`; `CAPABILITIES` with `rename/delete/move/modelSelection/commands/skills = true`, `permissions/mcp/forms/revert/turnDiff/agents/agentSelection/fork/attachments = false`.
- Consumes: routes from Task 2, `runtimeFetch`.

- [ ] **Step 1: Write the failing test**

Extend `packages/ui/src/lib/agent/omp-runtime.test.ts` (existing file already injects `fetchImpl`):

```ts
  it("renames, deletes and moves a session", async () => {
    const calls: Array<{ url: string; method: string }> = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET" })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof runtimeFetch
    const runtime = new OmpRuntimeClient(fetchImpl)
    await runtime.renameSession("ses_1", "Renamed")
    expect(await runtime.deleteSession("ses_1")).toBe(true)
    await runtime.moveSession("ses_1", "/repo/b")
    expect(calls).toEqual([
      { url: "/api/agents/omp/sessions/ses_1", method: "PATCH" },
      { url: "/api/agents/omp/sessions/ses_1", method: "DELETE" },
      { url: "/api/agents/omp/sessions/ses_1/move", method: "POST" },
    ])
  })

  it("advertises the enabled capabilities", () => {
    const runtime = new OmpRuntimeClient(async () => new Response("{}"))
    expect(runtime.capabilities).toMatchObject({ rename: true, delete: true, move: true, commands: true, skills: true })
    expect(runtime.capabilities.mcp).toBe(false)
    expect(runtime.capabilities.forms).toBe(false)
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run src/lib/agent/omp-runtime.test.ts` (workdir `packages/ui`)
Expected: FAIL — methods reject as unsupported.

- [ ] **Step 3: Implement the methods**

In `packages/ui/src/lib/agent/omp-runtime.ts`, update `CAPABILITIES` and replace the corresponding `unsupported` stubs:

```ts
const CAPABILITIES: AgentCapabilities = {
  fork: false,
  commands: true,
  mcp: false,
  agents: false,
  permissions: false,
  modelSelection: true,
  agentSelection: false,
  forms: false,
  revert: false,
  turnDiff: false,
  skills: true,
  rename: true,
  delete: true,
  move: true,
  attachments: false,
}
```

```ts
  async renameSession(id: string): Promise<void> {
    const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: arguments[1] as string }),
    })
    await readJson(response, okSchema)
  }

  async deleteSession(id: string): Promise<boolean> {
    const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(id)}`, { method: "DELETE" })
    return (await readJson(response, okSchema)).ok
  }

  async moveSession(id: string, toDirectory: string): Promise<void> {
    const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(id)}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory: toDirectory }),
    })
    await readJson(response, okSchema)
  }
```

Keep the exact contract signatures (`renameSession(id, title, directory?)`, etc.) — use named parameters, not `arguments`. Replace the `unsupported("selectModel")`, `unsupported("listCommands")` and `unsupported("listSkills")` stubs correspondingly: `selectModel` posts `{ provider, modelId }` to `/sessions/:id/model` (add the route in Task 2 if not present, or defer to P3 when the picker is wired — record the decision in the commit message). `listCommands` reads `/commands`; `listSkills` filters commands by `source === "skill"`.

- [ ] **Step 4: Run tests**

Run: `bunx vitest run src/lib/agent/omp-runtime.test.ts` (workdir `packages/ui`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/agent/omp-runtime.ts packages/ui/src/lib/agent/omp-runtime.test.ts
git commit -m "feat(ui): omp client session mutations and capabilities"
```

---

### Task 4: Registry default = omp

**Files:**
- Modify: `packages/ui/src/lib/agent/registry.ts`
- Test: `packages/ui/src/lib/agent/registry.test.ts`

**Interfaces:**
- Produces: `getAgentRuntime()` with no argument resolves to the OMP client; `DEFAULT_RUNTIME_ID = "omp"`. `registerSessionRuntime`/`getAgentRuntimeForSession` unchanged.

- [ ] **Step 1: Write the failing test**

Update `packages/ui/src/lib/agent/registry.test.ts`:

```ts
  it("defaults to the omp runtime", () => {
    expect(getAgentRuntime().id).toBe("omp")
    expect(getAgentRuntimeForSession("ses_unknown").id).toBe("omp")
  })
```

(Remove assertions that the default is OpenCode.)

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run src/lib/agent/registry.test.ts` (workdir `packages/ui`)
Expected: FAIL — default is `opencode`.

- [ ] **Step 3: Flip the default**

In `packages/ui/src/lib/agent/registry.ts`:

```ts
const DEFAULT_RUNTIME_ID = "omp"
```

Update `getAgentRuntime` so the fallback returns the cached OMP client:

```ts
export const getAgentRuntime = (runtimeId: string = DEFAULT_RUNTIME_ID): AgentRuntime => {
  const registered = registeredRuntimes.get(runtimeId)
  if (registered) return registered
  cachedOmp ??= new OmpRuntimeClient()
  return cachedOmp
}
```

Remove `cachedDefault`, `OpenCodeRuntime` and `AcpRuntimeClient` construction from this file (their modules are deleted in P3; leave the imports until P3 if the tree must compile, but stop resolving them).

- [ ] **Step 4: Run tests + type-check**

Run: `bunx vitest run src/lib/agent && bun run type-check` (workdir `packages/ui`)
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/agent/registry.ts packages/ui/src/lib/agent/registry.test.ts
git commit -m "feat(ui): make omp the default agent runtime"
```

---

### Task 5: Verify the agent-domain path end to end on web

**Files:** none (verification task).

- [ ] **Step 1: Start web + UI**

Run: `bun run --cwd packages/web dev:server` and, in another shell, the UI dev server (`bun run --cwd packages/web dev`).
Expected: both boot.

- [ ] **Step 2: Create a session and send a prompt in the browser**

Confirm the message streams, the session appears in the sidebar, and cancel works. Expected: driven by `OmpRuntimeClient`, no OpenCode network calls in devtools.

- [ ] **Step 3: Rename and delete a session**

Use the sidebar session menu. Expected: rename persists (reflected after reload), delete removes it.

- [ ] **Step 4: Report**

Record verified flows and any gap discovered (then add tasks for it). No commit.

---

## Self-Review

- **Spec coverage:** "Expand OmpRuntimeClient"; "registry.ts single runtime omp";
  "session-capabilities" update; server routes for mutations/models/commands —
  Tasks 1–4. `selectModel` route wiring is explicitly deferred to the picker
  work (P3) with a recorded decision, not a silent stub.
- **Placeholder scan:** no TBD; the `selectModel` note names the exact deferred
  decision.
- **Type consistency:** `OmpHost`/`OmpRuntime` method names match between
  runtime.ts and rpc-host.ts; capability keys match `AgentCapabilities` in
  `contract.ts`; route paths match between omp-routes.js and omp-runtime.ts.
