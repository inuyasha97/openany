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
    runsQueue.push(() => [run({ status: 'done', steps: [{ id: 'spec', status: 'done', attempts: [], checkpoint: null, note: null }] })]);
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
});
