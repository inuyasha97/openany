# Worktree sandbox for workflow runs (P4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a definition declare where its steps run, `worktree` (the default) or `working-tree`, run the whole workflow inside an isolated worktree when it does, and leave a clean way to bring the work back.

**Architecture:** Three changes on top of the engine plan. The definition gains a `sandbox` field, validated at load. The engine creates one worktree and one branch per run before the first step and uses its path as the run's directory. When the run finishes, the worktree is removed only when the person asks, and the branch stays for a merge they run themselves.

**Tech Stack:** Node ESM, `packages/web/server/lib/git/service.js` (`createWorktree`, `removeWorktree`, `getStatus`), vitest, supertest.

**Spec:** `docs/superpowers/specs/2026-10-14-sdlc-workflow-design.md` (P4)
**Engine plan:** `docs/superpowers/plans/2026-10-14-p1-workflow-engine.md`
**Screens plan:** `docs/superpowers/plans/2026-10-14-p3-workflow-screens.md`

## Global Constraints

- No new dependencies. Worktrees go through `packages/web/server/lib/git/service.js`; do not call `git` from a new place.
- Load `openchamber-change-discipline` and `sync-state-invariants` before editing.
- The `sandbox` field is additive: a definition without it means `worktree` after this plan, and `working-tree` before it. Every run records the mode it actually used, so an old run keeps reading the way it ran.
- A run in `worktree` mode never writes to the project's working tree. A step whose worktree could not be created is `blocked` with the git error recorded; it does not fall back to the working tree.
- Removing a worktree is always an explicit action on a finished run. Nothing deletes a directory on its own, and no route deletes a session.
- Focused test command: `bun run --cwd packages/web test -- server/lib/workflows/<file>.test.js`. Syntax check: `node --check <file>`.
- `AGENTS.md` forbids git commands unless the maintainer asked. The maintainer asked for this plan to be executed, so the commit steps below are the only git commands an executor runs. Tests that need a repository create their own temporary one, the way `packages/web/server/lib/git/service.test.js:1-45` does.

## Review Focus

1. A repository that is not a git repo, or a worktree path that already exists, must block the run with the git message rather than running steps in the project's working tree. Owner: Task 2.
2. Two runs of the same project must not collide on one branch or one worktree path. Owner: Task 2.
3. A definition that says `worktree` on a project with uncommitted changes must not move or lose those changes. Owner: Task 2.
4. Measured cost: a worktree that needs a fresh dependency install is slow, and the default ships only with a number attached. Owner: Task 4.

---

### Task 1: The sandbox field

**Files:**
- Modify: `packages/web/server/lib/workflows/definitions.js` + `definitions.test.js`
- Modify: `packages/web/server/lib/workflows/routes.js` + `routes.http.test.js` (the created run records `sandbox`)
- Modify: `packages/ui/src/lib/workflowsApi.ts` (the definition types gain `sandbox`)

**Interfaces:**
- Consumes: engine plan Task 1.
- Produces: `WorkflowDefinition.sandbox: 'worktree' | 'working-tree'` (default `worktree`); `WorkflowRun.sandbox` keeps the value the run is using.

- [ ] **Step 1: Write the failing test**

```js
// add to definitions.test.js
  it('defaults the sandbox to worktree and rejects an unknown one', () => {
    expect(parseDefinition(valid, { file: 'a.yaml' }).definition.sandbox).toBe('worktree');
    const explicit = parseDefinition(`${valid}\nsandbox: working-tree\n`, { file: 'a.yaml' });
    expect(explicit.definition.sandbox).toBe('working-tree');
    const bad = parseDefinition(`${valid}\nsandbox: container\n`, { file: 'a.yaml' });
    expect(bad.ok).toBe(false);
    expect(bad.errors).toEqual([{ field: 'sandbox', message: 'must be "worktree" or "working-tree"' }]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/web test -- server/lib/workflows/definitions.test.js`
Expected: FAIL, `sandbox` is `undefined`.

- [ ] **Step 3: Implement**

