import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
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

const buildEngine = async ({ overrides = {} } = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-engine-'));
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
    steps: [
      { id: 'first', status: 'pending', attempts: [], checkpoint: null, note: null },
      { id: 'second', status: 'pending', attempts: [], checkpoint: null, note: null },
    ],
  };
  await fs.mkdir(path.join(root, 'out'), { recursive: true });
  const store = createWorkflowRunStore({ fsPromises: fs, path, projectsDirPath: root, now: () => 42 });
  await store.create(run);

  const prompts = [];
  const host = {
    createSession: async () => ({ id: 'session-1' }),
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

  it('blocks a step whose declared input has no value', async () => {
    const { engine, root, runId, store, run } = await buildEngine();
    await store.write({ ...run, inputs: {} });
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
    const { engine, root, runId } = await buildEngine({ overrides: { turn: () => new Promise(() => {}) } });
    const first = engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    await expect(engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' }))
      .rejects.toMatchObject({ code: 'busy' });
    void first.catch(() => {});
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
});
