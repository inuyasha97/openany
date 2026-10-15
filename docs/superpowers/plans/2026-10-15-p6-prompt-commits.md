# A step commits only when its prompt says so (P6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine never writes a git commit. A step becomes `done` only when a person confirms it. Whether a step's work is committed is decided by that step's own prompt, so the agent commits when asked and the engine records only what it can verify.

**Why:** the checkpoint commit staged every dirty path in the run's directory, so in `working-tree` mode a person's uncommitted edit and untracked files were committed inside a `step write [run=…]` commit on their checked-out branch, after which `git status` read clean and nothing told them. It also marked a step `done` with no person involved (`confirm: auto`), which the maintainer ruled out: a step is done when a person says so.

**Spec:** `docs/superpowers/specs/2026-10-14-sdlc-workflow-design.md` (patched by this plan — it is the contract, and it is the document the checkpoint language lives in).
**Supersedes:** the checkpoint tasks of `docs/superpowers/plans/2026-10-14-p1-workflow-engine.md` (its Task 5 and every mention of `checkpoints`, `writeCheckpointFor`, `verifyCheckpoint`). That plan stays as the record of what it built; this one is the authority from here on.

## Global Constraints

- No new dependencies. No new files under `packages/web/server/lib/workflows/` except tests: this is a removal.
- Load `openchamber-change-discipline` and `sync-state-invariants` before editing.
- The evidence a step leaves behind is **not** a commit and must survive: `attempt.verify.artifacts` (path, exists, size, sha256 for `hash: true`) and `attempt.verify.commands` (exit code, stdout, stderr) are what a screen shows and what a restart re-checks. Only the git commit goes.
- `step.checkpoint` disappears from the run shape. Nothing reads it afterwards; a run file written before this change keeps its `checkpoint` key and nothing reads that either (the store passes unknown keys through, so old runs still load).
- The `confirm` field disappears from the step schema. A definition that still declares it is invalid, with a message that says why. This is a deliberate break of an authored file, not a silent ignore.
- Focused test command: `bun run --cwd packages/web test -- server/lib/workflows/<file>.test.js`. `bun test` is not the server runner (it hangs `commands.test.js`). UI tests are `bun test` in `packages/ui`.
- `AGENTS.md` forbids git commands unless the maintainer asked. The maintainer asked for this plan to be executed, so the commit steps below are the only git commands an executor runs.

## Review Focus

1. No code path can produce a `done` step without a person's `done` decision. Owner: Task 1.
2. Nothing writes to git on the engine's behalf — after this plan, `packages/web/server/lib/workflows/` contains no commit, add, or stage call. Owner: Task 1.
3. The restart re-check still catches a step whose recorded artifact changed or vanished, now reading the attempt instead of a commit. Owner: Task 2.
4. A person's uncommitted work can no longer be committed by the engine in either sandbox mode. Owner: Task 3.

---

### Task 1: The engine stops committing, and a step is done only when a person says so

**Files:**
- Delete: `packages/web/server/lib/workflows/git-checkpoint.js` + `git-checkpoint.test.js`
- Modify: `packages/web/server/lib/workflows/engine.js` + `engine.test.js`
- Modify: `packages/web/server/lib/workflows/definitions.js` + `definitions.test.js`
- Modify: `packages/web/server/lib/workflows/runtime.js` + `runtime.test.js`
- Modify: `packages/web/server/lib/workflows/routes.js` + `routes.http.test.js`
- Modify: `packages/web/server/lib/workflows/artifacts.js`, `sandbox.js` (comments only)

**Interfaces:**
- Consumes: nothing from P4.
- Produces: `createWorkflowEngine({ store, definitions, host, listProjectIds, reconcileRuns, runChecks, turn, now, broadcast, logger, worktrees })` — no `checkpoints`, no `git`. A step record is `{ id, status, attempts, note }`; a step becomes `done` only inside `confirmStep` with `decision: 'done'`.

- [ ] **Step 1: Write the failing tests**

