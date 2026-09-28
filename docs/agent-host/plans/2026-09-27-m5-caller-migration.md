# M5 caller migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent-domain callers read from `AgentRuntime` instead of `opencodeClient`.

**Architecture:** A registry-backed `useAgentRuntime()` hook for React, `getAgentRuntime()` for plain modules. The contract gains `sendPrompt`, `sendCommand` and `listSessionsPage`, and absorbs six parameter types from `client.ts`. Eighteen files migrate; thirty-five do not change.

**Tech Stack:** TypeScript, `bun:test`.

**Spec:** `docs/agent-host/M5-CALLER-MIGRATION.md`.

## Global Constraints

- Work on the `develop` branch. Never commit to `main`.
- New code lives only under fork-owned paths. This plan writes to `packages/ui/src/lib/agent/` and edits existing files thinly.
- No new dependencies.
- A migrated call renames per the spec's rename table; every other call keeps its name.
- Line numbers shift as edits land. Locate a call by its exact text, not by the inventory's line number.
- After each task: `bun run --cwd packages/ui type-check` and `bun run --cwd packages/ui test`. Hold at the two known upstream failures (`MarkdownRendererImpl.test.ts`, `extensions/builtins.test.tsx`), none new.

---

### Task 1: Hook, contract additions, adapter

**Files:**
- Create: `packages/ui/src/lib/agent/use-agent-runtime.ts`
- Modify: `packages/ui/src/lib/agent/contract.ts`
- Modify: `packages/ui/src/lib/agent/opencode-runtime.ts`
- Modify: `packages/ui/src/lib/opencode/client.ts`
- Test: `packages/ui/src/lib/agent/opencode-runtime.test.ts`

**Interfaces:**
- Produces: `useAgentRuntime()`, `sendPrompt`, `sendCommand`, `listSessionsPage` on `AgentRuntime`; `SendPromptParams`, `SendCommandParams`, `FileInputLite`, `SkillMentions`, `SessionPage`, `SessionListOptions` from `@/lib/agent/contract`, re-exported from `@/lib/opencode/client`.

- [ ] **Step 1: Create the hook**

Create `packages/ui/src/lib/agent/use-agent-runtime.ts`:

```ts
import type { AgentRuntime } from "./contract"
import { getAgentRuntime } from "./registry"

/** React access to the active agent runtime. Resolved at call time, never cached. */
export const useAgentRuntime = (): AgentRuntime => getAgentRuntime()
```

- [ ] **Step 2: Move the parameter types into the contract**

In `packages/ui/src/lib/opencode/client.ts`, delete these type definitions and move them verbatim to `packages/ui/src/lib/agent/contract.ts`:

- `SkillMentions` (with its `SkillAttachmentRef` sibling, kept private in the contract)
- `FileInputLite`
- `SessionPage` (its `spaces?: SpaceMark[]` field needs `import type { SpaceMark } from "@/lib/spaces/spaces-store"`)
- `SessionListOptions`
- the inline params type of `sendMessage`, named `SendPromptParams`
- the inline params type of `sendCommand`, named `SendCommandParams`

`SendPromptParams` is:

```ts
export type SendPromptParams = {
  runtimeKey?: string
  id: string
  model?: ModelRef
  agent?: string
  providerID: string
  text: string
  files?: Array<FileInputLite>
  context?: Array<{ text: string; metadata?: ContextPartMetadata; description?: string }>
  messageId?: string
  agentMentions?: Array<{ name: string; source?: { value: string; start: number; end: number } }>
  metadata?: Metadata
  delivery?: SessionInboxDelivery
  directory?: string | null
  skills?: SkillMentions
}
```

with `import type { ContextPartMetadata } from "@/lib/messages/contextParts"`.

`SendCommandParams` is:

```ts
export type SendCommandParams = {
  runtimeKey?: string
  id: string
  model?: ModelRef
  agent?: string
  command: string
  arguments?: string
  files?: Array<FileInputLite>
  context?: Array<{ text: string; metadata?: ContextPartMetadata; description?: string }>
  delivery?: SessionInboxDelivery
  directory?: string | null
}
```

In `client.ts`, import these names from `@/lib/agent/contract` and re-export them, and change `sendMessage(params: SendPromptParams)` and `sendCommand(params: SendCommandParams)` to use the imported types.

- [ ] **Step 3: Add the three methods to the contract**

In `contract.ts`, add to `AgentRuntime`:

```ts
  sendPrompt(params: SendPromptParams): Promise<string>
  sendCommand(params: SendCommandParams): Promise<void>
  listSessionsPage(options?: SessionListOptions): Promise<SessionPage>
```

- [ ] **Step 4: Extend the adapter**

In `opencode-runtime.ts`, add `"sendMessage" | "sendCommand" | "listSessionsPage"` to the `SessionClient` `Pick`, and add:

```ts
  sendPrompt(params: SendPromptParams): Promise<string> {
    return this.client.sendMessage(params)
  }

  sendCommand(params: SendCommandParams): Promise<void> {
    return this.client.sendCommand(params)
  }

  listSessionsPage(options?: SessionListOptions): Promise<SessionPage> {
    return this.client.listSessionsPage(options)
  }
```

Import `SendPromptParams`, `SendCommandParams`, `SessionPage`, `SessionListOptions` from `./contract`.

- [ ] **Step 5: Extend the delegation test**

In `opencode-runtime.test.ts`, add to the fake client:

```ts
  sendMessage: async (...args) => { calls.push({ method: "sendMessage", args }); return "msg_1" },
  sendCommand: async (...args) => { calls.push({ method: "sendCommand", args }) },
  listSessionsPage: async (...args) => { calls.push({ method: "listSessionsPage", args }); return { sessions: [], cursor: {} } },
```

and add a test:

```ts
  test("routes prompt, command and session page to the client", async () => {
    const calls: Call[] = []
    const runtime = new OpenCodeRuntime(recordingClient(calls))
    await runtime.sendPrompt({ id: "ses_1", providerID: "p", text: "hi" })
    await runtime.sendCommand({ id: "ses_1", command: "help" })
    await runtime.listSessionsPage({ directory: "/repo" })
    expect(methodsOf(calls)).toEqual(["sendMessage", "sendCommand", "listSessionsPage"])
  })
```

- [ ] **Step 6: Run tests and type-check**

