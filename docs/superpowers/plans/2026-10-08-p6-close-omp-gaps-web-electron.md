# Phase 6: Close the OMP gaps (web + electron) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every remaining OpenChamber capability either real over OMP or explicitly absent, on the **web** and **Electron** surfaces only, so no affordance in the shipped product promises something the runtime cannot do.

**Architecture:** OMP is reached through one RPC process per session (`omp --mode rpc`, JSONL) by `packages/omp-adapter`, hosted by `packages/web/server/lib/agents/`, and driven by `OmpRuntimeClient` in `packages/ui`. Every task here either adds an RPC command to that path (plus its route, client method and capability flip) or deletes the affordance that has no OMP equivalent behind it.

**Tech Stack:** TypeScript (`bun:test` in `packages/omp-adapter`), Node/Express + Zod (`vitest` in `packages/web`), React (`bun:test` + Vitest in `packages/ui`), Electron (Node `.mjs`, `node --test`).

**Spec:** `docs/superpowers/specs/2026-10-07-omp-only-runtime-design.md`
**Prior phases:** `docs/superpowers/plans/2026-10-07-p1..p5-*.md`, and `docs/agent-host/PHASE5-OMP.md` for what already landed.

## Global Constraints

- **Scope is web and Electron.** Do not change `packages/vscode` or `packages/mobile`; `packages/vscode` does not build and stays that way until its own phase.
- **OMP version floor:** `@oh-my-pi/pi-coding-agent` `18.1.11` is the pin (currently installed: 18.2.6). Any behavior cited below was verified against the installed package's `dist/cli.js` and `dist/types/**`.
- **OMP facts this plan rests on** (verified; do not re-litigate, but do re-verify a shape before coding against it):
  - `prompt` **expands commands itself**: a prompt whose text starts with `/name args` is matched against discovered file commands (`<agent dir>/commands/*.md`, `.omp/commands`, `.agent(s)/commands`, extension `commands/`) and, with `enableSkillCommands`, `/skill:<name>` skills. No command RPC exists.
  - RPC commands that exist and are unused by us: `branch {entryId}`, `new_session {parentSession?}`, `set_thinking_level {level}`, `cycle_thinking_level`, `set_fast_mode {enabled}`, `get_subagents`, `set_subagent_subscription`.
  - `get_state` returns `isStreaming`, `isCompacting`, `queuedMessageCount`, `tokensPerSecond`, `contextUsage`, `model`, `thinkingLevel`, `todoPhases`.
  - The **only** host-facing asking channel is `extension_ui_request`/`extension_ui_response`; the model's `ask` tool funnels through it (`method: "select"` with `options[]`, and `editor` for free text).
  - **No OMP equivalent** exists for: file/git revert, per-turn file diff, session agent selection, JSON agent/command config, a file index, synthetic (non-user) message injection, an RPC trigger for MCP OAuth reauth, or an external prompt-cache keep-alive.
- A capability flag may be `true` only when its route, client method and UI path all work. A flag that over-claims is a bug; fix the flag or delete the affordance.
- Where OMP has no equivalent, delete every user-visible promise of it in the same task — including i18n strings, settings-search entries, and any menu item — and say so in the owning `DOCUMENTATION.md`.
- Run `bun run dead-code` after any task that adds or deletes exports; inspect the report, do not mass-fix.
- Report exactly what was and was not validated. A static type-check is not runtime proof.

## Decisions needed before implementation

Each of these changes what a user sees; the maintainer answers before the task starts.

1. **Revert.** OMP cannot revert files. Recommendation: **delete the revert affordance for good** (it is already hidden by `capabilities.revert === false`), and leave `branch` (Task 5) as the only "go back" that exists. The alternative — mapping "revert" onto `branch` — changes the meaning from "restore my files" to "fork my transcript" and would surprise people.
2. **Session warming.** OMP keeps Anthropic's prompt cache warm itself; the knob is `providers.cacheRetention` (`auto|short|long|none`). Recommendation: **replace the removed warming row with a cache-retention row** in the OpenChamber settings page (Task 7), because it is the honest version of what the row meant. The alternative is dropping the row entirely.
3. **MCP reauth.** OMP runs the OAuth flow inside its own TUI and exposes no RPC to start it. Recommendation: **show the credential state and remove any sign-in button** (Task 8). The alternative is a hint telling people to run `omp`.
4. **Remote SSH instances.** Electron resolves and installs the **OpenCode** CLI on managed remote hosts. Recommendation: **port to OMP** (Task 12) so both ends run the same agent. The alternative is dropping managed remote instances from the desktop.
5. **Agent selection.** OMP chooses subagents inside the model's own `task` call; there is no session agent to select. Recommendation: **keep `agentSelection` false permanently** and document why (Task 6). No UI.

## Review Focus

Inputs and failure modes the tasks below must pin with tests, most likely to bite first:

1. `/notacommand args` (a prompt starting with `/` that matches nothing) — must send as a plain prompt, not error and not vanish.
2. A form with several questions, one of them `multi` — every answer must reach OMP, or the turn stalls forever.
3. A model with no `thinking` config — the effort control must be absent rather than offering levels OMP will reject.
4. A session that is compacting while not streaming — status must read busy, or the composer double-sends.
5. Forking at an entry id the session does not have — a clear error, and the original session untouched.
6. Electron: a packaged build whose staged UI predates `packages/web/dist` — the packaging step must fail rather than ship a stale UI.

---

## Gap inventory (what this plan is closing)

