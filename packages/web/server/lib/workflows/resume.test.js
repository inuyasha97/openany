import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reconcileRuns } from './resume.js';
import { createWorkflowEngine } from './engine.js';
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
    { id: 'second', status: 'running', attempts: [{ index: 0, sessionId: 'session-9', status: 'running' }], note: null },
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

describe('reconcileRuns and the session of an interrupted step', () => {
  it('settles the attempt of a step whose turn ended before the restart', async () => {
    await store.create(baseRun());
    const summary = await reconcileRuns(deps({ now: () => 42 }));
    const run = await store.read('proj-1', baseRun().runId);
    expect(summary.interrupted).toBe(1);
    // The session is idle, so the turn finished; the attempt is closed from that
    // evidence while the step still waits for a person.
    expect(run.steps[1].status).toBe('interrupted');
    expect(run.steps[1].attempts[0]).toMatchObject({ status: 'completed', endedAt: 42, turn: { outcome: 'unknown-after-restart' } });
    expect(run.status).toBe('waiting');
  });

  it('leaves the attempt running when the session is still busy', async () => {
    await store.create(baseRun());
    const summary = await reconcileRuns(deps({ host: { getSessionStatus: async () => ({ busy: true }), listSessions: async () => [{ id: 'session-9' }] } }));
    const run = await store.read('proj-1', baseRun().runId);
    expect(summary.interrupted).toBe(1);
    expect(run.steps[1].status).toBe('interrupted');
    expect(run.steps[1].attempts[0].status).toBe('running');
    expect(run.steps[1].attempts[0].endedAt).toBeUndefined();
    expect(run.steps[1].note).toMatch(/still running/);
  });

  it('always settles the attempt when the status call throws', async () => {
    await store.create(baseRun());
    await reconcileRuns(deps({ host: { getSessionStatus: async () => { throw new Error('the runtime is gone'); }, listSessions: async () => [{ id: 'session-9' }] } }));
    const run = await store.read('proj-1', baseRun().runId);
    expect(run.steps[1].attempts[0].status).toBe('completed');
  });

  it('does not touch a session a finished step already recorded', async () => {
    // `first` is done, so its session no longer matters: probing it (or letting
    // the settled-step rules skip it) must not disturb its record.
    await store.create(baseRun());
    const asked = [];
    await reconcileRuns(deps({ host: { getSessionStatus: async (id) => { asked.push(id); return { busy: false }; }, listSessions: async () => [{ id: 'session-1' }, { id: 'session-9' }] } }));
    expect(asked).toEqual(['session-9']);
  });

  it('lets a step whose turn ended before the restart be confirmed', async () => {
    await store.create(baseRun());
    await reconcileRuns(deps({ now: () => 42 }));
    const engine = createWorkflowEngine({
      store,
      definitions: { read: async () => ({ id: 'two-step', version: 1, steps: [{ id: 'first', prompt: 'x' }, { id: 'second', prompt: 'y' }] }) },
      host: { createSession: async () => ({ id: 'session-1' }), prompt: async () => true, getSessionStatus: async () => ({ busy: false }), listSessions: async () => [{ id: 'session-9' }], renameSession: async () => {}, setModel: async () => {}, setAutoAccept: async () => {} },
      runChecks: async () => ({ ok: true, artifacts: [], commands: [] }),
      now: () => 42,
      broadcast: () => {},
      logger: { warn: () => {}, error: () => {} },
    });
    // The step is interrupted, not finished; a fresh verdict is what reopens it,
    // and the attempt that already settled is what makes a confirmation possible
    // at all — before this fix `confirmStep` answered 409 forever.
    const verified = await engine.verifyStep({ projectId: 'proj-1', runId: baseRun().runId, stepId: 'second' });
    expect(verified.steps[1].status).toBe('waiting_confirm');
    const confirmed = await engine.confirmStep({ projectId: 'proj-1', runId: baseRun().runId, stepId: 'second', decision: 'done' });
    expect(confirmed.steps[1].status).toBe('done');
    expect(confirmed.steps[1].checkpoint).toBeUndefined();
    expect(confirmed.status).toBe('done');
  });
});
