# M4 contract breadth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the agent-domain operations to `AgentRuntime` with the hybrid naming from the spec, and move `MessagePage` and `FetchPermissionResult` into the contract. No caller migrates.

**Architecture:** `lib/agent/contract.ts` grows 22 methods, four capabilities, and two moved types. `OpenCodeRuntime` delegates every method. `lib/opencode/client.ts` re-exports the two moved types. `sendPrompt` and `sendCommand` stay out until M5.

**Tech Stack:** TypeScript, `bun:test`.

**Spec:** `docs/agent-host/M4-CONTRACT-BREADTH.md`.

## Global Constraints

- Work on the `develop` branch. Never commit to `main`.
- New code lives only under fork-owned paths. This plan writes to `packages/ui/src/lib/agent/` and edits `lib/opencode/client.ts` thinly (a type move plus a re-export).
- No new dependencies.
- `lib/agent/contract.ts` imports `@opencode/client` (the SDK), `@/lib/opencode/model`, and `./events`. It never imports `@/lib/opencode/client`.
- After each task: `bun run --cwd packages/ui type-check`.
- Commit after each task, on `develop`.

## Scope decisions

- Hybrid naming: ten neutral names, the rest keep the `opencodeClient` name.
- Optional methods are declared with `?` and gated by capabilities.
- `sendPrompt` and `sendCommand` are deferred to M5.
- `stageRevert` is compiler-checked but not exercised in the delegation test, because `SessionRevert` carries branded id types the fake cannot construct cheaply.

---

### Task 1: Move the two result types into the contract

**Files:**
- Modify: `packages/ui/src/lib/agent/contract.ts`
- Modify: `packages/ui/src/lib/opencode/client.ts`
- Test: `packages/ui/src/lib/opencode/client.test.ts` (existing, unchanged)

**Interfaces:**
- Produces: `MessagePage` and `FetchPermissionResult` from `@/lib/agent/contract`, re-exported from `@/lib/opencode/client`.

- [ ] **Step 1: Run the existing test to establish the baseline**

Run: `bun test src/lib/opencode/client.test.ts`
Expected: PASS. Note the pass count.

- [ ] **Step 2: Define the types in `lib/agent/contract.ts`**

Extend the `@/lib/opencode/model` import in `packages/ui/src/lib/agent/contract.ts` with `Message`, `Part` and `PermissionRequest`, then add these types:

```ts
export type MessagePage = {
  items: Array<{ info: Message; parts: Part[] }>
  cursor: { previous?: string; next?: string }
}

export type FetchPermissionResult =
  | { state: "ok"; permission: PermissionRequest }
  | { state: "resolved" }
  | { state: "unknown" }
```

- [ ] **Step 3: Replace the definitions in `lib/opencode/client.ts` with re-exports**

In `packages/ui/src/lib/opencode/client.ts`, delete the `export type MessagePage = { ... }` block and the `export type FetchPermissionResult = ...` union.

Add to the imports:

```ts
import type { FetchPermissionResult, MessagePage } from "@/lib/agent/contract"
```

Add near the other `export type` re-exports:

```ts
export type { FetchPermissionResult, MessagePage }
```

- [ ] **Step 4: Run the existing test to verify nothing broke**

Run: `bun test src/lib/opencode/client.test.ts`
Expected: PASS, same count as Step 1.

- [ ] **Step 5: Type-check the package**

Run: `bun run --cwd packages/ui type-check`
Expected: no errors. Consumers such as `lib/btw.test.ts` and `sync/session-message-loader.ts` import `MessagePage` from `@/lib/opencode/client`, which now re-exports it.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/lib/agent/contract.ts packages/ui/src/lib/opencode/client.ts
git commit -m "refactor(agent): move message page and permission result into the contract"
```

---

### Task 2: Add the methods, capabilities and delegations

**Files:**
- Modify: `packages/ui/src/lib/agent/contract.ts`
- Modify: `packages/ui/src/lib/agent/opencode-runtime.ts`
- Test: `packages/ui/src/lib/agent/opencode-runtime.test.ts`

**Interfaces:**
- Consumes: `@opencode/client` (`FormAnswer`, `FileDiffInfo`, `FormInfo`, `SessionInboxDelivery`, `SessionRevert`), `@/lib/opencode/model` (`Agent`, `Command`, `McpServerStatus`, `Message`, `Metadata`, `ModelRef`, `Part`, `PermissionReply`, `PermissionRequest`, `Session`, `SessionStatus`, `Skill`).
- Produces: the 22 methods and 4 capabilities from the spec; `SessionClient` covering all of them.

- [ ] **Step 1: Write the failing test**

Create `packages/ui/src/lib/agent/contract-delegation.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import type { Session } from "@/lib/opencode/model"
import type { MessagePage } from "./contract"
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