Add `'sandbox'` to `DEFINITION_FIELDS`, validate the two values, and return `sandbox: raw.sandbox === 'working-tree' ? 'working-tree' : 'worktree'` in the definition. In the create-run route, replace the hardcoded `sandbox: 'working-tree'` with `sandbox: definition.sandbox`. In `workflowsApi.ts`, add `sandbox: 'worktree' | 'working-tree'` to `WorkflowDefinitionSummary` and the step definition types.

- [ ] **Step 4: Run both suites**

```bash
bun run --cwd packages/web test -- server/lib/workflows/definitions.test.js server/lib/workflows/routes.http.test.js
```

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/workflows packages/ui/src/lib/workflowsApi.ts
git commit -m "feat(workflows): let a definition declare its sandbox"
```

---

### Task 2: A worktree per run

**Files:**
- Create: `packages/web/server/lib/workflows/sandbox.js`
- Test: `packages/web/server/lib/workflows/sandbox.test.js`
- Modify: `packages/web/server/lib/workflows/engine.js` (prepare the sandbox before the first step)
- Modify: `packages/web/server/lib/workflows/runtime.js` (pass the worktree functions)

**Interfaces:**
- Consumes: `createWorktree`, `removeWorktree`, `getStatus` from `packages/web/server/lib/git/service.js`.
- Produces:
  - `prepareSandbox({ run, projectPath, git }) -> Promise<{ directory, branch, created: boolean }>`
  - `releaseSandbox({ run, projectPath, git }) -> Promise<{ removed: boolean }>`
  - `engine.startStep` prepares the sandbox once per run, when `run.directory` is still the project path and `sandbox === 'worktree'`.

- [ ] **Step 1: Write the failing test**

```js
// packages/web/server/lib/workflows/sandbox.test.js
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { prepareSandbox, releaseSandbox } from './sandbox.js';
import * as gitService from '../git/service.js';

let root;
let counter = 0;
const run = () => ({
  runId: `run-${counter += 1}`,
  projectId: 'proj-1',
  sandbox: 'worktree',
  directory: root,
  steps: [],
});

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-sandbox-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(root, 'a.txt'), 'a');
  git('add', '.');
  git('commit', '-q', '-m', 'seed');
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('prepareSandbox', () => {
  it('creates one worktree per run, away from the project directory', async () => {
    const subject = run();
    const prepared = await prepareSandbox({ run: subject, projectPath: root, git: gitService });
    expect(prepared.created).toBe(true);
    expect(prepared.directory).not.toBe(root);
    expect(prepared.branch).toContain(subject.runId);
    expect(await fs.readFile(path.join(prepared.directory, 'a.txt'), 'utf8')).toBe('a');
  });

  it('is idempotent: a run that already has a worktree keeps it', async () => {
    const subject = run();
    const first = await prepareSandbox({ run: subject, projectPath: root, git: gitService });
    const second = await prepareSandbox({ run: { ...subject, directory: first.directory, worktreeBranch: first.branch }, projectPath: root, git: gitService });
    expect(second).toMatchObject({ directory: first.directory, branch: first.branch, created: false });
    await releaseSandbox({ run: { ...subject, directory: first.directory, worktreeBranch: first.branch }, projectPath: root, git: gitService });
  });

  it('asks for a different directory for every run, so two runs cannot share one', async () => {
    const left = await prepareSandbox({ run: run(), projectPath: root, git: gitService });
    const right = await prepareSandbox({ run: run(), projectPath: root, git: gitService });
    expect(left.directory).not.toBe(right.directory);
    expect(left.branch).not.toBe(right.branch);
  });

  it('surfaces a git refusal instead of running in the project directory', async () => {
    const notARepo = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-notrepo-'));
    await expect(prepareSandbox({ run: run(), projectPath: notARepo, git: gitService }))
      .rejects.toThrow();
    await fs.rm(notARepo, { recursive: true, force: true });
  });
});

