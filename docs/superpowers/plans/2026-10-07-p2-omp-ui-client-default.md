# Phase 2: OMP UI client + default runtime — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `OmpRuntimeClient` the session-management, model, command and status methods the UI calls, expose them through the adapter and server, and make OMP the registry default.

**Architecture:** Extend the P1 adapter (`OmpRuntime`/`OmpHost` + `rpc-host`) and server host/routes, then implement the matching `OmpRuntimeClient` methods, flip its capabilities, and change `registry.ts` so every unbound session and draft resolves to OMP.

**Tech Stack:** TypeScript (`bun:test` for adapter), Express + Zod + Vitest (server), React/Vitest (UI).

**Spec:** `docs/superpowers/specs/2026-10-07-omp-only-runtime-design.md`

## Global Constraints

- P1 is a prerequisite; `OmpRuntime`/`OmpHost`/`OmpRpcClient`/session store already exist.
- `OmpRuntimeClient.id === "omp"`; unsupported methods keep rejecting via the `unsupported` helper.
- A capability flag is `true` only when its route + client method + test exist in the same task.
- Current reality to reconcile (verified):
  - `packages/ui/src/lib/agent/registry.test.ts` asserts the default is `"opencode"` and that `"acp"` resolves; this plan rewrites it.
  - `packages/ui/src/lib/agent/omp-runtime.test.ts` asserts all capabilities `false` and `translateEvent()` `[]`; this plan updates the capability assertion only.
  - `packages/ui/src/lib/agent/registry.ts` currently builds `OpenCodeRuntime`/`AcpRuntimeClient`; `registry.test.ts` imports `OpenCodeRuntime` for a custom-registration test — keep a custom registration test using a stub, not `OpenCodeRuntime`.
- Do not modify `../opencode`.

## File Structure

- `packages/omp-adapter/src/runtime.ts` — modify. New `OmpHost`/`OmpRuntime` methods.
- `packages/omp-adapter/src/rpc-host.ts` — modify. Implement new host methods.
- `packages/omp-adapter/src/rpc-host.test.ts` — modify.
- `packages/web/server/lib/agents/omp-runtime-host.js` — modify. Expose new host calls.
- `packages/web/server/lib/agents/omp-routes.js` — modify. New routes.
- `packages/web/server/lib/agents/omp-routes.test.js` — modify.
- `packages/ui/src/lib/agent/omp-runtime.ts` — modify. Methods + capabilities + one schema.
- `packages/ui/src/lib/agent/omp-runtime.test.ts` — modify.
- `packages/ui/src/lib/agent/registry.ts` — modify. Default `omp`.
- `packages/ui/src/lib/agent/registry.test.ts` — modify.

---

### Task 1: Adapter — rename, delete, move, models, commands, per-session status

**Files:**
- Modify: `packages/omp-adapter/src/runtime.ts`
- Modify: `packages/omp-adapter/src/rpc-host.ts`
- Test: `packages/omp-adapter/src/runtime.test.ts`, `packages/omp-adapter/src/rpc-host.test.ts`

**Interfaces:**
- Produces on `OmpHost` and `OmpRuntime`:
  - `renameSession(id: string, title: string): Promise<void>`
  - `deleteSession(id: string): Promise<boolean>`
  - `moveSession(id: string, toDirectory: string): Promise<void>`
  - `listModels(): Promise<unknown[]>`
  - `listCommands(): Promise<unknown[]>`
  - `getSessionStatus(id: string): Promise<{ busy: boolean }>`
- Consumes: RPC `set_session_name`, `get_available_models`, `get_available_commands`, `get_state`; `OmpSessionStore.delete/move`.

- [ ] **Step 1: Write the failing test**

Extend `packages/omp-adapter/src/runtime.test.ts`. Update `makeHost` to capture calls and return fixtures:

```ts
const makeHost = (infos: OmpSessionInfo[]) => {
  const handles = new Map<string, FakeHandle>()
  const opened: string[] = []
  const renamed: Array<[string, string]> = []
  const deleted: string[] = []
  const moved: Array<[string, string]> = []
  const models = [{ provider: "anthropic", id: "claude" }]
  const commands = [{ name: "goal", source: "builtin" }]
  const host: OmpHost = {
    listSessions: async () => infos,
    openSession: async (input) => { /* unchanged */ },
    renameSession: async (id, title) => { renamed.push([id, title]) },
    deleteSession: async (id) => { deleted.push(id); return true },
    moveSession: async (id, to) => { moved.push([id, to]) },
    listModels: async () => models,
    listCommands: async () => commands,
    getSessionStatus: async () => ({ busy: false }),
  }
  return { host, opened, handles, renamed, deleted, moved }
}
```

Add tests:

```ts
  test("delegates rename, delete and move to the host", async () => {
    const { host, renamed, deleted, moved } = makeHost([info("ses_a")])
    const runtime = new OmpRuntime(host)
    await runtime.renameSession("ses_a", "New title")
    expect(await runtime.deleteSession("ses_a")).toBe(true)
    await runtime.moveSession("ses_a", "/repo/b")
    expect(renamed).toEqual([["ses_a", "New title"]])
    expect(deleted).toEqual(["ses_a"])
    expect(moved).toEqual([["ses_a", "/repo/b"]])
  })

  test("reads models, commands and session status from the host", async () => {
    const { host } = makeHost([])
    const runtime = new OmpRuntime(host)
    expect(await runtime.listModels()).toEqual([{ provider: "anthropic", id: "claude" }])
    expect(await runtime.listCommands()).toEqual([{ name: "goal", source: "builtin" }])
    expect(await runtime.getSessionStatus("ses_a")).toEqual({ busy: false })
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/runtime.test.ts` (workdir `packages/omp-adapter`)
Expected: FAIL — `renameSession` etc. not on `OmpRuntime`.

- [ ] **Step 3: Implement the `OmpRuntime` delegates**

In `packages/omp-adapter/src/runtime.ts`, extend `OmpHost`:

```ts
export type OmpHost = {
  listSessions: () => Promise<OmpSessionInfo[]>
  openSession: (input: { sessionPath?: string; cwd?: string }) => Promise<OmpSessionHandle>
  renameSession: (id: string, title: string) => Promise<void>
  deleteSession: (id: string) => Promise<boolean>
  moveSession: (id: string, toDirectory: string) => Promise<void>
  listModels: () => Promise<unknown[]>
  listCommands: () => Promise<unknown[]>
  getSessionStatus: (id: string) => Promise<{ busy: boolean }>
}
```

Add matching methods to `OmpRuntime` that forward to `this.host`.

- [ ] **Step 4: Implement the RPC host methods**

In `packages/omp-adapter/src/rpc-host.ts`:
- Keep a `clients = new Map<string, OmpRpcClient>()` populated in `openSession` (keyed by `state.sessionId`), removed in the handle's `dispose`.
- Add a `hostClient()` that spawns a short-lived client in `process.cwd()` for process-scoped commands (models, commands) and disposes it after.

```ts
    renameSession: async (id, title) => {
      const client = clients.get(id)
      if (!client) throw new Error(`unknown omp session: ${id}`)
      await client.command("set_session_name", { name: title })
    },
    deleteSession: async (id) => {
      const info = (await store.list()).find((s) => s.id === id)
      if (!info) return false
      clients.get(id)?.dispose?.()
      clients.delete(id)
      await store.delete(info.sessionPath)
      return true
    },
    moveSession: async (id, toDirectory) => {
      const info = (await store.list()).find((s) => s.id === id)
      if (!info) throw new Error(`unknown omp session: ${id}`)
      await store.move(info.sessionPath, toDirectory)
    },
    listModels: async () => {
      const client = new OmpRpcClient({ command, args, env: options.env, spawn })
      try {
        await client.start()
        return (await client.command<{ models: unknown[] }>("get_available_models")).models
      } finally {
        await client.dispose()
      }
    },
    listCommands: async () => {
      const client = new OmpRpcClient({ command, args, env: options.env, spawn })
      try {
        await client.start()
        return (await client.command<{ commands: unknown[] }>("get_available_commands")).commands
      } finally {
        await client.dispose()
      }
    },
    getSessionStatus: async (id) => {
      const client = clients.get(id)
      if (!client) return { busy: false }
      const state = await client.command<{ isStreaming?: boolean }>("get_state")
      return { busy: state.isStreaming === true }
    },
```

