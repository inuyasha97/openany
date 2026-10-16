# A chosen sandbox, a release that can delete, and a run that notices (P7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three decisions the maintainer made in session, turned into behaviour:

1. Releasing a run's worktree may delete work that no commit preserved — but only through a control that says how many files it will delete, and only after a confirmation.
2. The sandbox mode is **chosen, never defaulted**: a definition must declare it, and the person starting a run may choose again for that run. Nothing about where a run executes is implicit.
3. A run **notices** when the definition it was created from changed underneath it, instead of executing a workflow that is no longer the one it started with.

**Why now:** P6 made the engine stop committing, so a `worktree` step's output can exist only in the checkout that a release deletes (1); the `sandbox` field arrived with a parser default nobody chose (2); and `run.workflowHash` has been written since plan 1 and read by nobody, which the fork's rules call dead weight — the maintainer chose to use it rather than delete it (3).

**Spec:** `docs/superpowers/specs/2026-10-14-sdlc-workflow-design.md` — this plan changes three things the spec states, so the spec is updated with them.
**Supersedes:** the `sandbox` default in `docs/superpowers/plans/2026-10-14-p4-worktree-sandbox.md` (Task 1) and the release guard in `docs/superpowers/plans/2026-10-15-p6-prompt-commits.md` (its final fix wave).

## Global Constraints

- No new dependencies.
- Load `openchamber-change-discipline`, `sync-state-invariants`, `ui-api-decoupling` and `locale-ui-patterns` before editing.
- Nothing about where a run executes may be implicit after this plan: a definition without `sandbox` does not load, and a run records the mode it actually used (it already does).
- Deleting uncommitted work is a destructive action and must be named as one: the control states how many files it will delete and the confirmation repeats it. Nothing deletes a file as a side effect of another action.
- `workflowHash` keeps the convention it was written with — `sha256(JSON.stringify(parsedDefinition))`, not the file text — because that is what old runs already carry. The authoring guard's text hash (`P5`) is a different value for a different question and stays separate.
- Server tests are vitest (`bun run --cwd packages/web test -- <path>`); UI tests are `bun test` in `packages/ui`. Never `bun test` on `packages/web`.
- Every user-facing string goes into all thirteen dictionaries with a real translation.
- `AGENTS.md` forbids git commands unless the maintainer asked. The maintainer asked for this plan to be executed, so the commit steps below are the only git commands an executor runs.

## Review Focus

1. The destructive release cannot happen without an explicit request that names what it deletes, and a run whose checkout is clean is unaffected. Owner: Task 1.
2. No run executes in a mode nobody chose: not by a parser default, not by a stale screen, not by a definition edited between the choice and the create. Owner: Task 2.
3. A definition that changes under a live run is noticed before the next step runs, and the person is told what changed rather than being stopped with a code. Owner: Task 3.
4. Nothing that already worked stops working: a finished run is untouched by Task 3, and a definition that declares its mode behaves as before. Owner: Task 2, Task 3.

---

### Task 1: A release that can delete, on purpose