| Gap | OMP verdict | Task |
|---|---|---|
| `sendCommand` (slash commands) | **reachable** — OMP expands `/name args` inside `prompt` | 1 |
| Thinking level / effort, fast mode | **reachable** — `set_thinking_level`, `cycle_thinking_level`, `set_fast_mode` | 2 |
| Session status precision | **reachable** — `get_state` is richer than `budget` we read | 3 |
| Forms (`listPendingForms`/`replyForm`/`cancelForm`) | **reachable** — the `extension_ui_request` channel we already consume | 4 |
| Fork / session parent | **reachable** — `branch {entryId}`, `new_session {parentSession}` | 5 |
| Revert, turn diff, agent selection, synthetic messages | **no equivalent** — delete the promise | 6 |
| Session warming | **OMP does it itself** — `providers.cacheRetention` | 7 |
| MCP OAuth reauth | **OMP does it itself**, no RPC trigger | 8 |
| Websearch / plugins / custom providers config routes | **no UI consumer left** — remove the dead strings | 8 |
| Electron: stale `resources/web-dist` | rebuild + a check that fails packaging when stale | 9 |
| Electron: OpenCode CLI bundled (171 MB) | remove the pin, scripts, extraResources and verification | 10 |
| Electron: dead OpenCode runtime paths, docs | remove | 11 |
| Electron: SSH remotes install OpenCode | port to OMP | 12 |
| Everything above, on both surfaces | end-to-end verification | 13 |

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/omp-adapter/src/runtime.ts` | `OmpRuntime` — one method per `AgentRuntime` operation, delegating to the host |
| `packages/omp-adapter/src/rpc-host.ts` | `OmpHost` over `OmpRpcClient`: sessions, prompts, state, events |
| `packages/omp-adapter/src/rpc-client.ts` | JSONL framing, correlation, chunked frames |
| `packages/omp-adapter/src/mapping-events.ts` | OMP events → canonical `SyncEvent`s |
| `packages/web/server/lib/agents/omp-routes.js` | the HTTP surface (`/api/agents/omp/*`) |
| `packages/web/server/lib/agents/omp-runtime-host.js` | per-session projector, frame broadcast, pending requests |
| `packages/web/server/lib/agents/omp-approvals.js` | `extension_ui_request` ↔ permission/form requests and their replies |
| `packages/ui/src/lib/agent/omp-runtime.ts` | `OmpRuntimeClient` — capabilities and the HTTP calls |
| `packages/ui/src/lib/agent/contract.ts` | the `AgentRuntime` interface every runtime implements |
| `packages/ui/src/sync/session-ui-store.ts` | `routeMessage` — decides prompt vs command vs skill |
| `packages/web/server/lib/openchamber/omp-settings-routes.js` | **(new)** OMP `config.yml` keys the UI edits (cache retention) |
| `packages/electron/scripts/build-web-assets.mjs` | stages `packages/web/dist` → `packages/electron/resources/web-dist` |
| `packages/electron/ssh-manager.mjs` | managed remote instances: CLI resolution, install, launch |

---

### Task 1: Slash commands execute through OMP's own expansion

**Files:**
- Modify: `packages/omp-adapter/src/runtime.ts`, `packages/omp-adapter/src/rpc-host.ts`
- Modify: `packages/ui/src/lib/agent/omp-runtime.ts`
- Modify: `packages/ui/src/sync/session-ui-store.ts:214-285` (`routeMessage`)
- Test: `packages/omp-adapter/src/runtime.test.ts`, `packages/ui/src/lib/agent/omp-runtime.test.ts`, `packages/ui/src/sync/session-ui-store.test.ts` (create if absent)

**Interfaces:**
- Consumes: `OmpHost.prompt(id, text, options)` — already exists and already accepts `images` and `cwd`.
- Produces: `OmpRuntime.sendCommand(params)` implemented over the same prompt path; `AgentRuntime.capabilities.commands` stays `true` and becomes true in fact.

**Why:** a prompt beginning `/name args` is expanded by OMP itself (file commands, `/skill:<name>`, extension commands, MCP prompts). The client must not try to run commands; it must send the text.

- [ ] **Step 1: Write the failing adapter test**

Add to `packages/omp-adapter/src/runtime.test.ts`:

```ts
test("sendCommand sends the command text as a prompt", async () => {
  const { runtime, host } = makeRuntime();
  await runtime.sendCommand({ id: "ses_1", command: "review", arguments: "the diff", directory: "/repo" });
  expect(host.promptCalls).toEqual([{ id: "ses_1", text: "/review the diff", options: { cwd: "/repo" } }]);
});

test("sendCommand with no arguments sends the bare command", async () => {
  const { runtime, host } = makeRuntime();
  await runtime.sendCommand({ id: "ses_1", command: "init", arguments: "", directory: "/repo" });
  expect(host.promptCalls[0].text).toBe("/init");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/omp-adapter && bun test src/runtime.test.ts`
Expected: FAIL — `sendCommand` rejects with "OMP runtime does not support sendCommand".

- [ ] **Step 3: Implement `sendCommand` in the adapter**

In `packages/omp-adapter/src/runtime.ts`, replace the `sendCommand` rejection with a delegation that builds the command text and forwards the same options a prompt takes:

```ts
async sendCommand(params: OmpSendCommandParams): Promise<void> {
  const text = params.arguments?.trim() ? `/${params.command} ${params.arguments.trim()}` : `/${params.command}`;
  await this.host.prompt(params.id, text, {
    cwd: params.directory,
    images: params.images,
  });
}
```

Add `OmpSendCommandParams` to the adapter's exported types (`id`, `command`, `arguments?`, `directory?`, `images?`). Do **not** add a new RPC command: OMP has none.

- [ ] **Step 4: Run the adapter tests**

Run: `cd packages/omp-adapter && bun test && bun run type-check`
Expected: PASS, no type errors.

- [ ] **Step 5: Write the failing UI test**

Add to `packages/ui/src/lib/agent/omp-runtime.test.ts`:

```ts
test("sendCommand posts the command as prompt text", async () => {
  const { client, calls } = makeClient({ "POST /api/agents/omp/sessions/ses_a/prompt": { body: { ok: true } } });
  await client.sendCommand({ id: "ses_a", command: "review", arguments: "the diff", directory: "/repo" });
  expect(calls[0]).toMatchObject({ url: "/api/agents/omp/sessions/ses_a/prompt", method: "POST" });
  expect((calls[0].body as { text: string }).text).toBe("/review the diff");
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `cd packages/ui && bun test src/lib/agent/omp-runtime.test.ts`
Expected: FAIL — `unsupported("sendCommand")`.

- [ ] **Step 7: Implement it in `OmpRuntimeClient`**

In `packages/ui/src/lib/agent/omp-runtime.ts`, delete the `sendCommand` entry from the unsupported list and implement it by reusing the existing prompt call:

```ts
async sendCommand(params: SendCommandParams): Promise<void> {
  const text = params.arguments?.trim() ? `/${params.command} ${params.arguments.trim()}` : `/${params.command}`;
  await this.sendPrompt({ text, id: params.id, directory: params.directory, files: params.files, context: params.context, model: params.model, delivery: params.delivery });
}
```

`sendPrompt` already turns `files` into `@path` mentions and folds `context` into the text; a command must get the same treatment, which is why it delegates rather than posting a bare body.

- [ ] **Step 8: Simplify `routeMessage`**

In `packages/ui/src/sync/session-ui-store.ts`, the `matchedCommand` branch exists only because "OpenCode 2.x expands it only on the command route". That is no longer true, and the branch is what sends `/name` down the unsupported path. Replace the whole `if (params.content.startsWith("/") && (canUseCommands || canUseSkills))` block with: a command that matches the OMP command list is sent through `sendCommand`; **anything else that starts with `/` is sent as a plain prompt** (OMP decides whether to expand it). Write the test first:

```ts
test("an unmatched slash prompt is sent as a plain prompt", async () => {
  const { routeMessage, sent } = makeHarness({ commands: [{ name: "review" }], skills: [] });
  await routeMessage({ content: "/definitely-not-a-command hello", sessionId: "ses_1", directory: "/repo" });
  expect(sent[0]).toMatchObject({ text: "/definitely-not-a-command hello" });
});
```

- [ ] **Step 9: Run the UI suites for the touched areas**

Run: `cd packages/ui && bun test src/lib/agent src/sync`
Expected: PASS.

- [ ] **Step 10: Verify against the real binary**

Create a throwaway script under `/tmp` that drives `@openchamber/omp-adapter`'s `createOmpHost` against `omp --mode rpc` in a scratch directory containing `.omp/commands/ping.md` whose body is `PING-TEMPLATE $ARGUMENTS`, sends `/ping hello` through `prompt`, and prints the session's first user message. Expected: the text contains `PING-TEMPLATE hello`, not the raw `/ping hello`. Delete the script afterwards and paste the output into the task report.

- [ ] **Step 11: Commit**

```bash
git add packages/omp-adapter/src/runtime.ts packages/omp-adapter/src/runtime.test.ts \
        packages/ui/src/lib/agent/omp-runtime.ts packages/ui/src/lib/agent/omp-runtime.test.ts \
        packages/ui/src/sync/session-ui-store.ts
git commit -m "feat(omp): run slash commands through OMP's own expansion"
```

---

### Task 2: Thinking level, effort and fast mode in the model picker

**Files:**
- Modify: `packages/omp-adapter/src/runtime.ts`, `packages/omp-adapter/src/rpc-host.ts`, `packages/omp-adapter/src/index.ts`
- Modify: `packages/web/server/lib/agents/omp-routes.js`, `packages/web/server/lib/agents/omp-runtime-host.js`
- Modify: `packages/ui/src/lib/agent/omp-runtime.ts`, `packages/ui/src/lib/agent/contract.ts`
- Modify: `packages/ui/src/components/chat/ModelControls.tsx`
- Test: the same files' `.test.*` siblings

**Interfaces:**
- Produces: `OmpHost.setThinkingLevel(id, level)`, `OmpHost.cycleThinkingLevel(id)`, `OmpHost.setFastMode(id, enabled)`; `AgentRuntime.setThinkingLevel(id, level)`, `.setFastMode(id, enabled)`; `OmpSessionState.thinkingLevel`, `.thinking` (from the model payload), `.fastMode`.
- Consumes: `set_thinking_level`, `cycle_thinking_level`, `set_fast_mode` RPC commands.

- [ ] **Step 1: Write the failing adapter test**

```ts
test("setThinkingLevel forwards the level and reads it back", async () => {
  const { runtime, host } = makeRuntime();
  await runtime.setThinkingLevel("ses_1", "high");
  expect(host.commands).toContainEqual({ type: "set_thinking_level", level: "high" });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/omp-adapter && bun test src/runtime.test.ts`
Expected: FAIL — `setThinkingLevel is not a function`.

- [ ] **Step 3: Implement the three commands in the host and runtime**

`rpc-host.ts`:

```ts
setThinkingLevel: (id: string, level: string) => Promise<boolean>
cycleThinkingLevel: (id: string) => Promise<string | null>
setFastMode: (id: string, enabled: boolean) => Promise<{ enabled: boolean; active: boolean }>
```

Each resolves the handle for `id` and issues the matching RPC command; `cycleThinkingLevel` returns `data.level ?? null`.

- [ ] **Step 4: Add the routes**

`omp-routes.js`, beside the existing model route:

```
GET  /api/agents/omp/sessions/:id/model    (extend its response with `thinking`)
POST /api/agents/omp/sessions/:id/thinking  body { level }   → 200 { level }
POST /api/agents/omp/sessions/:id/fast-mode body { enabled } → 200 { enabled, active }
```

Validate `level` against OMP's enum with Zod: `inherit|off|minimal|low|medium|high|xhigh|max`. A bad level is a 400 naming the accepted values.

- [ ] **Step 5: Run the route tests**

Run: `cd packages/web && bunx vitest run server/lib/agents`
Expected: PASS, including new cases for the 400 and the happy path.

- [ ] **Step 6: Surface the model's thinking capability**

`get_available_models` returns `Model[]`; each model may carry `thinking?: ThinkingConfig` with `efforts[]`, `defaultLevel`, and `reasoning: boolean`. Extend the model projection in `omp-runtime-host.js` to pass through `reasoning`, `thinking.efforts` and `thinking.defaultLevel`, and extend the UI's model type accordingly. A model without `thinking` must project `efforts: []` — the picker then hides the effort control (Review Focus 3).

- [ ] **Step 7: Write the failing UI test for the effort control**

```ts
test("a model without thinking offers no effort control", () => {
  render(<ModelControls models={[{ id: "m1", provider: "p", reasoning: false, efforts: [] }]} />);
  expect(screen.queryByTestId("effort-select")).toBeNull();
});

test("a model with efforts offers exactly those levels", () => {
  render(<ModelControls models={[{ id: "m1", provider: "p", reasoning: true, efforts: ["low", "high"], defaultLevel: "low" }]} />);
  expect(screen.getByTestId("effort-select").children).toHaveLength(2);
});
```

- [ ] **Step 8: Implement the control in `ModelControls.tsx`**

Render an effort selector only when `efforts.length > 0`, defaulting to `defaultLevel`; changing it calls `getAgentRuntimeForSession(...).setThinkingLevel(id, level)`. Keep the existing model select above it.

- [ ] **Step 9: Run the UI tests and type-check**

Run: `cd packages/ui && bun test src/lib/agent src/components/chat && bun run type-check`
Expected: PASS, clean.

- [ ] **Step 10: Commit**

```bash
git add packages/omp-adapter/src packages/web/server/lib/agents packages/ui/src
git commit -m "feat(omp): thinking level, effort and fast mode"
```

---

### Task 3: Session status from the full OMP state

**Files:**
- Modify: `packages/omp-adapter/src/rpc-host.ts` (`getSessionStatus`), `packages/omp-adapter/src/runtime.ts`
- Modify: `packages/web/server/lib/agents/omp-routes.js` (`GET /sessions/:id/status`)
- Modify: `packages/ui/src/lib/agent/omp-runtime.ts`, `packages/ui/src/lib/opencode/model.ts` (the `SessionStatus` shape)
- Test: siblings

**Interfaces:**
- Produces: `getSessionStatus(id)` → `{ busy, compacting, queuedCount, tokensPerSecond, contextUsage }`, where `busy = isStreaming || isCompacting`.
- Consumes: `get_state`.

**Why:** the host currently reads only `isStreaming`, so a compacting session looks idle — the composer then accepts a send it should queue (Review Focus 4).

- [ ] **Step 1: Write the failing test**

```ts
test("a compacting session reads busy", async () => {
  const { runtime, host } = makeRuntime({ state: { isStreaming: false, isCompacting: true } });
  expect(await runtime.getSessionStatus("ses_1")).toMatchObject({ busy: true, compacting: true });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/omp-adapter && bun test src/runtime.test.ts`
Expected: FAIL — `busy` is `false`.

- [ ] **Step 3: Implement the mapping**

```ts
const state = await client.command<RpcSessionState>("get_state");
return {
  busy: state.isStreaming === true || state.isCompacting === true,
  compacting: state.isCompacting === true,
  queuedCount: state.queuedMessageCount ?? 0,
  tokensPerSecond: state.tokensPerSecond ?? null,
  contextUsage: state.contextUsage ?? null,
};
```

- [ ] **Step 4: Widen the route and the UI type**

`omp-routes.js` returns the new fields; `packages/ui/src/lib/opencode/model.ts`'s `SessionStatus` gains the optional fields, and every consumer that only read `busy` keeps working unchanged. Note in the route's docstring that OMP reports no error state — a failed turn is an event (`stopReason: "error"`, `notice`, `auto_retry_*`), not a status.

- [ ] **Step 5: Run the suites**

Run: `cd packages/omp-adapter && bun test` then `cd packages/web && bunx vitest run server/lib/agents` then `cd packages/ui && bun test src/lib/agent src/sync`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/omp-adapter/src packages/web/server/lib/agents packages/ui/src
git commit -m "feat(omp): report the full session state, not just streaming"
```

---

### Task 4: Forms — the `ask` tool's questions reach the UI

**Files:**
- Modify: `packages/omp-adapter/src/runtime.ts`, `packages/omp-adapter/src/rpc-host.ts` (pending-request bookkeeping)
- Modify: `packages/web/server/lib/agents/omp-approvals.js`, `omp-runtime-host.js`, `omp-routes.js`
- Modify: `packages/ui/src/lib/agent/omp-runtime.ts` (`forms` capability, `listPendingForms`, `replyForm`, `cancelForm`)
- Modify: `packages/ui/src/sync/session-actions.ts` (the form reply path already used by `WebSearchConsent`)
- Test: siblings

**Interfaces:**
- Consumes: the existing `extension_ui_request` frames with `method: "select" | "editor"`, and the existing reply channel (`extension_ui_response`).
- Produces: `listPendingForms({ sessionId, directory })` → `FormInfo[]`; `replyForm({ sessionId, requestId, answers })`; `cancelForm({ sessionId, requestId })`; `capabilities.forms = true`.

**Why:** the model's `ask` tool asks through the same frames we already answer for permissions, so a question with options currently renders as a permission card, and a multi-question ask cannot be answered at all — the turn stalls (Review Focus 2).

- [ ] **Step 1: Write the failing host test**

```ts
test("a select frame with several options becomes a form request", () => {
  const approvals = createOmpApprovals({ broadcast });
  approvals.handleFrame({ type: "extension_ui_request", id: "r1", method: "select", title: "Which one?", options: ["a", "b"], optionDetails: [{ description: "first" }, {}] });
  expect(pendingForms()).toEqual([
    { requestId: "r1", title: "Which one?", options: [{ label: "a", description: "first" }, { label: "b" }] },
  ]);
});

test("a reply answers the original frame", () => {
  const approvals = createOmpApprovals({ broadcast });
  approvals.handleFrame({ type: "extension_ui_request", id: "r1", method: "select", title: "?", options: ["a"] });
  approvals.replyForm("r1", { value: "a" });
  expect(sentFrames()).toContainEqual({ type: "extension_ui_response", id: "r1", value: "a" });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/web && bunx vitest run server/lib/agents/omp-approvals.test.js`
Expected: FAIL — no form projection, no `replyForm`.

- [ ] **Step 3: Project askable frames as forms and keep them pending**

`omp-approvals.js` already classifies askable methods. Split the projection by method: `select` and `editor` become **form requests** (with `options[]` and, for `editor`, a free-text field); `confirm` stays a **permission**. Keep the pending map so `listPendingForms` can answer from it, and emit either `permission.asked` or the form equivalent so the UI knows which surface to render. Cancel/timeout frames must clear the pending entry and tell the UI, so a stalled question never blocks the composer forever.

- [ ] **Step 4: Add the routes**

```
GET  /api/agents/omp/sessions/:id/forms        → { forms: FormInfo[] }
POST /api/agents/omp/sessions/:id/forms/:requestId  body { value } | { cancelled: true }
```

- [ ] **Step 5: Run the route tests** — `cd packages/web && bunx vitest run server/lib/agents` — PASS.

- [ ] **Step 6: Implement the client methods and flip the capability**

In `omp-runtime.ts` replace the three rejections with the calls above and set `forms: true`. Leave `WebSearchConsent` where it is: it renders a form and replies through the same path, so it keeps working and needs no change.

- [ ] **Step 7: Write the failing UI test for a multi-question form**

```ts
test("every answer in a multi-question form is sent", async () => {
  const { view, replies } = renderForm({ questions: [{ id: "q1", question: "A?", options: [{ label: "x" }, { label: "y" }] }, { id: "q2", question: "B?", multi: true, options: [{ label: "p" }, { label: "q" }] }] });
  await view.answer("q1", "x");
  await view.answerMulti("q2", ["p", "q"]);
  await view.submit();
  expect(replies[0].answers).toEqual({ q1: "x", q2: ["p", "q"] });
});
```

- [ ] **Step 8: Implement the form renderer**

Render one control per question (radio for single, checkboxes for `multi`, a text area for `editor`), a submit that sends all answers in one reply, and a cancel that sends `{ cancelled: true }`. Disable the composer while a form is pending, as it already does for permissions.

- [ ] **Step 9: Run the suites and verify against the real binary**

Run: `cd packages/ui && bun test src/components/chat src/sync` and `cd packages/web && bunx vitest run server/lib/agents`.
Then drive a real OMP session whose prompt makes the model call `ask` with two questions and confirm both answers arrive (paste the transcript into the report).

- [ ] **Step 10: Commit**

```bash
git add packages/omp-adapter/src packages/web/server/lib/agents packages/ui/src
git commit -m "feat(omp): carry the ask tool's questions through the form path"
```

---

### Task 5: Fork and parent — `branch` and `parentSession`

**Files:**
- Modify: `packages/omp-adapter/src/runtime.ts`, `rpc-host.ts`, `session-store.ts` (read `parentSession` from a session header)
- Modify: `packages/web/server/lib/agents/omp-routes.js`
- Modify: `packages/ui/src/lib/agent/omp-runtime.ts` (`fork: true`), `packages/ui/src/components/chat/message/TimelineNotice.tsx`, `packages/ui/src/components/chat/btw/BtwPanel.tsx`
- Test: siblings

**Interfaces:**
- Produces: `forkSession({ id, entryId, directory })` → the new session; session creation accepts `parentSession`; the session list exposes `parentSessionPath`.
- Consumes: `branch { entryId }`, `new_session { parentSession? }`, and the session header field `parentSession`.

- [ ] **Step 1: Write the failing adapter test**

```ts
test("forkSession branches at the given entry and reports the new session", async () => {
  const { runtime, host } = makeRuntime({ branchResult: { sessionId: "ses_2", sessionFile: "/s/ses_2.jsonl" } });
  const forked = await runtime.forkSession({ id: "ses_1", entryId: "e7", directory: "/repo" });
  expect(host.commands).toContainEqual({ type: "branch", entryId: "e7" });
  expect(forked.id).toBe("ses_2");
});
```

- [ ] **Step 2: Run it and watch it fail** — `cd packages/omp-adapter && bun test src/runtime.test.ts` — FAIL, `forkSession` rejects.

- [ ] **Step 3: Implement `branch` and the parent field**

`rpc-host.ts` gains `branch(id, entryId)`; `session-store.ts` reads `parentSession` out of the session header when listing, exposing `parentSessionPath` (it is already the field OMP writes). `runtime.ts` implements `forkSession` by branching and returning the new session handle, and `createSession` forwards `parentSession` when the caller supplies one.

- [ ] **Step 4: Routes**

```
POST /api/agents/omp/sessions/:id/branch   body { entryId }  → { session }
POST /api/agents/omp/sessions              body { cwd, parentSession? }
```

An unknown `entryId` must be a 400 with OMP's own message, and the original session must be untouched (Review Focus 5).

- [ ] **Step 5: Run the route tests** — PASS.

- [ ] **Step 6: Flip the capability and un-hide the UI**

`fork: true` in `omp-runtime.ts`. In `TimelineNotice.tsx` the fork action is already gated on `capabilities.fork`, so it appears; wire its handler to `forkSession` and navigate to the new session. In `BtwPanel.tsx`, the "promote the fork" path now has a real backing call.

- [ ] **Step 7: Write the UI tests**

```ts
test("the fork action is offered when the runtime can fork", () => { /* capabilities.fork true → button present */ });
test("a failed branch leaves the original session selected", async () => { /* 400 → toast, no navigation */ });
```

- [ ] **Step 8: Run the suites** — `cd packages/ui && bun test src/components/chat` — PASS.

- [ ] **Step 9: Commit** — `git commit -m "feat(omp): fork a session at a message with branch"`.

---

### Task 6: Delete the promises OMP cannot keep

**Files:**
- Modify: `packages/ui/src/lib/agent/contract.ts`, `omp-runtime.ts`, `packages/ui/src/lib/agent/testing/opencode-stub-runtime.ts`
- Modify: `packages/ui/src/lib/agent/registry.ts` (the capability set)
- Delete: dead affordances and strings found by the search below
- Docs: `docs/agent-host/PHASE5-OMP.md`, `packages/ui/src/lib/agent/DOCUMENTATION.md`

**Interfaces:**
- Produces: an `AgentRuntime` without `stageRevert`/`commitRevert`/`clearRevert`/`getSessionTurnDiff`/`listAgents`/`selectAgent`/`sendSyntheticMessage`, and capabilities `revert: false`, `turnDiff: false`, `agents: false`, `agentSelection: false` with a comment naming why.

- [ ] **Step 1: Find every promise**

Run and save the output:

```bash
grep -rn "revert\|turnDiff\|listAgents\|selectAgent\|agentSelection\|synthetic" \
  packages/ui/src --include=*.ts --include=*.tsx | grep -v "\.test\." > /tmp/p6-promises.txt
