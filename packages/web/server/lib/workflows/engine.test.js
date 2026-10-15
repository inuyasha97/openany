import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkflowEngine } from './engine.js';
import { createWorkflowRunStore } from './store.js';
import { parseDefinition } from './definitions.js';

const definitionText = `
id: two-step
name: Two step
version: 1
inputs:
  - name: request
    required: true
steps:
  - id: first
    prompt: "Do {{request}}"
    confirm: human
    verify:
      artifacts: ["out/*.md"]
  - id: second
    prompt: "Check it"
    session: reuse
    confirm: human
`;

const definition = parseDefinition(definitionText, { file: 'two-step.yaml' }).definition;

// One engine per test, each with its own project directory; the suite removes
// them afterwards so a run never leaves `wf-engine-*` directories behind.
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const buildEngine = async ({ overrides = {} } = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-engine-'));
  roots.push(root);
  const run = {
    runId: '11111111-2222-4333-8444-555555555555',
    projectId: 'proj-1',
    directory: root,
    workflowId: 'two-step',
    workflowVersion: 1,
    workflowHash: 'hash',
    inputs: { request: 'the thing' },
    status: 'idle',
    cursor: 'first',
    createdAt: 1,
    sandbox: 'working-tree',
    steps: (overrides.stepIds ?? ['first', 'second']).map((id) => ({ id, status: 'pending', attempts: [], checkpoint: null, note: null })),
  };
  await fs.mkdir(path.join(root, 'out'), { recursive: true });
  const store = createWorkflowRunStore({ fsPromises: fs, path, projectsDirPath: root, now: () => 42 });
  await store.create(run);

  const prompts = [];
  let created = 0;
  const host = {
    createSession: async () => ({ id: `session-${created += 1}` }),
    prompt: async (sessionId, text) => { prompts.push({ sessionId, text }); return true; },
    getSessionStatus: async () => ({ busy: false }),
    listSessions: async () => [{ id: 'session-1', cwd: root }],
    renameSession: async () => {},
    setModel: async () => {},
    setAutoAccept: async () => {},
  };
  const engine = createWorkflowEngine({
    store,
    definitions: { read: async () => definition },
    host,
    checkpoints: { write: async ({ artifacts }) => ({ at: 42, commit: 'c'.repeat(40), clean: false, artifacts }) },
    turn: async () => 'completed',
    now: () => 42,
    broadcast: () => {},
    logger: { warn: () => {}, error: () => {} },
    ...overrides,
  });
  return { engine, store, host, prompts, root, runId: run.runId, run };
};

const refusingHost = () => ({
  createSession: async () => ({ id: 'session-1' }),
  prompt: async () => null,
  getSessionStatus: async () => ({ busy: false }),
  listSessions: async () => [],
  renameSession: async () => {},
  setModel: async () => {},
  setAutoAccept: async () => {},
});

// A send that rejects rather than answers `false`: the runtime is gone, the
// socket died, the request never got an answer.
const rejectingHost = (message) => ({
  ...refusingHost(),
  prompt: async () => { throw new Error(message); },
});

// The host is wired per call, so the toggle can be missing entirely; nothing
// else about the step changes.
const hostWithoutAutoAccept = () => ({
  createSession: async () => ({ id: 'session-1' }),
  prompt: async () => true,
  getSessionStatus: async () => ({ busy: false }),
  listSessions: async () => [],
  renameSession: async () => {},
  setModel: async () => {},
});

const autoDefinition = parseDefinition(`
id: two-step
name: Two step
version: 1
steps:
  - id: first
    prompt: "Write out/one.md"
    confirm: auto
    verify:
      artifacts: ["out/*.md"]
  - id: second
    prompt: "Check it"
    session: reuse
    confirm: human
`, { file: 'two-step.yaml' }).definition;

const autoPermissionsDefinition = parseDefinition(`
id: two-step
name: Two step
version: 1
steps:
  - id: first
    prompt: "Write out/one.md"
    permissions: auto
    confirm: auto
    verify:
      artifacts: ["out/*.md"]
  - id: second
    prompt: "Check it"
    session: reuse
    confirm: human
`, { file: 'two-step.yaml' }).definition;