const emptyPage: MessagePage = { items: [], cursor: {} }

const recordingClient = (seen: string[]): SessionClient => ({
  createSession: async () => { seen.push("createSession"); return sessionFixture },
  getSession: async () => { seen.push("getSession"); return sessionFixture },
  listSessions: async () => { seen.push("listSessions"); return [sessionFixture] },
  deleteSession: async () => { seen.push("deleteSession"); return true },
  renameSession: async () => { seen.push("renameSession") },
  moveSession: async () => { seen.push("moveSession") },
  getSessionMessages: async () => { seen.push("getSessionMessages"); return emptyPage },
  abortSession: async () => { seen.push("abortSession"); return true },
  replyToPermission: async () => { seen.push("replyToPermission"); return true },
  fetchPermission: async () => { seen.push("fetchPermission"); return { state: "resolved" } },
  listPendingPermissions: async () => { seen.push("listPendingPermissions"); return [] },
  switchSessionModel: async () => { seen.push("switchSessionModel") },
  switchSessionAgent: async () => { seen.push("switchSessionAgent") },
  getActiveSessionStatuses: async () => { seen.push("getActiveSessionStatuses"); return null },
  forkSession: async () => { seen.push("forkSession"); return sessionFixture },
  listAgents: async () => { seen.push("listAgents"); return [] },
  listCommands: async () => { seen.push("listCommands"); return [] },
  listMcpServers: async () => { seen.push("listMcpServers"); return [] },
  connectMcpServer: async () => { seen.push("connectMcpServer") },
  disconnectMcpServer: async () => { seen.push("disconnectMcpServer") },
  listSkills: async () => { seen.push("listSkills"); return [] },
  replyToForm: async () => { seen.push("replyToForm"); return true },
  cancelForm: async () => { seen.push("cancelForm"); return true },
  listPendingForms: async () => { seen.push("listPendingForms"); return [] },
  // SessionRevert carries branded id types the fake cannot build cheaply, so
  // this method is compiler-covered and not exercised here.
  stageRevert: async () => { throw new Error("not exercised") },
  commitRevert: async () => { seen.push("commitRevert") },
  clearRevert: async () => { seen.push("clearRevert") },
  getSessionTurnDiff: async () => { seen.push("getSessionTurnDiff"); return [] },
})