wc -l /tmp/p6-promises.txt
```

Anything user-visible in that list (a menu item, a settings row, an i18n string) is deleted in this task; anything only reachable through the contract is deleted with the method.

- [ ] **Step 2: Delete the methods and their call sites**

Remove the seven methods from `contract.ts`, from `OmpRuntimeClient`, and from the test stub. In `TimelineNotice.tsx` the revert branch is already unreachable (`capabilities.revert === false`), so delete the branch rather than leaving dead JSX.

- [ ] **Step 3: Delete the dead i18n**

Remove the keys that only the deleted surfaces used, across all locales, and run the locale-parity test.

- [ ] **Step 4: Write the guard test**

```ts
test("the OMP runtime advertises only capabilities it implements", () => {
  const { client } = makeClient({});
  for (const [name, enabled] of Object.entries(client.capabilities)) {
    if (!enabled) continue;
    expect(implementedMethods(client), `${name} is advertised but not implemented`).toContain(name);
  }
});
```

- [ ] **Step 5: Run the suites**

Run: `cd packages/ui && bun run type-check && bun test src/lib/agent src/lib/i18n/messages.test.ts`
Expected: PASS.

- [ ] **Step 6: Document the permanent absences**

In `docs/agent-host/PHASE5-OMP.md`, replace the "no OMP surface for" list with the verified verdicts: `branch` covers fork but not file revert; OMP selects subagents inside the model's `task` call, so there is no session agent to pick; synthetic injection exists only inside OMP's own process; there is no file index and no per-turn diff API.

- [ ] **Step 7: Commit** — `git commit -m "refactor(ui): stop promising what OMP cannot do"`.

---

### Task 7: Replace session warming with OMP's cache retention

**Files:**
- Create: `packages/web/server/lib/openchamber/omp-settings-routes.js`
- Create: `packages/web/server/lib/openchamber/omp-settings-routes.test.js`
- Modify: `packages/web/server/lib/openchamber/feature-routes-runtime.js`, `packages/web/server/index.js` (deps only)
- Modify: `packages/ui/src/components/sections/openchamber/DefaultsSettings.tsx`, `packages/ui/src/lib/settings/search.ts`, i18n
- Docs: `packages/web/server/lib/openchamber/DOCUMENTATION.md`

**Interfaces:**
- Produces: `GET /api/config/cache-retention` → `{ retention: 'auto'|'short'|'long'|'none' }`; `PUT` the same body → `{ retention, changed }`.
- Consumes: `writeConfig`/`readConfigFile`/`CONFIG_FILE` from `agent-config-files.js` (the agent dir's `config.yml`), and OMP's `providers.cacheRetention` key.

**Blocked on decision 2.** If the maintainer chooses to drop the row instead, this task becomes "delete the settings-search entry and the i18n keys" and nothing else.

- [ ] **Step 1: Write the failing route test**

```js
it("reads and writes providers.cacheRetention", async () => {
  const app = mount();
  await request(app).put('/api/config/cache-retention').send({ retention: 'short' }).expect(200);
  expect(readConfigFile().providers.cacheRetention).toBe('short');
  expect((await request(app).get('/api/config/cache-retention')).body).toEqual({ retention: 'short' });
});

