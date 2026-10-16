# OMP parity: todos, sub-agents and roles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make three things OMP already produces visible and controllable in the app: the model's todo list, the sub-agents a turn runs, and OMP's `modelRoles`.

**Architecture:** Nothing here is new data collection — OMP already has it. Each item adds one seam and then surfaces it: the adapter projects what OMP streams (a new canonical event), the server exposes it (a route, or the existing event broadcast), and the UI renders it (a store plus one component). Fork-owned code carries the OMP specifics (`packages/omp-adapter`, `packages/web/server/lib/agents/`, `packages/web/server/lib/openchamber/`); the UI diff stays thin and, where behaviour becomes visible, sits behind a capability flag.

**Tech Stack:** TypeScript (adapter, UI), plain JS ESM (web server), React 19 + zustand + zod + Tailwind tokens (UI), vitest (web/ui tests), `bun:test` (adapter/electron), OMP `18.10.4` over `omp --mode rpc-ui`.

**Spec:** none separate — this plan carries its own design notes in **§Design notes**, and every task lists the evidence it argues from. The maintainer's own plan series (`docs/superpowers/plans/2026-10-14-p1-workflow-engine.md` … `2026-10-16-p7-…`) is unrelated (workflows), so do not extend it.

## Global Constraints

- OMP is the only agent runtime. Do not add OpenCode-era paths back; tool name `subagent` is OpenCode v2's, OMP's is `task`.
- Do not modify `../opencode`. Do not add dependencies (`packages/ui` and `packages/web` manifests stay untouched).
- Do not log or store secrets; the OMP session files under `~/.omp/agent/sessions` are user data — read only what a feature needs.
- Placement: new OMP logic goes in fork-owned modules (adapter, `web/server/lib/agents/`, `web/server/lib/openchamber/`). New UI code goes in a focused file beside the surface it belongs to; keep edits to shared upstream files small and named for the behaviour.
- Anything that changes what the user sees is either flag-gated or confirmed by the maintainer first (**§Decisions**).
- `bun run` is broken on this machine (`error loading current directory`). Use the equivalents: `bun test --cwd <abs path>`, `./node_modules/.bin/tsc --noEmit`, `./node_modules/.bin/oxlint <paths>`, `bunx vitest run <path>` (cwd = the package), `node ../../scripts/run-isolated-tests.mjs .`.
- Run `./node_modules/.bin/oxlint <changed paths>` after each task; the anti-slop plugin rejects type assertions without a `SAFETY:` comment and ad-hoc `typeof` narrowing.
- Server restart is required for `packages/web/server/**` changes to take effect: `node packages/web/bin/cli.js restart` (the adapter is consumed from `packages/omp-adapter/dist`, rebuilt with `bun ../../scripts/build-omp-adapter.mjs` from `packages/omp-adapter`).

## Review Focus

1. **Tool-name drift.** OMP renames a tool (`todo`, `task`) and a surface silently disappears, because every surface keys on the name. Expect the item list to vanish with no error, and pin the names in tests that fail loudly.
2. **Partial and locked files.** Sub-agent transcripts are written while the app reads them and sit beside `.lock.os` files. Expect a truncated last line, an empty file, or a lock file listed as a transcript; the reader must skip rather than throw.
3. **State after reload.** A todo list lives in a stream the UI only sees while mounted. Expect an empty list after a reload or a reconnect even though OMP still holds it; the route must be able to answer for a session the UI just opened.
4. **Config write shape.** `modelRoles` is written into the user's `config.yml`, which they also edit by hand. Expect lost comments or a reordered file; the writer must change one key and keep the rest byte-identical (the existing `writeConfigKey` path is the one that already does this for `cacheRetention`/`toolApproval`).
5. **Stale role resolution.** OMP reads its config when a session process starts. Expect a role change to appear to do nothing in a session that was already running; the UI must say when it takes effect.

---

## Design notes

What exists today, all verified:

| Item | OMP side | App side today |
|---|---|---|
| Todo | tool `todo` (`args.list[].{phase,items}`, `args.op:"done"`, text result `Remaining items (N) … [in_progress]`), plus `custom_message`/`mid-run-todo-nudge` frames | tool call rides the generic path (`mapping-messages.ts:220-234`, `mapping-events.ts:85-99`), `todo` has no entry in `TOOL_METADATA` (`lib/toolHelpers.ts:266-274`), result renders as text (`ToolPart.tsx:1592-1610`), the nudge frame is dropped, and the session-todo store/dropdown is gone (only orphan i18n keys remain, `lib/i18n/messages/en.ts:2202-2212`) |
| Sub-agents | tools `task` (spawn, **streams `tool_execution_update`**) and `hub` (wait/status on `jobs[].id` = the agent name), one transcript per sub-agent at `<project>/<session-file>/<Agent>.jsonl` with its own `session` header and a `parentSession` link | tool name `subagent` is what the UI keys on (`lib/opencode/tools.ts:39-70`), so OMP's `task`/`hub` rows stay generic; the store deliberately ignores 3-segment files (`omp-adapter/src/session-store.ts:113-118`), `session-activity.js:41-51` hard-codes "no children", `toAgentSession` carries no `parentID` (`lib/agent/omp-runtime.ts:306-318`), and the prompt route has no `agent` field (`web/server/lib/agents/omp-routes.js:27-46`) |
| Roles | `modelRoles.<role>` in `~/.omp/agent/config.yml` (this machine: `DEV`, `plan`, `default`); per-run flags `--smol/--slow/--plan`; role list from OMP 18.10.4 docs | no route, no page, no i18n (`grep modelRoles` in `packages/ui` and `packages/web` = 0). The two OMP-native knobs the UI *can* write are `providers.cacheRetention` and `tools.approvalMode` (`web/server/lib/openchamber/omp-settings-routes.js:20-156`) — that pair is the template |

Two facts that shape the tasks:

- **`tool_execution_update` (with `partialResult`) is declared in the event union (`omp-adapter/src/model.ts:100`) and consumed nowhere** — no projector branch, no UI reader. Live progress for `task`/`todo` is available from OMP and currently dropped. Task 2 fixes that once, for both items.
- **No OMP surface names an agent for a prompt**: `omp --help` has no `--agent`, `omp agents` only does `unpack`, and the prompt route carries no agent. The model chooses the sub-agent inside its `task` call. So "run a sub-agent from the UI" is not implementable today; what is implementable is *seeing* them (Task 7/8) and telling the user who chooses.

---

## Decisions

Settle these before the named task; each is a choice two reasonable people could make differently, and the repo's rule is that such a choice is the maintainer's, made before the code.

- **D1 — where the todo list appears (before Task 5).** (a) Only inside the `todo` tool row: cheapest, visible only in the transcript; (b) tool row *plus* a live session-level surface (status row above the composer or the existing work-status panel): survives scrolling and shows progress across calls. This plan implements (a) in Task 5 and (b) in Task 6; drop Task 6 for (a) only.
- **D2 — how sub-agent transcripts reach the UI (before Task 7).** (a) A separate read-only viewer hung off the `task` row (no new sessions anywhere); (b) synthesize child sessions fed into the UI's existing child machinery (`child-session-discovery.ts`, `runningSubagentRuns.ts`) so the OpenCode-era UI lights up. This plan implements (a); (b) is a larger behavioural change and touches what `agentSelection:false` deliberately encodes.
- **D3 — may the UI write `modelRoles` (before Task 9)?** Yes (mirrors the two existing knobs) or read-only with the roles shown for information. Unanswered → build the GET half and stop.

**Settled by the maintainer, 2026-10-16:** D1 = tool row **and** the live surface (Tasks 5 and 6), D2 = a separate read-only viewer (Tasks 7 and 8, no synthesized child sessions), D3 = yes, the UI may write `modelRoles` (Tasks 9 and 10). Execution: **native** — the agent implements each task in one session, each task ending in its own test run and commit.

---

### Task 1: Verify the three unknowns (read-only, no code)

**Files:** append findings to this plan (§Verified), plus a throwaway script under `/tmp` only.

**Interfaces:**
- Consumes: nothing.
- Produces: the two answers Task 2 and Task 6 depend on — whether OMP streams `tool_execution_update` for `todo`/`task`, and whether a `modelRoles` change needs a fresh process.

- [ ] **Step 1: Capture live frames**

Write `/tmp/omp-frames.ts` that builds `new OmpRuntime(createOmpHost({ command: <staged omp>, onStderr: () => {} }))` from `packages/omp-adapter/dist`, subscribes with `runtime.subscribe((id, event) => …)`, creates a session, then prompts: *"Use the todo tool to record two tasks, then use the task tool to run one sub-agent that replies DONE, then wait for it."* Print `event.type` plus, for `tool_execution_update`, the `toolName` and whether `partialResult` is present.

- [ ] **Step 2: Run it and record**

Run: `bun /tmp/omp-frames.ts` (needs `bun ../../scripts/build-omp-adapter.mjs` first if the dist is stale). Expected: the todo/task sequence appears in the transcript, and the printed frame list either contains `tool_execution_update` for `task`/`todo` or does not. Record the exact list in §Verified.

- [ ] **Step 3: Check role freshness**

With `omp --config <overlay.yml>`, run one prompt twice: once with the overlay setting `modelRoles.smol`, once with the base config, and compare which model the turn reports (the transcript records `model_change`). Run: `omp -p "reply OK" --config /tmp/roles-overlay.yml --no-session --mode json | head -20`. Expected: either the overlay applies per run (config read per process — then a UI role change needs a new process/session) or it is ignored. Record it.