- [ ] **Step 5: Add a `rpc-host.test.ts` case**

Cover: `deleteSession` calls store delete and disposes the client; `renameSession` on an unknown session throws; `listModels` spawns+disposes and returns `models`.

- [ ] **Step 6: Run tests + type-check**

Run: `bun test && bun run type-check` (workdir `packages/omp-adapter`)
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/omp-adapter/src/runtime.ts packages/omp-adapter/src/runtime.test.ts packages/omp-adapter/src/rpc-host.ts packages/omp-adapter/src/rpc-host.test.ts
git commit -m "feat(omp): session mutations, model/command listing and status"
```

---

### Task 2: Server — host plumbing and routes

**Files:**
- Modify: `packages/web/server/lib/agents/omp-runtime-host.js`
- Modify: `packages/web/server/lib/agents/omp-routes.js`
- Test: `packages/web/server/lib/agents/omp-routes.test.js`

**Interfaces:**
- Produces routes (all under `/api/agents/omp`):
  - `PATCH /sessions/:id` `{ title }` -> `{ ok }`
  - `DELETE /sessions/:id` -> `{ ok }`
  - `POST /sessions/:id/move` `{ directory }` -> `{ ok }`
  - `POST /sessions/:id/model` `{ provider, modelId }` -> `{ ok }`
  - `GET /sessions/:id/status` -> `{ busy }`
  - `GET /models` -> `{ models }`
  - `GET /commands` -> `{ commands }`

- [ ] **Step 1: Write the failing tests**

Add to `packages/web/server/lib/agents/omp-routes.test.js` (its fake adapter returns a runtime object; extend that fake with `renameSession`, `deleteSession`, `moveSession`, `setModel`, `getSessionStatus`, `listModels`, `listCommands`):

```js
  it('serves session mutations', async () => {
    const app = express();
    await installOmpAgentRuntime({ app, broadcast: () => {}, adapter: createAdapter() });
    expect((await request(app).patch('/api/agents/omp/sessions/ses_1').send({ title: 'Renamed' })).body).toEqual({ ok: true });
    expect((await request(app).delete('/api/agents/omp/sessions/ses_1')).body).toEqual({ ok: true });
    expect((await request(app).post('/api/agents/omp/sessions/ses_1/move').send({ directory: '/repo/b' })).body).toEqual({ ok: true });
    expect((await request(app).post('/api/agents/omp/sessions/ses_1/model').send({ provider: 'anthropic', modelId: 'claude' })).body).toEqual({ ok: true });
  });

  it('serves status, models and commands', async () => {
    const app = express();
    await installOmpAgentRuntime({ app, broadcast: () => {}, adapter: createAdapter() });
    expect((await request(app).get('/api/agents/omp/sessions/ses_1/status')).body).toEqual({ busy: false });
    expect((await request(app).get('/api/agents/omp/models')).body).toEqual({ models: [] });
    expect((await request(app).get('/api/agents/omp/commands')).body).toEqual({ commands: [] });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run server/lib/agents/omp-routes.test.js` (workdir `packages/web`)
Expected: FAIL — routes 404.

- [ ] **Step 3: Expose host calls**

In `packages/web/server/lib/agents/omp-runtime-host.js`, add to the returned controller:

```js
    renameSession: (id, title) => runtime.renameSession(id, title),
    deleteSession: (id) => runtime.deleteSession(id),
    moveSession: (id, toDirectory) => runtime.moveSession(id, toDirectory),
    getSessionStatus: (id) => runtime.getSessionStatus(id),
    listModels: () => runtime.listModels(),
    listCommands: () => runtime.listCommands(),
```

For `setModel`, add `setModel: (id, provider, modelId) => runtime.promptSessionModel?.(id, provider, modelId)` only if Task 3 implements `selectModel`; otherwise register the route but have it answer 501 and do not set the capability (see Task 3 Step 3).

- [ ] **Step 4: Register the routes**

In `packages/web/server/lib/agents/omp-routes.js`, add the schemas and handlers from the P2 interface list, placed with the other `/sessions/:id/*` routes (before any catch-all). Reuse `respondWithError` and `isUnknownSession`. For `/sessions/:id/status`, if the session is unknown, answer 404.

- [ ] **Step 5: Run tests**

Run: `bunx vitest run server/lib/agents` (workdir `packages/web`)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/server/lib/agents/omp-runtime-host.js packages/web/server/lib/agents/omp-routes.js packages/web/server/lib/agents/omp-routes.test.js
git commit -m "feat(server): omp session mutations, status, models and commands"
```

---

### Task 3: UI client — methods and capabilities

**Files:**
- Modify: `packages/ui/src/lib/agent/omp-runtime.ts`
- Test: `packages/ui/src/lib/agent/omp-runtime.test.ts`

**Interfaces:**
- Produces implemented: `renameSession`, `deleteSession`, `moveSession`, `listCommands`, `listSkills`, `getActiveStatus`.
- Capabilities: `{ fork:false, commands:true, mcp:false, agents:false, permissions:false, modelSelection:false, agentSelection:false, forms:false, revert:false, turnDiff:false, skills:true, rename:true, delete:true, move:true, attachments:false }`.
  `modelSelection` stays `false` until the model picker route is wired (P5 Task 3); the `/model` route may exist but is not advertised.
- Consumes: routes from Task 2, `runtimeFetch`.

- [ ] **Step 1: Write the failing test**

Replace the capability assertion in `packages/ui/src/lib/agent/omp-runtime.test.ts` (currently `Object.values(...).toEqual([false x15])`) with:

```ts
  test("advertises the enabled capabilities", () => {
    const { client } = makeClient({})
    expect(client.capabilities).toMatchObject({
      rename: true, delete: true, move: true, commands: true, skills: true,
      mcp: false, forms: false, revert: false, turnDiff: false, modelSelection: false,
    })
  })
```

Add:

```ts
  test("renames, deletes and moves a session", async () => {
    const { client, calls } = makeClient({
      "PATCH /api/agents/omp/sessions/ses_a": { body: { ok: true } },
      "DELETE /api/agents/omp/sessions/ses_a": { body: { ok: true } },
      "POST /api/agents/omp/sessions/ses_a/move": { body: { ok: true } },
    })
    await client.renameSession("ses_a", "Renamed")
    expect(await client.deleteSession("ses_a")).toBe(true)
    await client.moveSession("ses_a", "/repo/b")
    expect(calls).toEqual([
      { url: "/api/agents/omp/sessions/ses_a", method: "PATCH", body: { title: "Renamed" } },
      { url: "/api/agents/omp/sessions/ses_a", method: "DELETE", body: undefined },
      { url: "/api/agents/omp/sessions/ses_a/move", method: "POST", body: { directory: "/repo/b" } },
    ])
  })

  test("lists commands and derives skills", async () => {
    const { client } = makeClient({
      "GET /api/agents/omp/commands": { body: { commands: [
        { name: "goal", source: "builtin", description: "g" },
        { name: "commit", source: "skill", description: "c" },
      ] } },
    })
    expect((await client.listCommands()).map((c) => c.name)).toEqual(["goal", "commit"])
    expect((await client.listSkills()).map((s) => s.name)).toEqual(["commit"])
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run src/lib/agent/omp-runtime.test.ts` (workdir `packages/ui`)
Expected: FAIL.

- [ ] **Step 3: Implement**

In `packages/ui/src/lib/agent/omp-runtime.ts`:
- Set the capability object per the interface block.
- Add a `commandSchema` and `commandsSchema` (`z.object({ commands: z.array(z.object({ name: z.string(), source: z.string(), description: z.string().optional() })) })`) and a `statusSchema` (`z.object({ busy: z.boolean() })`).
- Implement `renameSession(id, title)`, `deleteSession(id)`, `moveSession(id, to)`, `listCommands()` (GET `/commands`, map to `Command`), `listSkills()` (filter `source === "skill"`, map to `Skill`), `getActiveStatus(directory)` (for each session id from `fetchSessions()`, GET `/sessions/:id/status`, build `Record<string, SessionStatus>`; map `busy` to the OpenCode `SessionStatus` busy shape used elsewhere — read it in `@/lib/opencode/model` and match).
- Remove those `unsupported(...)` stubs. Leave `selectModel`/`selectAgent`/`listAgents`/`forkSession`/`listMcpServers`/`connectMcpServer`/`disconnectMcpServer`/`replyPermission`/`getPermission`/`listPermissions`/`replyForm`/`cancelForm`/`listPendingForms`/`stageRevert`/`commitRevert`/`clearRevert`/`getSessionTurnDiff`/`sendCommand` as `unsupported`.

- [ ] **Step 4: Run tests + type-check**

Run: `bunx vitest run src/lib/agent/omp-runtime.test.ts && bun run type-check` (workdir `packages/ui`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/agent/omp-runtime.ts packages/ui/src/lib/agent/omp-runtime.test.ts
git commit -m "feat(ui): omp client session mutations, commands and status"
```

---

### Task 4: Registry default = omp

**Files:**
- Modify: `packages/ui/src/lib/agent/registry.ts`
- Modify: `packages/ui/src/lib/agent/registry.test.ts`

**Interfaces:**
- Produces: `getAgentRuntime()` -> OMP; `DEFAULT_RUNTIME_ID = "omp"`; `getAgentRuntimeForSession(unknown) -> omp`.

- [ ] **Step 1: Rewrite the failing test**

Replace the body of `packages/ui/src/lib/agent/registry.test.ts` (drop the `OpenCodeRuntime` import; use a local stub for the registered-runtime test):

```ts
import { afterEach, describe, expect, test } from "bun:test"
import type { AgentCapabilities, AgentRuntime } from "./contract"
import {
  clearAgentRuntimes, forgetSessionRuntime, getAgentRuntime, getAgentRuntimeForSession,
  registerAgentRuntime, registerSessionRuntime, runtimeIdForSession,
} from "./registry"
import { resolveSessionCapabilities } from "./session-capabilities"

afterEach(() => clearAgentRuntimes())

const stub = (id: string, caps: Partial<AgentCapabilities> = {}): AgentRuntime =>
  ({ id, capabilities: { fork: false, commands: false, mcp: false, agents: false, permissions: false, modelSelection: false, agentSelection: false, forms: false, revert: false, turnDiff: false, skills: false, rename: false, delete: false, move: false, attachments: false, ...caps } }) as AgentRuntime

describe("agent runtime registry", () => {
  test("defaults to the omp runtime", () => {
    expect(getAgentRuntime().id).toBe("omp")
  })

  test("returns the runtime registered for an id", () => {
    const custom = stub("custom")
    registerAgentRuntime(custom)
    expect(getAgentRuntime("custom")).toBe(custom)
  })

  test("falls back to the default runtime for an unregistered id", () => {
    expect(getAgentRuntime("gemini").id).toBe("omp")
  })

  test("resolves a session to its bound runtime, omp by default", () => {
    expect(runtimeIdForSession("ses_a")).toBe("omp")
    registerSessionRuntime("ses_a", "custom")
    expect(runtimeIdForSession("ses_a")).toBe("custom")
    forgetSessionRuntime("ses_a")
    expect(getAgentRuntimeForSession("ses_a").id).toBe("omp")
    expect(getAgentRuntimeForSession(undefined).id).toBe("omp")
  })

  test("session capabilities follow the session's runtime", () => {
    expect(resolveSessionCapabilities(null, "omp").commands).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run src/lib/agent/registry.test.ts` (workdir `packages/ui`)
Expected: FAIL — default is `"opencode"`.

- [ ] **Step 3: Flip the default**

Replace `packages/ui/src/lib/agent/registry.ts` with:

```ts
import type { AgentRuntime } from "./contract"
import { OmpRuntimeClient } from "./omp-runtime"

const DEFAULT_RUNTIME_ID = "omp"

const registeredRuntimes = new Map<string, AgentRuntime>()
const sessionRuntimes = new Map<string, string>()
let cachedOmp: AgentRuntime | null = null

export const getAgentRuntime = (runtimeId: string = DEFAULT_RUNTIME_ID): AgentRuntime => {
  const registered = registeredRuntimes.get(runtimeId)
  if (registered) return registered
  cachedOmp ??= new OmpRuntimeClient()
  return cachedOmp
}

export const registerSessionRuntime = (sessionId: string, runtimeId: string): void => {
  sessionRuntimes.set(sessionId, runtimeId)
}

export const forgetSessionRuntime = (sessionId: string): void => {
  sessionRuntimes.delete(sessionId)
}

export const runtimeIdForSession = (sessionId: string | undefined): string =>
  (sessionId ? sessionRuntimes.get(sessionId) : undefined) ?? DEFAULT_RUNTIME_ID

export const getAgentRuntimeForSession = (sessionId: string | undefined): AgentRuntime =>
  getAgentRuntime(runtimeIdForSession(sessionId))

export const registerAgentRuntime = (runtime: AgentRuntime): void => {
  registeredRuntimes.set(runtime.id, runtime)
}

export const clearAgentRuntimes = (): void => {
  registeredRuntimes.clear()
  sessionRuntimes.clear()
}
```

(`OpenCodeRuntime`/`AcpRuntimeClient` imports are dropped here; their files are deleted in P3.)

- [ ] **Step 4: Run tests + type-check**

Run: `bunx vitest run src/lib/agent && bun run type-check` (workdir `packages/ui`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/agent/registry.ts packages/ui/src/lib/agent/registry.test.ts
git commit -m "feat(ui): make omp the default agent runtime"
```

---

### Task 5: End-to-end web verification

**Files:** none.

- [ ] **Step 1: Start server + UI.**

- [ ] **Step 2: Create a session, stream a prompt, cancel.** Confirm the sidebar lists it and no OpenCode request appears in devtools.

- [ ] **Step 3: Rename and delete via the sidebar.** Confirm persistence.

- [ ] **Step 4: Report** what passed and any gap (add tasks for gaps). No commit.

---

## Self-Review

- **Spec coverage:** "Expand OmpRuntimeClient", "registry single runtime omp",
  "session-capabilities", server routes for mutations/models/commands/status —
  Tasks 1–4. `modelSelection` deliberately stays `false` and its route is
  deferred to P5 Task 3.
- **Placeholder scan:** no TBD. `getActiveStatus` mapping is pinned to matching
  the existing `@/lib/opencode/model` `SessionStatus` busy shape (read it in
  Step 3).
- **Type consistency:** `OmpHost`/`OmpRuntime` names match between runtime.ts and
  rpc-host.ts; capability keys match `AgentCapabilities`; route paths match
  between omp-routes.js and omp-runtime.ts; the registry test's stub covers all
  `AgentCapabilities` keys.