it("rejects a value OMP does not accept", async () => {
  await request(mount()).put('/api/config/cache-retention').send({ retention: 'forever' }).expect(400);
});
```

- [ ] **Step 2: Run it and watch it fail** — `cd packages/web && bunx vitest run server/lib/openchamber/omp-settings-routes` — FAIL, no such module.

- [ ] **Step 3: Implement the module**

A factory `registerOmpSettingsRoutes(app, deps)` in the style of `config-settings-routes.js`, writing only `providers.cacheRetention` into the agent dir's `config.yml` through the existing `readConfigFile`/`writeConfig`, with a Zod enum for the four accepted values. Preserve every other key in the file.

- [ ] **Step 4: Wire it**

Import and call it from `feature-routes-runtime.js`, passing `readConfigFile`/`writeConfig` (add them to the deps object in `index.js` the way Task 7 of the previous phase added its four).

- [ ] **Step 5: Run the route tests and boot the server**

Run: `cd packages/web && bunx vitest run server/lib/openchamber`, then boot on a scratch `HOME` and confirm `PUT` then `GET` round-trips into `~/.omp/agent/config.yml`.

- [ ] **Step 6: Add the settings row**

In `DefaultsSettings.tsx`, where the warming row was removed, add a cache-retention selector with the four values and OMP's own wording; add its settings-search entry and its i18n keys in every locale.

- [ ] **Step 7: Run the UI tests** — `cd packages/ui && bun test src/components/sections/openchamber src/lib/i18n/messages.test.ts` — PASS.

- [ ] **Step 8: Commit** — `git commit -m "feat(settings): expose OMP cache retention where warming used to be"`.

---

### Task 8: MCP credential state, and the dead config strings

**Files:**
- Modify: `packages/ui/src/components/sections/mcp/McpPage.tsx`, `McpGrid.tsx`
- Modify: i18n (`settings.providers.page.toast.customProviderSaved`, `customProviderSaveFailed`, and any plugin/install strings)
- Delete: `packages/ui/src/lib/settings/search.ts` entries for surfaces with no page
- Docs: `packages/web/server/lib/openchamber/DOCUMENTATION.md`

**Blocked on decision 3.**

- [ ] **Step 1: Show credential state instead of a sign-in button**

Read the server's credential list (`GET /api/agents/omp/mcp` already reports the server entries; extend it with whether an `auth.credentialId` is present and whether that id exists in `agent.db`) and render "connected" / "not connected" plus the credential id in the MCP server detail. Delete any button that would start an OAuth flow: OMP runs it, and no RPC exists to ask.

- [ ] **Step 2: Add the hint, not a fake action**

When no credential is present, the panel says the server is not authenticated and names the action OMP expects (its own `/mcp` reauth in the terminal). No HTTP call is made.

- [ ] **Step 3: Write the test**

```ts
test("an unauthenticated mcp server shows no sign-in button", () => {
  render(<McpPage servers={[{ name: "s", url: "https://x", credentialId: null }]} />);
  expect(screen.queryByRole("button", { name: /sign in/i })).toBeNull();
  expect(screen.getByText(/not authenticated/i)).toBeInTheDocument();
});
```

- [ ] **Step 4: Delete the strings nobody can reach**

`customProviderSaved`/`customProviderSaveFailed` describe a custom-provider form that does not exist (the model picker's "+ add provider" opens the OMP login list). There is no plugins page. Delete those keys and any settings-search entry pointing at a page that is not rendered, keeping locale parity.

- [ ] **Step 5: Run the suites** — `cd packages/ui && bun test src/components/sections src/lib/i18n/messages.test.ts` — PASS.

- [ ] **Step 6: Record what OMP owns**

In `packages/web/server/lib/openchamber/DOCUMENTATION.md`, state that websearch settings, extensions/plugins and custom providers are **not** served by OpenChamber routes: OMP owns `web_search.*`/`providers.webSearch*`, `extensions`/`disabledExtensions` plus its `omp plugin` CLI, and `models.yml` `providers.<name>`. The former routes are gone on purpose and no UI calls them.

- [ ] **Step 7: Commit** — `git commit -m "feat(mcp): show credential state; drop strings for surfaces that do not exist"`.

---

### Task 9: Stage the desktop UI, and fail the build when it is stale

**Files:**
- Modify: `packages/electron/scripts/build-web-assets.mjs`, `packages/electron/package.json`
- Create: `packages/electron/scripts/verify-web-assets.mjs`, `packages/electron/scripts/verify-web-assets.test.mjs`
- Docs: `packages/electron/README.md`

**Interfaces:**
- Produces: `bun run --cwd packages/electron verify:web-assets`, which exits non-zero when `resources/web-dist` is older than `packages/web/dist` or is missing.
- Consumes: `packages/web/dist` (built by `bun run --cwd packages/web build`) and `resolveWebDistDir()` in `main.mjs`.

**Why:** the packaged app loads the UI from `resources/web-dist` over `openchamber-ui://app`, and that directory is currently ~21 hours stale. Nothing in the build notices (Review Focus 6).