describe('startStep', () => {
  it('prompts with the substituted input, verifies, and stops for a person', async () => {
    const { engine, prompts, root, runId } = await buildEngine();
    const run = await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    expect(prompts).toEqual([{ sessionId: 'session-1', text: 'Do the thing' }]);
    const step = run.steps[0];
    expect(step.status).toBe('needs_work');
    expect(step.attempts[0]).toMatchObject({ sessionId: 'session-1', status: 'completed' });
    expect(step.attempts[0].verify.ok).toBe(false);
    expect(run.status).toBe('waiting');
    expect(run.cursor).toBe('first');
  });

  it('waits for confirmation when the verifier passed', async () => {
    const { engine, root, runId } = await buildEngine();
    await fs.writeFile(path.join(root, 'out/a.md'), 'x');
    const run = await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    expect(run.steps[0].status).toBe('waiting_confirm');
    expect(run.steps[0].attempts[0].verify.ok).toBe(true);
  });

  it('advances on its own, with a checkpoint, when confirm is auto and the verifier passed', async () => {
    const { engine, root, runId } = await buildEngine({ overrides: { definitions: { read: async () => autoDefinition } } });
    await fs.writeFile(path.join(root, 'out/a.md'), 'x');
    const run = await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    expect(run.steps[0].status).toBe('done');
    expect(run.steps[0].checkpoint).toMatchObject({ commit: 'c'.repeat(40) });
    expect(run.cursor).toBe('second');
    expect(run.status).toBe('running');
  });

  it('records a refused prompt as blocked and never as a sent one', async () => {
    const { engine, root, runId } = await buildEngine({ overrides: { host: refusingHost() } });
    const run = await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    expect(run.steps[0].status).toBe('blocked');
    expect(run.steps[0].attempts[0]).toMatchObject({ status: 'blocked' });
    expect(run.steps[0].attempts[0].error.code).toBe('unavailable');
    expect(run.status).toBe('waiting');
  });

  it('settles an attempt whose send rejected instead of leaving it running', async () => {
    const { engine, root, runId, store } = await buildEngine({ overrides: { host: rejectingHost('the runtime is down') } });
    const run = await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    expect(run.steps[0].status).toBe('blocked');
    expect(run.steps[0].note).toBe('the runtime is down');
    // The attempt is settled, not left claiming a live turn: the run file on disk
    // says the same thing the answer does.
    expect(run.steps[0].attempts[0]).toMatchObject({ status: 'blocked', endedAt: 42, error: { code: 'unavailable', message: 'the runtime is down' } });
    expect(run.status).toBe('waiting');
    expect((await store.read('proj-1', runId)).steps[0].attempts[0].status).toBe('blocked');
    await expect(engine.confirmStep({ projectId: 'proj-1', runId, stepId: 'first', decision: 'done' }))
      .rejects.toMatchObject({ code: 'conflict' });
  });

  it('settles an attempt whose turn threw instead of leaving it running', async () => {
    const { engine, root, runId } = await buildEngine({ overrides: { turn: async () => { throw new Error('the status call failed'); } } });
    const run = await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    expect(run.steps[0].attempts[0]).toMatchObject({ status: 'blocked', error: { code: 'unavailable', message: 'the status call failed' } });
    expect(run.steps[0].status).toBe('blocked');
    expect(run.status).toBe('waiting');
  });

  it('runs a step whose host carries no auto-accept toggle', async () => {
    const { engine, root, runId } = await buildEngine({
      overrides: { definitions: { read: async () => autoPermissionsDefinition }, host: hostWithoutAutoAccept() },
    });
    await fs.writeFile(path.join(root, 'out/a.md'), 'x');
    const run = await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    expect(run.steps[0].status).toBe('done');
    expect(run.status).toBe('running');
  });

  it('blocks a step whose declared input has no value', async () => {
    const { engine, root, runId, store, run } = await buildEngine();
    await store.write(run.projectId, { ...run, inputs: {} });
    const result = await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    expect(result.steps[0].status).toBe('blocked');
    expect(result.steps[0].note).toBe('missing input: request');
  });

  it('reuses the session of the previous attempt when the step says reuse', async () => {
    const { engine, root, runId, prompts } = await buildEngine();
    await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'second' });
    expect(prompts.map((entry) => entry.sessionId)).toEqual(['session-1', 'session-1']);
  });

  it('refuses a second start while the first is still running', async () => {
    // The turn waits on a gate the test opens at the end, so nothing outlives the
    // test and the temp directory is not removed under a live attempt.
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const { engine, root, runId } = await buildEngine({ overrides: { turn: async () => { await gate; return 'completed'; } } });
    const first = engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    await expect(engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' }))
      .rejects.toMatchObject({ code: 'busy' });
    release();
    await first;
  });

  it('broadcasts the running step, because the request answers only after the turn', async () => {
    const frames = [];
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    let sawFrame = () => {};
    const anyFrame = new Promise((resolve) => { sawFrame = resolve; });
    const { engine, root, runId } = await buildEngine({
      overrides: {
        broadcast: (frame) => { frames.push(frame); sawFrame(); },
        turn: async () => { await gate; return 'completed'; },
      },
    });
    const first = engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    // The turn stays gated until `release`, so a frame showing the step running
    // can only exist if the engine broadcast it before waiting on the turn. The
    // wait is a race rather than one macrotask because `store.write` is async.
    await Promise.race([anyFrame, new Promise((resolve) => setTimeout(resolve, 1000))]);
    expect(frames.some((frame) => frame.properties.steps.some((step) => step.id === 'first' && step.status === 'running'))).toBe(true);
    release();
    await first;
  });

  it('refuses to cancel a run while a step is executing', async () => {
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const { engine, root, runId } = await buildEngine({ overrides: { turn: async () => { await gate; return 'completed'; } } });
    const first = engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    await expect(engine.cancelRun({ projectId: 'proj-1', runId }))
      .rejects.toMatchObject({ code: 'busy' });
    release();
    await first;
  });

  it('refuses to confirm a step whose attempt never finished', async () => {
    const { engine, store, run, runId } = await buildEngine();
    await store.write(run.projectId, {
      ...run,
      steps: run.steps.map((step) => (step.id === 'first'
        ? { ...step, status: 'blocked', attempts: [{ index: 0, sessionId: 'session-1', prompt: 'x', startedAt: 1, endedAt: null, status: 'blocked', turn: null, verify: { ok: true, artifacts: [], commands: [] }, error: { code: 'unavailable', message: 'no' } }] }
        : step)),
    });
    // The verdict is deliberately a pass, so a passing verifier cannot be the
    // reason the answer is refused: the unfinished attempt itself must be.
    await expect(engine.confirmStep({ projectId: 'proj-1', runId, stepId: 'first', decision: 'done' }))
      .rejects.toMatchObject({ code: 'conflict' });
  });

  it('answers not-found for a step the definition does not declare', async () => {
    const { engine, root, runId } = await buildEngine();
    await expect(engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'nope' }))
      .rejects.toMatchObject({ code: 'not-found' });
  });

  it('answers not-found for a run that is not on disk', async () => {
    const { engine, root } = await buildEngine();
    await expect(engine.startStep({ projectId: 'proj-1', projectPath: root, runId: '99999999-2222-4333-8444-555555555555', stepId: 'first' }))
      .rejects.toMatchObject({ code: 'not-found' });
  });

  it('continues the nearest preceding session, not the first one the run opened', async () => {
    const threeSteps = parseDefinition(`
id: two-step
name: Two step
version: 1
steps:
  - id: first
    prompt: "one"
    confirm: human
  - id: second
    prompt: "two"
    session: new
    confirm: human
  - id: third
    prompt: "three"
    session: reuse
    confirm: human
`, { file: 'two-step.yaml' }).definition;
    const { engine, root, runId, prompts } = await buildEngine({
      overrides: { definitions: { read: async () => threeSteps }, stepIds: ['first', 'second', 'third'] },
    });
    await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'second' });
    await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'third' });
    expect(prompts.map((entry) => entry.sessionId)).toEqual(['session-1', 'session-2', 'session-2']);
  });

  it('does not call a run done while a step behind the cursor still owes work', async () => {
    const autoLast = parseDefinition(`
id: two-step
name: Two step
version: 1
steps:
  - id: first
    prompt: "one"
    confirm: human
  - id: second
    prompt: "two"
    confirm: auto
    verify:
      artifacts: ["out/*.md"]
`, { file: 'two-step.yaml' }).definition;
    const { engine, root, runId } = await buildEngine({ overrides: { definitions: { read: async () => autoLast } } });
    await fs.writeFile(path.join(root, 'out/a.md'), 'x');
    const run = await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'second' });
    expect(run.steps[1].status).toBe('done');
    expect(run.cursor).toBeNull();
    // `first` never ran, so the run is waiting on it, not finished.
    expect(run.status).toBe('waiting');
  });

  it('returns a run that is already stopped instead of prompting its step again', async () => {
    const { engine, root, runId, prompts } = await buildEngine();
    await fs.writeFile(path.join(root, 'out/a.md'), 'x');
    await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    const before = prompts.length;
    const run = await engine.runUntilStop({ projectId: 'proj-1', projectPath: root, runId });
    expect(prompts.length).toBe(before);
    expect(run.steps[0].status).toBe('waiting_confirm');
    expect(run.steps[0].attempts).toHaveLength(1);
    expect(run.status).toBe('waiting');
  });
});

