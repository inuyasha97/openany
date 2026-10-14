import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reconcileRuns } from './resume.js';
import { createWorkflowRunStore } from './store.js';

let root;
let store;

const baseRun = (overrides = {}) => ({
  runId: '11111111-2222-4333-8444-555555555555',
  projectId: 'proj-1',
  directory: '/tmp/proj',
  workflowId: 'two-step',
  workflowVersion: 1,
  workflowHash: 'hash',
  inputs: {},
  status: 'running',
  cursor: 'second',
  createdAt: 1,
  sandbox: 'working-tree',
  steps: [
    { id: 'first', status: 'done', attempts: [{ index: 0, sessionId: 'session-1', status: 'completed' }], checkpoint: { at: 1, commit: 'a'.repeat(40), clean: false, artifacts: [] }, note: null },
    { id: 'second', status: 'running', attempts: [{ index: 0, sessionId: 'session-9', status: 'running' }], checkpoint: null, note: null },
  ],
  ...overrides,
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-resume-'));
  store = createWorkflowRunStore({ fsPromises: fs, path, projectsDirPath: root, now: () => 42 });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const deps = (overrides = {}) => ({
  store,
  definitions: { read: async () => ({ id: 'two-step', steps: [{ id: 'first' }, { id: 'second' }] }) },
  host: { getSessionStatus: async () => ({ busy: false }), listSessions: async () => [{ id: 'session-9' }] },
  verifyCheckpoint: async () => ({ ok: true, mismatches: [] }),
  listProjectIds: async () => ['proj-1'],
  logger: { warn: () => {} },
  ...overrides,
});

describe('reconcileRuns', () => {
  it('marks a step that was running when the server stopped as interrupted', async () => {
    await store.create(baseRun());
    const summary = await reconcileRuns(deps());
    const run = await store.read('proj-1', baseRun().runId);
    expect(summary.interrupted).toBe(1);
    expect(run.steps[1].status).toBe('interrupted');
    expect(run.status).toBe('waiting');
  });

  it('blocks the run when a checkpoint no longer matches', async () => {
    await store.create(baseRun());
    const summary = await reconcileRuns(deps({ verifyCheckpoint: async () => ({ ok: false, mismatches: [{ path: 'a.md', reason: 'changed' }] }) }));
    const run = await store.read('proj-1', baseRun().runId);
    expect(summary.blocked).toBe(1);
    expect(run.status).toBe('waiting');
    expect(run.steps[0].status).toBe('done');
    expect(run.steps[0].note).toMatch(/a\.md \(changed\)/);
    expect(run.cursor).toBe('first');
  });

  it('leaves a run alone when its session is gone', async () => {
    await store.create(baseRun());
    const summary = await reconcileRuns(deps({ host: { getSessionStatus: async () => ({ busy: false }), listSessions: async () => [] } }));
    const run = await store.read('proj-1', baseRun().runId);
    expect(summary.blocked).toBe(1);
    expect(run.steps[1].status).toBe('interrupted');
    expect(run.steps[1].note).toMatch(/session .* is no longer known/);
  });

  it('leaves a finished run untouched', async () => {
    await store.create(baseRun({ status: 'done', steps: [{ id: 'first', status: 'done', attempts: [], checkpoint: null, note: null }, { id: 'second', status: 'done', attempts: [], checkpoint: null, note: null }] }));
    const summary = await reconcileRuns(deps());
    expect(summary).toMatchObject({ runs: 0, interrupted: 0, blocked: 0 });
  });

  it('keeps the first blocked step as the cursor, not the last', async () => {
    await store.create(baseRun({
      steps: [
        { id: 'first', status: 'done', attempts: [], checkpoint: { at: 1, commit: 'a'.repeat(40), clean: false, artifacts: [{ path: 'a.md', size: 1, sha256: 'x' }] }, note: null },
        { id: 'second', status: 'done', attempts: [], checkpoint: { at: 2, commit: 'b'.repeat(40), clean: false, artifacts: [{ path: 'b.md', size: 1, sha256: 'y' }] }, note: null },
      ],
    }));
    const summary = await reconcileRuns(deps({ verifyCheckpoint: async () => ({ ok: false, mismatches: [{ path: 'x.md', reason: 'changed' }] }) }));
    const run = await store.read('proj-1', baseRun().runId);
    // Both steps fail their check; the run's cursor has to point at the first of
    // them, or the earlier block is invisible and the run can later read `done`.
    expect(summary).toMatchObject({ runs: 1, blocked: 1 });
    expect(run.cursor).toBe('first');
    expect(run.status).toBe('waiting');
  });

  it('does not let one unreadable project cost the others their sweep', async () => {
    await store.create(baseRun());
    const summary = await reconcileRuns(deps({
      listProjectIds: async () => ['bad/project', 'proj-1'],
      logger: { warn: () => {} },
    }));
    expect(summary.interrupted).toBe(1);
    expect((await store.read('proj-1', baseRun().runId)).steps[1].status).toBe('interrupted');
  });

  it('skips a project whose run is executing right now', async () => {
    await store.create(baseRun());
    const summary = await reconcileRuns(deps({ isProjectBusy: (projectId) => projectId === 'proj-1' }));
    const run = await store.read('proj-1', baseRun().runId);
    expect(summary).toMatchObject({ runs: 0, interrupted: 0 });
    expect(run.steps[1].status).toBe('running');
  });
});
