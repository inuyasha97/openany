import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

/**
 * The client is replaced through `mock.module`, the way the stores' own tests do
 * it (`stores/messageQueueStore.test.ts:6`). Each queue holds the answers for the
 * next calls, so a test can hand back data, an error, or a promise it releases
 * later.
 *
 * The replacement is process-global, so it is also what the other suite that
 * imports this module sees. It therefore keeps every real export and only
 * answers a call the queues have an entry for; a call with nothing queued falls
 * through to the real client, which is what `workflowsApi.test.ts` exercises.
 */
const real = { ...(await import('@/lib/workflowsApi')) };
// A plain copy, not the live namespace: after `mock.module` the namespace's own
// properties are the replacement, so reading the real readers off it lazily
// inside the factory would answer with the mock and recurse.

const runsQueue: Array<() => unknown> = [];
const definitionsQueue: Array<() => unknown> = [];
const take = async (queue: Array<() => unknown>, fallback: () => Promise<unknown>) => {
  const next = queue.shift();
  return next ? await next() : fallback();
};

mock.module('@/lib/workflowsApi', () => ({
  ...real,
  fetchWorkflowRuns: (directory: string) => take(runsQueue, () => real.fetchWorkflowRuns(directory)),
  fetchWorkflowDefinitions: (directory: string) => take(definitionsQueue, () => real.fetchWorkflowDefinitions(directory)),
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
  steps: [{ id: 'spec', status: 'pending', attempts: [], note: null }],
  ...overrides,
});

beforeEach(() => {
  runsQueue.length = 0;
  definitionsQueue.length = 0;
  useWorkflowStore.setState({ entries: {}, pendingFrames: {} });
});

// Nothing queued may outlive this file: a leftover here would answer a real
// call `workflowsApi.test.ts` makes through the same process-global mock.
afterEach(() => {
  runsQueue.length = 0;
  definitionsQueue.length = 0;
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
    const { promise: pending, resolve: release } = Promise.withResolvers<unknown>();
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

  it('does not let a slow load overwrite a frame for a run it already knows', async () => {
    runsQueue.push(() => [run()]);
    definitionsQueue.push(() => []);
    await useWorkflowStore.getState().load(project);

    const { promise: pending, resolve: release } = Promise.withResolvers<unknown>();
    runsQueue.push(() => pending);
    definitionsQueue.push(() => []);
    const loading = useWorkflowStore.getState().load(project, { force: true });

    useWorkflowStore.getState().applyRunFrame({ runId: 'r1', projectId: 'path_proj', status: 'waiting', cursor: 'spec', steps: [{ id: 'spec', status: 'waiting_confirm' }] });
    // The read resolves with the snapshot it took before that frame.
    release([run()]);
    await loading;

    const entry = useWorkflowStore.getState().getEntry(project);
    expect(entry.runs[0].status).toBe('waiting');
    expect(entry.runs[0].steps[0].status).toBe('waiting_confirm');
  });

  it('does not re-apply a frame that arrived before a later load started', async () => {
    runsQueue.push(() => [run()]);
    definitionsQueue.push(() => []);
    await useWorkflowStore.getState().load(project);

    useWorkflowStore.getState().applyRunFrame({ runId: 'r1', projectId: 'path_proj', status: 'waiting', cursor: 'spec', steps: [{ id: 'spec', status: 'waiting_confirm' }] });

    // Nothing was in flight when that frame arrived, so a later load's payload is
    // the newer truth and must win.
    runsQueue.push(() => [run({ status: 'done', steps: [{ id: 'spec', status: 'done', attempts: [], note: null }] })]);
    definitionsQueue.push(() => []);
    await useWorkflowStore.getState().load(project, { force: true });

    expect(useWorkflowStore.getState().getEntry(project).runs[0].status).toBe('done');
  });

  it('patches the cache from a frame that arrives while idle', async () => {
    runsQueue.push(() => [run()]);
    definitionsQueue.push(() => []);
    await useWorkflowStore.getState().load(project);

    useWorkflowStore.getState().applyRunFrame({ runId: 'r1', projectId: 'path_proj', status: 'waiting', cursor: 'spec', steps: [{ id: 'spec', status: 'waiting_confirm' }] });

    // No read asked for: the frame alone must move what the screen shows.
    const entry = useWorkflowStore.getState().getEntry(project);
    expect(entry.runs[0].status).toBe('waiting');
    expect(entry.runs[0].steps[0].status).toBe('waiting_confirm');
  });

  it('drops a frame remembered by a load that fails', async () => {
    runsQueue.push(() => [run()]);
    definitionsQueue.push(() => []);
    await useWorkflowStore.getState().load(project);

    const { promise: failing, reject } = Promise.withResolvers<unknown>();
    runsQueue.push(() => failing);
    definitionsQueue.push(() => []);
    const loading = useWorkflowStore.getState().load(project, { force: true });

    // Remembered while that load is in flight, then the load fails.
    useWorkflowStore.getState().applyRunFrame({ runId: 'r1', projectId: 'path_proj', status: 'waiting', cursor: 'spec', steps: [{ id: 'spec', status: 'waiting_confirm' }] });
    reject(new Error('the server went away'));
    await loading;

    // Dropped with that load, so a later read's newer payload wins.
    runsQueue.push(() => [run({ status: 'done', steps: [{ id: 'spec', status: 'done', attempts: [], note: null }] })]);
    definitionsQueue.push(() => []);
    await useWorkflowStore.getState().load(project, { force: true });

    expect(useWorkflowStore.getState().getEntry(project).runs[0].status).toBe('done');
  });
});

describe('applyRunFrame', () => {
  it('ignores a frame for a project this store has not loaded', () => {
    useWorkflowStore.getState().applyRunFrame({ runId: 'r9', projectId: 'other', status: 'running', cursor: null, steps: [] });
    expect(useWorkflowStore.getState().entries).toEqual({});
  });

  it('carries a release the frame names into the run in the entry', async () => {
    runsQueue.push(() => [run({ sandbox: 'worktree', worktreeBranch: 'omp/wf/r1' })]);
    definitionsQueue.push(() => []);
    await useWorkflowStore.getState().load(project);

    useWorkflowStore.getState().applyRunFrame({ runId: 'r1', projectId: 'path_proj', status: 'done', cursor: null, worktreeReleasedAt: 42, steps: [] });

    expect(useWorkflowStore.getState().getEntry(project).runs[0].worktreeReleasedAt).toBe(42);
  });

  it('leaves a release in place when a frame does not name it', async () => {
    runsQueue.push(() => [run({ sandbox: 'worktree', worktreeBranch: 'omp/wf/r1', worktreeReleasedAt: 42 })]);
    definitionsQueue.push(() => []);
    await useWorkflowStore.getState().load(project);

    useWorkflowStore.getState().applyRunFrame({ runId: 'r1', projectId: 'path_proj', status: 'done', cursor: null, steps: [] });

    expect(useWorkflowStore.getState().getEntry(project).runs[0].worktreeReleasedAt).toBe(42);
  });
});
