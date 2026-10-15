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
- Focused test command: `bun run --cwd packages/web test -- server/lib/workflows/<file>.test.js`. That is the package's own runner (`vitest run`); `bun test` is **not** the server runner — it hangs `commands.test.js` past its 5s per-test timeout and reports a failure vitest does not have. Syntax check: `node --check <file>`.
- `store.write` takes the project as well as the run: `store.write(projectId, run)`. The one-argument form this plan was first written with no longer exists.
- The worktree service is loaded lazily, the way `packages/web/server/lib/git/routes.js:11-19` does it (`await import('./index.js')` on first use). `packages/web/server/lib/git/service.js` is 6000 lines and must not be pulled in at server boot; the engine takes the worktree functions as an injected dependency so tests can pass a fake.
- `AGENTS.md` forbids git commands unless the maintainer asked. The maintainer asked for this plan to be executed, so the commit steps below are the only git commands an executor runs. Tests that need a repository create their own temporary one, the way `packages/web/server/lib/git/service.test.js:1-45` does.

## Review Focus

1. A repository that is not a git repo, or a worktree path that already exists, must block the run with the git message rather than running steps in the project's working tree. Owner: Task 2.
2. Two runs of the same project must not collide on one branch or one worktree path. Owner: Task 2.
3. A definition that says `worktree` on a project with uncommitted changes must not move or lose those changes. Owner: Task 2.
4. Measured cost: a worktree that needs a fresh dependency install is slow, and the default ships only with a number attached. Owner: Task 4.
5. A step's session is created with the worktree as its `cwd`, which is what makes the isolation real — and it means the chat banner, which resolves a project from the session's directory, will not find the run for a `worktree` step. That is the same class as the open banner item plan 2 handed over; record it in Task 4's evidence rather than papering over it here. Owner: Task 4.
6. The mirror of focus 3 for `working-tree`: because the checkpoint commit stages everything dirty, a run in that mode commits the person's own uncommitted and untracked files too, on their checked-out branch, and afterwards `git status` reads clean — so nothing tells them their work was committed under the run's message. Record both consequences in Task 4's evidence, and note that refusing or warning on a dirty checkout is an open decision for the maintainer (not implemented). Owner: Task 4.

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

Add `'sandbox'` to `DEFINITION_FIELDS` (`packages/web/server/lib/workflows/definitions.js:13`), reject anything other than the two values with exactly `{ field: 'sandbox', message: 'must be "worktree" or "working-tree"' }`, and return `sandbox: raw.sandbox === 'working-tree' ? 'working-tree' : 'worktree'` in the definition.

In the create-run route, replace the hardcoded `sandbox: 'working-tree'` (`packages/web/server/lib/workflows/routes.js:157`) with `sandbox: definition.sandbox`. That single line is what makes the default real: every run records the mode it is using, so an old run keeps reading the way it ran.

In `packages/ui/src/lib/workflowsApi.ts`, add `sandbox: 'worktree' | 'working-tree'` to `WorkflowDefinitionSummary`, and tighten `WorkflowRun.sandbox` from `string` (`:86`) to the same union so the screen cannot compare against a mode that does not exist.

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
- Consumes: `createWorktree`, `removeWorktree`, `getWorktreeBootstrapStatus` from `packages/web/server/lib/git/service.js`.
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
const branchFor = (run) => `omp/wf/${run.runId}`;
const nameFor = (run) => `wf-${run.runId}`;

// `createWorktree` attaches the checkout with `git worktree add --no-checkout`
// and populates it in a queued task (`service.js:1913`), so it returns while the
// directory is still empty. A run whose first step started then would read an
// empty tree, so the sandbox waits for the checkout to be there first — the same
// wait a session opened on a worktree does. `setup-ready` is not required: that
// phase is the project's own setup script, which may be a long dependency
// install and is not what makes the checkout real.
const BOOTSTRAP_TIMEOUT_MS = 60_000;
const BOOTSTRAP_POLL_MS = 150;
// The deadline and the poll are parameters so a test can prove the timeout
// branch without spending the real minute; the defaults are what a run gets.
const waitForCheckout = async (directory, git, { timeoutMs = BOOTSTRAP_TIMEOUT_MS, pollMs = BOOTSTRAP_POLL_MS } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await git.getWorktreeBootstrapStatus(directory);
    if (status?.status === 'failed') throw new Error(`the worktree could not be prepared: ${status.error || 'unknown error'}`);
    if (status?.status === 'ready' || status?.phase === 'git-ready' || status?.phase === 'setup-ready') return;
    if (Date.now() >= deadline) throw new Error('timed out waiting for the worktree checkout');
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
};