- [ ] **Step 1: Write the failing check test**

```js
test('a web-dist older than packages/web/dist fails the check', async () => {
  const verdict = await verifyWebAssets({ webDist: staleDir, builtDist: freshDir });
  expect(verdict.ok).toBe(false);
  expect(verdict.reason).toMatch(/older than/);
});
```

- [ ] **Step 2: Run it and watch it fail** — `cd packages/electron && node --test scripts/verify-web-assets.test.mjs` — FAIL, module missing.

- [ ] **Step 3: Implement the check**

Compare `index.html`'s mtime and a content hash of the `assets/` directory names between `packages/web/dist` and `resources/web-dist`. Fail with the two paths and the age gap. Also fail when `resources/web-dist/index.html` is missing.

- [ ] **Step 4: Call it from packaging and staging**

Add `verify:web-assets` to `package.json` scripts and run it in `package` (which already runs the prepare steps) after `build:web-assets`, so a stale stage cannot ship.

- [ ] **Step 5: Stage the current build**

Run `bun run --cwd packages/web build` then `bun run --cwd packages/electron build:web-assets`, then the new check; expect it to pass.

- [ ] **Step 6: Document the step**

`packages/electron/README.md`: the packaged UI is served from `resources/web-dist` over `openchamber-ui://app`; rebuild it with these two commands; the packaging step now verifies it.