**Files:**
- Modify: `packages/web/server/lib/workflows/sandbox.js` + `sandbox.test.js`
- Modify: `packages/web/server/lib/workflows/engine.js` + `engine.test.js` (the release method and the route's answer)
- Modify: `packages/web/server/lib/workflows/routes.js` + `routes.http.test.js`
- Modify: `packages/ui/src/lib/workflowsApi.ts` (+ its test), `packages/ui/src/components/views/workflows/RunDetail.tsx`
- Modify: the thirteen `packages/ui/src/lib/i18n/messages/*.ts`

**Interfaces:**
- Consumes: the existing `releaseSandbox` guard (`sandbox.js:96-116`) that refuses a dirty checkout with the paths.
- Produces: `releaseSandbox({ run, projectPath, git, deleteUncommitted = false, confirmed = null }) -> { removed: boolean, deleted?: string[] }`; `POST /api/workflows/runs/:runId/sandbox/release` with `{ deleteUncommitted?: boolean, confirmed?: string[] }` — the request carries the paths the person was shown, and the server removes nothing unless a fresh status read is exactly that set, answering the paths it deleted beside the run; `releaseWorkflowSandbox(directory, runId, { deleteUncommitted, confirmed })` on the client.

- [ ] **Step 1: Write the failing tests**

```js
// sandbox.test.js — the destructive path
it('deletes the uncommitted work it names, but only when the release asks it to', async () => {
  const prepared = await prepareSandbox({ run: run(), projectPath: root, git: gitService });
  await fs.writeFile(path.join(prepared.directory, 'scratch.txt'), 'x');
  await expect(releaseSandbox({ run: runWith(prepared), projectPath: root, git: gitService }))
    .rejects.toThrow(/uncommitted changes/);                                  // unchanged: refuses, naming the paths
  const released = await releaseSandbox({ run: runWith(prepared), projectPath: root, git: gitService, deleteUncommitted: true, confirmed: ['scratch.txt'] });
  expect(released).toMatchObject({ removed: true, deleted: ['scratch.txt'] });
  await expect(fs.stat(prepared.directory)).rejects.toThrow();
  // The branch survives the deletion: it is the work, the checkout is tidiness.
});
it('refuses a deletion that confirms nothing, and deletes nothing', async () => { /* a bare flag names no path */ });
it('refuses a deletion the checkout no longer matches, naming what changed', async () => { /* a path appeared */ });

// engine.test.js — the refusal names the paths; the confirmed request is what removes them
it('names the uncommitted paths in the refusal, and removes them when the release is asked to', async () => { /* … */ });
it('refuses a deletion whose confirmation no longer matches the checkout', async () => { /* … */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun run --cwd packages/web test -- server/lib/workflows/sandbox.test.js server/lib/workflows/engine.test.js`

- [ ] **Step 3: Implement**

- `sandbox.js`: keep the guard's refusal exactly as it is when `deleteUncommitted` is false; when it is true, compare the paths a fresh status read reports with the `confirmed` set the person was shown — a path that appeared, or one that is no longer uncommitted, means the confirmation describes a different checkout, so the release refuses and names what changed, with the fresh paths in `details.uncommitted`. Only when the two are the same set is the checkout removed, answering the paths as `deleted`; a flag with no list confirms nothing and is refused the same way. A read that fails for a reason other than a missing repository still refuses — the override does not make the guard fail-open.
- `engine.js`: the release method passes the flag and the confirmed paths through, answers the deleted paths beside the run, and refuses a run that has not finished (`running` or `waiting`) with wording true of both.
- `routes.js`: the body's `deleteUncommitted` must be a boolean or absent, and `confirmed` an array of paths or absent; anything else is a 400, in the shape the route already uses for a malformed body.

- [ ] **Step 4: The screen**

`RunDetail.tsx` already offers the release and renders the refusal's message. Add the destructive path: when the refusal names uncommitted work, offer a second control that states how many files it will delete and opens a confirmation; only the confirmed request carries `deleteUncommitted: true`. The count and the paths come from the refusal's `uncommitted` list in the body — the same list the request sends back as `confirmed`, never re-derived on the client, so what the person confirmed is what the server compares against.

- [ ] **Step 5: Run the suites**

```bash
bun run --cwd packages/web test -- server/lib/workflows
bun run type-check:ui
cd packages/ui && bun test src/lib/i18n/messages.test.ts src/lib/workflowsApi.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/web/server/lib/workflows packages/ui/src
git commit -m "feat(workflows): release a worktree that holds uncommitted work, when asked"
```

---

### Task 2: The mode is chosen, never defaulted

**Files:**
- Modify: `packages/web/server/lib/workflows/definitions.js` + `definitions.test.js` (the field is required)
- Modify: `packages/web/server/lib/workflows/routes.js` + `routes.http.test.js` (the create accepts a chosen mode)
- Modify: `packages/ui/src/components/views/workflows/RunList.tsx` (the start flow asks), `packages/ui/src/lib/workflowsApi.ts`
- Modify: the thirteen dictionaries

**Interfaces:**
- Consumes: `sandbox: 'worktree' | 'working-tree'` from P4; the start flow that collects inputs (`RunList`).
- Produces: a definition without `sandbox` fails to load with `{ field: 'sandbox', message: 'is required: choose "worktree" or "working-tree"' }`; `POST /api/workflows/runs` accepts an optional `sandbox` that overrides the definition's for that run; the start dialog asks, pre-selected from the definition, and sends what was chosen.

- [ ] **Step 1: Write the failing tests**

```js
// definitions.test.js
it('refuses a definition that does not choose a sandbox', () => {
  const result = parseDefinition(validWithoutSandbox, { file: 'a.yaml' });
  expect(result.ok).toBe(false);
  expect(result.errors).toEqual([{ field: 'sandbox', message: 'is required: choose "worktree" or "working-tree"' }]);
});

// routes.http.test.js
it('records the mode the caller chose, not the one the definition declares', async () => {
  // definition declares worktree; the request says working-tree; the stored run says working-tree
});
it('refuses a mode that is not one of the two', async () => { /* 400 */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun run --cwd packages/web test -- server/lib/workflows/definitions.test.js server/lib/workflows/routes.http.test.js`

- [ ] **Step 3: Implement**

- `definitions.js`: `sandbox` is required and validated; the default branch goes. Every definition in the repository's fixtures and the SDLC template must declare it — the template already does.
- `routes.js`: the create route takes `sandbox` from the body when present (validated against the two values, 400 otherwise) and records that; otherwise it records the definition's declaration. The run still records the mode it is using, and nothing else reads a default.

- [ ] **Step 4: The start flow asks**

`RunList`'s start flow (the one that already collects required inputs) gains the mode: two options with the definition's declaration pre-selected, and the chosen value goes into the create request. A definition whose mode is `worktree` and whose person picks `working-tree` must produce a run that records `working-tree` — and the screen must not claim otherwise afterwards.

- [ ] **Step 5: Run the suites**

```bash
bun run --cwd packages/web test -- server/lib/workflows
bun run type-check:ui
cd packages/ui && bun test src/lib/i18n/messages.test.ts src/lib/workflowsApi.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/web/server/lib/workflows packages/ui/src
git commit -m "feat(workflows)!: a run's sandbox is chosen, not defaulted"
```

---

### Task 3: A run notices its definition changed

**Files:**
- Modify: `packages/web/server/lib/workflows/engine.js` + `engine.test.js`
- Modify: `packages/web/server/lib/workflows/routes.js` if the refusal needs a status the route does not already map
- Modify: `packages/ui/src/components/views/workflows/StepPane.tsx` only if the note needs a place to be read

**Interfaces:**
- Consumes: `run.workflowHash`, written since plan 1 as `sha256(JSON.stringify(parsedDefinition))`.
- Produces: a step that would run against a changed definition is `blocked` with a note naming what changed; a run whose definition is unchanged behaves exactly as it does today.

- [ ] **Step 1: Write the failing tests**

```js
// engine.test.js
it('blocks a step when the definition changed under the run', async () => {
  const { engine, store } = await harness({ definition: 'v1' });
  const created = await engine.startStep({ ...subject, stepId: 'write' });
  await harness.replaceDefinition('v2');                       // the file is edited between steps
  const next = await engine.startStep({ ...subject, stepId: 'second' });
  expect(next.steps[1].status).toBe('blocked');
  expect(next.steps[1].note).toMatch(/changed since this run started/);
});
it('does not touch a finished run', async () => { /* a done run re-read is unchanged */ });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/web test -- server/lib/workflows/engine.test.js`

- [ ] **Step 3: Implement**

- `engine.js`: wherever a run in flight loads its definition (`attemptStep`, `continueStep`, `verifyStep`), compare the freshly parsed definition's hash with `run.workflowHash` using the same convention, and block the step with a note naming the change (for example the declared version, or that the definition's content differs) when they differ. A run that carries no hash — created before this plan — is not blocked; there is nothing to compare. The block is written before the definition is asked to declare the step, and a definition that no longer loads at all is the same change: an edit that leaves a typo, or removes the step, must reach this block rather than a lookup's 404, which would write nothing and leave an auto-advancing run reading `running` on disk with nothing executing it.
- The note must tell the person what to do: the definition changed, so the run cannot continue on the workflow it started with; restoring the file or starting a new run are the two ways forward.

- [ ] **Step 4: Run the suites**

```bash
bun run --cwd packages/web test -- server/lib/workflows
```

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/workflows
git commit -m "feat(workflows): a run stops when its definition changes underneath it"
```

---

### Task 4: Drive it, and update the spec

- [ ] **Step 1: The three behaviours on a real server**

With the real `omp` binary and a fixture project: a `worktree` run whose step leaves an uncommitted file, released first without the flag (409, paths named) and then with it (removed, `deleted` names the file, branch survives); a run created with the opposite mode to its definition's (the stored run records the choice, and the checkout matches it); a run whose definition is edited between two steps (the second step blocks with the note, and restoring the file clears it).

- [ ] **Step 2: Update the spec**

`docs/superpowers/specs/2026-10-14-sdlc-workflow-design.md`: `sandbox` is required and chosen per run; the release's destructive path and what it says; a run that notices its definition changed. Record it in `docs/agent-host/FUNCTION-STATUS.md` under its conventions, `UNTESTED` for anything not driven.

- [ ] **Step 3: Commit**

```bash
git add docs
git commit -m "docs(workflows): record the chosen sandbox, the destructive release and the changed definition"
```
