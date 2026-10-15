# Workflow screens (P3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the workflow engine screens: a rail surface listing runs, a run detail with the step sequence and live status, a step pane with the evidence a person needs to confirm or continue, and a chat banner for a session that belongs to a step.

**Architecture:** Shared UI only, in `packages/ui`. One new client (`lib/workflowsApi.ts`) talks to `/api/workflows/*` through `runtimeFetch`; one store (`stores/useWorkflowStore.ts`) caches runs per project and applies `openchamber:workflow` frames pushed by the server; screens live in `components/views/workflows/` and are reached through the existing context rail registry. No server code changes.

**Tech Stack:** React 19, TypeScript, zustand, zod, `runtimeFetch`, Tailwind with the project's theme tokens, `beautiful-mermaid` (already a dependency).

**Spec:** `docs/superpowers/specs/2026-10-14-sdlc-workflow-design.md` (P3)
**Engine plan:** `docs/superpowers/plans/2026-10-14-p1-workflow-engine.md`

## Global Constraints

- Load these project skills before editing: `theme-system`, `locale-ui-patterns`, `ui-api-decoupling`, `sync-state-invariants`. They own tokens, copy, data access, and store rules.
- No new dependencies. `beautiful-mermaid`, `zustand`, `zod` and the `components/ui` primitives are already there.
- Every user-facing string goes through `useI18n()` and lands in all 13 locales under `packages/ui/src/lib/i18n/messages/`: de, en, es, fr, ja, ko, nl, pl, pt-BR, tr, uk, zh-CN, zh-TW. English is the source.
- No raw colors. Status colors come from theme tokens, so light and dark both read.
- HTTP goes through `runtimeFetch` from `@/lib/runtime-fetch`, with the project directory passed as `directory` (it becomes the `x-opencode-directory` header the routes scope by). No `fetch` calls to OpenChamber routes.
- A failed read is an error on screen, never an empty list. `lib/projectContextApi.ts:1-16` states the rule this repo holds to: "An authoritative read must never resolve to an empty value that a caller could mistake for 'the project has nothing'."
- The UI package's tests are **`bun:test`** files run by `bun test <file>` (538 files under `packages/ui/src` import `bun:test`; none import vitest). `mock.module(...)` is the package's own way to replace a module (`stores/messageQueueStore.test.ts:6`), and it is available. `packages/web`'s server tests are vitest and stay vitest; the two runners do not mix inside one package.
- Focused test command for a UI file: `bun test src/<path>.test.ts` from `packages/ui` (or `bun test packages/ui/src/<path>.test.ts` from the repository root). Type check: `bun run type-check:ui`. Run `bunx oxlint <changed-paths>` once at the end.
- Do not modify `packages/web` in this plan, with one exception: Task 0 extends the definitions route to return each definition's declared steps, because the definition diagram cannot be drawn without them. Any other server change is out of scope: stop and report it instead.
- `AGENTS.md` forbids git commands unless the maintainer asked. The maintainer asked for this plan to be executed, so the commit steps below are the only git commands an executor runs.

## Review Focus

Failure modes the spec implies that no single task's tests otherwise pin, each with the owning task:

1. A server that cannot be reached must show an error, not "no runs yet". A person who sees an empty list concludes their runs are gone. Owner: Task 1, Task 4.
2. A frame that arrived before the store loaded must not be overwritten by a slower load. Owner: Task 2.
3. `blocked` (waiting on a person: a tool approval, a model refusal) must look different from `failed` and must show its reason, because one needs an action and the other needs a fix. Owner: Task 5, Task 6.
4. The confirm button must be disabled while a request is in flight, and a refused confirm must show the server's own words (a failing verifier) rather than a generic message. Owner: Task 7.
5. A step's status must be legible without color alone: an icon or label carries the same meaning for a person who cannot separate the hues. Owner: Task 5.

---

## File Structure

```
packages/web/server/lib/workflows/routes.js         definitions carry their steps   Task 0
packages/web/server/lib/workflows/routes.http.test.js
packages/ui/src/
  lib/workflowsApi.ts                            client for /api/workflows/*      Task 1
  lib/workflowsApi.test.ts
  lib/workflows/status.ts                        status -> label, icon, tone     Task 5
  lib/workflows/status.test.ts
  stores/useWorkflowStore.ts                     runs per project + frames       Task 2
  stores/useWorkflowStore.test.ts
  lib/openchamberEvents.ts                       add the openchamber:workflow frame  Task 2
  lib/surfaces/registry.ts                       add the workflows surface       Task 3
  lib/surfaces/modes.ts                          add the mode                    Task 3
  components/layout/ContextPanel.tsx             render the screen for the mode  Task 3
  components/views/workflows/WorkflowsView.tsx   the surface: list + detail      Task 4, 5
  components/views/workflows/RunList.tsx         runs of the project             Task 4
  components/views/workflows/RunDetail.tsx       timeline + step pane            Task 5
  components/views/workflows/StepPane.tsx        evidence and actions            Task 6, 7
  components/views/workflows/WorkflowDiagram.tsx definition diagram              Task 9
  components/chat/WorkflowStepBanner.tsx         banner for a step session       Task 8
  lib/i18n/messages/*.ts                         13 locale files                 Task 3
```

---

### Task 0: The definitions route answers the declared steps

**Files:**
- Modify: `packages/web/server/lib/workflows/routes.js` (the `summary` helper)
- Modify: `packages/web/server/lib/workflows/routes.http.test.js` (one assertion)
- Modify: `packages/ui/src/lib/workflowsApi.ts` (`WorkflowDefinitionSummary`)

**Interfaces:**
- Consumes: the engine plan's Task 1 and Task 11.
- Produces: `WorkflowDefinitionSummary` gains `steps: WorkflowStepDefinition[]` and `inputs: WorkflowInput[]`, which Task 9's diagram and Task 4's start action need. This task also creates `packages/ui/src/lib/workflowsApi.ts` with the wire types every later task imports (the route's shapes and the client's types mirror each other, so they land together); Task 1 extends that file with the client functions rather than replacing it.

- [ ] **Step 1: Extend the summary in the route**

```js
const summary = (entry) => ({
  file: entry.file,
  id: entry.id,
  name: entry.name,
  version: entry.version,
  errors: entry.errors,
  // The diagram needs the declared steps; a summary without them would force the
  // screen to re-read every file separately.
  steps: entry.definition ? entry.definition.steps : [],
  // The create route rejects a missing required input, so a screen that offers
  // to start a run has to know what to ask for.
  inputs: entry.definition ? entry.definition.inputs : [],
});
```

- [ ] **Step 2: Assert it in the route test**

In the `lists definitions for a project directory` case, the fixture's `definition` is `null`, so add a second case:

```js
  it('returns the declared steps of a valid definition', async () => {
    const { app } = createApp({
      definitions: {
        list: async () => [{
          file: 'a.yaml', id: 'a', name: 'A', version: 1, errors: [],
          definition: { id: 'a', name: 'A', version: 1, inputs: [], steps: [{ id: 'first', title: 'First', prompt: 'x', session: 'new', permissions: 'ask', verify: { artifacts: [], commands: [] }, confirm: 'human' }] },
        }],
        read: async () => null,
      },
    });
    const response = await request(app).get('/api/workflows/definitions').set(SCOPE);
    expect(response.body.definitions[0].steps.map((step) => step.id)).toEqual(['first']);
  });
```

- [ ] **Step 3: Create the wire types in the UI**

Write `packages/ui/src/lib/workflowsApi.ts` with the type block from Task 1's Step 3 (the status unions, the run, step, attempt, checkpoint, verify and definition shapes), plus `steps: WorkflowStepDefinition[]` on `WorkflowDefinitionSummary`. No functions yet: Task 1 adds those to this same file, so do not write a client here and do not expect one to exist.

- [ ] **Step 4: Run both suites**

```bash
bun run --cwd packages/web test -- server/lib/workflows/routes.http.test.js
bun run type-check:ui
```

Expected: the route suite passes with 9 tests, and the UI type check has no error from the new field.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/workflows/routes.js packages/web/server/lib/workflows/routes.http.test.js packages/ui/src/lib/workflowsApi.ts
git commit -m "feat(workflows): return the declared steps with a definition"
```

---

### Task 1: API client and types

**Files:**
- Create: `packages/ui/src/lib/workflowsApi.ts`
- Test: `packages/ui/src/lib/workflowsApi.test.ts`

**Interfaces:**
- Consumes: `runtimeFetch` (`@/lib/runtime-fetch`), `createProjectIdFromPath` (`@/lib/projectId`), the routes from the engine plan, and the wire types Task 0 already wrote into `packages/ui/src/lib/workflowsApi.ts`.
- Produces: functions
  `fetchWorkflowDefinitions(directory)`, `fetchWorkflowRuns(directory)`, `fetchWorkflowRun(directory, runId)`, `createWorkflowRun(directory, { workflowId, inputs })`, `runWorkflow(directory, runId)`, `cancelWorkflowRun(directory, runId)`, `runWorkflowStep(directory, runId, stepId)`, `verifyWorkflowStep(directory, runId, stepId)`, `promptWorkflowStep(directory, runId, stepId, text)`, `confirmWorkflowStep(directory, runId, stepId, decision, reason?)`, `deleteWorkflowRun(directory, runId)`.
- Also produces: `WorkflowRequestError` carrying the server's message and status.

- [ ] **Step 1: Write the failing test**

The UI suite never mocks a module (`vi.mock(` appears zero times under `packages/ui/src`, and the vendored `anti-slop` lint rejects module mocking). It stubs `globalThis.fetch` and restores it, as `lib/fileReferenceStat.test.ts` does. That is also the stronger test here: it pins the request that actually leaves the process, including the `x-opencode-directory` header the routes are scoped by, which a module mock of `runtimeFetch` could not see.

```ts
// packages/ui/src/lib/workflowsApi.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { confirmWorkflowStep, createWorkflowRun, fetchWorkflowRun, fetchWorkflowRuns, WorkflowRequestError } from './workflowsApi';

const originalFetch = globalThis.fetch;
let calls: Array<{ url: string; init: RequestInit }> = [];
let responses: Array<{ status: number; body: unknown }> = [];

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  responses = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift() ?? { status: 200, body: {} };
    return jsonResponse(next.body, next.status);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const headersOf = (index: number) => new Headers(calls[index].init.headers);

describe('fetchWorkflowRuns', () => {
  it('sends the directory the routes scope by', async () => {
    responses = [{ status: 200, body: { runs: [] } }];
    await fetchWorkflowRuns('/Users/me/project');
    expect(calls[0].url).toContain('/api/workflows/runs');
    expect(headersOf(0).get('x-opencode-directory')).toBe('/Users/me/project');
  });

  it('throws on a failed read instead of answering an empty list', async () => {
    responses = [{ status: 503, body: { error: 'the server is starting' } }];
    await expect(fetchWorkflowRuns('/Users/me/project')).rejects.toThrow(/the server is starting/);
  });
});

describe('fetchWorkflowRun', () => {
  it('reads the run out of the envelope', async () => {
    responses = [{ status: 200, body: { run: { runId: 'r1', steps: [] } } }];
    expect(await fetchWorkflowRun('/Users/me/project', 'r1')).toMatchObject({ runId: 'r1' });
  });

  it('carries the server message and status on the error', async () => {
    responses = [{ status: 404, body: { error: 'run r1 was not found' } }];
    await expect(fetchWorkflowRun('/Users/me/project', 'r1')).rejects.toMatchObject({
      name: 'WorkflowRequestError',
      status: 404,
      message: 'run r1 was not found',
    });
    expect(new WorkflowRequestError('x', 500)).toBeInstanceOf(Error);
  });
});

describe('createWorkflowRun', () => {
  it('posts the workflow and its input values', async () => {
    responses = [{ status: 201, body: { run: { runId: 'r1', steps: [] } } }];
    await createWorkflowRun('/Users/me/project', { workflowId: 'a', inputs: { request: 'x' } });
    expect(calls[0].url).toContain('/api/workflows/runs');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ workflowId: 'a', inputs: { request: 'x' } });
  });
});

