# Agent runtime contract (M1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the `AgentRuntime` seam and an OpenCode adapter that wraps the existing `opencodeClient`, with zero behavior change, and route one small existing caller through it.

**Architecture:** New fork-owned module `packages/ui/src/lib/agent/` holds a runtime-neutral contract, an `OpenCodeRuntime` adapter that delegates to `opencodeClient`, and a registry that resolves the active runtime at call time. One existing caller (`lib/multirun/createSession.ts`) moves to the registry; its existing test proves the delegation.

**Tech Stack:** TypeScript, `bun:test`, existing `@/lib/opencode/client` and `@/lib/opencode/model`.

**Spec:** `docs/agent-host/ROLLOUT.md` (milestone M1), `docs/agent-host/DESIGN.md` (contract shape).

## Global Constraints

- Work on the `develop` branch. Never commit to `main`.
- New code lives only under fork-owned paths. This plan writes only to `packages/ui/src/lib/agent/` and edits one shared file thinly (`lib/multirun/createSession.ts`).
- No new dependencies.
- Fork-owned code imports seams, not upstream internals. The adapter may import `opencodeClient`; callers import the registry.
- After each task: `bun run --cwd packages/ui type-check`.
- Focused test runs use `bun test <path>` from `packages/ui`.
- Commit after each task, on `develop`.

## Scope decisions

- The contract starts with session lifecycle only (`createSession`, `getSession`, `listSessions`, `deleteSession`, `renameSession`, `moveSession`) plus capabilities. Message, prompt, permission and status methods join in later milestones as their callers migrate. This keeps M1 free of unused surface.
- No boolean feature flag. M1 is behavior-identical, so the registry's default (OpenCode) is the current path and reverting is a one-line change. The flag rule in ROLLOUT applies to behavior changes, which start in M2.

---

### Task 1: Contract and OpenCode adapter

**Files:**
- Create: `packages/ui/src/lib/agent/contract.ts`
- Create: `packages/ui/src/lib/agent/opencode-runtime.ts`
- Test: `packages/ui/src/lib/agent/opencode-runtime.test.ts`

**Interfaces:**
- Consumes: `opencodeClient` from `@/lib/opencode/client`; `Metadata`, `ModelRef`, `Session` from `@/lib/opencode/model`.
- Produces:
  - `type AgentCapabilities = { fork: boolean; commands: boolean; mcp: boolean; agents: boolean; permissions: boolean; modelSelection: boolean; agentSelection: boolean }`
  - `type AgentRuntime = { readonly id: string; readonly capabilities: AgentCapabilities; createSession(params?: CreateSessionParams, directory?: string | null): Promise<Session>; getSession(id: string, directory?: string | null): Promise<Session>; listSessions(directory?: string | null): Promise<Session[]>; deleteSession(id: string, directory?: string | null): Promise<boolean>; renameSession(id: string, title: string, directory?: string | null): Promise<void>; moveSession(id: string, toDirectory: string, options?: MoveSessionOptions): Promise<void> }`
  - `type CreateSessionParams = { id?: string; title?: string; agent?: string; model?: ModelRef; metadata?: Metadata }`
  - `type MoveSessionOptions = { delivery?: SessionInboxDelivery }`
  - `class OpenCodeRuntime implements AgentRuntime` with `id = "opencode"` and a constructor taking an optional `SessionClient`.
  - `type SessionClient = Pick<typeof opencodeClient, "createSession" | "getSession" | "listSessions" | "deleteSession" | "renameSession" | "moveSession">`

- [ ] **Step 1: Write the failing test**