export const prepareSandbox = async ({ run, projectPath, git, waitOptions = {} }) => {
  if (run.sandbox !== 'worktree') return { directory: projectPath, branch: null, created: false };
  if (run.worktreeBranch && run.directory && run.directory !== projectPath) {
    return { directory: run.directory, branch: run.worktreeBranch, created: false };
  }
  // `createWorktree(projectPath, input)` decides the directory itself, under the
  // app's worktree root, from the name it is handed: it takes no target path
  // (`packages/web/server/lib/git/service.js:4967`, `resolveCandidateDirectory`).
  // The `path` it returns is the run's directory from here on.
  const created = await git.createWorktree(projectPath, { mode: 'new', worktreeName: nameFor(run), branchName: branchFor(run) });
  const directory = created?.path;
  if (!directory) throw new Error('the worktree was created without a directory');
  try {
    await waitForCheckout(directory, git, waitOptions);
  } catch (error) {
    // A checkout that never finished preparing is not a sandbox. The run has
    // recorded neither its directory nor its branch, so nothing would ever
    // release them, and the branch name alone (`omp/wf/<runId>`) would refuse
    // every later attempt with `Branch already exists`. Tear the checkout down
    // here, branch included, and let the original failure be what the person
    // sees: a release that fails is recoverable by hand, the prepare error is
    // what explains the run.
    try {
      await git.removeWorktree(projectPath, { directory, deleteLocalBranch: true });
    } catch {
      // Deliberately swallowed so the prepare error is the one that surfaces.
    }
    throw error;
  }
  return { directory, branch: created.branch ?? branchFor(run), created: true };
};

export const releaseSandbox = async ({ run, projectPath, git }) => {
  if (run.sandbox !== 'worktree' || !run.worktreeBranch || !run.directory || run.directory === projectPath) {
    return { removed: false };
  }
  // `removeWorktree(projectPath, { directory })`: the first argument is the
  // project the worktree belongs to, the second names the checkout to remove
  // (`service.js:5118`). The branch is deliberately left behind.
  await git.removeWorktree(projectPath, { directory: run.directory, deleteLocalBranch: false });
  return { removed: true };
};
```

The Step 1 test must release every worktree it creates, not only the ones in the release cases: the service puts them under the app's own worktree root (outside the temp project), so a test that leaves them behind litters a directory the suite does not own. Add a `releaseSandbox` call to the "different directory for every run" case, and after `afterAll` nothing may remain under that root.

A refusal is a rejection: `createWorktree` throws when the directory is not a repository (through `resolveWorktreeProjectContext`) and when the worktree cannot be attached, which is what the Step 1 test's last case pins.

- [ ] **Step 4: Prepare the sandbox from the engine**

In `engine.js`, in `attemptStep`, after `const step = assertStepIsOpen(findStep(run, stepId));` (`engine.js:137`):

```js
    // A run in `worktree` mode executes in its own checkout from its first step
    // on. A refusal blocks the step instead of falling back: running in the
    // project's working tree while the run says `worktree` is the opposite of
    // what the person asked for, and they would only learn it from the diff.
    if (run.sandbox === 'worktree' && (!run.worktreeBranch || run.directory === projectPath)) {
      try {
        const prepared = await prepareSandbox({ run, projectPath, git: worktrees });
        run.directory = prepared.directory;
        run.worktreeBranch = prepared.branch;
        emit(await store.write(projectId, run));
      } catch (error) {
        step.status = 'blocked';
        step.note = `the run could not get its own worktree: ${error?.message ?? error}`;
        run.status = 'waiting';
        const saved = await store.write(projectId, run);
        emit(saved);
        return saved;
      }
    }