- [ ] **Step 7: Commit** — `git commit -m "build(electron): stage the UI and fail packaging when it is stale"`.

---

### Task 10: Stop bundling the OpenCode CLI

**Files:**
- Modify: `packages/electron/package.json`, `scripts/electron-dev.mjs`, `scripts/target-architecture.mjs`, `scripts/verify-linux-appimage.mjs`, `scripts/ensure-electron.mjs` if it references the pin
- Delete: `scripts/prepare-opencode-cli.mjs`, `scripts/opencode-cli-version.mjs`, `scripts/opencode-cli-version.test.mjs`, `scripts/verify-opencode-cli.mjs`
- Delete: `packages/electron/resources/opencode-cli/` (171 MB staged)
- Docs: `packages/electron/README.md`, `packages/electron/process-lifecycle.md`

**Why:** the desktop ships a 171 MB OpenCode binary it never runs, a `opencodeCli.version` pin, `extraResources` entry, `prepare:opencode-cli`/`verify:opencode-cli` scripts, and a Linux verification that asserts the OpenCode CLI version.

- [ ] **Step 1: Enumerate every reference**

```bash
grep -rn "opencode-cli\|opencodeCli\|OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR\|prepare-opencode-cli" \
  packages/electron .github 2>/dev/null | grep -v node_modules > /tmp/p6-electron-opencode.txt
```