Create `packages/ui/src/lib/agent/opencode-runtime.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import type { Session } from "@/lib/opencode/model"
import { OpenCodeRuntime, type SessionClient } from "./opencode-runtime"

const sessionFixture: Session = {
  id: "ses_1",
  projectID: "p",
  directory: "/repo",
  title: "t",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
}

const recordingClient = (): { client: SessionClient; seen: string[] } => {
  const seen: string[] = []
  const client: SessionClient = {
    createSession: async () => { seen.push("createSession"); return sessionFixture },
    getSession: async () => { seen.push("getSession"); return sessionFixture },
    listSessions: async () => { seen.push("listSessions"); return [sessionFixture] },
    deleteSession: async () => { seen.push("deleteSession"); return true },
    renameSession: async () => { seen.push("renameSession") },
    moveSession: async () => { seen.push("moveSession") },
  }
  return { client, seen }
}

describe("OpenCodeRuntime", () => {
  test("declares the OpenCode capability set", () => {
    const runtime = new OpenCodeRuntime(recordingClient().client)
    expect(runtime.id).toBe("opencode")
    expect(runtime.capabilities).toEqual({
      fork: true,
      commands: true,
      mcp: true,
      agents: true,
      permissions: true,
      modelSelection: true,
      agentSelection: true,
    })
  })

  test("delegates every session method to the same client method", async () => {
    const { client, seen } = recordingClient()
    const runtime = new OpenCodeRuntime(client)
    await runtime.createSession({ title: "t" }, "/repo")
    await runtime.getSession("ses_1", "/repo")
    await runtime.listSessions("/repo")
    await runtime.deleteSession("ses_1", "/repo")
    await runtime.renameSession("ses_1", "t", "/repo")
    await runtime.moveSession("ses_1", "/repo2")
    expect(seen).toEqual(["createSession", "getSession", "listSessions", "deleteSession", "renameSession", "moveSession"])
  })

  test("forwards arguments and returns the client value", async () => {
    let received: unknown[] = []
    const client: SessionClient = {
      createSession: async (params, directory) => { received = [params, directory]; return sessionFixture },
      getSession: async () => sessionFixture,
      listSessions: async () => [sessionFixture],
      deleteSession: async () => true,
      renameSession: async () => undefined,
      moveSession: async () => undefined,
    }
    const runtime = new OpenCodeRuntime(client)
    const created = await runtime.createSession({ title: "x" }, "/repo")
    expect(received).toEqual([{ title: "x" }, "/repo"])
    expect(created).toBe(sessionFixture)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/agent/opencode-runtime.test.ts`
Expected: FAIL, cannot resolve `./opencode-runtime`.

- [ ] **Step 3: Write `contract.ts`**

Create `packages/ui/src/lib/agent/contract.ts`:

```ts
import type { SessionInboxDelivery } from "@opencode/client"
import type { Metadata, ModelRef, Session } from "@/lib/opencode/model"

export type AgentCapabilities = {
  fork: boolean
  commands: boolean
  mcp: boolean
  agents: boolean
  permissions: boolean
  modelSelection: boolean
  agentSelection: boolean
}

export type CreateSessionParams = {
  id?: string
  title?: string
  agent?: string
  model?: ModelRef
  metadata?: Metadata
}

export type MoveSessionOptions = { delivery?: SessionInboxDelivery }

export type AgentRuntime = {
  readonly id: string
  readonly capabilities: AgentCapabilities

  createSession(params?: CreateSessionParams, directory?: string | null): Promise<Session>
  getSession(id: string, directory?: string | null): Promise<Session>
  listSessions(directory?: string | null): Promise<Session[]>
  deleteSession(id: string, directory?: string | null): Promise<boolean>
  renameSession(id: string, title: string, directory?: string | null): Promise<void>
  moveSession(id: string, toDirectory: string, options?: MoveSessionOptions): Promise<void>
}
```

- [ ] **Step 4: Write `opencode-runtime.ts`**

Create `packages/ui/src/lib/agent/opencode-runtime.ts`:

```ts
import { opencodeClient } from "@/lib/opencode/client"
import type { Session } from "@/lib/opencode/model"
import type { AgentCapabilities, AgentRuntime, CreateSessionParams, MoveSessionOptions } from "./contract"

export type SessionClient = Pick<
  typeof opencodeClient,
  "createSession" | "getSession" | "listSessions" | "deleteSession" | "renameSession" | "moveSession"
>

const OPENCODE_CAPABILITIES: AgentCapabilities = {
  fork: true,
  commands: true,
  mcp: true,
  agents: true,
  permissions: true,
  modelSelection: true,
  agentSelection: true,
}

export class OpenCodeRuntime implements AgentRuntime {
  readonly id = "opencode"
  readonly capabilities = OPENCODE_CAPABILITIES

  constructor(private readonly client: SessionClient = opencodeClient) {}

  createSession(params?: CreateSessionParams, directory?: string | null): Promise<Session> {
    return this.client.createSession(params, directory)
  }

  getSession(id: string, directory?: string | null): Promise<Session> {
    return this.client.getSession(id, directory)
  }

  listSessions(directory?: string | null): Promise<Session[]> {
    return this.client.listSessions(directory)
  }

  deleteSession(id: string, directory?: string | null): Promise<boolean> {
    return this.client.deleteSession(id, directory)
  }

  renameSession(id: string, title: string, directory?: string | null): Promise<void> {
    return this.client.renameSession(id, title, directory)
  }

  moveSession(id: string, toDirectory: string, options?: MoveSessionOptions): Promise<void> {
    return this.client.moveSession(id, toDirectory, options)
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/lib/agent/opencode-runtime.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Type-check**

Run: `bun run --cwd packages/ui type-check`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/lib/agent/contract.ts packages/ui/src/lib/agent/opencode-runtime.ts packages/ui/src/lib/agent/opencode-runtime.test.ts
git commit -m "feat(agent): add AgentRuntime contract and OpenCode adapter"
```

---

### Task 2: Runtime registry

**Files:**
- Create: `packages/ui/src/lib/agent/registry.ts`
- Test: `packages/ui/src/lib/agent/registry.test.ts`

**Interfaces:**
- Consumes: `AgentRuntime` from `./contract`, `OpenCodeRuntime` and `SessionClient` from `./opencode-runtime`.
- Produces: `getAgentRuntime(): AgentRuntime`, `setAgentRuntime(runtime: AgentRuntime | null): void`.

- [ ] **Step 1: Write the failing test**

Create `packages/ui/src/lib/agent/registry.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test"
import type { Session } from "@/lib/opencode/model"
import { OpenCodeRuntime, type SessionClient } from "./opencode-runtime"
import { getAgentRuntime, setAgentRuntime } from "./registry"

const sessionFixture: Session = {
  id: "ses_1",
  projectID: "p",
  directory: "/repo",
  title: "t",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
}

const client: SessionClient = {
  createSession: async () => sessionFixture,
  getSession: async () => sessionFixture,
  listSessions: async () => [sessionFixture],
  deleteSession: async () => true,
  renameSession: async () => undefined,
  moveSession: async () => undefined,
}

afterEach(() => setAgentRuntime(null))

describe("agent runtime registry", () => {
  test("defaults to the OpenCode runtime", () => {
    expect(getAgentRuntime().id).toBe("opencode")
  })

  test("returns the runtime set for tests or another adapter", () => {
    const custom = new OpenCodeRuntime(client)
    setAgentRuntime(custom)
    expect(getAgentRuntime()).toBe(custom)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/agent/registry.test.ts`
Expected: FAIL, cannot resolve `./registry`.

- [ ] **Step 3: Write `registry.ts`**

Create `packages/ui/src/lib/agent/registry.ts`:

```ts
import type { AgentRuntime } from "./contract"
import { OpenCodeRuntime } from "./opencode-runtime"

let activeRuntime: AgentRuntime | null = null
let defaultRuntime: AgentRuntime | null = null

/** Resolved at call time so a runtime switch is never cached across endpoints. */
export const getAgentRuntime = (): AgentRuntime => {
  if (activeRuntime) return activeRuntime
  defaultRuntime ??= new OpenCodeRuntime()
  return defaultRuntime
}

export const setAgentRuntime = (runtime: AgentRuntime | null): void => {
  activeRuntime = runtime
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/agent/registry.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Type-check**

Run: `bun run --cwd packages/ui type-check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/lib/agent/registry.ts packages/ui/src/lib/agent/registry.test.ts
git commit -m "feat(agent): add runtime registry resolved at call time"
```

---

### Task 3: Route one caller through the seam

**Files:**
- Modify: `packages/ui/src/lib/multirun/createSession.ts`
- Test: `packages/ui/src/lib/multirun/createSession.test.ts` (existing, unchanged)

**Interfaces:**
- Consumes: `getAgentRuntime()` from `@/lib/agent/registry`.
- Produces: no new exports. `createMultiRunSession` keeps its signature.

- [ ] **Step 1: Run the existing test to establish the baseline**

Run: `bun test src/lib/multirun/createSession.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 2: Replace the two direct client calls**