- [ ] **Step 4: Record both answers in this plan and commit the plan edit**

```bash
git add docs/superpowers/plans/2026-10-16-omp-parity-todo-subagents-roles.md
git commit -m "docs(plans): verify the OMP surfaces this plan builds on"
```

---

### Task 2: Adapter — carry live tool progress

**Files:**
- Modify: `packages/omp-adapter/src/model.ts` (event union), `packages/omp-adapter/src/mapping-events.ts` (projector)
- Test: `packages/omp-adapter/src/mapping-events.test.ts`

**Interfaces:**
- Consumes: OMP frame `{ type: "tool_execution_update"; toolCallId; toolName; args; partialResult }` (already in the union, `model.ts:100`).
- Produces: canonical event `{ type: "tool_progress"; sessionID: string; messageID: string; toolCallId: string; tool: string; text: string }`, where `text` is `partialResult` rendered as text (`toolOutputText` when it is a content list, `String(partialResult)` otherwise) and empty strings are not emitted.

- [ ] **Step 1: Write the failing test**

In `mapping-events.test.ts`, add to the existing projector describe block:

```ts
test("carries a tool's partial output as it arrives", () => {
  const events: OmpEvent[] = []
  const projector = createOmpEventProjector({ onEvent: (event) => events.push(event) })
  projector.handle({ type: "tool_execution_start", toolCallId: "c1", toolName: "task", args: {} })
  projector.handle({ type: "tool_execution_update", toolCallId: "c1", toolName: "task", args: {}, partialResult: "scout: mapping the stores…" })
  expect(events.at(-1)).toMatchObject({ type: "tool_progress", tool: "task", text: "scout: mapping the stores…" })
})

test("does not emit progress for an empty partial result", () => {
  const events: OmpEvent[] = []
  const projector = createOmpEventProjector({ onEvent: (event) => events.push(event) })
  projector.handle({ type: "tool_execution_start", toolCallId: "c2", toolName: "wait", args: {} })
  projector.handle({ type: "tool_execution_update", toolCallId: "c2", toolName: "wait", args: {}, partialResult: "" })
  expect(events.some((event) => event.type === "tool_progress")).toBe(false)
})
```

- [ ] **Step 2: Run the tests to watch them fail**

Run: `bun test --cwd /Users/phonnt/Documents/00.AI/openany/packages/omp-adapter -t "partial output"`
Expected: FAIL — no `tool_progress` event.

- [ ] **Step 3: Implement the projection**

Add `tool_progress` to the canonical event union in `model.ts` (shape above). In `mapping-events.ts`, add a branch beside the existing `tool_execution_end` handling that reuses the same message/part resolution the start/end branches use, resolves the tool call's `messageID`, and emits `tool_progress` with the rendered text. Skip empty/whitespace-only payloads. `toolOutputText` already lives in `mapping-messages.ts`; reuse it rather than adding a second renderer.

- [ ] **Step 4: Run the adapter tests**

Run: `bun test --cwd /Users/phonnt/Documents/00.AI/openany/packages/omp-adapter`
Expected: all pass, including the two new tests.

- [ ] **Step 5: Rebuild the dist and commit**

```bash
cd packages/omp-adapter && bun ../../scripts/build-omp-adapter.mjs
cd ../.. && ./node_modules/.bin/oxlint packages/omp-adapter/src/model.ts packages/omp-adapter/src/mapping-events.ts packages/omp-adapter/src/mapping-events.test.ts
git add packages/omp-adapter/src/model.ts packages/omp-adapter/src/mapping-events.ts packages/omp-adapter/src/mapping-events.test.ts
git commit -m "feat(omp-adapter): carry a tool's partial output to the UI"
```

---

### Task 3: Adapter — a session todo state

**Files:**
- Create: `packages/omp-adapter/src/todo-state.ts`
- Modify: `packages/omp-adapter/src/mapping-events.ts` (feed it), `packages/omp-adapter/src/model.ts` (`todo_updated` event), `packages/omp-adapter/src/runtime.ts` (reset on dispose)
- Test: `packages/omp-adapter/src/todo-state.test.ts`

**Interfaces:**
- Consumes: tool `todo` frames — start args `{ i?: string; list?: Array<{ phase?: string; items?: string[] }>; op?: "done" | …; task?: string }`, and their text result.
- Produces:

```ts
export type OmpTodoItem = { phase: string; text: string; status: "pending" | "in_progress" | "done" }
export type OmpTodoState = { title: string; items: OmpTodoItem[] }
export type OmpTodoReducer = {
  /** Merge one `todo` tool call's input; returns the next state, or null when nothing changed. */
  apply: (state: OmpTodoState | null, args: Record<string, unknown>) => OmpTodoState | null
  /** Apply one text result's status markers ("[in_progress]", "Overall: 8/11 done"). */
  applyResult: (state: OmpTodoState, text: string) => OmpTodoState | null
}
export const createTodoReducer = (): OmpTodoReducer
```