```

Then make `run.directory` the single place the execution path is read. The `projectPath` argument is the project the run was created from, and it stops being where the run executes the moment a worktree exists. Three call sites move: `createSession({ cwd: run.directory })` (`:151`), `setAutoAccept(sessionId, true, run.directory)` (`:162`), and `runPromptInSession`'s `projectPath` parameter, which exists only for auto-accept (`:185`) — drop the parameter from `runPromptInSession` and from its two callers (`:169`, `:357`) and read `run.directory` inside. Verifiers and checkpoints already read `run.directory` (`:244`, `:264`, `:369`), so no other line moves.

`worktrees` is a new engine dependency, injected by `runtime.js` as a lazy loader so the 6000-line git service is not imported at server boot:

```js
  // runtime.js, beside the engine's other dependencies
  worktrees: {
    createWorktree: async (...args) => (await import('../git/index.js')).createWorktree(...args),
    removeWorktree: async (...args) => (await import('../git/index.js')).removeWorktree(...args),
    getWorktreeBootstrapStatus: async (...args) => (await import('../git/index.js')).getWorktreeBootstrapStatus(...args),
  },
```

Tests inject a fake instead. The engine and resume fixtures already carry `sandbox: 'working-tree'` (`engine.test.js:52`, `resume.test.js:23`), because plan 1 mirrored the run shape the create route wrote, so they keep exercising the non-worktree path unchanged. A new engine case for the worktree path needs its own fixture with `sandbox: 'worktree'` and the injected fake.

- [ ] **Step 5: Run the engine and sandbox suites**

```bash
bun run --cwd packages/web test -- server/lib/workflows
```

Expected: PASS. The engine and resume fixtures already carry `sandbox: 'working-tree'`, so they keep exercising the non-worktree path unchanged; `sandbox.test.js` is the only place that drives the real worktree service.

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

`engine.releaseSandbox` loads the run (`loadRun(projectId, runId)`), refuses when its status is `running` or `waiting` — a person may still answer a step — calls `releaseSandbox`, records `worktreeReleasedAt` on the run and writes it with `store.write(projectId, run)`.

The route follows the existing action family exactly (`routes.js:191-234`): `app.post('/api/workflows/runs/:runId/sandbox/release', parseJsonBody, withProject(...))`, with `runIdOf(req, res)` first and `engine.releaseSandbox({ projectId, projectPath, runId })` as the body. It inherits the `no-store` middleware and the project scope from that family; do not add a second scope resolver.

On the client: `releaseWorkflowSandbox(directory, runId)` in `packages/ui/src/lib/workflowsApi.ts` next to the other run actions, a store action that replaces the run with the answer, and the control in `packages/ui/src/components/views/workflows/RunDetail.tsx` — shown only when the run is `done`, `failed` or `cancelled` **and** `run.worktreeBranch` is set, labelled `t('workflows.step.releaseWorktree')`. Every new key goes into all thirteen dictionaries (`packages/ui/src/lib/i18n/messages/*.ts`); `messages.test.ts` is what proves parity.

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
D=$(mktemp -d /tmp/wf-measure-XXXXXX)
cd "$D" && git init -q -b main && git config user.email a@b.c && git config user.name A
echo x > a.txt && git add . && git commit -q -m seed
for i in 1 2 3; do
  /usr/bin/time -p git worktree add -q "$D-wt/$i" -b "omp/wf/measure-$i" 2>&1 | grep real
done
```

Record the wall-clock time of `git worktree add` (three runs, report the range), and separately the time the app's own path takes — `createWorktree` plus the bootstrap wait `prepareSandbox` performs — because that is the number a person waits for before the first step starts. Then, on a project that needs one, the time a step spends installing dependencies in the fresh checkout (a project with a lockfile, `bun install --frozen-lockfile` in its verifier). Report both numbers. If the dependency install dominates the time to first output, say so plainly in the evidence and recommend the default change; changing it is the maintainer's decision, so record it rather than making it in this task.

- [ ] **Step 2: Drive both modes on a real server**

With the fixture project: one run whose definition says `worktree` and one whose definition says `working-tree`. Observed for each: the run's `directory` (the worktree path, or the project path), that a checkpoint commit lands on the run's branch in worktree mode and on the checked-out branch in working-tree mode, and that the project's working tree is untouched while the worktree run is in flight (`git status` clean apart from the person's own changes).

- [ ] **Step 3: Report and commit**

```bash
git add docs/agent-host/FUNCTION-STATUS.md
git commit -m "docs(workflows): record the worktree sandbox evidence"
```