- [ ] **Step 2: Point the architecture map at OMP**

`target-architecture.mjs` maps arch under an `opencode` key that `prepare-omp-cli.mjs` reads. Rename that key to something neutral (`cli`) and update both call sites, so removing the OpenCode scripts does not break OMP staging.

- [ ] **Step 3: Delete the OpenCode staging pipeline**

Remove the four scripts, the `opencodeCli` pin, `prepare:opencode-cli`/`verify:opencode-cli` from `scripts`, the `prepare:opencode-cli` call from `package`, the `extraResources` entry for `resources/opencode-cli`, and the dev-script's `OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR` handoff. Delete the staged directory.

- [ ] **Step 4: Verify the AppImage against OMP instead**

`verify-linux-appimage.mjs` asserts the packaged OpenCode CLI version. Point it at the OMP binary (it already exists in `resources/omp-cli`, staged by `prepare-omp-cli.mjs`) and assert the version from the OMP pin.

- [ ] **Step 5: Run the Electron suites**

Run: `cd packages/electron && bun run test && bun run test:architecture`
Expected: PASS after the reference updates.

- [ ] **Step 6: Confirm the package no longer carries it**

Run the packaging script and list the packaged resources; expect `omp-cli` and no `opencode-cli`.

- [ ] **Step 7: Commit** — `git commit -m "build(electron): stop bundling the OpenCode CLI"`.

---

### Task 11: Delete the dead OpenCode runtime paths in Electron

**Files:**
- Modify: `packages/electron/main.mjs`, `packages/electron/server-shutdown.mjs`, `packages/electron/early-startup.mjs`
- Delete: `packages/electron/opencode-readiness.mjs`, `opencode-readiness.test.mjs`, `opencode-cwd.mjs`, `opencode-cwd.test.mjs`
- Modify: `packages/web/server/index.js` (drop `getManagedOpenCodePreflight`/`getOpenCodeProcessInfo` and their `.d.ts` entries)
- Docs: `packages/electron/README.md`, `packages/electron/process-lifecycle.md`

**Why:** `launchDetachedOpenCodeKiller` still hunts a managed OpenCode child that no longer exists; `desktop_managed_opencode_compatible` calls a probe that now always returns `null`; `OPENCHAMBER_OPENCODE_CWD` feeds a fallback for a process nobody starts.

- [ ] **Step 1: Confirm each path is dead before deleting it**

For each of `canReuseManagedOpenCodePreflight`, `resolveManagedOpenCodeCwd`, `launchDetachedOpenCodeKiller`, `desktop_managed_opencode_compatible` and `OPENCHAMBER_OPENCODE_CWD`: name the caller, and confirm the server-side counterpart returns a constant (`getManagedOpenCodePreflight: () => null`, `getOpenCodeProcessInfo: () => ({ managed: false })`). Record the finding in the task report.

- [ ] **Step 2: Delete the modules and their call sites**

Remove the two `.mjs` modules with their tests, the detached-killer path in `stopEmbeddedServer`, the IPC command and its handler, the env variable assignment, and the `getManagedOpenCodePreflight`/`getOpenCodeProcessInfo` exports plus their type declarations.

- [ ] **Step 3: Keep shutdown correct**