```js
// engine.test.js — add
it('never marks a step done without a person, whatever the verifiers say', async () => {
  const { engine, store } = await harness({ step: { confirm: 'auto' } });   // the old shape, if the parser still took it
  const run = await engine.startStep({ ...subject, stepId: 'write' });
  expect(run.steps[0].status).toBe('waiting_confirm');   // not 'done'
});

it('writes no commit when a person confirms a step', async () => {
  const { engine, calls } = await harness();
  await engine.startStep({ ...subject, stepId: 'write' });
  const run = await engine.confirmStep({ ...subject, stepId: 'write', decision: 'done' });
  expect(run.steps[0].status).toBe('done');
  expect(run.steps[0].checkpoint).toBeUndefined();
  expect(calls.commits).toEqual([]);                      // the engine's git driver never committed
});

// definitions.test.js — add
it('rejects a definition that still declares confirm, and says why', () => {
  const result = parseDefinition(`${valid}\n  confirm: human\n`, { file: 'a.yaml' });
  expect(result.ok).toBe(false);
  expect(result.errors).toEqual([{ field: 'steps[0].confirm', message: '"confirm" is gone: every step becomes done only when a person confirms it' }]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun run --cwd packages/web test -- server/lib/workflows/engine.test.js server/lib/workflows/definitions.test.js`
Expected: FAIL — the auto fixture reaches `done`, `checkpoint` is present, the git driver committed, and `confirm` still parses.

- [ ] **Step 3: Remove the commit**

- Delete `git-checkpoint.js` and its test.
- `engine.js`: delete `writeCheckpointFor`, the `checkpoints` dependency, and every `step.checkpoint = …`; delete the `confirm === 'auto'` branch in `settleAttempt` so a passing verifier leaves the step `waiting_confirm`; `confirmStep` with `decision: 'done'` records the step `done` and the run's advance, and writes nothing to git.
- `runtime.js`: drop `checkpoints` and the `createGitDriver()`/`git` wiring (the worktree service arrives through `worktrees`, which stays).
- `routes.js`: the create-run step template drops `checkpoint: null`.
- Comments in `artifacts.js` and `sandbox.js` that call the artifact record a checkpoint are reworded to say what it is: the evidence a step left behind.

- [ ] **Step 4: Remove the confirm field**

- `definitions.js`: drop `'confirm'` from `STEP_FIELDS`, drop the `human`/`auto` validation and the "auto needs a verifier" rule, and drop `confirm` from the parsed step. In the unknown-field loop, special-case the name so the error reads `"confirm" is gone: every step becomes done only when a person confirms it` — a migration hint, not an accepted value.
- `engine.js`: nothing reads `declared.confirm` afterwards; grep for it and remove every use.

- [ ] **Step 5: Run the directory suite**

```bash
bun run --cwd packages/web test -- server/lib/workflows
```

Expected: PASS. Every fixture that declared `confirm: auto` or `confirm: human` loses the field, and the auto-path tests are rewritten to assert `waiting_confirm` instead of `done`.

- [ ] **Step 6: Commit**

```bash
git add -A packages/web/server/lib/workflows
git commit -m "feat(workflows)!: a step is done when a person says so, and the engine writes no commit"
```

---

### Task 2: The restart re-check reads the attempt, not a commit