describe('confirmWorkflowStep', () => {
  it('sends the decision and the reason', async () => {
    responses = [{ status: 200, body: { run: { runId: 'r1', steps: [] } } }];
    await confirmWorkflowStep('/Users/me/project', 'r1', 'spec', 'not_done', 'the spec is thin');
    expect(calls[0].url).toContain('/api/workflows/runs/r1/steps/spec/confirm');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ decision: 'not_done', reason: 'the spec is thin' });
  });

  it('leaves the reason out when there is none', async () => {
    responses = [{ status: 200, body: { run: { runId: 'r1', steps: [] } } }];
    await confirmWorkflowStep('/Users/me/project', 'r1', 'spec', 'done');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ decision: 'done' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd packages/ui test -- src/lib/workflowsApi.test.ts`
Expected: FAIL, `Failed to resolve import "./workflowsApi"`.

- [ ] **Step 3: Add the client to the file Task 0 created**

Extend `packages/ui/src/lib/workflowsApi.ts` — it already holds the wire types, including `WorkflowDefinitionSummary.steps`. Add the error class and the functions below it, and keep every existing type exactly as it is: the types are the route's contract and Task 0 pinned them.

```ts
/**
 * Client for the workflow routes.
 *
 * The server owns run state; this module only speaks HTTP. Every function
 * throws on failure, because a caller that rendered "no runs" after a failed
 * read would be telling the person their runs are gone.
 */
import { runtimeFetch } from '@/lib/runtime-fetch';

export class WorkflowRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'WorkflowRequestError';
    this.status = status;
  }
}

export type WorkflowStepStatus =
  | 'pending' | 'running' | 'waiting_confirm' | 'needs_work' | 'done' | 'failed' | 'skipped' | 'blocked' | 'interrupted';

export type WorkflowRunStatus = 'idle' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';

export type WorkflowConfirmDecision = 'done' | 'not_done' | 'skip';

export interface WorkflowVerifyCommandResult {
  run: string;
  expectExit: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when either stream was cut at the engine's 64 KiB cap. */
  truncated: boolean;
  durationMs: number;
  ok: boolean;
}

export interface WorkflowVerifyArtifactResult {
  glob: string;
  path: string | null;
  exists: boolean;
  size: number | null;
  sha256: string | null;
}

export interface WorkflowVerifyResult {
  ok: boolean;
  artifacts: WorkflowVerifyArtifactResult[];
  commands: WorkflowVerifyCommandResult[];
  /** Present when the artifact inspection itself failed; every pattern then reads unmatched. */
  error?: string;
}

export interface WorkflowCheckpoint {
  at: number;
  commit: string;
  clean: boolean;
  artifacts: Array<{ path: string; size: number; sha256: string | null }>;
}

export interface WorkflowAttempt {
  index: number;
  sessionId: string | null;
  prompt: string;
  startedAt: number;
  endedAt: number | null;
  status: 'running' | 'completed' | 'failed' | 'blocked' | 'interrupted';
  turn: null | { outcome?: string };
  verify: WorkflowVerifyResult | null;
  error: null | { code: string; message: string };
}

export interface WorkflowStep {
  id: string;
  status: WorkflowStepStatus;
  attempts: WorkflowAttempt[];
  checkpoint: WorkflowCheckpoint | null;
  note: string | null;
}

export interface WorkflowRun {
  runId: string;
  projectId: string;
  directory: string;
  workflowId: string;
  workflowVersion: number;
  workflowHash: string;
  inputs: Record<string, string>;
  status: WorkflowRunStatus;
  cursor: string | null;
  createdAt: number;
  updatedAt: number;
  sandbox: string;
  steps: WorkflowStep[];
}

export interface WorkflowStepDefinition {
  id: string;
  title: string;
  prompt: string;
  session: 'new' | 'reuse';
  permissions: 'ask' | 'auto';
  verify: { artifacts: Array<{ glob: string; hash: boolean }>; commands: Array<{ run: string; expectExit: number; timeoutMs: number }> };
  confirm: 'human' | 'auto';
}

export interface WorkflowInput {
  name: string;
  description: string;
  required: boolean;
}

export interface WorkflowDefinitionSummary {
  file: string;
  id: string | null;
  name: string | null;
  version: number | null;
  errors: Array<{ field: string; message: string }>;
  /** The declared steps, for the definition diagram. */
  steps: WorkflowStepDefinition[];
  /** The declared inputs, so a screen can ask for the values the create route requires. */
  inputs: WorkflowInput[];
}

/**
 * Every route is scoped by the `x-opencode-directory` header, and `runtimeFetch`'s
 * `directory` option is NOT that header: it only decides which isolated space a
 * request belongs to (`lib/runtime-fetch.ts:111-121`). The header has to be set
 * here, the way the other scoped clients do it
 * (`lib/contextFileOpenGuard.ts:58`, `lib/guests/files.ts:87`). `runtimeFetch`
 * percent-encodes the value and adds `x-opencode-directory-encoding: uri` when the
 * path is not Latin-1-safe, which is exactly what the routes decode for.
 */
const request = async <T>(path: string, directory: string, init: RequestInit = {}): Promise<T> => {
  const response = await runtimeFetch(path, {
    ...init,
    headers: { 'x-opencode-directory': directory, ...(init.headers ?? {}) },
  });
  const body = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) {
    throw new WorkflowRequestError(body?.error ?? `The request failed with ${response.status}`, response.status);
  }
  if (!body) throw new WorkflowRequestError('The server answered with no body', response.status);
  return body;
};

const post = <T>(path: string, directory: string, payload?: unknown) => request<T>(path, directory, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload ?? {}),
});

export const fetchWorkflowDefinitions = async (directory: string): Promise<WorkflowDefinitionSummary[]> =>
  (await request<{ definitions: WorkflowDefinitionSummary[] }>('/api/workflows/definitions', directory)).definitions;

export const fetchWorkflowRuns = async (directory: string): Promise<WorkflowRun[]> =>
  (await request<{ runs: WorkflowRun[] }>('/api/workflows/runs', directory)).runs;

export const fetchWorkflowRun = async (directory: string, runId: string): Promise<WorkflowRun> =>
  (await request<{ run: WorkflowRun }>(`/api/workflows/runs/${encodeURIComponent(runId)}`, directory)).run;

export const createWorkflowRun = async (directory: string, value: { workflowId: string; inputs?: Record<string, string> }): Promise<WorkflowRun> =>
  (await post<{ run: WorkflowRun }>('/api/workflows/runs', directory, value)).run;

export const runWorkflow = async (directory: string, runId: string): Promise<WorkflowRun> =>
  (await post<{ run: WorkflowRun }>(`/api/workflows/runs/${encodeURIComponent(runId)}/run`, directory)).run;

export const cancelWorkflowRun = async (directory: string, runId: string): Promise<WorkflowRun> =>
  (await post<{ run: WorkflowRun }>(`/api/workflows/runs/${encodeURIComponent(runId)}/cancel`, directory)).run;

export const runWorkflowStep = async (directory: string, runId: string, stepId: string): Promise<WorkflowRun> =>
  (await post<{ run: WorkflowRun }>(`/api/workflows/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/run`, directory)).run;

export const verifyWorkflowStep = async (directory: string, runId: string, stepId: string): Promise<WorkflowRun> =>
  (await post<{ run: WorkflowRun }>(`/api/workflows/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/verify`, directory)).run;

export const promptWorkflowStep = async (directory: string, runId: string, stepId: string, text: string): Promise<WorkflowRun> =>
  (await post<{ run: WorkflowRun }>(`/api/workflows/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/prompt`, directory, { text })).run;

export const confirmWorkflowStep = async (
  directory: string,
  runId: string,
  stepId: string,
  decision: WorkflowConfirmDecision,
  reason?: string,
): Promise<WorkflowRun> =>
  (await post<{ run: WorkflowRun }>(
    `/api/workflows/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/confirm`,
    directory,
    reason === undefined ? { decision } : { decision, reason },
  )).run;