describe('releaseSandbox', () => {
  it('removes the worktree and leaves the branch', async () => {
    const subject = run();
    const prepared = await prepareSandbox({ run: subject, projectPath: root, git: gitService });
    const preparedRun = { ...subject, directory: prepared.directory, worktreeBranch: prepared.branch };
    expect(await releaseSandbox({ run: preparedRun, projectPath: root, git: gitService })).toEqual({ removed: true });
    await expect(fs.stat(prepared.directory)).rejects.toThrow();
    expect(execFileSync('git', ['branch', '--list', prepared.branch], { cwd: root }).toString()).toContain(prepared.branch);
  });

  it('does nothing for a run that has no worktree', async () => {
    expect(await releaseSandbox({ run: { ...run(), directory: root }, projectPath: root, git: gitService })).toEqual({ removed: false });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/web test -- server/lib/workflows/sandbox.test.js`
Expected: FAIL, `Failed to resolve import "./sandbox.js"`.

- [ ] **Step 3: Implement**

```js
// packages/web/server/lib/workflows/sandbox.js
/**
 * The sandbox a run executes in.
 *
 * `worktree` mode gives every run its own checkout and branch, so its steps
 * cannot touch the project working tree and a checkpoint commit lands somewhere
 * reviewable. The branch outlives the worktree: removing the worktree is tidy-up,
 * the merge is a person's decision.
 *
 * A git refusal is an error. A run never falls back to the project's working
 * tree, because a person who asked for isolation would be getting the opposite
 * while the screen said `worktree`.
 */
import path from 'node:path';

const WORKTREE_ROOT_SUFFIX = '-worktrees';

const branchFor = (run) => `omp/wf/${run.runId}`;

const directoryFor = (projectPath, run) => path.join(path.dirname(projectPath), `${path.basename(projectPath)}${WORKTREE_ROOT_SUFFIX}`, run.runId);

export const prepareSandbox = async ({ run, projectPath, git }) => {
  if (run.sandbox !== 'worktree') return { directory: projectPath, branch: null, created: false };
  if (run.worktreeBranch && run.directory && run.directory !== projectPath) {
    return { directory: run.directory, branch: run.worktreeBranch, created: false };
  }
  const branch = branchFor(run);
  const directory = directoryFor(projectPath, run);
  // `createWorktree` is the same call the worktree routes use; copy its input
  // keys from `packages/web/server/lib/git/routes.js` rather than inventing new
  // ones, and pass the branch name and the target directory it expects.
  await git.createWorktree(projectPath, { mode: 'new', branchName: branch, directory });
  return { directory, branch, created: true };
};

export const releaseSandbox = async ({ run, projectPath, git }) => {
  if (run.sandbox !== 'worktree' || !run.worktreeBranch || !run.directory || run.directory === projectPath) {
    return { removed: false };
  }
  await git.removeWorktree(projectPath, { directory: run.directory, deleteLocalBranch: false });
  return { removed: true };
};
```

Before writing the call, read the worktree creation handler in `packages/web/server/lib/git/routes.js` and use its exact input keys and its expected target-directory shape; the field names above are placeholders for that read, and the test in Step 1 is what proves the read was right.

- [ ] **Step 4: Prepare the sandbox from the engine**

In `engine.js`, at the top of `attemptStep`, after the definition is resolved:

```js
    if (run.sandbox === 'worktree' && (!run.worktreeBranch || run.directory === projectPath)) {
      try {
        const prepared = await prepareSandbox({ run, projectPath, git: gitForWorktrees });
        run.directory = prepared.directory;
        run.worktreeBranch = prepared.branch;
        await store.write(run);
      } catch (error) {
        step.status = 'blocked';
        step.note = `the run could not get its own worktree: ${error?.message ?? error}`;
        const saved = await store.write(run);
        emit(saved);
        return saved;
      }
    }
```

`gitForWorktrees` is a new engine dependency, passed by `runtime.js` as the git service. Do the block after `const step = findStep(run, stepId)` so the blocked reason lands on the step the person clicked.

- [ ] **Step 5: Run the engine and sandbox suites**

```bash
bun run --cwd packages/web test -- server/lib/workflows
```

Expected: PASS. The engine tests use `sandbox: 'working-tree'` runs, so they keep exercising the non-worktree path unchanged.

- [ ] **Step 6: Commit**

```bash
node --check packages/web/server/lib/workflows/sandbox.js
git add packages/web/server/lib/workflows/sandbox.js packages/web/server/lib/workflows/sandbox.test.js packages/web/server/lib/workflows/engine.js packages/web/server/lib/workflows/runtime.js
git commit -m "feat(workflows): give a run its own worktree"
```

---

### Task 3: Releasing the worktree

**Files:**
- Modify: `packages/web/server/lib/workflows/routes.js` + `routes.http.test.js`
- Modify: `packages/ui/src/lib/workflowsApi.ts` and the run detail screen (a release action on a finished run)

**Interfaces:**
- Consumes: Task 2's `releaseSandbox`, `engine.releaseSandbox({ projectId, runId })`.
- Produces: `POST /api/workflows/runs/:runId/sandbox/release -> { run }`, and the screen action `t('workflows.step.releaseWorktree')`.

- [ ] **Step 1: Write the failing route test**

```js
  it('refuses to release a worktree while the run is still going', async () => {
    const { app } = createApp({ store: { read: async () => ({ ...run, status: 'running', sandbox: 'worktree' }), list: async () => [], remove: async () => true, create: async (value) => value } });
    const response = await request(app).post('/api/workflows/runs/11111111-2222-4333-8444-555555555555/sandbox/release').set(SCOPE).send({});
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/still running/);
  });
```

- [ ] **Step 2: Implement the route and the engine method**

`engine.releaseSandbox` loads the run, refuses when its status is `running` or `waiting` (a person may still answer a step), calls `releaseSandbox`, records `worktreeReleasedAt` on the run, and writes it. The route mirrors the other run actions, and the screen shows the action only when the run is `done`, `failed` or `cancelled` and has a `worktreeBranch`.

- [ ] **Step 3: Run the suites**

```bash
bun run --cwd packages/web test -- server/lib/workflows/routes.http.test.js
bun run type-check:ui
```

- [ ] **Step 4: Commit**

```bash
git add packages/web/server/lib/workflows packages/ui/src
git commit -m "feat(workflows): release a run's worktree when the run is finished"
```

---

### Task 4: Measure the cost, then drive both modes

**Files:**
- Modify: `docs/agent-host/FUNCTION-STATUS.md` (what was observed, and the measurement)

- [ ] **Step 1: Measure a worktree's setup cost on a real project**

```bash
sh -c '
set -e
D=$(mktemp -d /tmp/wf-measure-XXXXXX)
cd "$D" && git init -q -b main && git config user.email a@b.c && git config user.name A
echo x > a.txt && git add . && git commit -q -m seed
git worktree add -q "$D-wt/one" -b omp/wf/measure >/dev/null
echo "worktree created in $(date +%s.%N) to now: done"
'
```

Record the wall-clock time of `git worktree add` here, and separately the time a step spends when it needs a dependency install in the fresh worktree (run one step in `worktree` mode whose verifier runs `bun install --frozen-lockfile`, if the project uses Bun). Report both numbers. If the dependency install dominates, change the default to `working-tree` in the definition parser and say so in the spec, because the default has to earn its cost.

- [ ] **Step 2: Drive both modes on a real server**

With the fixture project: one run whose definition says `worktree` and one whose definition says `working-tree`. Observed for each: the run's `directory` (the worktree path, or the project path), that a checkpoint commit lands on the run's branch in worktree mode and on the checked-out branch in working-tree mode, and that the project's working tree is untouched while the worktree run is in flight (`git status` clean apart from the person's own changes).

- [ ] **Step 3: Report and commit**

```bash
git add docs/agent-host/FUNCTION-STATUS.md
git commit -m "docs(workflows): record the worktree sandbox evidence"
```