**Files:**
- Modify: `packages/web/server/lib/workflows/verifiers.js` + `verifiers.test.js` (`verifyCheckpoint` becomes `recheckArtifacts`)
- Modify: `packages/web/server/lib/workflows/resume.js` + `resume.test.js`
- Modify: `packages/web/server/lib/workflows/engine.js` + `engine.test.js` (`CHECKPOINT_NOTE_PREFIX` at `engine.js:36` is the literal `checkpoint no longer matches`, and `engine.js:395` keeps a checked step's note only when it starts with that string, which `engine.test.js:508-523` pins — the constant, its use and that test move with the new wording, or a `verifyStep` on a step the sweep blocked silently overwrites the reason)

**Interfaces:**
- Consumes: Task 1's step shape (no `checkpoint`).
- Produces: `recheckArtifacts({ artifacts, directory, deps }) -> { ok, mismatches }`, called from the restart sweep with the last settled attempt's `verify.artifacts`.

- [ ] **Step 1: Write the failing tests**

```js
// resume.test.js — replace the checkpoint case
it('flags a step whose recorded artifact changed while the server was down', async () => {
  // a done step whose last attempt recorded sha256 for spec.md; change the file, sweep, expect
  // step.note to name the path and the run to be blocked on it
});
it('does not flag a step whose artifact is unhashed and still exists', async () => { /* … */ });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/web test -- server/lib/workflows/resume.test.js`

- [ ] **Step 3: Implement**

- `verifiers.js`: rename `verifyCheckpoint` to `recheckArtifacts` and take `artifacts` (the attempt's list) instead of a checkpoint object. Its rules stay exactly as they are: a missing file is a mismatch; a changed file is a mismatch only when a digest was recorded; an unhashed artifact that still exists is fine.
- `resume.js`: read `step.attempts.at(-1)?.verify?.artifacts` for a settled step, and keep the note wording (`checkpoint no longer matches: …` becomes `an artifact no longer matches: …`). A settled step with no recorded artifacts is skipped, as before.

- [ ] **Step 4: Run the suites**

```bash
bun run --cwd packages/web test -- server/lib/workflows/resume.test.js server/lib/workflows/verifiers.test.js server/lib/workflows
```

- [ ] **Step 5: Commit**

```bash
git add -A packages/web/server/lib/workflows
git commit -m "refactor(workflows): re-check a finished step's artifacts, not a commit"
```

---

### Task 3: The screen and the documents stop saying checkpoint

**Files:**
- Modify: `packages/ui/src/components/views/workflows/StepPane.tsx`
- Modify: `packages/ui/src/lib/workflowsApi.ts` + `workflowsApi.test.ts`, `packages/ui/src/stores/useWorkflowStore.test.ts`
- Modify: all thirteen `packages/ui/src/lib/i18n/messages/*.ts`
- Modify: `docs/superpowers/specs/2026-10-14-sdlc-workflow-design.md`, `docs/superpowers/plans/2026-10-14-p1-workflow-engine.md` (a superseded note), `docs/superpowers/plans/2026-10-14-p3-workflow-screens.md`, `docs/agent-host/FUNCTION-STATUS.md`

**Interfaces:**
- Consumes: Task 1's step shape.
- Produces: a step pane that shows the verification evidence (artifact paths and their digests, the command output) and no commit.

- [ ] **Step 1: The screen**

`StepPane.tsx` drops the checkpoint block (the `workflows.step.checkpoint` label and the commit hash) and keeps what the attempt already carries: each artifact with its digest, and each command with its exit code and output. The pane must still show, for a `done` step, what was verified — that is now the whole of its evidence.

- [ ] **Step 2: The client type and the strings**

- `workflowsApi.ts`: drop `checkpoint` from `WorkflowStep`.
- Delete `workflows.step.checkpoint` from all thirteen dictionaries and fix whatever referenced it; `bun test src/lib/i18n/messages.test.ts` proves parity.

- [ ] **Step 3: The documents**

- The spec: rewrite the checkpoint language — "Run state holds four things" (no checkpoint), the `verify.artifacts` bullet (a recorded digest is re-checked on resume, with no commit involved), the `confirm: auto` bullet and transitions 3 and 4, the "unattended run needs `confirm: auto`" consequence (an unattended run is no longer possible: every step stops for a person, and that is the point), the API table's "checkpoints" wording, and the checkpoint test rows. Add a sentence stating the rule this plan exists for: **a step's work is committed only if that step's prompt asks the agent to commit it**.
- `2026-10-14-p1-workflow-engine.md`: a note at the top saying its checkpoint tasks were superseded by this plan, so a future reader does not re-implement them.
- `2026-10-14-p3-workflow-screens.md`: its four checkpoint mentions corrected.
- `docs/agent-host/FUNCTION-STATUS.md`: the rows that report checkpoint behaviour re-worded to what is now true, marked as driven in this pass.

- [ ] **Step 4: Run the checks**

```bash
bun run --cwd packages/web test -- server/lib/workflows
bun run type-check:ui
cd packages/ui && bun test src/lib/i18n/messages.test.ts src/lib/workflowsApi.test.ts src/stores/useWorkflowStore.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/ui docs
git commit -m "docs(workflows): the evidence a step leaves is not a commit"
```

---

### Task 4: Drive it

- [ ] **Step 1: A step that asks for a commit, and one that does not**

Two definitions in a fixture project, both `sandbox: working-tree`, each with a step whose verifier checks an artifact. One step's prompt ends with "commit your work with the message `step: <id>`"; the other's does not. Drive both through `POST /api/workflows/runs` → step run → confirm, on a real server with the real `omp` binary.

- [ ] **Step 2: Observe, and record**

For each: the step reaches `waiting_confirm` and only a `POST …/confirm {decision: 'done'}` makes it `done`; the run file carries no `checkpoint`; `git log` shows a commit for the prompt-driven step and **none** for the other; and with a dirty working tree before the run, the person's uncommitted edit is still uncommitted afterwards in both cases. Then record it in `docs/agent-host/FUNCTION-STATUS.md` under its conventions, `UNTESTED` for anything not driven.

- [ ] **Step 3: Commit**

```bash
git add docs/agent-host/FUNCTION-STATUS.md
git commit -m "docs(workflows): record the prompt-commit evidence"
```