export const deleteWorkflowRun = async (directory: string, runId: string): Promise<void> => {
  await request<{ removed: boolean }>(`/api/workflows/runs/${encodeURIComponent(runId)}`, directory, { method: 'DELETE' });
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run --cwd packages/ui test -- src/lib/workflowsApi.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Type check and commit**

```bash
bun run type-check:ui
git add packages/ui/src/lib/workflowsApi.ts packages/ui/src/lib/workflowsApi.test.ts
git commit -m "feat(workflows): client for the workflow routes"
```

---

### Task 2: Store and live frames

**Files:**
- Create: `packages/ui/src/stores/useWorkflowStore.ts`
- Test: `packages/ui/src/stores/useWorkflowStore.test.ts`
- Modify: `packages/ui/src/lib/openchamberEvents.ts` (add the frame type and the branch). This is the control-stream listener that already carries `openchamber:scheduled-task-ran`; `packages/ui/src/sync/event-pipeline.ts` is a different path (the agent-runtime bridge) and must not be edited for this frame.

**Interfaces:**
- Consumes: Task 1's client, `subscribeOpenchamberEvents` (`@/lib/openchamberEvents:524`), the frame `openchamber:workflow` the engine broadcasts.
- Produces: `useWorkflowStore` with `{ entries: Record<projectKey, Entry>, getEntry(projectRef), load(projectRef, { force? }), applyRunFrame(frame), setRun(projectRef, run), removeRun(projectRef, runId) }` and `Entry = { runs, definitions, loaded, loading, error }`; plus `subscribeWorkflowFrames()` returning an unsubscribe.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/stores/useWorkflowStore.test.ts
import { beforeEach, describe, expect, it, mock } from 'bun:test';

/**
 * The client is replaced through `mock.module`, the way the stores' own tests do
 * it (`stores/messageQueueStore.test.ts:6`). Each queue holds the answers for the
 * next calls, so a test can hand back data, an error, or a promise it releases
 * later.
 */
const runsQueue: Array<() => unknown> = [];
const definitionsQueue: Array<() => unknown> = [];
const take = async (queue: Array<() => unknown>) => {
  const next = queue.shift();
  return next ? await next() : [];
};

mock.module('@/lib/workflowsApi', () => ({
  fetchWorkflowRuns: () => take(runsQueue),
  fetchWorkflowDefinitions: () => take(definitionsQueue),
}));

const { useWorkflowStore } = await import('./useWorkflowStore');

const project = { id: 'path_proj', path: '/Users/me/project', name: 'project' };
const run = (overrides: Record<string, unknown> = {}) => ({
  runId: 'r1',
  projectId: 'path_proj',
  directory: '/Users/me/project',
  workflowId: 'sdlc',
  status: 'idle',
  cursor: 'spec',
  createdAt: 1,
  updatedAt: 1,
  steps: [{ id: 'spec', status: 'pending', attempts: [], checkpoint: null, note: null }],
  ...overrides,
});

beforeEach(() => {
  runsQueue.length = 0;
  definitionsQueue.length = 0;
  useWorkflowStore.setState({ entries: {}, pendingFrames: {} });
});

describe('load', () => {
  it('keeps the error and the cached runs when the read fails', async () => {
    runsQueue.push(() => [run()]);
    definitionsQueue.push(() => []);
    await useWorkflowStore.getState().load(project);
    expect(useWorkflowStore.getState().getEntry(project).runs).toHaveLength(1);

    runsQueue.push(() => { throw new Error('the server is starting'); });
    definitionsQueue.push(() => { throw new Error('the server is starting'); });
    await useWorkflowStore.getState().load(project, { force: true });
    const entry = useWorkflowStore.getState().getEntry(project);
    expect(entry.error).toContain('the server is starting');
    expect(entry.runs).toHaveLength(1);
    expect(entry.loaded).toBe(true);
  });

  it('does not let a slow load overwrite a frame that arrived first', async () => {
    let release = () => {};
    const pending = new Promise((resolve) => { release = resolve; });
    runsQueue.push(() => pending);
    definitionsQueue.push(() => []);
    const loading = useWorkflowStore.getState().load(project);

    useWorkflowStore.getState().applyRunFrame({ runId: 'r1', projectId: 'path_proj', status: 'waiting', cursor: 'spec', steps: [{ id: 'spec', status: 'waiting_confirm' }] });
    release([run()]);
    await loading;

    const entry = useWorkflowStore.getState().getEntry(project);
    expect(entry.runs[0].status).toBe('waiting');
    expect(entry.runs[0].steps[0].status).toBe('waiting_confirm');
  });
});

describe('applyRunFrame', () => {
  it('ignores a frame for a project this store has not loaded', () => {
    useWorkflowStore.getState().applyRunFrame({ runId: 'r9', projectId: 'other', status: 'running', cursor: null, steps: [] });
    expect(useWorkflowStore.getState().entries).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd packages/ui test -- src/stores/useWorkflowStore.test.ts`
Expected: FAIL, `Failed to resolve import "./useWorkflowStore"`.

- [ ] **Step 3: Write the store**

```ts
// packages/ui/src/stores/useWorkflowStore.ts
/**
 * Workflow runs and definitions, cached per project.
 *
 * The server owns the truth. This store holds a cache, applies the live frames
 * the server pushes, and keeps the last good data when a read fails: an error is
 * shown beside what is known, never instead of it.
 *
 * Two rules from the sync invariants apply here. A frame that arrives while a
 * load is in flight is newer than that load, so the load must not overwrite it.
 * And a project's entry is only created by a frame for a project already known,
 * so a frame cannot invent a project.
 */
import { create } from 'zustand';

import { fetchWorkflowDefinitions, fetchWorkflowRuns, type WorkflowDefinitionSummary, type WorkflowRun, type WorkflowStepStatus } from '@/lib/workflowsApi';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';

export interface WorkflowRunFrame {
  runId: string;
  projectId: string;
  status: WorkflowRun['status'];
  cursor: string | null;
  steps: Array<{ id: string; status: WorkflowStepStatus }>;
}

interface WorkflowEntry {
  runs: WorkflowRun[];
  definitions: WorkflowDefinitionSummary[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

export interface WorkflowStoreState {
  entries: Record<string, WorkflowEntry>;
  /** Frames for runs this client had not read yet, applied by the next load. */
  pendingFrames: Record<string, Record<string, WorkflowRunFrame>>;
  getEntry: (project: { id: string } | null | undefined) => WorkflowEntry;
  load: (project: { id: string; path: string }, options?: { force?: boolean }) => Promise<void>;
  setRun: (project: { id: string }, run: WorkflowRun) => void;
  removeRun: (project: { id: string }, runId: string) => void;
  applyRunFrame: (frame: WorkflowRunFrame) => void;
}

const EMPTY: WorkflowEntry = { runs: [], definitions: [], loaded: false, loading: false, error: null };

const patchRun = (run: WorkflowRun, frame: WorkflowRunFrame): WorkflowRun => ({
  ...run,
  status: frame.status,
  cursor: frame.cursor,
  steps: run.steps.map((step) => {
    const framed = frame.steps.find((candidate) => candidate.id === step.id);
    return framed && framed.status !== step.status ? { ...step, status: framed.status } : step;
  }),
});

export const useWorkflowStore = create<WorkflowStoreState>((set, get) => ({
  entries: {},
  pendingFrames: {},

  getEntry: (project) => (project ? get().entries[project.id] ?? EMPTY : EMPTY),

  load: async (project, options = {}) => {
    const current = get().entries[project.id] ?? EMPTY;
    if (current.loading && !options.force) return;
    set((state) => ({ entries: { ...state.entries, [project.id]: { ...current, loading: true, error: null } } }));

    try {
      const [runs, definitions] = await Promise.all([
        fetchWorkflowRuns(project.path),
        fetchWorkflowDefinitions(project.path),
      ]);
      set((state) => {
        // A frame that arrived for a run this load had not read yet is newer than
        // the read, so the read is patched with it rather than replacing it.
        const frames = state.pendingFrames[project.id] ?? {};
        const patched = runs.map((run) => (frames[run.runId] ? patchRun(run, frames[run.runId]) : run));
        const { [project.id]: _dropped, ...pendingFrames } = state.pendingFrames;
        return {
          pendingFrames,
          entries: { ...state.entries, [project.id]: { runs: patched, definitions, loaded: true, loading: false, error: null } },
        };
      });
    } catch (error) {
      set((state) => {
        const entry = state.entries[project.id] ?? EMPTY;
        return { entries: { ...state.entries, [project.id]: { ...entry, loading: false, error: error instanceof Error ? error.message : 'The workflow runs could not be read' } } };
      });
    }
  },

  setRun: (project, run) => set((state) => {
    const entry = state.entries[project.id] ?? EMPTY;
    const known = entry.runs.some((candidate) => candidate.runId === run.runId);
    return { entries: { ...state.entries, [project.id]: { ...entry, runs: known ? entry.runs.map((candidate) => (candidate.runId === run.runId ? run : candidate)) : [run, ...entry.runs] } } };
  }),

  removeRun: (project, runId) => set((state) => {
    const entry = state.entries[project.id] ?? EMPTY;
    return { entries: { ...state.entries, [project.id]: { ...entry, runs: entry.runs.filter((candidate) => candidate.runId !== runId) } } };
  }),

  applyRunFrame: (frame) => set((state) => {
    const entry = state.entries[frame.projectId];
    // A frame cannot invent a project this client has never loaded.
    if (!entry) return state;
    const existing = entry.runs.find((candidate) => candidate.runId === frame.runId);
    if (!existing) {
      return { pendingFrames: { ...state.pendingFrames, [frame.projectId]: { ...(state.pendingFrames[frame.projectId] ?? {}), [frame.runId]: frame } } };
    }
    return {
      entries: {
        ...state.entries,
        [frame.projectId]: {
          ...entry,
          runs: entry.runs.map((candidate) => (candidate.runId === frame.runId ? patchRun(candidate, frame) : candidate)),
        },
      },
    };
  }),
}));

export const subscribeWorkflowFrames = (): (() => void) => subscribeOpenchamberEvents((event) => {
  if (event.type !== 'workflow-run-updated') return;
  useWorkflowStore.getState().applyRunFrame({
    runId: event.runId,
    projectId: event.projectId,
    status: event.status,
    cursor: event.cursor,
    steps: event.steps,
  });
});
```

- [ ] **Step 4: Add the frame to `openchamberEvents.ts`**

Next to `ScheduledTaskRanEvent` (`packages/ui/src/lib/openchamberEvents.ts:10-17`) add:

```ts
export type WorkflowRunUpdatedEvent = {
  type: 'workflow-run-updated';
  runId: string;
  projectId: string;
  status: 'idle' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';
  cursor: string | null;
  steps: Array<{ id: string; status: string }>;
};
```

Add it to the `Listener` union, and add a branch next to the `openchamber:scheduled-task-ran` branch. Two details the first draft of this plan got wrong and the implementation had to correct:

- the branch is wrapped in its own `if (envelope.type === 'openchamber:workflow') { … }` block, because an early-return form would redeclare the consts the scheduled-task branch below already declares in the same scope;
- a step status this client does not recognise is dropped rather than guessed, which needs a local guard:

```ts
const WORKFLOW_STEP_STATUSES: Record<WorkflowStepStatus, true> = {
  pending: true,
  running: true,
  waiting_confirm: true,
  needs_work: true,
  done: true,
  failed: true,
  skipped: true,
  blocked: true,
  interrupted: true,
};

const isWorkflowStepStatus = (value: unknown): value is WorkflowStepStatus =>
  typeof value === 'string' && value in WORKFLOW_STEP_STATUSES;
```

```ts
  if (envelope.type === 'openchamber:workflow') {
    const properties = getEventProperties(envelope.properties);
    const runId = typeof properties?.runId === 'string' ? properties.runId : '';
    const projectId = typeof properties?.projectId === 'string' ? properties.projectId : '';
    if (!runId || !projectId) return;
    const rawSteps = Array.isArray(properties?.steps) ? properties.steps : [];
    const rawStatus = properties?.status;
    const status = rawStatus === 'idle' || rawStatus === 'running' || rawStatus === 'waiting' || rawStatus === 'done' || rawStatus === 'failed' || rawStatus === 'cancelled'
      ? rawStatus
      : 'running';
    const nextEvent: WorkflowRunUpdatedEvent = {
      type: 'workflow-run-updated',
      runId,
      projectId,
      status,
      cursor: typeof properties?.cursor === 'string' ? properties.cursor : null,
      // The frame is a summary. A step whose status this client does not know
      // keeps its last known value rather than being reset to a guess.
      steps: rawSteps.flatMap((step) => (
        Boolean(step) && typeof step.id === 'string' && isWorkflowStepStatus(step.status)
          ? [{ id: String(step.id), status: step.status }]
          : []
      )),
    };
    for (const listener of listeners) {
      listener(nextEvent);
    }
    return;
  }
```

The frame carries a summary, not the whole run: a step's attempts and verifier output stay on the server, and the screen re-reads the run when the frame says the step it is showing changed.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd packages/ui test -- src/stores/useWorkflowStore.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Type check and commit**

```bash
bun run type-check:ui
git add packages/ui/src/stores/useWorkflowStore.ts packages/ui/src/stores/useWorkflowStore.test.ts packages/ui/src/lib/openchamberEvents.ts
git commit -m "feat(workflows): cache runs and apply live frames"
```

---

### Task 3: The rail surface, its empty state, and the locale text

**Files:**
- Modify: `packages/ui/src/lib/surfaces/registry.ts` (add the descriptor), `packages/ui/src/lib/surfaces/modes.ts` (add `workflows`), `packages/ui/src/components/layout/ContextPanel.tsx` (render it)
- Create: `packages/ui/src/components/views/workflows/WorkflowsView.tsx` (the container, filled in by Tasks 4 to 7)
- Modify: the 13 locale files under `packages/ui/src/lib/i18n/messages/`

**Interfaces:**
- Consumes: Task 2's store.
- Produces: the `workflows` mode and surface id; `WorkflowsView` as the single mount point for the run list, the run detail and the definition tab.

- [ ] **Step 1: Add the mode and the surface**

In `lib/surfaces/modes.ts`, add `'workflows'` to `BUILT_IN_CONTEXT_PANEL_MODES`. A second hand-maintained copy of that list lives at `stores/useUIStore.ts:29` (`contextPanelModeSchema`), and the per-mode panel-width sanitizer iterates it (`useUIStore.ts:766`), so a mode missing there loses its remembered width on the next store migration. Add it in both places. In `lib/surfaces/registry.ts`, add an entry beside the `plan` entry (`registry.ts:99-107`):

```ts
  {
    id: 'workflows',
    descriptionKey: 'contextRail.surface.workflows.description',
    // A list beside a detail pane carrying stdout and verifier output: the same
    // shape as `notes` and `walkthrough`, which are both 3/5 for that reason.
    defaultWidthFraction: 3 / 5,
    mode: 'workflows',
    icon: 'list-check-2',
    labelKey: 'contextPanel.mode.workflows',
    // Always available: a project with no workflow yet needs the way in to the
    // definition directory, which a `has-content` rule would hide.
    availability: 'always',
  },
```

Check `icon: 'list-check'` against the icon set the registry uses; if that name is not there, pick the closest existing one and use it in the label prefix story. Do not add an icon dependency.

- [ ] **Step 2: Render it**

`components/layout/ContextPanel.tsx` keeps **three** hand-written chains keyed by mode, and all three need the new mode or the rail entry opens a tab labelled "Context" with an empty body: the label chain (`getModeLabel`, around line 174), the icon chain (`getTabIcon`, around line 262), and the render chain (`activeNonChatContent`, around line 1073, which falls through to `null`). Extend each one the way its neighbours do, then add the render branch beside `mode === 'plan'`:

```tsx
{activeTab.mode === 'workflows' ? <WorkflowsView project={activeProject} /> : null}
```

Lazy import it the way `PlanView` is imported at `ContextPanel.tsx:22`:

```tsx
const WorkflowsView = lazy(() => import('@/components/views/workflows/WorkflowsView'));
```

- [ ] **Step 3: Write the container with an empty state**

```tsx
// packages/ui/src/components/views/workflows/WorkflowsView.tsx
/**
 * The workflows surface: the runs of one project on the left, the selected run's
 * detail on the right, and a tab for the declared workflow itself.
 *
 * The list and the detail are separate components; this file owns which run is
 * selected and the loading, error and empty states, so a failure is never
 * rendered as "no runs".
 */
import { useEffect, useMemo, useState } from 'react';

import { useI18n } from '@/lib/i18n';
import { useWorkflowStore } from '@/stores/useWorkflowStore';
import { RunList } from './RunList';
import { RunDetail } from './RunDetail';
import type { ProjectRef } from '@/lib/projectContextApi';

export interface WorkflowsViewProps {
  project: ProjectRef | null;
}

export const WorkflowsView = ({ project }: WorkflowsViewProps) => {
  const { t } = useI18n();
  const entry = useWorkflowStore((state) => (project ? state.getEntry(project) : null));
  const load = useWorkflowStore((state) => state.load);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  useEffect(() => {
    if (project) void load(project);
  }, [project?.id, load]);

  const selected = useMemo(
    () => entry?.runs.find((run) => run.runId === selectedRunId) ?? entry?.runs[0] ?? null,
    [entry?.runs, selectedRunId],
  );

  if (!project) {
    return <Empty text={t('workflows.empty.noProject')} />;
  }
  if (entry?.loading && !entry.loaded) {
    return <Empty text={t('workflows.empty.loading')} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {entry?.error ? (
        <div role="status" className="border-b border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {t('workflows.error.readFailed')}: {entry.error}
        </div>
      ) : null}
      {entry && entry.runs.length === 0 && !entry.error ? (
        <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
          {t('workflows.empty.noRuns')} <code className="text-foreground">.openchamber/workflows/</code>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <RunList
          runs={entry?.runs ?? []}
          selectedRunId={selected?.runId ?? null}
          onSelect={setSelectedRunId}
          definitions={entry?.definitions ?? []}
          project={project}
        />
        {selected ? <RunDetail run={selected} project={project} /> : <Empty text={t('workflows.empty.selectRun')} />}
      </div>
    </div>
  );
};

const Empty = ({ text }: { text: string }) => (
  <div className="flex h-full flex-1 items-center justify-center p-4 text-xs text-muted-foreground">{text}</div>
);

export default WorkflowsView;
```

- [ ] **Step 4: Add the English strings**

In `packages/ui/src/lib/i18n/messages/en.ts`, add a `workflows` group in the same shape as the neighbouring groups:

```ts
  workflows: {
    title: 'Workflows',
    empty: {
      noProject: 'Open a project to see its workflows.',
      noRuns: 'No run yet. A workflow is declared in',
      selectRun: 'Select a run to see its steps.',
      loading: 'Reading the project workflows…',
    },
    error: {
      readFailed: 'The workflow runs could not be read',
      actionFailed: 'The action failed',
      runBusy: 'This run is already executing a step.',
    },
    run: {
      status: { idle: 'Not started', running: 'Running', waiting: 'Waiting', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' },
    },
    step: {
      status: {
        pending: 'Not started', running: 'Running', waiting_confirm: 'Waiting for you', needs_work: 'Needs work',
        done: 'Done', failed: 'Failed', skipped: 'Skipped', blocked: 'Blocked', interrupted: 'Interrupted',
      },
      run: 'Run this step',
      runAll: 'Run until the next stop',
      verify: 'Re-run the checks',
      prompt: 'Send another prompt',
      promptPlaceholder: 'Say what to change, then send it into the same session',
      confirmDone: 'Confirm done',
      confirmNotDone: 'Not done',
      skip: 'Skip this step',
      cancelRun: 'Stop the run',
      attempts: 'Attempts',
      checkpoint: 'Checkpoint',
      verifier: 'Checks',
      truncated: 'output cut at 64 KiB',
      // The run list's delete confirmation; the dialog names the run and says
      // that only the run file goes.
      start: 'Start a run',
      startConfirm: 'Start',
      startCancel: 'Cancel',
      startNeedsInput: 'This workflow asks for the values below.',
      delete: 'Delete run',
      deleteConfirm: 'This removes the run and its step history. Commits and artifacts stay in the project.',
      deleteCancel: 'Cancel',
      timeout: 'timed out',
      exit: 'exit {code}',
      diffFailed: 'The diff could not be read',
      session: 'Session',
      openTranscript: 'Open the transcript',
      diff: 'See the changes',
      notMatching: 'This checkpoint no longer matches what is on disk.',
    },
    banner: {
      title: 'Step of a workflow run',
      waiting: 'This step is waiting for your answer.',
      blocked: 'This step needs you before it can go on.',
      openRun: 'Open the run',
    },
    definition: {
      tab: 'Workflow',
      invalid: 'This definition does not load',
      diagram: 'Diagram',
    },
  },
```

Then add the same keys, translated, to de, es, fr, ja, ko, nl, pl, pt-BR, tr, uk, zh-CN, zh-TW. The repo's locale test (`packages/ui/src/lib/i18n/messages.test.ts`) fails when a locale is missing a key, so run it in the next step.

- [ ] **Step 5: Run the locale test and type check**

Run: `bun run --cwd packages/ui test -- src/lib/i18n/messages.test.ts`
Expected: PASS. A missing translation shows up as a failure naming the locale and the key.

```bash
bun run type-check:ui
git add packages/ui/src/lib/surfaces packages/ui/src/components/layout/ContextPanel.tsx packages/ui/src/components/views/workflows/WorkflowsView.tsx packages/ui/src/lib/i18n/messages
git commit -m "feat(workflows): add the workflows surface and its text"
```

---

### Task 4: Run list

**Files:**
- Create: `packages/ui/src/components/views/workflows/RunList.tsx`

**Interfaces:**
- Consumes: Task 1's client functions, Task 2's store, Task 5's `describeRunStatus` and `describeStepStatus`.
- Produces: `<RunList runs selectedRunId onSelect definitions project />`, which creates a run from a definition and deletes a run.

- [ ] **Step 1: Write the component**

```tsx
// packages/ui/src/components/views/workflows/RunList.tsx
/**
 * The runs of one project, newest first, with the actions a person takes on a
 * run itself: start one from a definition, open one, delete one.
 *
 * Delete asks first and names the run. It removes the run file only; commits and
 * artifacts stay in the project, so the dialog says so.
 */
import { useState } from 'react';

import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { createWorkflowRun, deleteWorkflowRun, type WorkflowDefinitionSummary, type WorkflowRun } from '@/lib/workflowsApi';
import { useWorkflowStore } from '@/stores/useWorkflowStore';
import { describeRunStatus } from '@/lib/workflows/status';
import type { ProjectRef } from '@/lib/projectContextApi';

export interface RunListProps {
  runs: WorkflowRun[];
  definitions: WorkflowDefinitionSummary[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  project: ProjectRef;
}

export const RunList = ({ runs, definitions, selectedRunId, onSelect, project }: RunListProps) => {
  const { t } = useI18n();
  const setRun = useWorkflowStore((state) => state.setRun);
  const removeRun = useWorkflowStore((state) => state.removeRun);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `WorkflowDefinitionSummary` carries `id: string | null`, not the parsed definition.
  const usable = definitions.filter((definition) => definition.id !== null);

  const start = async (definition: WorkflowDefinitionSummary) => {
    setBusy(true);
    setError(null);
    try {
      // A definition may require inputs, and the create route rejects a missing
      // one; the dialog collects them before the run exists.
      const run = await createWorkflowRun(project.path, { workflowId: definition.id as string, inputs: pendingInputs });
      setRun(project, run);
      onSelect(run.runId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('workflows.error.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (runId: string) => {
    setBusy(true);
    setError(null);
    try {
      await deleteWorkflowRun(project.path, runId);
      removeRun(project, runId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('workflows.error.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex w-64 shrink-0 flex-col border-r border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="text-xs font-medium">{t('workflows.title')}</span>
        <div className="flex gap-1">
          {usable.map((definition) => (
            <Button key={definition.file} size="xs" variant="ghost" disabled={busy} onClick={() => setPendingStart(definition)}>
              {definition.name ?? definition.id}
            </Button>
          ))}
        </div>
      </div>
      {error ? <div role="status" className="px-3 py-2 text-xs text-destructive">{error}</div> : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {runs.map((run) => {
          const status = describeRunStatus(run.status, t);
          return (
            <div
              key={run.runId}
              className={run.runId === selectedRunId ? 'flex items-center gap-2 bg-accent px-3 py-2' : 'flex items-center gap-2 px-3 py-2 hover:bg-accent/50'}
            >
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onSelect(run.runId)}>
                <span className="flex items-center gap-1.5 text-xs">
                  <Icon name={status.icon} className={status.className} aria-hidden />
                  <span className="truncate">{run.workflowId}</span>
                  <span className="text-muted-foreground">{status.label}</span>
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">{run.cursor ?? run.runId.slice(0, 8)}</span>
              </button>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy || run.steps.some((step) => step.status === 'running')}
                title={t('workflows.run.delete')}
                aria-label={t('workflows.run.delete')}
                onClick={() => setPendingDelete(run.runId)}
              >
                <Icon name="delete-bin" className="size-3.5" aria-hidden />
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Check the primitives the component uses**

Confirm the exact prop names of `Button` in `packages/ui/src/components/ui/button.tsx` (sizes and variants) and adjust, and confirm the icon component's props against how another view imports its status icons. Do not invent props; use what the file offers.

- [ ] **Step 3: Type check**

Run: `bun run type-check:ui`
Expected: no errors. This view is exercised by the browser smoke in Task 10, which is what proves the list renders a real run.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/views/workflows/RunList.tsx
git commit -m "feat(workflows): list the runs of a project"
```

---

### Task 5: Status vocabulary and the run timeline

**Files:**
- Create: `packages/ui/src/lib/workflows/status.ts`
- Test: `packages/ui/src/lib/workflows/status.test.ts`
- Create: `packages/ui/src/components/views/workflows/RunDetail.tsx`

**Interfaces:**
- Consumes: `WorkflowStepStatus`, `WorkflowRunStatus` (Task 1).
- Produces: `describeStepStatus(status, t) -> { label, tone, className, icon }`, `describeRunStatus(status, t) -> { label, tone, className, icon }` where `tone` is `'neutral' | 'active' | 'attention' | 'danger' | 'done'`, and `<RunDetail run project />`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/lib/workflows/status.test.ts
import { describe, expect, it } from 'bun:test';
import { describeRunStatus, describeStepStatus } from './status';

const t = (key: string) => key;

describe('describeStepStatus', () => {
  it('separates a person deciding from a failure', () => {
    expect(describeStepStatus('waiting_confirm', t).tone).toBe('attention');
    expect(describeStepStatus('needs_work', t).tone).toBe('attention');
    expect(describeStepStatus('blocked', t).tone).toBe('attention');
    expect(describeStepStatus('failed', t).tone).toBe('danger');
    expect(describeStepStatus('interrupted', t).tone).toBe('danger');
  });

  it('marks what is running and what is finished', () => {
    expect(describeStepStatus('running', t).tone).toBe('active');
    expect(describeStepStatus('done', t).tone).toBe('done');
    expect(describeStepStatus('pending', t).tone).toBe('neutral');
    expect(describeStepStatus('skipped', t).tone).toBe('neutral');
  });

  it('gives every status a label and an icon, so color is never the only signal', () => {
    for (const status of ['pending', 'running', 'waiting_confirm', 'needs_work', 'done', 'failed', 'skipped', 'blocked', 'interrupted'] as const) {
      const described = describeStepStatus(status, t);
      expect(described.label.length).toBeGreaterThan(0);
      expect(described.icon).toBeTruthy();
      expect(described.className).toContain('text-');
    }
  });
});

describe('describeRunStatus', () => {
  it('distinguishes waiting from running', () => {
    expect(describeRunStatus('waiting', t).tone).toBe('attention');
    expect(describeRunStatus('running', t).tone).toBe('active');
    expect(describeRunStatus('done', t).tone).toBe('done');
    expect(describeRunStatus('cancelled', t).tone).toBe('neutral');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd packages/ui test -- src/lib/workflows/status.test.ts`
Expected: FAIL, `Failed to resolve import "./status"`.

- [ ] **Step 3: Write the vocabulary**

```ts
// packages/ui/src/lib/workflows/status.ts
/**
 * One place that turns a workflow status into what a screen shows.
 *
 * Every status carries a label and an icon, not only a color: a person who
 * cannot separate the hues still reads the same state. The colors come from
 * theme tokens, so light and dark are both legible.
 */
import type { IconName } from '@/components/icon/icons';
import type { I18nKey, I18nParams } from '@/lib/i18n';
import type { WorkflowRunStatus, WorkflowStepStatus } from '@/lib/workflowsApi';

export type StatusTone = 'neutral' | 'active' | 'attention' | 'danger' | 'done';

export interface DescribedStatus {
  label: string;
  tone: StatusTone;
  className: string;
  /** A sprite name; the caller renders `<Icon name={status.icon} />`. */
  icon: IconName;
}

// The translator's real contract: `useI18n().t` takes an `I18nKey`, so a
// `(key: string) => string` signature would reject it under `strict`.
type Translate = (key: I18nKey, params?: I18nParams) => string;

// Only tokens the design system defines: this theme has no `success` or
// `warning` colour, and a raw Tailwind palette class would silently do nothing.
// `chart-2` is the theme's green and `chart-3` its amber, in both light and dark.
const TONE_CLASS: Record<StatusTone, string> = {
  neutral: 'text-muted-foreground',
  active: 'text-primary',
  attention: 'text-chart-3',
  danger: 'text-destructive',
  done: 'text-chart-2',
};

const STEP_TONE: Record<WorkflowStepStatus, StatusTone> = {
  pending: 'neutral',
  running: 'active',
  waiting_confirm: 'attention',
  needs_work: 'attention',
  blocked: 'attention',
  done: 'done',
  failed: 'danger',
  interrupted: 'danger',
  skipped: 'neutral',
};

// Every status carries a distinct sprite icon, so the state reads without colour.
const STEP_ICON: Record<WorkflowStepStatus, DescribedStatus['icon']> = {
  pending: 'checkbox-blank',
  running: 'loader',
  waiting_confirm: 'time',
  needs_work: 'tools',
  blocked: 'pause',
  done: 'checkbox-circle',
  failed: 'error-warning',
  interrupted: 'alert',
  skipped: 'stop',
};

export const describeStepStatus = (status: WorkflowStepStatus, t: Translate): DescribedStatus => ({
  label: t(`workflows.step.status.${status}`),
  tone: STEP_TONE[status],
  className: TONE_CLASS[STEP_TONE[status]],
  icon: STEP_ICON[status],
});

const RUN_TONE: Record<WorkflowRunStatus, StatusTone> = {
  idle: 'neutral',
  running: 'active',
  waiting: 'attention',
  done: 'done',
  failed: 'danger',
  cancelled: 'neutral',
};

const RUN_ICON: Record<WorkflowRunStatus, DescribedStatus['icon']> = {
  idle: 'checkbox-blank',
  running: 'loader',
  waiting: 'time',
  done: 'checkbox-circle',
  failed: 'error-warning',
  cancelled: 'stop',
};

export const describeRunStatus = (status: WorkflowRunStatus, t: Translate): DescribedStatus => ({
  label: t(`workflows.run.status.${status}`),
  tone: RUN_TONE[status],
  className: TONE_CLASS[RUN_TONE[status]],
  icon: RUN_ICON[status],
});
```

The icons are the app's own generated sprite: `IconName` is `keyof typeof iconSpriteData` (`components/icon/icons.ts`), the rail renders one through `<Icon name={…} />` (`components/icon/Icon.tsx`), and `lucide-react` is not a dependency of this package. Every name above is present in the sprite. The caller renders the icon with the status's `className`, and `running` may add a spin utility.

- [ ] **Step 4: Write the run detail**

```tsx
// packages/ui/src/components/views/workflows/RunDetail.tsx
/**
 * One run: the step sequence down the left, the selected step on the right.
 *
 * The timeline is theme-colored markup rather than a diagram renderer: a step's
 * status changes on every frame, and re-rendering a full SVG each time is work
 * for nothing. The declared workflow itself is drawn separately, on the
 * definition tab, where it does not change.
 */
import { useEffect, useState } from 'react';

import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { fetchWorkflowRun, type WorkflowDefinitionSummary, type WorkflowRun } from '@/lib/workflowsApi';
import { describeRunStatus, describeStepStatus } from '@/lib/workflows/status';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { StepPane } from './StepPane';
import { WorkflowDiagram } from './WorkflowDiagram';

export interface RunDetailProps {
  run: WorkflowRun;
  project: { path: string };
  /** The declared workflow, for the diagram tab; `null` while it does not load. */
  definition: WorkflowDefinitionSummary | null;
}

export const RunDetail = ({ run, project, definition }: RunDetailProps) => {
  const [tab, setTab] = useState<'steps' | 'definition'>('steps');
  const { t } = useI18n();
  const [full, setFull] = useState<WorkflowRun>(run);
  const [stepId, setStepId] = useState<string | null>(run.cursor ?? run.steps[0]?.id ?? null);
  const [error, setError] = useState<string | null>(null);

  // The parent swaps the `run` prop when a person selects another run, without
  // remounting this component. Without this the pane would show the previous
  // run's steps under the new selection until the re-read landed, and forever if
  // that read failed.
  if (full.runId !== run.runId) {
    setFull(run);
    setStepId(run.cursor ?? run.steps[0]?.id ?? null);
    setError(null);
  }
  const runStatus = describeRunStatus(run.status, t);

  // The frame the server pushes carries a step summary, not the attempts and
  // verifier output. When a step's status moved, re-read the run so the pane
  // shows what the new state actually contains.
  useEffect(() => {
    void fetchWorkflowRun(project.path, run.runId)
      .then((next) => {
        setError(null);
        setFull(next);
        setStepId((current) => current ?? next.cursor ?? next.steps[0]?.id ?? null);
      })
      .catch((failure) => setError(failure instanceof Error ? failure.message : t('workflows.error.readFailed')));
  }, [project.path, run.runId, run.updatedAt, run.status, run.steps.map((step) => `${step.id}:${step.status}`).join(',')]);

  const step = full.steps.find((candidate) => candidate.id === stepId) ?? full.steps[0] ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon name={runStatus.icon} className={runStatus.className} aria-hidden />
        <span className="text-xs font-medium">{full.workflowId}</span>
        <span className="text-xs text-muted-foreground">{runStatus.label}</span>
        <span className="ml-auto text-[11px] text-muted-foreground">{full.sandbox}</span>
      </div>
      <div className="flex items-center gap-1 border-b border-border px-2 py-1" role="tablist">
        <Button size="xs" variant={tab === 'steps' ? 'secondary' : 'ghost'} role="tab" aria-selected={tab === 'steps'} onClick={() => setTab('steps')}>
          {t('workflows.step.attempts')}
        </Button>
        <Button size="xs" variant={tab === 'definition' ? 'secondary' : 'ghost'} role="tab" aria-selected={tab === 'definition'} onClick={() => setTab('definition')}>
          {t('workflows.definition.tab')}
        </Button>
      </div>
      {error ? <div role="status" className="px-3 py-2 text-xs text-destructive">{error}</div> : null}
      <div className="flex min-h-0 flex-1">
        <ol className="w-56 shrink-0 overflow-y-auto border-r border-border py-1">
          {full.steps.map((candidate) => {
            const status = describeStepStatus(candidate.status, t);
            return (
              <li key={candidate.id}>
                <button
                  type="button"
                  onClick={() => setStepId(candidate.id)}
                  className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs', candidate.id === step?.id ? 'bg-accent' : 'hover:bg-accent/50')}
                >
                  <status.icon className={cn(status.className, candidate.status === 'running' && 'animate-spin')} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{candidate.id}</span>
                  <span className="text-[11px] text-muted-foreground">{status.label}</span>
                </button>
              </li>
            );
          })}
        </ol>
        {tab === 'definition'
          ? (definition
            ? <WorkflowDiagram summary={definition} />
            : <div className="flex-1 p-3 text-xs text-muted-foreground">{t('workflows.empty.loading')}</div>)
          : (step ? <StepPane key={step.id} run={full} step={step} project={project} /> : null)}
      </div>
    </div>
  );
};
```

- [ ] **Step 5: Run the tests and type check**

Run: `bun run --cwd packages/ui test -- src/lib/workflows/status.test.ts && bun run type-check:ui`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/lib/workflows/status.ts packages/ui/src/lib/workflows/status.test.ts packages/ui/src/components/views/workflows/RunDetail.tsx
git commit -m "feat(workflows): describe statuses and render the run timeline"
```

---

### Task 6: The step pane as evidence

**Files:**
- Create: `packages/ui/src/components/views/workflows/StepPane.tsx`

**Interfaces:**
- Consumes: Task 1's types, Task 5's `describeStepStatus`.
- Produces: `<StepPane run step project />`, showing the block reason, the attempts with their sessions, the verifier results verbatim, and the checkpoint with its commit and artifacts.

- [ ] **Step 1: Write the pane**

```tsx
// packages/ui/src/components/views/workflows/StepPane.tsx
/**
 * One step, shown as evidence: what the step is waiting for, what each attempt
 * ran in which session, what the verifiers actually printed, and what the
 * checkpoint recorded.
 *
 * Nothing here summarizes a model's claim. The verifier block shows the command
 * that ran and its exit code and output, because a person deciding whether to
 * confirm needs the evidence, not a sentence about it.
 */
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { WorkflowRun, WorkflowStep } from '@/lib/workflowsApi';
import { describeStepStatus } from '@/lib/workflows/status';

export interface StepPaneProps {
  run: WorkflowRun;
  step: WorkflowStep;
  project: { path: string };
}

export const StepPane = ({ run, step, project }: StepPaneProps) => {
  const { t } = useI18n();
  const status = describeStepStatus(step.status, t);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Icon name={status.icon} className={cn(status.className, step.status === 'running' && 'animate-spin')} aria-hidden />
          <span className="text-sm font-medium">{step.id}</span>
          <span className="text-xs text-muted-foreground">{status.label}</span>
        </div>
        {step.note ? (
          <p className="text-xs text-muted-foreground">{step.note}</p>
        ) : null}
      </div>

      {step.checkpoint ? (
        <section className="rounded border border-border p-2">
          <h4 className="text-[11px] font-medium text-muted-foreground">{t('workflows.step.checkpoint')}</h4>
          <p className="font-mono text-[11px]">{step.checkpoint.commit.slice(0, 12)}</p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {step.checkpoint.artifacts.map((artifact) => (
              <li key={artifact.path} className="truncate font-mono text-[11px] text-muted-foreground">
                {artifact.path} {artifact.sha256 ? artifact.sha256.slice(0, 8) : ''}
              </li>
            ))}
          </ul>
          {/* The diff of one commit is rendered from the same data the changes
              panel uses; do not write a second differ. */}
          <CheckpointDiff directory={project.path} commit={step.checkpoint.commit} />
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h4 className="text-[11px] font-medium text-muted-foreground">{t('workflows.step.attempts')}</h4>
        {step.attempts.length === 0 ? <p className="text-xs text-muted-foreground">{t('workflows.step.status.pending')}</p> : null}
        {step.attempts.map((attempt) => (
          <div key={attempt.index} className="rounded border border-border p-2">
            <div className="flex items-center gap-2 text-[11px]">
              <span className="font-medium">#{attempt.index + 1}</span>
              <span className={attempt.status === 'completed' ? 'text-muted-foreground' : 'text-destructive'}>{attempt.status}</span>
              {attempt.sessionId ? (
                <span className="ml-auto font-mono text-muted-foreground">{attempt.sessionId.slice(0, 8)}</span>
              ) : null}
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words text-[11px] text-muted-foreground">{attempt.prompt}</p>
            {attempt.error ? <p className="mt-1 text-[11px] text-destructive">{attempt.error.message}</p> : null}
            {attempt.verify ? <VerifierBlock verify={attempt.verify} /> : null}
          </div>
        ))}
      </section>
    </div>
  );
};

const VerifierBlock = ({ verify }: { verify: NonNullable<WorkflowStep['attempts'][number]['verify']> }) => {
  const { t } = useI18n();
  // A step may declare no checks at all (`confirm: human` with no verifier), and
  // the engine records an empty verdict for it. A heading over an empty list
  // reads as a bug, so the block simply is not there.
  if (!verify.error && verify.artifacts.length === 0 && verify.commands.length === 0) return null;
  return (
    <div className="mt-2 border-t border-border pt-2">
      <h5 className="text-[11px] font-medium text-muted-foreground">{t('workflows.step.verifier')}</h5>
      {verify.error ? <p className="mt-1 text-[11px] text-destructive">{verify.error}</p> : null}
      <ul className="mt-1 flex flex-col gap-1">
        {verify.artifacts.map((artifact) => (
          <li key={`${artifact.glob}:${artifact.path ?? 'none'}`} className="flex items-center gap-2 text-[11px]">
            <span className={artifact.exists ? 'text-chart-2' : 'text-destructive'}>{artifact.exists ? '✓' : '✗'}</span>
            <span className="truncate font-mono">{artifact.path ?? artifact.glob}</span>
            {!artifact.exists ? <span className="text-muted-foreground">{t('workflows.step.verifier')}: {artifact.glob}</span> : null}
          </li>
        ))}
        {verify.commands.map((command, index) => (
          <li key={`${command.run}:${index}`} className="text-[11px]">
            <div className="flex items-center gap-2">
              <span className={command.ok ? 'text-chart-2' : 'text-destructive'}>{command.ok ? '✓' : '✗'}</span>
              <span className="truncate font-mono">{command.run}</span>
              <span className="ml-auto text-muted-foreground">
                {command.timedOut ? t('workflows.step.timeout') : t('workflows.step.exit', { code: command.exitCode ?? '—' })} · {(command.durationMs / 1000).toFixed(1)}s
              </span>
            </div>
            {command.truncated ? <span className="ml-1 text-muted-foreground">({t('workflows.step.truncated')})</span> : null}
            {command.stdout ? <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground">{command.stdout}</pre> : null}
            {command.stderr ? <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] text-destructive">{command.stderr}</pre> : null}
          </li>
        ))}
      </ul>
    </div>
  );
};
```

- [ ] **Step 2: Add the checkpoint diff, reusing the git routes**

Add to the same file:

```tsx
/**
 * The diff of one checkpoint commit, read from the git routes the changes panel
 * already uses. This is why the checkpoint is a commit: the evidence a person
 * needs to confirm a step is the change itself, and it does not need a second
 * implementation of diffing.
 */
const CheckpointDiff = ({ directory, commit }: { directory: string; commit: string }) => {
  const { t } = useI18n();
  const [files, setFiles] = useState<Array<{ path: string; insertions: number; deletions: number }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // A new commit (or a new translator identity) means the previous answer no
    // longer describes what this block is about, so nothing stale may survive
    // the refetch: an error from the last attempt would otherwise hide a
    // successful one, and the old file list would sit under the new header.
    setFiles(null);
    setError(null);
    void runtimeFetch(`/api/git/commit-files?directory=${encodeURIComponent(directory)}&hash=${encodeURIComponent(commit)}`, { directory })
      .then((response) => (response.ok ? response.json() : response.json().catch(() => null).then((body: { error?: string } | null) => Promise.reject(new Error(body?.error ?? `${t('workflows.step.diffFailed')} (${response.status})`)))))
      // `GET /api/git/commit-files` answers `{ files: [{ path, insertions, deletions, changeType }] }`
      // (`lib/git/service.js:5640-5677`); the field is `insertions`, not `additions`.
      .then((body: { files?: Array<{ path: string; insertions: number; deletions: number }> }) => { if (!cancelled) setFiles(body.files ?? []); })
      .catch((failure: unknown) => { if (!cancelled) setError(failure instanceof Error ? failure.message : t('workflows.error.readFailed')); });
    return () => { cancelled = true; };
  }, [directory, commit, t]);

  if (error) return <p className="mt-1 text-[11px] text-destructive">{error}</p>;
  if (!files) return <p className="mt-1 text-[11px] text-muted-foreground">{t('workflows.empty.loading')}</p>;
  return (
    <ul className="mt-1 flex flex-col gap-0.5">
      {files.map((file) => (
        <li key={file.path} className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{file.path}</span>
          <span className="text-chart-2">+{file.insertions}</span>
          <span className="text-destructive">-{file.deletions}</span>
        </li>
      ))}
    </ul>
  );
};
```

Read the exact query parameters and response shape of `GET /api/git/commit-files` in `packages/web/server/lib/git/routes.js:1336-1374` before writing the call, and match it. If the response is a bare array rather than `{ files }`, use the array; the point of this step is to read that route, not to guess it. For the full hunks themselves, open the changes panel's own diff view for the commit rather than embedding a reducer here: compare against how `packages/ui/src/components/views/walkthrough/WalkthroughHunkRun.tsx` renders a hunk and follow it.

- [ ] **Step 3: Add the missing strings**

If the pane uses a string that is not in the Task 3 block (for example an empty-state line for a verifier with no checks), add it to `en.ts` and the other 12 locales, then:

Run: `bun run --cwd packages/ui test -- src/lib/i18n/messages.test.ts`
Expected: PASS.

- [ ] **Step 4: Type check and commit**

```bash
bun run type-check:ui
git add packages/ui/src/components/views/workflows/StepPane.tsx packages/ui/src/lib/i18n/messages
git commit -m "feat(workflows): show a step's evidence"
```

---

### Task 7: The actions a person takes

**Files:**
- Modify: `packages/ui/src/components/views/workflows/StepPane.tsx` (add the action bar)

**Interfaces:**
- Consumes: Task 1's client functions, Task 2's `setRun`.
- Produces: the four actions from the spec (run the step, run until the next stop, send another prompt, confirm not done / done / skip), the re-verify action, cancel, plus the in-flight rules.

- [ ] **Step 1: Add the action bar**

The engine refuses three classes of action with `conflict`, so the bar must not offer them: any action on a run whose status is `done`, `failed` or `cancelled`; `run` and `prompt` on a step that is `done` or `skipped` (a settled step); and `confirm` on a step whose last attempt is not `completed`. Compute them once:

```tsx
const TERMINAL_RUN_STATUSES: Partial<Record<WorkflowRun['status'], true>> = { done: true, failed: true, cancelled: true };
const SETTLED_STEP_STATUSES: Partial<Record<WorkflowStepStatus, true>> = { done: true, skipped: true };
const runIsOpen = TERMINAL_RUN_STATUSES[run.status] !== true;
const stepIsSettled = SETTLED_STEP_STATUSES[step.status] === true;
const attemptSettled = step.attempts.at(-1)?.status === 'completed';
```

Then gate the buttons, matching what the engine actually refuses (`packages/web/server/lib/workflows/engine.js`):

- `run`: `runIsOpen && !stepIsSettled`. The engine refuses a terminal run and a settled step.
- `runAll`, `cancel`, `verify`: `runIsOpen`.
- `confirmDone`: `attemptSettled` — the engine only accepts a `completed` attempt for `done`.
- `confirmNotDone` and `skip`: `runIsOpen` only. The engine requires a completed attempt **only** for `done`, and a step can be blocked before it ever had an attempt (a missing input, for example), so gating these two on `attemptSettled` leaves such a step with no working control at all.
- The prompt box appears for `waiting_confirm`, `needs_work`, `blocked` **and `interrupted`**: a step the restart left interrupted still holds its session, and the person's choices there are the same as at any other stop.

A disabled control carries its reason, but a disabled `Button` is `pointer-events-none` (`components/ui/button.tsx:53`), so its own `title` never shows. Wrap the disabled control in a `<span title={reason}>`, which is the hit target that can. Every control also gets an `aria-label`, and the prompt textarea gets one too (the `workflows.step.prompt` key).

```tsx
/**
 * The action bar.
 *
 * Every action is disabled while one is in flight: two clicks on "run this step"
 * must not start two attempts, and the server answers `busy` for the second one
 * anyway. A refused action shows the server's own message, because "the verifier
 * failed" is more useful than "the action failed".
 */
const actionBar = (
  <div className="flex flex-col gap-2 border-t border-border p-2">
    {actionError ? <p role="status" className="text-[11px] text-destructive">{actionError}</p> : null}
    <div className="flex flex-wrap gap-1">
      <Button size="xs" disabled={busy || step.status === 'running'} onClick={() => void act(() => runWorkflowStep(project.path, run.runId, step.id))}>
        {t('workflows.step.run')}
      </Button>
      <Button size="xs" variant="ghost" disabled={busy} onClick={() => void act(() => runWorkflow(project.path, run.runId))}>
        {t('workflows.step.runAll')}
      </Button>
      <Button size="xs" variant="ghost" disabled={busy || step.attempts.length === 0} onClick={() => void act(() => verifyWorkflowStep(project.path, run.runId, step.id))}>
        {t('workflows.step.verify')}
      </Button>
      <Button size="xs" variant="ghost" disabled={busy} onClick={() => void act(() => cancelWorkflowRun(project.path, run.runId))}>
        {t('workflows.step.cancelRun')}
      </Button>
    </div>
    {step.status === 'waiting_confirm' || step.status === 'needs_work' || step.status === 'blocked' ? (
      <div className="flex flex-col gap-1">
        <textarea
          className="min-h-16 rounded border border-border bg-transparent p-1.5 text-xs"
          placeholder={t('workflows.step.promptPlaceholder')}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <div className="flex flex-wrap gap-1">
          <Button size="xs" disabled={busy || prompt.trim().length === 0} onClick={() => void act(async () => {
            const next = await promptWorkflowStep(project.path, run.runId, step.id, prompt.trim());
            setPrompt('');
            return next;
          })}>
            {t('workflows.step.prompt')}
          </Button>
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => void act(() => confirmWorkflowStep(project.path, run.runId, step.id, 'done'))}>
            {t('workflows.step.confirmDone')}
          </Button>
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => void act(() => confirmWorkflowStep(project.path, run.runId, step.id, 'not_done'))}>
            {t('workflows.step.confirmNotDone')}
          </Button>
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => void act(() => confirmWorkflowStep(project.path, run.runId, step.id, 'skip'))}>
            {t('workflows.step.skip')}
          </Button>
        </div>
      </div>
    ) : null}
  </div>
);
```

with these locals above it in `StepPane`:

```tsx
  const setRun = useWorkflowStore((state) => state.setRun);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // One step's refusal must not stand against the next step's banner.
  useEffect(() => {
    setActionError(null);
  }, [sessionId]);
  const [prompt, setPrompt] = useState('');

  const act = async (run_action: () => Promise<WorkflowRun>) => {
    setBusy(true);
    setActionError(null);
    try {
      setRun(project as { id: string; path: string }, await run_action());
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : t('workflows.error.actionFailed'));
    } finally {
      setBusy(false);
    }
  };
```

`StepPane` receives `project` as `{ path: string }`; the store wants `{ id: string }`, so pass the project id from `WorkflowsView` (`project` is a `ProjectRef` there, which has `id`). Change `StepPaneProps.project` to `ProjectRef` and use `project.id` / `project.path` directly.

- [ ] **Step 2: Type check**

Run: `bun run type-check:ui`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/views/workflows/StepPane.tsx
git commit -m "feat(workflows): the actions a person takes on a step"
```

---

### Task 8: The chat banner and the sidebar rows

**Files:**
- Create: `packages/ui/src/components/chat/WorkflowStepBanner.tsx`
- Modify: the chat transcript header that already renders `AutoReviewBanner` (`packages/ui/src/components/chat/AutoReviewBanner.tsx` is the pattern; find its mount point and add this one beside it)
- Read (not modified): `packages/ui/src/components/session/sidebar/sessions/RunSidebarRow.tsx`, the multi-run grouping this task decided not to reuse

**Interfaces:**
- Consumes: Task 2's store, Task 1's client.
- Produces: `<WorkflowStepBanner sessionId directory />`, which finds the run whose step attempt owns the open session and offers confirm and continue from the transcript.

- [ ] **Step 1: Write the banner**

```tsx
// packages/ui/src/components/chat/WorkflowStepBanner.tsx
/**
 * The banner a step's own session shows.
 *
 * A person working in the transcript should not have to find the run screen to
 * answer the step they are looking at. The banner only appears when the open
 * session is the session of a step attempt, and it names the run and the step so
 * the answer cannot land on the wrong one.
 */
import { useMemo } from 'react';

import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { confirmWorkflowStep, promptWorkflowStep } from '@/lib/workflowsApi';
import { useWorkflowStore } from '@/stores/useWorkflowStore';

export interface WorkflowStepBannerProps {
  sessionId: string;
  project: { id: string; path: string };
}

export const WorkflowStepBanner = ({ sessionId, project }: WorkflowStepBannerProps) => {
  const { t } = useI18n();
  const entry = useWorkflowStore((state) => state.getEntry(project));
  const setRun = useWorkflowStore((state) => state.setRun);

  // A `session: reuse` step continues the session of the nearest preceding
  // attempt, so two steps can name the same session. The run's own cursor is the
  // step that is live in it; anything else is a step that has finished with that
  // session, and answering the live one from here is the point of the banner.
  const found = useMemo(() => {
    let fallback: { run: WorkflowRun; step: WorkflowStep } | null = null;
    for (const run of entry.runs) {
      for (const step of run.steps) {
        const attempt = step.attempts.at(-1);
        if (attempt?.sessionId !== sessionId) continue;
        if (run.cursor === step.id) return { run, step };
        fallback = { run, step };
      }
    }
    return fallback;
  }, [entry.runs, sessionId]);

  if (!found) return null;
  const needsAnswer = found.step.status === 'waiting_confirm' || found.step.status === 'needs_work' || found.step.status === 'blocked' || found.step.status === 'interrupted';

  // A frame carries only each step's status, never its attempts, so a step that
  // reached a stop while this project was already loaded still shows its last
  // attempt as `running` and the confirm would stay disabled. One read of that
  // run settles it; the key keeps it to one read per step and status.
  useEffect(() => {
    if (!needsAnswer) return;
    const attempt = found.step.attempts.at(-1);
    if (attempt?.status === 'completed') return;
    let cancelled = false;
    void fetchWorkflowRun(project.path, found.run.runId)
      .then((next) => { if (!cancelled) setRun(project, next); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [needsAnswer, found.run.runId, found.step.id, found.step.status, found.step.attempts.length, project.path, setRun]);

  return (
    <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs">
      <span className="font-medium">{t('workflows.banner.title')}</span>
      <span className="text-muted-foreground">{found.run.workflowId} · {found.step.id}</span>
      {needsAnswer ? (
        <>
          <span className="text-muted-foreground">{found.step.status === 'blocked' ? t('workflows.banner.blocked') : t('workflows.banner.waiting')}</span>
          <Button size="xs" className="ml-auto" onClick={() => void confirmWorkflowStep(project.path, found.run.runId, found.step.id, 'done').then((run) => setRun(project, run))}>
            {t('workflows.step.confirmDone')}
          </Button>
        </>
      ) : null}
    </div>
  );
};
```

Wire it where the transcript header renders, next to `AutoReviewBanner`. If `AutoReviewBanner` is mounted from a message-list component rather than a header, follow that mount point exactly; the banner belongs where the person's attention already is.

- [ ] **Step 2: Group the step sessions in the sidebar**

The sessions a run created are ordinary sessions with a title the engine set (`<workflowId> <stepId>`).

Grouping them the way multi-run does was attempted and dropped. `RunSidebarRow` opens its overview by a key that only the session-metadata multirun index resolves (`sessionSidebarRowModel.ts:147-172`), so reusing it means inventing run identity or writing metadata onto sessions; the second route (a group row derived from the workflow store) would restructure a large list for a cosmetic gain. Ruling: dropped, not half-built. A run's sessions stay ordinary rows whose titles name the run and the step. — Cost if wrong: a person with several runs in flight reads the sidebar by title instead of by group.

- [ ] **Step 3: Type check and commit**

```bash
bun run type-check:ui
git add packages/ui/src/components/chat/WorkflowStepBanner.tsx packages/ui/src/components/session/sidebar
git commit -m "feat(workflows): answer a step from its session"
```

---

### Task 9: The definition diagram tab

**Files:**
- Create: `packages/ui/src/components/views/workflows/WorkflowDiagram.tsx`
- Modify: `packages/ui/src/components/views/workflows/RunDetail.tsx` (a tab for the definition)

**Interfaces:**
- Consumes: `SimpleMarkdownRenderer` (`@/components/chat/MarkdownRenderer`), the definitions summary Task 0 extended with `steps`.
- Produces: `<WorkflowDiagram summary />`, a read-only drawing of the declared steps, plus the validation errors of a definition that does not load.

- [ ] **Step 1: Write the diagram**

The app already renders mermaid: a fenced ```mermaid block inside `SimpleMarkdownRenderer` goes through `MarkdownRendererImpl`'s decorate context, which builds theme-aware colours from the current theme (`MarkdownRendererImpl.tsx:775-785`), caches the render and honours the user's ASCII/SVG preference. `PlanView.tsx:984` is the precedent for using that renderer in a view. So this component builds the mermaid source and hands it over; it does not render SVG itself, does not import `beautiful-mermaid`, and does not use `dangerouslySetInnerHTML`.

```tsx
// packages/ui/src/components/views/workflows/WorkflowDiagram.tsx
/**
 * The declared workflow as a diagram.
 *
 * The source is a mermaid fence handed to the app's markdown renderer, so the
 * diagram follows the theme, the user's mermaid mode and the render cache the
 * chat already uses. It shows the definition, which does not change, and never
 * the live status: that is the timeline's job.
 */
import { useMemo } from 'react';

import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useI18n } from '@/lib/i18n';
import type { WorkflowDefinitionSummary, WorkflowStepDefinition } from '@/lib/workflowsApi';

export interface WorkflowDiagramProps {
  summary: WorkflowDefinitionSummary;
}

const mermaidSource = (steps: WorkflowStepDefinition[]) => {
  const lines = ['flowchart TD'];
  steps.forEach((step, index) => {
    const label = `${step.id}${step.confirm === 'auto' ? ' (auto)' : ''}`;
    lines.push(`  s${index}["${label}"]`);
    if (index > 0) lines.push(`  s${index - 1} --> s${index}`);
  });
  return lines.join('\n');
};

export const WorkflowDiagram = ({ summary }: WorkflowDiagramProps) => {
  const { t } = useI18n();
  const content = useMemo(
    () => (summary.steps.length > 0 ? `\`\`\`mermaid\n${mermaidSource(summary.steps)}\n\`\`\`` : ''),
    [summary.steps],
  );

  if (summary.errors.length > 0) {
    return (
      <div className="p-3 text-xs">
        <p className="text-destructive">{t('workflows.definition.invalid')}</p>
        <ul className="mt-1 flex flex-col gap-0.5">
          {summary.errors.map((error) => (
            <li key={`${error.field}:${error.message}`} className="font-mono text-[11px] text-muted-foreground">{error.field}: {error.message}</li>
          ))}
        </ul>
      </div>
    );
  }

  if (!content) {
    return <div className="p-3 text-xs text-muted-foreground">{t('workflows.definition.diagram')}</div>;
  }

  return <SimpleMarkdownRenderer content={content} className="typography-markdown-body" enableFileReferences={false} />;
};
```

The step ids a definition may carry are restricted to lowercase words and dashes by the parser, so nothing a person typed can reach the fence as markup.

- [ ] **Step 2: Add the tab**

`RunDetail` already carries the two-tab header and renders `WorkflowDiagram` from its `definition` prop (Task 5b), so nothing is added here. The prop is filled by `WorkflowsView` (Task 3b), which owns the definitions list:

```tsx
const definition = entry?.definitions.find((candidate) => candidate.id === run.workflowId) ?? null;
```

The steps come from that summary's `steps` field, which Task 0 added to the route. If a definition does not load, its `errors` are shown instead of a diagram, which is the point of keeping a broken file in the list.

- [ ] **Step 3: Type check and commit**

```bash
bun run type-check:ui
git add packages/ui/src/components/views/workflows/WorkflowDiagram.tsx packages/ui/src/components/views/workflows/RunDetail.tsx
git commit -m "feat(workflows): draw the declared workflow"
```

---

### Task 10: Browser smoke

**Files:**
- Modify: nothing, unless the smoke finds a defect.

**Interfaces:**
- Consumes: everything above, and a project whose `.openchamber/workflows/` holds the two-step fixture from the engine plan.
- Produces: the observed evidence that the screens work on a real run.

- [ ] **Step 1: Start the real server against the fixture project**

Reuse the engine plan's smoke project (`/tmp/wf-smoke-*`) or create one the same way, then:

```bash
bun packages/web/server/index.js --port 4199
```

- [ ] **Step 2: Drive the screens in a real browser**

Open the app on that port, add the fixture project, and, with the browser's own tooling (not jsdom):

1. Open the workflows surface from the rail. Observed: the run created during the engine smoke is listed with its status, and a definition with a broken file shows its errors instead of vanishing from the list.
2. Select the run. Observed: the step sequence renders with a label and an icon per step, the finished step carries its checkpoint commit and artifact hashes, and the waiting step carries its verifier result.
3. Click "run this step" on the waiting step. Observed: the button disables while the turn runs, the step shows `running` with a spinner, and it returns to `waiting_confirm` when the turn ends.
4. Click "run this step" twice quickly. Observed: one attempt appears, and the second click's message is the server's `this run is already executing a step`.
5. Type a prompt and send it. Observed: a second attempt lands in the same session (the session id is unchanged) with the new prompt text shown.
6. Confirm done. Observed: a new checkpoint commit appears for that step, and the next step becomes current. Check `git -C "$DIR" log --oneline` for the new subject.
7. Stop the server, reload the page, and reopen the surface while the server is down. Observed: the surface shows the read error, not "no runs yet". Start the server again and confirm the list recovers.
8. Open the step's session in the chat. Observed: the workflow banner names the run and the step and offers the same confirm.
9. Switch the app theme between light and dark with a step in each of the four tones on screen. Observed: each status stays legible in both.

Report the observed result of each step. A step that cannot be driven is reported as unproven, not as passing.

- [ ] **Step 3: Final checks and commit**

```bash
bun run --cwd packages/ui test
bun run type-check:ui
bunx oxlint packages/ui/src/lib/workflowsApi.ts packages/ui/src/lib/workflows packages/ui/src/stores/useWorkflowStore.ts packages/ui/src/components/views/workflows
git add packages/ui/src
git commit -m "chore(workflows): whole-branch checks for the screens"
```

- [ ] **Step 4: Record the evidence**

Add rows for these screens to `docs/agent-host/FUNCTION-STATUS.md`, marked with what was actually driven and what was not. Windows and Linux were never run for this repo, so those platforms stay `UNTESTED`.