and canonical event `{ type: "todo_updated"; sessionID: string; todo: OmpTodoState | null }` (null = cleared).

- [ ] **Step 1: Write the failing tests**

```ts
import { createTodoReducer } from "./todo-state"

test("merges a phase list into items, keeping order", () => {
  const reducer = createTodoReducer()
  const state = reducer.apply(null, { i: "Ship the parity work", list: [{ phase: "Evidence", items: ["check the store"] }, { phase: "Fix", items: ["map the frame"] }] })
  expect(state).toEqual({
    title: "Ship the parity work",
    items: [
      { phase: "Evidence", text: "check the store", status: "pending" },
      { phase: "Fix", text: "map the frame", status: "pending" },
    ],
  })
})

test("marks the named item done and ignores an unknown name", () => {
  const reducer = createTodoReducer()
  const first = reducer.apply(null, { i: "t", list: [{ phase: "P", items: ["a", "b"] }] })
  const second = reducer.apply(first, { op: "done", task: "a" })
  expect(second?.items.map((item) => [item.text, item.status])).toEqual([["a", "done"], ["b", "pending"]])
  expect(reducer.apply(second, { op: "done", task: "nope" })).toBeNull()
})

test("reads progress markers out of the result text", () => {
  const reducer = createTodoReducer()
  const state = reducer.apply(null, { i: "t", list: [{ phase: "P", items: ["a", "b"] }] })!
  const next = reducer.applyResult(state, "Remaining items (1):\n  - b [in_progress] (P)\nOverall: 1/2 done, 1 open.")
  expect(next?.items.map((item) => item.status)).toEqual(["done", "in_progress"])
})

test("returns null for an input it cannot read", () => {
  expect(createTodoReducer().apply(null, {})).toBeNull()
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test --cwd /Users/phonnt/Documents/00.AI/openany/packages/omp-adapter -t "todo"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the reducer**

Follow `parseSessionFile`'s style in `session-store.ts`: read fields defensively, ignore anything unrecognised, return `null` for a no-op so callers can skip emitting. The `op: "done"` path matches the item by exact text (the tool's own vocabulary) and returns `null` when nothing matches.

- [ ] **Step 4: Wire it into the projector**

In `mapping-events.ts`: hold one reducer per session, call `apply` on `tool_execution_start` when `toolName === "todo"`, `applyResult` on `tool_execution_end` for the same tool, and emit `todo_updated` when either returns non-null. In `runtime.ts`, drop the per-session state in `disposeSession` alongside `lastUsedAt`.

- [ ] **Step 5: Run the adapter tests, rebuild, commit**

Run: `bun test --cwd /Users/phonnt/Documents/00.AI/openany/packages/omp-adapter` → all pass.
```bash
cd packages/omp-adapter && bun ../../scripts/build-omp-adapter.mjs && cd ../..
./node_modules/.bin/oxlint packages/omp-adapter/src/todo-state.ts packages/omp-adapter/src/mapping-events.ts
git add packages/omp-adapter/src/todo-state.ts packages/omp-adapter/src/todo-state.test.ts packages/omp-adapter/src/mapping-events.ts packages/omp-adapter/src/model.ts packages/omp-adapter/src/runtime.ts
git commit -m "feat(omp-adapter): keep a session's todo state from its todo tool calls"
```

---

### Task 4: Server — broadcast and replay the new events

**Files:**
- Modify: `packages/web/server/lib/agents/omp-runtime-host.js` (forward the two events, keep the current todo per session, expose a reader), `packages/web/server/lib/agents/omp-routes.js` (one route)
- Test: `packages/web/server/lib/agents/omp-runtime-host.test.js`

**Interfaces:**
- Consumes: canonical events from Task 2/3 (`tool_progress`, `todo_updated`).
- Produces: UI frames `{ type: "openchamber:omp", properties: { sessionID, event } }` (unchanged channel) for both events; `GET /api/agents/omp/sessions/:id/todo` → `{ todo: OmpTodoState | null }`.

- [ ] **Step 1: Write the failing test**

In `omp-runtime-host.test.js`, using the existing fake runtime harness:

```js
test("broadcasts a session's todo state and answers it on demand", async () => {
  const broadcast = []
  const host = createOmpRuntimeHost({ adapter: fakeAdapter, broadcast: (payload) => broadcast.push(payload) })
  fakeRuntime.emit("ses_1", { type: "todo_updated", sessionID: "ses_1", todo: { title: "t", items: [{ phase: "P", text: "a", status: "done" }] } })
  expect(broadcast.at(-1)).toMatchObject({ type: "openchamber:omp" })
  expect(await host.getTodo("ses_1")).toEqual({ title: "t", items: [{ phase: "P", text: "a", status: "done" }] })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/web && bunx vitest run server/lib/agents/omp-runtime-host.test.js`
Expected: FAIL — `host.getTodo` is not a function.

- [ ] **Step 3: Implement the forwarding and the reader**

In `omp-runtime-host.js`: forward `todo_updated`/`tool_progress` in the existing `runtime.subscribe` callback (the same body that handles `extension_ui_request`), keep the last todo per session in a `Map` cleared in `forgetSession`, and add `getTodo(sessionId)`. In `omp-routes.js`, add the GET route beside the other session routes, following the `respondWithError` pattern already used there.

- [ ] **Step 4: Run the server tests**

Run: `cd packages/web && bunx vitest run server/lib/agents`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
./node_modules/.bin/oxlint packages/web/server/lib/agents/omp-runtime-host.js packages/web/server/lib/agents/omp-routes.js
git add packages/web/server/lib/agents/omp-runtime-host.js packages/web/server/lib/agents/omp-runtime-host.test.js packages/web/server/lib/agents/omp-routes.js
git commit -m "feat(server): broadcast a session's todo state and answer it on demand"
```

---

### Task 5: UI — the todo tool row renders a checklist

**Files:**
- Modify: `packages/ui/src/lib/toolHelpers.ts` (`TOOL_METADATA.todo`), `packages/ui/src/components/chat/message/parts/ToolPart.tsx` (a `Todo` result branch)
- Test: `packages/ui/src/components/chat/message/parts/ToolPart.todo.test.tsx`

**Interfaces:**
- Consumes: the tool part's `state.input` (`{ i, list }`) and `state.output` (text) — no new data.
- Produces: a rendered checklist (phase heading, one row per item, status marker); `getToolMetadata("todo").displayName === "Todo"` stays as it is today.

- [ ] **Step 1: Write the failing component test**

Render a `ToolPart` for a `todo` tool with `input: { i: "Ship parity", list: [{ phase: "Evidence", items: ["check the store"] }, { phase: "Fix", items: ["map the frame"] }] }` and assert the DOM shows both phase names and both item texts, and that no raw JSON is displayed. Use the same harness as the neighbouring `ToolPart` tests.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/ui && bunx vitest run src/components/chat/message/parts/ToolPart.todo.test.tsx`
Expected: FAIL — the item texts are not in the DOM.

- [ ] **Step 3: Implement the branch**

Add `todo` to `TOOL_METADATA` (name, icon, and a `renderResult` hook); in `ToolPart.tsx`, add the branch next to the existing special cases, parse `input.list` with a small local function that tolerates a missing/odd shape (render nothing special and fall back to today's text output when it cannot read the input), and render the checklist with theme tokens only (no raw colours).

- [ ] **Step 4: Run the test and the UI type-check**

Run: `cd packages/ui && bunx vitest run src/components/chat/message/parts/ToolPart.todo.test.tsx && ../../node_modules/.bin/tsc --noEmit` (the package's own `type-check` script needs `bun run`, which is broken on this machine).
Expected: pass.

- [ ] **Step 5: Commit**

```bash
./node_modules/.bin/oxlint packages/ui/src/lib/toolHelpers.ts packages/ui/src/components/chat/message/parts/ToolPart.tsx
git add packages/ui/src/lib/toolHelpers.ts packages/ui/src/components/chat/message/parts/ToolPart.tsx packages/ui/src/components/chat/message/parts/ToolPart.todo.test.tsx
git commit -m "feat(ui): render OMP's todo tool as a checklist"
```

---

### Task 6: UI — the live todo surface (only for D1(b))

**Files:**
- Create: `packages/ui/src/stores/useTodoStore.ts`
- Modify: `packages/ui/src/sync/event-reducer.ts` (consume `todo_updated`), the composer status row (the component that already renders the working indicator)
- Test: `packages/ui/src/stores/useTodoStore.test.ts`

**Interfaces:**
- Consumes: `todo_updated` events from Task 4 and `GET …/sessions/:id/todo` for a session the UI opens (Review Focus 3).
- Produces: `useTodoStore` with `{ bySession: Map<string, OmpTodoState>; apply(sessionID: string, todo: OmpTodoState | null): void; load(sessionID: string, deps?: { fetchTodo?: (sessionID: string) => Promise<OmpTodoState | null> }): Promise<void> }`, and a status row that renders `n/m done · <current item>` when a todo exists.

- [ ] **Step 1: Write the failing store test**

```ts
test("applies an update, then keeps the last state when a load fails", async () => {
  useTodoStore.getState().apply("s1", { title: "t", items: [{ phase: "P", text: "a", status: "done" }] })
  expect(useTodoStore.getState().bySession.get("s1")?.items.length).toBe(1)
  await expect(useTodoStore.getState().load("s1", { fetchTodo: async () => null })).resolves.toBeUndefined()
  expect(useTodoStore.getState().bySession.get("s1")?.items.length).toBe(1)
})
```

- [ ] **Step 2: Run it and watch it fail** — `cd packages/ui && bunx vitest run src/stores/useTodoStore.test.ts`

- [ ] **Step 3: Implement the store, the reducer hook, and the row**

Keep the fetch injectable (the test above passes `fetchTodo`) so the store never mocks a module; the real call goes through `runtimeFetch` like `lib/projectContextApi.ts` does. A failed load must not clear state (Review Focus 3).

- [ ] **Step 4: Run the store test, then the sync tests**

Run: `cd packages/ui && bunx vitest run src/stores/useTodoStore.test.ts src/sync/event-reducer.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/stores/useTodoStore.ts packages/ui/src/stores/useTodoStore.test.ts packages/ui/src/sync/event-reducer.ts
git commit -m "feat(ui): show a session's live todo progress"
```

---

### Task 7: Server — read a session's sub-agent transcripts

**Files:**
- Create: `packages/web/server/lib/agents/subagent-transcripts.js`
- Modify: `packages/web/server/lib/agents/omp-routes.js` (two routes), `packages/web/server/lib/agents/omp-host-access.js` (accessor)
- Test: `packages/web/server/lib/agents/subagent-transcripts.test.js`

**Interfaces:**
- Consumes: a session file path; the sibling directory named after it (`<dir>/<file-without-.jsonl>/*.jsonl`), whose headers carry `{ type: "session", id, cwd, parentSession }`.
- Produces:

```js
export const listSubagentTranscripts = async ({ sessionPath, readdir, readHeader }) =>
  Array<{ id: string; agent: string; sessionPath: string; startedAt: string | null }>
export const readSubagentMessages = async ({ sessionPath, childId, readMessages }) =>
  Array<{ info: object; parts: object[] }>
```

and routes `GET /api/agents/omp/sessions/:id/children` → `{ children: [...] }`, `GET /api/agents/omp/sessions/:id/children/:childId/messages` → `{ items, cursor }` shaped like the existing messages route.

- [ ] **Step 1: Write the failing tests**

```js
test("lists a child per transcript file and skips locks and unreadable files", async () => {
  const children = await listSubagentTranscripts({
    sessionPath: "/s/2026-10-14T12-00-00Z_aaa.jsonl",
    readdir: () => ["ImplArtifacts.jsonl", ".ImplArtifacts.jsonl.lock.os", "ReReview.jsonl", "empty.jsonl"],
    readHeader: (file) => (file.includes("empty") ? null : { type: "session", id: `child-${file[0]}`, cwd: "/repo", parentSession: "/s/2026-10-14T12-00-00Z_aaa.jsonl" }),
  })
  expect(children.map((child) => child.agent)).toEqual(["ImplArtifacts", "ReReview"])
})

test("ignores a child whose parent link points elsewhere", async () => {
  const children = await listSubagentTranscripts({
    sessionPath: "/s/a.jsonl",
    readdir: () => ["other.jsonl"],
    readHeader: () => ({ type: "session", id: "c1", cwd: "/repo", parentSession: "/s/somewhere-else.jsonl" }),
  })
  expect(children).toEqual([])
})
```

- [ ] **Step 2: Run them and watch them fail** — `cd packages/web && bunx vitest run server/lib/agents/subagent-transcripts.test.js`

- [ ] **Step 3: Implement discovery and read**

Match by the header's `parentSession` (not by directory name alone) so a rename or a moved file still resolves; tolerate a missing directory, a lock file, an empty file and a truncated last line (Review Focus 2). Reuse the existing message projection the parent route uses (`readSessionMessages`-shaped output) so the UI can render a child with the transcript components it already has.

- [ ] **Step 4: Run the tests, then the route tests**

Run: `cd packages/web && bunx vitest run server/lib/agents`

- [ ] **Step 5: Commit**

```bash
./node_modules/.bin/oxlint packages/web/server/lib/agents/subagent-transcripts.js packages/web/server/lib/agents/omp-routes.js
git add packages/web/server/lib/agents/subagent-transcripts.js packages/web/server/lib/agents/subagent-transcripts.test.js packages/web/server/lib/agents/omp-routes.js packages/web/server/lib/agents/omp-host-access.js
git commit -m "feat(server): expose a session's sub-agent transcripts"
```

---

### Task 8: UI — the task row opens its sub-agents

**Files:**
- Modify: `packages/ui/src/lib/opencode/tools.ts` (recognise `task` where `subagent` is recognised), `packages/ui/src/components/chat/message/parts/ToolPart.tsx` (Task summary + viewer trigger)
- Create: `packages/ui/src/components/chat/message/parts/SubagentTranscriptDialog.tsx`
- Test: `packages/ui/src/components/chat/message/parts/subagentTranscript.test.tsx`

**Interfaces:**
- Consumes: `GET …/sessions/:id/children` and `…/children/:childId/messages` (Task 7), `tool_progress` events (Task 2).
- Produces: a `task` row that lists the sub-agents the call spawned (name + state) and opens one child's transcript read-only; `isSubagentTool("task") === true`.

- [ ] **Step 1: Write the failing test**

Assert `isSubagentTool("task")` is true, and that a `task` tool part whose progress text is ``Spawned agent `WordReply`…`` plus a `hub` part carrying `{ op: "wait", jobs: [{ id: "WordReply", status: … }] }` renders the agent name and a control that opens the transcript. (Both from the nearest existing ToolPart test harness.)

- [ ] **Step 2: Run it and watch it fail** — `cd packages/ui && bunx vitest run src/components/chat/message/parts/subagentTranscript.test.tsx`

- [ ] **Step 3: Implement recognition, the summary and the dialog**

Extend the OpenCode-era helper rather than adding a second notion: `isSubagentTool` becomes "the tool that spawns children" and gains `task` (and `hub`, whose job list names them); `taskToolModel.ts` keeps parsing what it already parses and gains the two shapes OMP actually emits — the ``Spawned agent `<name>`…`` progress text and the `hub` `jobs[].id` list. The dialog fetches the child's messages and renders them with the existing transcript renderer; it is read-only (there is no control to stop, start or message a sub-agent).

- [ ] **Step 4: Run the UI tests**

Run: `cd packages/ui && bunx vitest run src/components/chat/message/parts`

- [ ] **Step 5: Commit**

```bash
./node_modules/.bin/oxlint packages/ui/src/lib/opencode/tools.ts packages/ui/src/components/chat/message/parts/ToolPart.tsx packages/ui/src/components/chat/message/parts/SubagentTranscriptDialog.tsx
git add packages/ui/src/lib/opencode/tools.ts packages/ui/src/components/chat/message/parts/ToolPart.tsx packages/ui/src/components/chat/message/parts/SubagentTranscriptDialog.tsx packages/ui/src/components/chat/message/parts/subagentTranscript.test.tsx
git commit -m "feat(ui): open a sub-agent's transcript from its task row"
```

---

### Task 9: Server — model roles over the existing settings pattern (only for D3)

**Files:**
- Modify: `packages/web/server/lib/openchamber/omp-settings-routes.js` (two routes)
- Test: `packages/web/server/lib/openchamber/omp-settings-routes.test.js`

**Interfaces:**
- Consumes: `getUserConfigPath()` / `writeConfigKey()` from `agent-config-files.js` (the pair `cacheRetention` and `toolApproval` already use).
- Produces: `GET /api/config/model-roles` → `{ roles: Array<{ name: string; value: string | null }>, known: string[] }` (`known` = the chat roles of the pinned OMP version plus any custom key already present) and `PUT /api/config/model-roles` with `{ role: string; value: string | null }` → `{ ok: true, roles: [...] }`; `null`/`""` removes the key.

- [ ] **Step 1: Write the failing tests**

Mirror the existing cache-retention tests: GET on a temp config with `modelRoles: { default: a/b, DEV: c/d }` returns both plus the known list; PUT sets one role and leaves every other line of the file byte-identical; PUT with an empty value removes the key (Review Focus 4).

- [ ] **Step 2: Run them and watch them fail** — `cd packages/web && bunx vitest run server/lib/openchamber/omp-settings-routes.test.js`

- [ ] **Step 3: Implement the routes**

Reuse the read/validate/`writeConfigKey` shape of the neighbouring handlers; validate the role name against `/^[A-Za-z][A-Za-z0-9_-]{0,31}$/` and reject an unknown role only when it is neither known nor already present in the file.

- [ ] **Step 4: Run the tests**

Run: `cd packages/web && bunx vitest run server/lib/openchamber/omp-settings-routes.test.js`

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/openchamber/omp-settings-routes.js packages/web/server/lib/openchamber/omp-settings-routes.test.js
git commit -m "feat(server): read and write OMP model roles"
```

---

### Task 10: UI — a Roles row in Session Defaults

**Files:**
- Create: `packages/ui/src/components/sections/openchamber/ModelRolesRows.tsx`
- Modify: `packages/ui/src/components/sections/openchamber/DefaultsSettings.tsx` (mount the rows), `packages/ui/src/lib/settings/metadata.ts` + `search.ts` (make them searchable), `packages/ui/src/lib/i18n/messages/en.settings.ts` (labels)
- Test: `packages/ui/src/components/sections/openchamber/ModelRolesRows.test.tsx`

**Interfaces:**
- Consumes: `GET|PUT /api/config/model-roles` (Task 9), the model catalog already used by the Default Model picker.
- Produces: one row per role (label = role name, value = the model picker), an empty state ("no role set — OMP falls back to its own default"), and the Task 1 finding rendered as a note when it applies ("takes effect for sessions started after the change", Review Focus 5).

- [ ] **Step 1: Write the failing test**

Assert a row per role from a stubbed `GET`, that picking a model issues one PUT with `{ role, value }`, and that the note appears. Stub the fetch through an injected prop (no module mocks: the anti-slop plugin rejects them).

- [ ] **Step 2: Run it and watch it fail** — `cd packages/ui && bunx vitest run src/components/sections/openchamber/ModelRolesRows.test.tsx`

- [ ] **Step 3: Implement the rows**

Follow `CacheRetentionRow.tsx` for the control shape and `DefaultsSettings.tsx` for mounting; theme tokens only, and every string through `t()`.

- [ ] **Step 4: Run the UI tests and the search test**

Run: `cd packages/ui && bunx vitest run src/components/sections/openchamber src/lib/settings`

- [ ] **Step 5: Commit**

```bash
./node_modules/.bin/oxlint packages/ui/src/components/sections/openchamber/ModelRolesRows.tsx
git add packages/ui/src/components/sections/openchamber/ModelRolesRows.tsx packages/ui/src/components/sections/openchamber/ModelRolesRows.test.tsx packages/ui/src/components/sections/openchamber/DefaultsSettings.tsx packages/ui/src/lib/settings/metadata.ts packages/ui/src/lib/settings/search.ts packages/ui/src/lib/i18n/messages/en.settings.ts
git commit -m "feat(ui): set OMP model roles from Session Defaults"
```

---

### Task 11: End-to-end verification on the running app

**Files:** none (this task produces evidence, not code).

- [ ] **Step 1: Restart the server and the app on the new build**

```bash
cd packages/omp-adapter && bun ../../scripts/build-omp-adapter.mjs && cd ../..
node packages/web/bin/cli.js restart
```

- [ ] **Step 2: Todo, sub-agent and role, one run each**

Open the web UI at `http://127.0.0.1:4599` and:
1. Send a prompt that calls `todo` (*"track three steps in the todo tool, then do the first"*) → the row shows a checklist (Task 5) and the status row shows progress (Task 6, if built).
2. Send a prompt that calls `task` → the row lists the sub-agent and opens its transcript (Task 8); while it runs, the row shows the partial output from Task 2.
3. Change one role in Settings → Session Defaults → open a **new** session → the picker reflects the role's model (Task 10), and a session that was already open does not (Review Focus 5).

- [ ] **Step 3: Record the result**

Append the observed output to §Verified in this plan, then:

```bash
git add docs/superpowers/plans/2026-10-16-omp-parity-todo-subagents-roles.md
git commit -m "docs(plans): record the parity verification run"
```

---

## Verified

_(Filled by Task 1 and Task 11; each entry states what ran and what was seen.)_

- **Task 1, live frames (run 2026-10-16, session `01a142b2-b436-706c-859a-20aaf14a0179`, OMP 18.10.4, staged CLI).** One session, two prompts, every runtime frame printed:
  - Prompt *"Use the todo tool to record exactly two tasks…"* → **three `todo` calls, each producing only `tool_execution_start` + `tool_execution_end`; no `tool_execution_update` at all.** Todo has no partial-result channel: the reducer in Task 3 must build state from the start args and the end text, and live todo progress means re-emitting on each call, not streaming within one.
  - Prompt *"Use the task tool to launch exactly one scout sub-agent…"* → **`task` streams `tool_execution_update` frames** whose `partialResult` is an object `{ content: [{ type: "text", text }], details: { … } }` with texts `Spawned agent \`WordReply\`…`, `Running background task WordReply…`, `Running agent WordReply…` (repeated), and finally `Background task WordReply complete.`. Task 2's projection is therefore the live channel for sub-agents, and the agent's own name appears in the text **and** in `details`/the job list.
  - The waiting tool in this OMP version is **`hub`**, not `wait`: its args/partials carry `{ op: "wait", jobs: [{ id: "WordReply", … }] }`, and `hub` produced its own `tool_execution_update` frames while the sub-agent ran. Task 7/8 must key on `task` and `hub`, and prefer `jobs[].id`/`details` as the link to a child, falling back to the transcript's `parentSession` header.
- Task 1, role freshness: _(pending — Step 3 not run yet)_
- Task 11, todo row: _(pending)_
- Task 11, sub-agent row and viewer: _(pending)_
- Task 11, role change: _(pending)_
