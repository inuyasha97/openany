import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { registerWorkflowRoutes } from './routes.js';

const run = { runId: '11111111-2222-4333-8444-555555555555', projectId: 'proj-1', status: 'idle', cursor: 'first', steps: [] };
const SCOPE = { 'x-opencode-directory': '/tmp/proj' };

const createApp = (overrides = {}) => {
  const calls = [];
  const runtime = {
    definitions: {
      list: async () => [{ file: 'a.yaml', id: 'a', name: 'A', version: 1, errors: [], definition: null }],
      read: async () => null,
    },
    store: {
      list: async () => [run],
      read: async () => run,
      create: async (value) => { calls.push(['create', value]); return value; },
      remove: async () => true,
    },
    engine: {
      startStep: async (value) => { calls.push(['startStep', value]); return run; },
      runUntilStop: async () => run,
      continueStep: async () => run,
      confirmStep: async (value) => { calls.push(['confirmStep', value]); return run; },
      verifyStep: async () => run,
      cancelRun: async () => run,
    },
    resolveProjectId: () => 'proj-1',
    projectPathFromId: () => '/tmp/proj',
    // Mirrors `createWorkflowRuntime`'s default: the identity until a caller
    // injects a canonicalizing normalizer.
    normalizeDirectoryPath: (value) => value,
    ...overrides,
  };
  const app = express();
  registerWorkflowRoutes(app, { workflowsRuntime: runtime });
  return { app, calls, runtime };
};