describe("OpenCodeRuntime delegation", () => {
  test("declares every OpenCode capability", () => {
    const runtime = new OpenCodeRuntime(recordingClient([]))
    expect(runtime.capabilities).toEqual({
      fork: true,
      commands: true,
      mcp: true,
      agents: true,
      permissions: true,
      modelSelection: true,
      agentSelection: true,
      forms: true,
      revert: true,
      turnDiff: true,
      skills: true,
    })
  })

  test("routes each contract method to the matching client method", async () => {
    const seen: string[] = []
    const runtime = new OpenCodeRuntime(recordingClient(seen))
    await runtime.getMessages("ses_1", undefined, "/repo")
    await runtime.cancel("ses_1", "/repo")
    await runtime.replyPermission("ses_1", "req_1", "once", { directory: "/repo" })
    await runtime.getPermission("ses_1", "req_1", "/repo")
    await runtime.listPermissions({ directories: ["/repo"] })
    await runtime.selectModel("ses_1", { providerID: "p", id: "m" }, "/repo")
    await runtime.selectAgent("ses_1", "build", "/repo")
    await runtime.getActiveStatus("/repo")
    await runtime.forkSession?.("ses_1", { directory: "/repo" })
    await runtime.listAgents?.("/repo")
    await runtime.listCommands?.("/repo")
    await runtime.listMcpServers?.("/repo")
    await runtime.connectMcpServer?.("srv", "/repo")
    await runtime.disconnectMcpServer?.("srv", "/repo")
    await runtime.listSkills?.("/repo")
    await runtime.replyForm?.("ses_1", "form_1", {}, "/repo")
    await runtime.cancelForm?.("ses_1", "form_1", "/repo")
    await runtime.listPendingForms?.({ directories: ["/repo"] })
    await runtime.commitRevert?.("ses_1", "/repo")
    await runtime.clearRevert?.("ses_1", "/repo")
    await runtime.getSessionTurnDiff?.("ses_1", { directory: "/repo" })
    expect(seen).toEqual([
      "getSessionMessages",
      "abortSession",
      "replyToPermission",
      "fetchPermission",
      "listPendingPermissions",
      "switchSessionModel",
      "switchSessionAgent",
      "getActiveSessionStatuses",
      "forkSession",
      "listAgents",
      "listCommands",
      "listMcpServers",
      "connectMcpServer",
      "disconnectMcpServer",
      "listSkills",
      "replyToForm",
      "cancelForm",
      "listPendingForms",
      "commitRevert",
      "clearRevert",
      "getSessionTurnDiff",
    ])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/lib/agent/contract-delegation.test.ts`
Expected: FAIL. The methods and the new capabilities do not exist.

- [ ] **Step 3: Extend the contract**

In `packages/ui/src/lib/agent/contract.ts`, add these imports:

```ts
import type { FormAnswer, FileDiffInfo, FormInfo, SessionRevert } from "@opencode/client"
import type {
  Agent,
  Command,
  McpServerStatus,
  Message,
  PermissionReply,
  PermissionRequest,
  Part,
  SessionStatus,
  Skill,
} from "@/lib/opencode/model"
```

Add `forms`, `revert`, `turnDiff` and `skills` to `AgentCapabilities` as `boolean`.

Add:

```ts
export type PendingRequestListOptions = {
  directories?: Array<string | null | undefined>
  includeGlobal?: boolean
}
```

Add to `AgentRuntime`, before `translateEvent`, the eight core methods and the fourteen optional methods exactly as listed in the spec, using:
- `getMessages(id: string, options?: { limit?: number; cursor?: string; order?: "asc" | "desc" }, directory?: string | null): Promise<MessagePage>`
- `cancel(id: string, directory?: string | null): Promise<boolean>`
- `replyPermission(sessionID: string, requestID: string, reply: PermissionReply, options?: { message?: string; directory?: string | null }): Promise<boolean>`
- `getPermission(sessionID: string, requestID: string, directory?: string | null): Promise<FetchPermissionResult>`
- `listPermissions(options?: PendingRequestListOptions): Promise<PermissionRequest[]>`
- `selectModel(id: string, model: ModelRef, directory?: string | null): Promise<void>`
- `selectAgent(id: string, agent: string, directory?: string | null): Promise<void>`
- `getActiveStatus(directory?: string | null): Promise<Record<string, SessionStatus> | null>`
- `forkSession?(sessionId: string, options?: { before?: string; directory?: string | null }): Promise<Session>`
- `listAgents?(directory?: string | null): Promise<Agent[]>`
- `listCommands?(directory?: string | null, signal?: AbortSignal): Promise<Command[]>`
- `listMcpServers?(directory?: string | null): Promise<McpServerStatus[]>`
- `connectMcpServer?(server: string, directory?: string | null): Promise<void>`
- `disconnectMcpServer?(server: string, directory?: string | null): Promise<void>`
- `listSkills?(directory?: string | null): Promise<Skill[]>`
- `replyForm?(sessionID: string, formID: string, answer: FormAnswer, directory?: string | null): Promise<boolean>`
- `cancelForm?(sessionID: string, formID: string, directory?: string | null): Promise<boolean>`
- `listPendingForms?(options?: PendingRequestListOptions): Promise<FormInfo[]>`
- `stageRevert?(sessionId: string, messageId: string, options?: { files?: boolean; directory?: string | null }): Promise<SessionRevert>`
- `commitRevert?(sessionId: string, directory?: string | null): Promise<void>`
- `clearRevert?(sessionId: string, directory?: string | null): Promise<void>`
- `getSessionTurnDiff?(sessionId: string, options?: { from?: string; to?: string; context?: number; directory?: string | null }): Promise<FileDiffInfo[]>`

- [ ] **Step 4: Extend the adapter**

In `packages/ui/src/lib/agent/opencode-runtime.ts`:

Extend the `SessionClient` `Pick` list with `"getSessionMessages" | "abortSession" | "replyToPermission" | "fetchPermission" | "listPendingPermissions" | "switchSessionModel" | "switchSessionAgent" | "getActiveSessionStatuses" | "forkSession" | "listAgents" | "listCommands" | "listMcpServers" | "connectMcpServer" | "disconnectMcpServer" | "listSkills" | "replyToForm" | "cancelForm" | "listPendingForms" | "stageRevert" | "commitRevert" | "clearRevert" | "getSessionTurnDiff"`.

Add `forms: true`, `revert: true`, `turnDiff: true`, `skills: true` to `OPENCODE_CAPABILITIES`.

Add the imports the method signatures need:
- from `./contract`: `FetchPermissionResult`, `MessagePage`, `PendingRequestListOptions`
- from `@/lib/opencode/model`: `Agent`, `Command`, `McpServerStatus`, `ModelRef`, `PermissionReply`, `PermissionRequest`, `SessionStatus`, `Skill`
- from `@opencode/client`: `FileDiffInfo`, `FormAnswer`, `FormInfo`, `SessionRevert`

Add these methods to the class:

```ts
  getMessages(id: string, options?: { limit?: number; cursor?: string; order?: "asc" | "desc" }, directory?: string | null): Promise<MessagePage> {
    return this.client.getSessionMessages(id, options, directory)
  }

  cancel(id: string, directory?: string | null): Promise<boolean> {
    return this.client.abortSession(id, directory)
  }

  replyPermission(sessionID: string, requestID: string, reply: PermissionReply, options?: { message?: string; directory?: string | null }): Promise<boolean> {
    return this.client.replyToPermission(sessionID, requestID, reply, options)
  }

  getPermission(sessionID: string, requestID: string, directory?: string | null): Promise<FetchPermissionResult> {
    return this.client.fetchPermission(sessionID, requestID, directory)
  }

  listPermissions(options?: PendingRequestListOptions): Promise<PermissionRequest[]> {
    return this.client.listPendingPermissions(options)
  }

  selectModel(id: string, model: ModelRef, directory?: string | null): Promise<void> {
    return this.client.switchSessionModel(id, model, directory)
  }

  selectAgent(id: string, agent: string, directory?: string | null): Promise<void> {
    return this.client.switchSessionAgent(id, agent, directory)
  }

  getActiveStatus(directory?: string | null): Promise<Record<string, SessionStatus> | null> {
    return this.client.getActiveSessionStatuses(directory)
  }

  forkSession(sessionId: string, options?: { before?: string; directory?: string | null }): Promise<Session> {
    return this.client.forkSession(sessionId, options)
  }

  listAgents(directory?: string | null): Promise<Agent[]> {
    return this.client.listAgents(directory)
  }

  listCommands(directory?: string | null, signal?: AbortSignal): Promise<Command[]> {
    return this.client.listCommands(directory, signal)
  }

  listMcpServers(directory?: string | null): Promise<McpServerStatus[]> {
    return this.client.listMcpServers(directory)
  }

  connectMcpServer(server: string, directory?: string | null): Promise<void> {
    return this.client.connectMcpServer(server, directory)
  }

  disconnectMcpServer(server: string, directory?: string | null): Promise<void> {
    return this.client.disconnectMcpServer(server, directory)
  }

  listSkills(directory?: string | null): Promise<Skill[]> {
    return this.client.listSkills(directory)
  }

  replyForm(sessionID: string, formID: string, answer: FormAnswer, directory?: string | null): Promise<boolean> {
    return this.client.replyToForm(sessionID, formID, answer, directory)
  }

  cancelForm(sessionID: string, formID: string, directory?: string | null): Promise<boolean> {
    return this.client.cancelForm(sessionID, formID, directory)
  }

  listPendingForms(options?: PendingRequestListOptions): Promise<FormInfo[]> {
    return this.client.listPendingForms(options)
  }

  stageRevert(sessionId: string, messageId: string, options?: { files?: boolean; directory?: string | null }): Promise<SessionRevert> {
    return this.client.stageRevert(sessionId, messageId, options)
  }

  commitRevert(sessionId: string, directory?: string | null): Promise<void> {
    return this.client.commitRevert(sessionId, directory)
  }

  clearRevert(sessionId: string, directory?: string | null): Promise<void> {
    return this.client.clearRevert(sessionId, directory)
  }

  getSessionTurnDiff(sessionId: string, options?: { from?: string; to?: string; context?: number; directory?: string | null }): Promise<FileDiffInfo[]> {
    return this.client.getSessionTurnDiff(sessionId, options)
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test src/lib/agent/contract-delegation.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Run the existing adapter test**

Run: `bun test src/lib/agent/opencode-runtime.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Type-check the package**

Run: `bun run --cwd packages/ui type-check`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/ui/src/lib/agent/contract.ts packages/ui/src/lib/agent/opencode-runtime.ts packages/ui/src/lib/agent/contract-delegation.test.ts
git commit -m "feat(agent): carry the agent-domain operations in the contract"
```

---

### Task 3: Update the module documentation

**Files:**
- Modify: `packages/ui/src/lib/agent/DOCUMENTATION.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Record the contract breadth**

In `packages/ui/src/lib/agent/DOCUMENTATION.md`, add to the `## Rules` list:

```markdown
- `contract.ts` carries the session, message, permission, form, revert and catalog operations. Optional methods are declared with `?` and gated by `AgentCapabilities`.
```

- [ ] **Step 2: Commit**

```bash
git add packages/ui/src/lib/agent/DOCUMENTATION.md
git commit -m "docs(agent): document the contract breadth"
```

---

## Self-Review

- Spec coverage: the spec lists the ten hybrid renames, eight core methods, fourteen optional methods, four capabilities, and the `MessagePage`/`FetchPermissionResult` move. Tasks 1 and 2 cover each; Task 3 documents them. `sendPrompt` and `sendCommand` stay out, matching the spec.
- Placeholder scan: no TBD; the test is given in full and every method body is given.
- Type consistency: the contract method names, the adapter method names, the `SessionClient` `Pick` list, and the test's expected client names agree with the spec's rename table.