Run: `bun test src/lib/agent/opencode-runtime.test.ts`
Run: `bun run --cwd packages/ui type-check`
Expected: PASS and no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/lib/agent/use-agent-runtime.ts packages/ui/src/lib/agent/contract.ts packages/ui/src/lib/agent/opencode-runtime.ts packages/ui/src/lib/agent/opencode-runtime.test.ts packages/ui/src/lib/opencode/client.ts
git commit -m "feat(agent): add the runtime hook, prompt and session page to the contract"
```

---

### Task 2: Migrate the plain entirely-agent files

**Files (all keep only agent-domain calls, so the `opencodeClient` import is replaced):**
- `packages/ui/src/lib/btw.ts`
- `packages/ui/src/lib/multirun/keep.ts`
- `packages/ui/src/lib/multirun/laneData.ts`
- `packages/ui/src/lib/reviewFlow.ts`
- `packages/ui/src/stores/useMcpStore.ts`
- `packages/ui/src/sync/vscode-permission-auto-accept.ts`

For each file: replace `import { opencodeClient } from "@/lib/opencode/client"` with `import { getAgentRuntime } from "@/lib/agent/registry"`, then rewrite each agent-domain call as `getAgentRuntime().<contractMethod>(...)`.

- [ ] **Step 1: `lib/btw.ts`**

- `opencodeClient.forkSession(` -> `getAgentRuntime().forkSession(`
- `opencodeClient.getSessionMessages(` -> `getAgentRuntime().getMessages(`

- [ ] **Step 2: `lib/multirun/keep.ts`**

- `opencodeClient.listSessionsPage(` -> `getAgentRuntime().listSessionsPage(`
- `opencodeClient.getSession(` -> `getAgentRuntime().getSession(`

- [ ] **Step 3: `lib/multirun/laneData.ts`**

- both `opencodeClient.getSessionMessages(` -> `getAgentRuntime().getMessages(`

- [ ] **Step 4: `lib/reviewFlow.ts`**

- `opencodeClient.sendMessage(` -> `getAgentRuntime().sendPrompt(`
- every `opencodeClient.getSession(` -> `getAgentRuntime().getSession(`
- `opencodeClient.createSession(` -> `getAgentRuntime().createSession(`
- `opencodeClient.deleteSession(` -> `getAgentRuntime().deleteSession(`

- [ ] **Step 5: `stores/useMcpStore.ts`**

- `opencodeClient.listMcpServers(` -> `getAgentRuntime().listMcpServers(`
- both `opencodeClient.connectMcpServer(` -> `getAgentRuntime().connectMcpServer(`
- both `opencodeClient.disconnectMcpServer(` -> `getAgentRuntime().disconnectMcpServer(`

- [ ] **Step 6: `sync/vscode-permission-auto-accept.ts`**

- `opencodeClient.getSession(` -> `getAgentRuntime().getSession(`
- `opencodeClient.listPendingPermissions(` -> `getAgentRuntime().listPermissions(`
- `opencodeClient.fetchPermission(` -> `getAgentRuntime().getPermission(`

- [ ] **Step 7: Verify**

Run: `bun run --cwd packages/ui type-check`
Run: `bun run --cwd packages/ui test`
Expected: no new failures. The mocks in the sibling test files target `@/lib/opencode/client`, which the adapter still resolves.

- [ ] **Step 8: Commit**

```bash
git add packages/ui/src/lib/btw.ts packages/ui/src/lib/multirun/keep.ts packages/ui/src/lib/multirun/laneData.ts packages/ui/src/lib/reviewFlow.ts packages/ui/src/stores/useMcpStore.ts packages/ui/src/sync/vscode-permission-auto-accept.ts
git commit -m "refactor(agent): route the plain agent-domain modules through the runtime"
```

---

### Task 3: Migrate the small mixed plain files

**Files (keep the `opencodeClient` import, add `getAgentRuntime`):**
- `packages/ui/src/lib/multirun/fusion.ts`
- `packages/ui/src/stores/useAgentsStore.ts`
- `packages/ui/src/stores/useCommandsStore.ts`
- `packages/ui/src/stores/useConfigStore.ts`
- `packages/ui/src/stores/useGlobalSessionsStore.ts`
- `packages/ui/src/sync/bootstrap.ts`

Add `import { getAgentRuntime } from "@/lib/agent/registry"` next to the existing `opencodeClient` import, then:

- [ ] **Step 1: `lib/multirun/fusion.ts`**
  - `opencodeClient.getSession(` -> `getAgentRuntime().getSession(`
  - `opencodeClient.sendMessage(` -> `getAgentRuntime().sendPrompt(`

- [ ] **Step 2: `stores/useAgentsStore.ts`**
  - `opencodeClient.listAgents(` -> `getAgentRuntime().listAgents(`

- [ ] **Step 3: `stores/useCommandsStore.ts`**
  - `opencodeClient.listCommands(` -> `getAgentRuntime().listCommands(`

- [ ] **Step 4: `stores/useConfigStore.ts`**
  - `opencodeClient.listAgents(` -> `getAgentRuntime().listAgents(`

- [ ] **Step 5: `stores/useGlobalSessionsStore.ts`**
  - `opencodeClient.listSessionsPage(` -> `getAgentRuntime().listSessionsPage(`

- [ ] **Step 6: `sync/bootstrap.ts`**
  - `opencodeClient.getActiveSessionStatuses(` -> `getAgentRuntime().getActiveStatus(`
  - `opencodeClient.listPendingForms(` -> `getAgentRuntime().listPendingForms(`
  - `opencodeClient.listPendingPermissions(` -> `getAgentRuntime().listPermissions(`

- [ ] **Step 7: Verify and commit**

Run: `bun run --cwd packages/ui type-check`
Run: `bun run --cwd packages/ui test`
Expected: no new failures.

```bash
git add packages/ui/src/lib/multirun/fusion.ts packages/ui/src/stores/useAgentsStore.ts packages/ui/src/stores/useCommandsStore.ts packages/ui/src/stores/useConfigStore.ts packages/ui/src/stores/useGlobalSessionsStore.ts packages/ui/src/sync/bootstrap.ts
git commit -m "refactor(agent): route the small mixed modules through the runtime"
```

---

### Task 4: Migrate `sync/session-actions.ts` and `sync/session-ui-store.ts`

**Files:** keep the `opencodeClient` import, add `getAgentRuntime`.

- [ ] **Step 1: `sync/session-actions.ts` (2623 lines)**

Replace every occurrence, in this order:
- `opencodeClient.moveSession(` -> `getAgentRuntime().moveSession(`
- `opencodeClient.abortSession(` -> `getAgentRuntime().cancel(`
- `opencodeClient.getSessionMessages(` -> `getAgentRuntime().getMessages(`
- `opencodeClient.stageRevert(` -> `getAgentRuntime().stageRevert(`
- `opencodeClient.commitRevert(` -> `getAgentRuntime().commitRevert(`
- `opencodeClient.clearRevert(` -> `getAgentRuntime().clearRevert(`
- `opencodeClient.createSession(` -> `getAgentRuntime().createSession(`
- `opencodeClient.deleteSession(` -> `getAgentRuntime().deleteSession(`
- `opencodeClient.getActiveSessionStatuses(` -> `getAgentRuntime().getActiveStatus(`
- `opencodeClient.renameSession(` -> `getAgentRuntime().renameSession(`
- `opencodeClient.replyToPermission(` -> `getAgentRuntime().replyPermission(`
- `opencodeClient.replyToForm(` -> `getAgentRuntime().replyForm(`
- `opencodeClient.cancelForm(` -> `getAgentRuntime().cancelForm(`
- `opencodeClient.forkSession(` -> `getAgentRuntime().forkSession(`
- every remaining `opencodeClient.getSession(` -> `getAgentRuntime().getSession(`

Leave `opencodeClient.getSdkClient(` unchanged.

Note: `createSession` reads `opencodeClient.getSdkClient()` into `runtimeClient` for a post-await identity check. Keep that read on `opencodeClient`; it is a transport identity, not an agent call.

- [ ] **Step 2: `sync/session-ui-store.ts` (2383 lines)**

- `opencodeClient.listCommands(` -> `getAgentRuntime().listCommands(`
- `opencodeClient.sendCommand(` -> `getAgentRuntime().sendCommand(`
- `opencodeClient.sendMessage(` -> `getAgentRuntime().sendPrompt(`

Leave `shellSession`, `getDirectory`, `getDirectoryAvailability`, `setDirectory` unchanged.

- [ ] **Step 3: Verify**

Run: `bun run --cwd packages/ui type-check`
Run: `bun run --cwd packages/ui test`
Expected: no new failures. `sync/session-actions.test.ts` mocks `opencodeClient`; the adapter resolves that mock.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/sync/session-actions.ts packages/ui/src/sync/session-ui-store.ts
git commit -m "refactor(agent): route the sync session stores through the runtime"
```

---

### Task 5: Migrate the React callers

**Files:** `components/views/DiffView.tsx`, `sync/use-session-ai-rename.ts`, `sync/use-sync.ts`, `sync/sync-context.tsx`.

React callers inside a component or hook body use `const runtime = useAgentRuntime()` and call `runtime.<contractMethod>(...)`. Calls that live in a plain module-level function in the file use `getAgentRuntime()`.

- [ ] **Step 1: `sync/use-session-ai-rename.ts`**

Add `const runtime = useAgentRuntime()` in the hook body and replace both `opencodeClient.getSession(` with `runtime.getSession(`. Drop the `opencodeClient` import if nothing else uses it.

- [ ] **Step 2: `sync/use-sync.ts`**

Add `const runtime = useAgentRuntime()` in the hook body and replace `opencodeClient.getSession(` with `runtime.getSession(`. Drop the `opencodeClient` import if nothing else uses it.

- [ ] **Step 3: `components/views/DiffView.tsx`**

Add `const runtime = useAgentRuntime()` in the component and replace `opencodeClient.getSessionTurnDiff(` with `runtime.getSessionTurnDiff(`. Drop the `opencodeClient` import if nothing else uses it.

- [ ] **Step 4: `sync/sync-context.tsx` (3852 lines, mixed)**

Keep the `opencodeClient` import for `getSdkClient`, `getConfig`, `clearConfigCache`, `listProjects`, `getProvidersForConfig`, `getDirectory`. Add `const runtime = useAgentRuntime()` in the provider component and replace the agent-domain calls:
- `opencodeClient.getActiveSessionStatuses(` -> `runtime.getActiveStatus(`
- `opencodeClient.listPendingForms(` -> `runtime.listPendingForms(`
- `opencodeClient.listPendingPermissions(` -> `runtime.listPermissions(`
- `opencodeClient.getSession(` -> `runtime.getSession(`
- `opencodeClient.listAgents(` -> `runtime.listAgents(`
- `opencodeClient.listSessionsPage(` -> `runtime.listSessionsPage(`

- [ ] **Step 5: Verify**

Run: `bun run --cwd packages/ui type-check`
Run: `bun run --cwd packages/ui test`
Expected: no new failures. `sync/bootstrap.test.ts` and the sync suites mock `opencodeClient` and still resolve through the adapter.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/views/DiffView.tsx packages/ui/src/sync/use-session-ai-rename.ts packages/ui/src/sync/use-sync.ts packages/ui/src/sync/sync-context.tsx
git commit -m "refactor(agent): route the React callers through the runtime hook"
```

---

### Task 6: Update the module documentation

**Files:** `packages/ui/src/lib/agent/DOCUMENTATION.md`

- [ ] **Step 1: Document the hook and the migration**

Add to `## Files`:

```markdown
- `use-agent-runtime.ts` holds `useAgentRuntime()`, the React access to the active runtime.
```

Add to `## Rules`:

```markdown
- React callers use `useAgentRuntime()`; plain modules use `getAgentRuntime()`. Agent-domain calls go through the runtime; OpenChamber-owned and OpenCode-specific calls stay on `opencodeClient`.
```

- [ ] **Step 2: Commit**

```bash
git add packages/ui/src/lib/agent/DOCUMENTATION.md
git commit -m "docs(agent): document the runtime hook and caller migration"
```

---

## Self-Review

- Spec coverage: the spec asks for the hook, the three contract additions with six moved types, the rename rule, and the eighteen-file migration. Tasks 1 to 5 cover each; Task 6 documents it. The thirty-five untouched files stay untouched, matching the spec.
- Placeholder scan: no TBD; each migration step lists the exact find/replace pairs, and Task 1 carries the full new code.
- Type consistency: the rename table matches the contract method names; the fake client gains exactly the three new client methods; the contract's method names match the adapter's and the test's expected client names.