describe('workflow routes', () => {
  it('lists definitions for a project directory', async () => {
    const { app } = createApp();
    const response = await request(app).get('/api/workflows/definitions').set(SCOPE);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ definitions: [{ file: 'a.yaml', id: 'a', name: 'A', version: 1, errors: [], steps: [], inputs: [], sandbox: null }] });
  });

  it('returns the declared steps of a valid definition', async () => {
    const { app } = createApp({
      definitions: {
        list: async () => [{
          file: 'a.yaml', id: 'a', name: 'A', version: 1, errors: [],
          definition: { id: 'a', name: 'A', version: 1, sandbox: 'working-tree', inputs: [], steps: [{ id: 'first', title: 'First', prompt: 'x', session: 'new', permissions: 'ask', verify: { artifacts: [], commands: [] }, confirm: 'human' }] },
        }],
        read: async () => null,
      },
    });
    const response = await request(app).get('/api/workflows/definitions').set(SCOPE);
    expect(response.body.definitions[0].steps.map((step) => step.id)).toEqual(['first']);
    expect(response.body.definitions[0].inputs).toEqual([]);
    expect(response.body.definitions[0].sandbox).toBe('working-tree');
  });

  it('returns the declared inputs of a valid definition', async () => {
    const { app } = createApp({
      definitions: {
        list: async () => [{
          file: 'a.yaml', id: 'a', name: 'A', version: 1, errors: [],
          definition: { id: 'a', name: 'A', version: 1, inputs: [{ name: 'request', description: 'What to build', required: true }], steps: [] },
        }],
        read: async () => null,
      },
    });
    const response = await request(app).get('/api/workflows/definitions').set(SCOPE);
    expect(response.body.definitions[0].inputs).toEqual([{ name: 'request', description: 'What to build', required: true }]);
    // The definition object carries no `sandbox` field at all: the summary
    // reports `null`, not a missing key.
    expect(response.body.definitions[0].sandbox).toBeNull();
  });

  it('forbids caching every workflow response', async () => {
    const { app } = createApp();
    const response = await request(app).get('/api/workflows/runs').set(SCOPE);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('normalizes a directory before deriving the project id, so a symlink and its realpath name one project', async () => {
    const seen = [];
    const { app } = createApp({
      normalizeDirectoryPath: (value) => (value === '/tmp/link/proj' ? '/tmp/real/proj' : value),
      resolveProjectId: (directory) => { seen.push(directory); return `id:${directory}`; },
    });
    await request(app).get('/api/workflows/runs').set({ 'x-opencode-directory': '/tmp/link/proj' });
    await request(app).get('/api/workflows/runs').set({ 'x-opencode-directory': '/tmp/real/proj' });
    expect(seen).toEqual(['/tmp/real/proj', '/tmp/real/proj']);
    expect(new Set(seen).size).toBe(1);
  });

  it('answers 400 when the project header is missing', async () => {
    const { app } = createApp();
    const response = await request(app).get('/api/workflows/definitions');
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('x-opencode-directory is required');
  });

  it('creates a run from a definition with its inputs', async () => {
    const { app, calls } = createApp({
      definitions: { list: async () => [], read: async () => ({ id: 'a', version: 3, sandbox: 'working-tree', inputs: [{ name: 'request', required: true }], steps: [{ id: 'first' }, { id: 'second' }] }) },
    });
    const response = await request(app).post('/api/workflows/runs').set(SCOPE).send({ workflowId: 'a', inputs: { request: 'x' } });
    expect(response.status).toBe(201);
    expect(calls[0][0]).toBe('create');
    expect(calls[0][1]).toMatchObject({ projectId: 'proj-1', directory: '/tmp/proj', workflowId: 'a', workflowVersion: 3, inputs: { request: 'x' }, status: 'idle', sandbox: 'working-tree' });
    expect(calls[0][1].steps.map((step) => [step.id, step.status])).toEqual([['first', 'pending'], ['second', 'pending']]);
  });

  it('records the sandbox the definition declared, not a fixed one', async () => {
    const { app, calls } = createApp({
      definitions: { list: async () => [], read: async () => ({ id: 'a', version: 1, sandbox: 'worktree', inputs: [], steps: [{ id: 'first' }] }) },
    });
    const response = await request(app).post('/api/workflows/runs').set(SCOPE).send({ workflowId: 'a' });
    expect(response.status).toBe(201);
    expect(calls[0][1].sandbox).toBe('worktree');
  });

  it('refuses a run whose required input has no value', async () => {
    const { app } = createApp({
      definitions: { list: async () => [], read: async () => ({ id: 'a', version: 1, inputs: [{ name: 'request', required: true }], steps: [{ id: 'first' }] }) },
    });
    const response = await request(app).post('/api/workflows/runs').set(SCOPE).send({ workflowId: 'a' });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('input "request" is required');
  });

  it('parses a body, because there is no global json parser', async () => {
    const { app, calls } = createApp();
    const response = await request(app)
      .post('/api/workflows/runs/11111111-2222-4333-8444-555555555555/steps/first/confirm')
      .set(SCOPE)
      .send({ decision: 'done' });
    expect(response.status).toBe(200);
    expect(calls[0][1]).toMatchObject({ decision: 'done', stepId: 'first' });
  });

  it('rejects an unknown decision with 400', async () => {
    const { app } = createApp();
    const response = await request(app)
      .post('/api/workflows/runs/11111111-2222-4333-8444-555555555555/steps/first/confirm')
      .set(SCOPE)
      .send({ decision: 'maybe' });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/decision/);
  });

  it('maps an engine WorkflowError to its status and its message', async () => {
    const { app } = createApp({
      engine: {
        // This request goes to `/run`, which the routes map to `runUntilStop`.
        runUntilStop: async () => {
          const error = new Error('this run is already executing a step');
          error.code = 'busy';
          error.status = 409;
          throw error;
        },
      },
    });
    const response = await request(app).post('/api/workflows/runs/11111111-2222-4333-8444-555555555555/run').set(SCOPE).send({});
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('this run is already executing a step');
  });

  it('decodes a marked directory header, so an encoded path names the same project', async () => {
    const seen = [];
    const { app } = createApp({ resolveProjectId: (directory) => { seen.push(directory); return directory === '/tmp/proj' ? 'proj-1' : ''; } });
    const response = await request(app)
      .get('/api/workflows/definitions')
      .set({ 'x-opencode-directory': encodeURIComponent('/tmp/proj'), 'x-opencode-directory-encoding': 'uri' });
    expect(response.status).toBe(200);
    expect(seen).toEqual(['/tmp/proj']);
  });

  it('answers 400 for a run id the store would refuse', async () => {
    const { app } = createApp();
    const response = await request(app).get('/api/workflows/runs/abc').set(SCOPE);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('the run id is not valid');
  });

  it('deletes one run and answers 404 when there is none', async () => {
    const { app } = createApp();
    expect((await request(app).delete('/api/workflows/runs/11111111-2222-4333-8444-555555555555').set(SCOPE)).status).toBe(200);
    const missing = createApp({ store: { read: async () => null, remove: async () => false, list: async () => [] } });
    expect((await request(missing.app).delete('/api/workflows/runs/11111111-2222-4333-8444-555555555555').set(SCOPE)).status).toBe(404);
  });
});