In `packages/ui/src/lib/multirun/createSession.ts`, change the import on line 1 from:

```ts
import { opencodeClient } from '@/lib/opencode/client';
```

to:

```ts
import { getAgentRuntime } from '@/lib/agent/registry';
```

Then change the create call:

```ts
  const session = await opencodeClient.createSession({
    title: input.title,
    model: input.selection?.model,
    agent: input.selection?.agent,
    metadata: withMultiRunMembership({}, membership),
  }, input.directory);
```

to:

```ts
  const session = await getAgentRuntime().createSession({
    title: input.title,
    model: input.selection?.model,
    agent: input.selection?.agent,
    metadata: withMultiRunMembership({}, membership),
  }, input.directory);
```

And change the cleanup call:

```ts
      await opencodeClient.deleteSession(session.id, input.directory);
```

to:

```ts
      await getAgentRuntime().deleteSession(session.id, input.directory);
```

- [ ] **Step 3: Run the existing test to verify it still passes**

Run: `bun test src/lib/multirun/createSession.test.ts`
Expected: PASS, 3 tests. The test mocks `@/lib/opencode/client`; the adapter resolves that mock, so the assertions on `create` and `delete` still hold.

- [ ] **Step 4: Type-check**

Run: `bun run --cwd packages/ui type-check`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/multirun/createSession.ts
git commit -m "refactor(multirun): create sessions through the agent runtime seam"
```

---

### Task 4: Module documentation

**Files:**
- Create: `packages/ui/src/lib/agent/DOCUMENTATION.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Write the module documentation**

Create `packages/ui/src/lib/agent/DOCUMENTATION.md`:

```markdown
# lib/agent

Fork-owned agent runtime seam. See `docs/agent-host/DESIGN.md` and `docs/agent-host/ROLLOUT.md`.

## Files

- `contract.ts` holds `AgentRuntime`, `AgentCapabilities`, and the parameter types. Runtime-neutral.
- `opencode-runtime.ts` holds `OpenCodeRuntime`, the adapter over `opencodeClient`, and `SessionClient`, the structural client type it depends on.
- `registry.ts` holds `getAgentRuntime()` and `setAgentRuntime()`. The active runtime is resolved at call time, never cached across endpoints.

## Rules

- Callers use `getAgentRuntime()`, not `opencodeClient`, for agent-domain operations.
- The adapter is the only file here that imports `opencodeClient`.
- The contract grows only when a caller migrates; do not add methods no one uses.
```

- [ ] **Step 2: Run dead-code check**

Run: `bun run dead-code`
Expected: report only. `lib/agent/` has few callers yet, so entries are expected and do not block.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/lib/agent/DOCUMENTATION.md
git commit -m "docs(agent): document the agent runtime module"
```

---

## Self-Review

- Spec coverage: M1 in ROLLOUT asks for contract, adapter, registry, tests, one migrated caller, and zero behavior change. Tasks 1 to 3 cover them; Task 4 covers the new module's documentation. `AgentSession` and `AgentEvent` are deferred to M2/M3 with their consumers, per the scope decisions above.
- Placeholder scan: no TBD, no "add error handling", every code step carries real code.
- Type consistency: `SessionClient`, `AgentRuntime`, `CreateSessionParams`, `MoveSessionOptions`, `getAgentRuntime`, and `setAgentRuntime` are used with the same names and shapes across tasks.