describe('confirmStep', () => {
  it('writes the checkpoint and advances on done', async () => {
    const { engine, root, runId } = await buildEngine();
    await fs.writeFile(path.join(root, 'out/a.md'), 'x');
    await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    const run = await engine.confirmStep({ projectId: 'proj-1', runId, stepId: 'first', decision: 'done' });
    expect(run.steps[0].status).toBe('done');
    expect(run.steps[0].checkpoint).toMatchObject({ commit: 'c'.repeat(40) });
    expect(run.cursor).toBe('second');
    expect(run.status).toBe('running');
  });

  it('keeps the step waiting when the answer is not_done', async () => {
    const { engine, root, runId } = await buildEngine();
    await fs.writeFile(path.join(root, 'out/a.md'), 'x');
    await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    const run = await engine.confirmStep({ projectId: 'proj-1', runId, stepId: 'first', decision: 'not_done', reason: 'the spec is thin' });
    expect(run.steps[0].status).toBe('needs_work');
    expect(run.steps[0].note).toBe('the spec is thin');
    expect(run.cursor).toBe('first');
  });

  it('skips a step and moves the cursor past it', async () => {
    const { engine, root, runId } = await buildEngine();
    const run = await engine.confirmStep({ projectId: 'proj-1', runId, stepId: 'first', decision: 'skip', reason: 'not needed' });
    expect(run.steps[0].status).toBe('skipped');
    expect(run.cursor).toBe('second');
    // The run still has a step to run, so it keeps running.
    expect(run.status).toBe('running');
  });

  it('settles the run when its last open step is skipped', async () => {
    const { engine, root, runId, store } = await buildEngine({ overrides: { stepIds: ['first'] } });
    const run = await engine.confirmStep({ projectId: 'proj-1', runId, stepId: 'first', decision: 'skip', reason: 'not needed' });
    expect(run.steps[0].status).toBe('skipped');
    expect(run.cursor).toBeNull();
    // Nothing is open and nothing is cursored: the run is over, and it says so on
    // disk as well, or neither `runUntilStop` nor the restart sweep can move it.
    expect(run.status).toBe('done');
    expect((await store.read('proj-1', runId)).status).toBe('done');
    await expect(engine.runUntilStop({ projectId: 'proj-1', projectPath: root, runId }))
      .rejects.toMatchObject({ code: 'conflict' });
  });

  it('refuses to run a step that is already settled', async () => {
    const { engine, root, runId, store, prompts } = await buildEngine();
    await engine.confirmStep({ projectId: 'proj-1', runId, stepId: 'first', decision: 'skip', reason: 'not needed' });
    await expect(engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' }))
      .rejects.toMatchObject({ code: 'conflict', message: 'step first is already settled' });
    const run = await store.read('proj-1', runId);
    expect(run.steps[0].attempts).toHaveLength(0);
    expect(prompts).toHaveLength(0);
  });

  it('refuses to confirm a step that never ran', async () => {
    const { engine, runId } = await buildEngine();
    await expect(engine.confirmStep({ projectId: 'proj-1', runId, stepId: 'second', decision: 'done' }))
      .rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('continueStep', () => {
  it('sends another prompt in the same session and counts a new attempt', async () => {
    const { engine, root, runId, prompts } = await buildEngine();
    await fs.writeFile(path.join(root, 'out/a.md'), 'x');
    await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    const run = await engine.continueStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first', text: 'tighten it' });
    expect(prompts.at(-1)).toEqual({ sessionId: 'session-1', text: 'tighten it' });
    expect(run.steps[0].attempts).toHaveLength(2);
    expect(run.steps[0].status).toBe('waiting_confirm');
  });

  it('refuses an empty prompt', async () => {
    const { engine, root, runId } = await buildEngine();
    await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    await expect(engine.continueStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first', text: '   ' }))
      .rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('cancelRun', () => {
  it('marks the run cancelled and keeps the steps as they were', async () => {
    const { engine, root, runId } = await buildEngine();
    await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    const run = await engine.cancelRun({ projectId: 'proj-1', runId });
    expect(run.status).toBe('cancelled');
    expect(run.steps[0].status).toBe('needs_work');
  });

  it('refuses every later per-step call instead of bringing the run back to life', async () => {
    const { engine, root, runId, store, prompts } = await buildEngine();
    await engine.cancelRun({ projectId: 'proj-1', runId });
    const calls = {
      startStep: () => engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' }),
      continueStep: () => engine.continueStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first', text: 'more' }),
      confirmStep: () => engine.confirmStep({ projectId: 'proj-1', runId, stepId: 'first', decision: 'done' }),
      verifyStep: () => engine.verifyStep({ projectId: 'proj-1', runId, stepId: 'first' }),
    };
    for (const [name, call] of Object.entries(calls)) {
      await expect(call(), name).rejects.toMatchObject({ code: 'conflict' });
    }
    // No call dispatched a turn, wrote an attempt or touched the run file's
    // status: the run is still cancelled on disk.
    const run = await store.read('proj-1', runId);
    expect(run.status).toBe('cancelled');
    expect(run.steps.every((step) => step.attempts.length === 0)).toBe(true);
    expect(prompts).toHaveLength(0);
  });
});

describe('runUntilStop', () => {
  it('holds the project lock for the whole loop, so a cancel cannot land between steps', async () => {
    let startedTurn = () => {};
    const turnStarted = new Promise((resolve) => { startedTurn = resolve; });
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const { engine, root, runId, prompts } = await buildEngine({
      overrides: { turn: async () => { startedTurn(); await gate; return 'completed'; } },
    });
    // `first` writes nothing, so its verifier fails and the loop stops there.
    const running = engine.runUntilStop({ projectId: 'proj-1', projectPath: root, runId });
    await turnStarted;
    // The lock started before the first step and is not released until the whole
    // loop is done, so nothing can cancel the run between two of its steps.
    await expect(engine.cancelRun({ projectId: 'proj-1', runId })).rejects.toMatchObject({ code: 'busy' });
    release();
    const run = await running;
    expect(prompts).toHaveLength(1);
    expect(run.cursor).toBe('first');
    expect(run.steps[1].attempts).toHaveLength(0);
    expect(run.status).toBe('waiting');
  });
});

describe('verifyStep', () => {
  it('re-runs the verifiers without prompting', async () => {
    const { engine, root, runId, prompts } = await buildEngine();
    await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    const before = prompts.length;
    const run = await engine.verifyStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    expect(prompts.length).toBe(before);
    expect(run.steps[0].attempts[0].verify.ok).toBe(false);
  });

  it('keeps the checkpoint note and moves a blocked step back to waiting_confirm', async () => {
    const { engine, store, run, runId } = await buildEngine();
    await fs.writeFile(path.join(run.directory, 'out/a.md'), 'x');
    const note = 'checkpoint no longer matches: out/a.md (changed)';
    await store.write(run.projectId, {
      ...run,
      status: 'waiting',
      steps: run.steps.map((step) => (step.id === 'first'
        ? { ...step, status: 'blocked', note, attempts: [{ index: 0, sessionId: 'session-1', prompt: 'x', startedAt: 1, endedAt: 2, status: 'completed', turn: 'completed', verify: { ok: false, artifacts: [], commands: [] }, error: null }] }
        : step)),
    });
    const verified = await engine.verifyStep({ projectId: 'proj-1', runId, stepId: 'first' });
    // The fresh verdict is a pass, but the broken checkpoint is still a fact, so
    // its note survives while the status follows the verdict.
    expect(verified.steps[0].status).toBe('waiting_confirm');
    expect(verified.steps[0].note).toBe(note);
  });

  it('moves a waiting step back to needs_work when the verifier fails', async () => {
    const { engine, store, run, runId } = await buildEngine();
    await store.write(run.projectId, {
      ...run,
      status: 'waiting',
      steps: run.steps.map((step) => (step.id === 'first'
        ? { ...step, status: 'waiting_confirm', note: null, attempts: [{ index: 0, sessionId: 'session-1', prompt: 'x', startedAt: 1, endedAt: 2, status: 'completed', turn: 'completed', verify: { ok: true, artifacts: [], commands: [] }, error: null }] }
        : step)),
    });
    const verified = await engine.verifyStep({ projectId: 'proj-1', runId, stepId: 'first' });
    expect(verified.steps[0].status).toBe('needs_work');
    expect(verified.steps[0].note).toBe('a verifier failed');
  });
});