`server-shutdown.mjs` justifies itself with "the backend owns PTYs and services as well as OpenCode". PTYs and services are real, so the module stays; only the OpenCode clause and the `getOpenCodeProcessInfo` fallback go. Add a test asserting the shutdown path still runs when the server handle has no OpenCode accessor.

- [ ] **Step 4: Run the Electron suites** — `cd packages/electron && bun run test` — PASS.

- [ ] **Step 5: Update the docs**

`process-lifecycle.md` describes a managed `opencode serve` and an OpenCode version pin; `README.md` has a "Bundled OpenCode CLI" section. Both now describe the OMP binary and the in-process server.

- [ ] **Step 6: Clean the icon comments** — the "OpenCode logo" comments in `resources/icons/*.svg` are wrong; fix or delete them.

- [ ] **Step 7: Commit** — `git commit -m "refactor(electron): remove the dead OpenCode runtime paths"`.

---

### Task 12: Managed remote instances run OMP

**Files:**
- Modify: `packages/electron/ssh-manager.mjs`, `packages/electron/ssh-manager.test.mjs`
- Modify: `packages/electron/scripts/electron-dev.mjs` if it feeds a CLI path to SSH
- Docs: `packages/electron/README.md`

**Blocked on decision 4.**

**Why:** the desktop's managed SSH instances resolve, install and launch the **OpenCode** CLI (`REMOTE_OPENCODE_CANDIDATES`, `OPENCODE_BINARY`, and the error "The opencode CLI is not installed on the remote machine"). With the OpenCode bundling gone (Task 10) this path installs a CLI the product does not use, so remote sessions cannot run.

- [ ] **Step 1: Map the current remote flow**

Read `ssh-manager.mjs:22-36, 1160-1177` and write down, in the task report: which candidates are probed, what is installed when none is present, how the binary path is passed to the remote server, and which env variable carries it.

- [ ] **Step 2: Write the failing test**

```js
test('a remote without omp reports the OMP install hint', async () => {
  const result = await resolveRemoteCli({ exec: async () => ({ code: 1, stdout: '' }) });
  expect(result.found).toBe(false);
  expect(result.message).toMatch(/oh-my-pi|omp/);
});
```

- [ ] **Step 3: Point the resolution at OMP**

Probe `omp` on the remote's PATH (bun global bin, `~/.bun/bin`, plus a locally staged binary the desktop can copy over, which is how the current flow ships OpenCode). Keep the candidate list shape; change the names, the install command and the error text. Verify the remote shell snippet quotes paths the same way the current one does — SSH command construction is where this breaks.

- [ ] **Step 4: Pass the OMP path to the remote server**

The launched remote server must resolve OMP from the path this flow found. Use the adapter's documented override (`OPENCHAMBER_OMP_PATH`/`OPENCHAMBER_OMP_BIN`, the variables `resolveOmpCommand` already reads) rather than inventing a new one.

- [ ] **Step 5: Run the tests** — `cd packages/electron && bun run test` — PASS, including the existing SSH cases updated to the new CLI.

- [ ] **Step 6: Smoke a real remote if one is available**

If no remote host is reachable in this environment, say so in the report and leave the path covered by unit tests only. Do not claim it works.

- [ ] **Step 7: Commit** — `git commit -m "feat(electron): managed remote instances run OMP"`.

---

### Task 13: Verify the whole surface, web and desktop

**Files:** none modified except docs.

**Interfaces:** consumes every route and capability the tasks above produce.

- [ ] **Step 1: Full suites and type-checks**

```bash
cd packages/omp-adapter && bun test && bun run type-check
cd packages/web && bun run test && bun run type-check
cd packages/ui && bun run test && bun run type-check
cd packages/electron && bun run test && bun run type-check
```

Record the counts. Know the pre-existing failures before you start: `server/lib/spaces/code-out.test.js` fails on APFS, and `gatekeeper-program.test.js` fails on a machine whose resolver answers for `.test` — both documented, neither caused by this plan.

- [ ] **Step 2: Web, end to end, in a browser**

Boot the server with a scratch `HOME` and the freshly built `packages/web/dist`, then: open the app, confirm zero failing requests on load; send a prompt; send a slash command and confirm the expanded template appears in the transcript; change the thinking level and confirm `get_state` reports it; answer an `ask` form; fork a session and confirm the new session lists its parent; open Settings and confirm a change round-trips to disk. Paste the observed requests and their statuses into the report.

- [ ] **Step 3: Desktop, packaged**

Run the packaging step, then the packaged app: confirm it loads the current UI (the new Settings row is visible, proving the stage is fresh), the OMP binary resolves, a session starts, and no `opencode` resource is present in the package.

- [ ] **Step 4: Dead code and documentation**

Run `bun run dead-code` and read the report. Confirm each `DOCUMENTATION.md` touched above matches the code: `packages/ui/src/lib/agent/`, `packages/web/server/lib/agents/`, `packages/web/server/lib/openchamber/`, `packages/electron/`.

- [ ] **Step 5: Branch review**

Ask a fresh reviewer to compare the branch against this plan and the spec, with the Review Focus list in hand, and to report anything a person would experience as broken. Fix what it finds before the final commit.

- [ ] **Step 6: Commit** — the fixes from the review, and the verification notes in the plan's own report.

---

## Self-Review

**1. Spec coverage.** The spec's runtime requirements are met by P1–P5; this plan closes what an audit found still false in the shipped product: command execution, model depth, status, forms, fork (Task 1-5), the affordances with no backing (6-8), and the Electron half that still shipped OpenCode (9-12). The spec's out-of-scope list (`packages/vscode`, `packages/mobile`) is preserved by the Global Constraints.

**2. Placeholder scan.** No TBD, no "handle edge cases", no "similar to Task N". Every task names its files, its RPC command or route, and the test that fails first. Tasks blocked on a product decision say so in their header instead of guessing.

**3. Type consistency.** `sendCommand` keeps its existing `SendCommandParams`; `forkSession` returns a session like `createSession`; `getSessionStatus` widens the existing `SessionStatus` rather than replacing it; the new routes extend `/api/agents/omp/sessions/:id/*`, matching the existing family; `cache-retention` writes the same `config.yml` the other OMP settings do.

**4. Review Focus.** Each of the six inputs listed is pinned by a task: 1 → Task 1 Step 8; 2 → Task 4 Steps 1 and 7; 3 → Task 2 Steps 6-7; 4 → Task 3 Step 1; 5 → Task 5 Step 4; 6 → Task 9 Steps 1-3.
