import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reconcileRuns } from './resume.js';
import { createWorkflowEngine } from './engine.js';
import { createWorkflowRunStore } from './store.js';
import { recheckArtifacts, runVerifiers } from './verifiers.js';

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
    { id: 'first', status: 'done', attempts: [{ index: 0, sessionId: 'session-1', status: 'completed', verify: { ok: true, artifacts: [], commands: [] } }], note: null },
    { id: 'second', status: 'running', attempts: [{ index: 0, sessionId: 'session-9', status: 'running' }], note: null },
  ],
  ...overrides,
});

/** A step the person confirmed: its last attempt recorded what the check saw. */
const doneStep = (id, verify) => ({ id, status: 'done', attempts: [{ index: 0, sessionId: 'session-1', status: 'completed', verify }], note: null });

/** A project directory the sweep can read artifacts from. */
const projectDirectory = async () => {
  const directory = path.join(root, 'project');
  await fs.mkdir(directory, { recursive: true });
  return directory;
};

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
  recheckArtifacts,
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

  it('flags a step whose recorded artifact changed while the server was down', async () => {
    const directory = await projectDirectory();
    await fs.writeFile(path.join(directory, 'spec.md'), 'the body the step left behind');
    // The evidence is whatever `runVerifiers` recorded on the attempt, so the
    // fixture records it the way a real attempt does.
    const recorded = await runVerifiers({ step: { verify: { artifacts: [{ glob: 'spec.md', hash: true }] } }, directory });
    expect(recorded.ok).toBe(true);
    await store.create(baseRun({ directory, steps: [doneStep('first', recorded), baseRun().steps[1]] }));

    await fs.writeFile(path.join(directory, 'spec.md'), 'something else entirely');

    const summary = await reconcileRuns(deps());
    const run = await store.read('proj-1', baseRun().runId);
    expect(summary.blocked).toBe(1);
    expect(run.status).toBe('waiting');
    expect(run.steps[0].status).toBe('done');
    // The note names the path and the reason, because that is all a person has
    // to go on: the engine writes no commit they could look at instead.
    expect(run.steps[0].note).toBe('an artifact no longer matches: spec.md (changed)');
    expect(run.cursor).toBe('first');
  });

  it('flags a step whose recorded artifact vanished while the server was down', async () => {
    const directory = await projectDirectory();
    await fs.writeFile(path.join(directory, 'spec.md'), 'the body the step left behind');
    const recorded = await runVerifiers({ step: { verify: { artifacts: [{ glob: 'spec.md', hash: false }] } }, directory });
    await store.create(baseRun({ directory, steps: [doneStep('first', recorded), baseRun().steps[1]] }));

    await fs.rm(path.join(directory, 'spec.md'));

    const summary = await reconcileRuns(deps());
    const run = await store.read('proj-1', baseRun().runId);
    expect(summary.blocked).toBe(1);
    expect(run.steps[0].note).toBe('an artifact no longer matches: spec.md (missing)');
  });

  it('does not flag a step whose artifact is unhashed and still exists', async () => {
    const directory = await projectDirectory();
    await fs.writeFile(path.join(directory, 'notes.md'), 'one');
    const recorded = await runVerifiers({ step: { verify: { artifacts: [{ glob: 'notes.md', hash: false }] } }, directory });
    expect(recorded.artifacts[0].sha256).toBeNull();
    await store.create(baseRun({ directory, steps: [doneStep('first', recorded), baseRun().steps[1]] }));

    // No digest was recorded, so the contract is that the file is still there —
    // a file that changed is not a mismatch, or every unhashed step would read
    // broken on the first restart.
    await fs.writeFile(path.join(directory, 'notes.md'), 'a much longer body');

    const summary = await reconcileRuns(deps());
    const run = await store.read('proj-1', baseRun().runId);
    expect(summary.blocked).toBe(0);
    expect(run.steps[0].note).toBeNull();
  });

  it('skips a settled step that recorded no artifacts', async () => {
    // A step whose definition checks no artifact leaves `artifacts: []` behind,
    // and a step confirmed before an attempt settled leaves nothing at all.
    await store.create(baseRun({ steps: [doneStep('first', { ok: true, artifacts: [], commands: [] }), baseRun().steps[1]] }));
    const summary = await reconcileRuns(deps());
    expect(summary.blocked).toBe(0);
    expect((await store.read('proj-1', baseRun().runId)).steps[0].note).toBeNull();
  });

  it('does not re-check a step the person skipped', async () => {
    const directory = await projectDirectory();
    const recorded = { ok: true, artifacts: [{ path: 'gone.md', size: 1, sha256: 'a'.repeat(64) }], commands: [] };
    await store.create(baseRun({ directory, steps: [{ ...doneStep('first', recorded), status: 'skipped', note: 'not needed' }, baseRun().steps[1]] }));
    const summary = await reconcileRuns(deps());
    const run = await store.read('proj-1', baseRun().runId);
    // The person decided this step's work does not matter, so its missing
    // artifact is not a reason to block the run on it.
    expect(summary.blocked).toBe(0);
    expect(run.steps[0].note).toBe('not needed');
  });

  it('ignores a step field this release no longer reads, and still loads the run', async () => {
    // A run file written by an earlier release carries a field this engine
    // dropped. The store passes unknown keys through, so the file loads; the
    // sweep must not read that field, even where its content would have been a
    // mismatch, because the attempt is the record now.
    const dropped = { at: 1, artifacts: [{ path: 'gone.md', size: 1, sha256: 'a'.repeat(64) }] };
    await store.create(baseRun({ steps: [{ ...doneStep('first', { ok: true, artifacts: [], commands: [] }), previousReleaseField: dropped }, baseRun().steps[1]] }));
    expect((await store.read('proj-1', baseRun().runId)).steps[0].previousReleaseField).toEqual(dropped);

    const summary = await reconcileRuns(deps());
    expect(summary.blocked).toBe(0);
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
    await store.create(baseRun({ status: 'done', steps: [{ id: 'first', status: 'done', attempts: [], note: null }, { id: 'second', status: 'done', attempts: [], note: null }] }));
    const summary = await reconcileRuns(deps());
    expect(summary).toMatchObject({ runs: 0, interrupted: 0, blocked: 0 });
  });

  it('keeps the first blocked step as the cursor, not the last', async () => {
    const directory = await projectDirectory();
    await store.create(baseRun({
      directory,
      steps: [
        doneStep('first', { ok: true, artifacts: [{ path: 'a.md', size: 1, sha256: 'a'.repeat(64) }], commands: [] }),
        doneStep('second', { ok: true, artifacts: [{ path: 'b.md', size: 1, sha256: 'b'.repeat(64) }], commands: [] }),
      ],
    }));
    // Neither file is on disk, so both steps fail their re-check; the run's
    // cursor has to point at the first of them, or the earlier block is
    // invisible and the run can later read `done`.
    const summary = await reconcileRuns(deps());
    const run = await store.read('proj-1', baseRun().runId);
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
    expect(Object.keys(confirmed.steps[1]).sort()).toEqual(['attempts', 'id', 'note', 'status']);
    expect(confirmed.status).toBe('done');
  });
});
