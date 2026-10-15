import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createWorkflowDefinitions } from './definitions.js';
import { createWorkflowEngine } from './engine.js';
import { registerWorkflowRoutes } from './routes.js';

const run = { runId: '11111111-2222-4333-8444-555555555555', projectId: 'proj-1', status: 'idle', cursor: 'first', steps: [] };
const SCOPE = { 'x-opencode-directory': '/tmp/proj' };

const createApp = (overrides = {}) => {
  const calls = [];
  const runtime = {
    definitions: {
      list: async () => [{ file: 'a.yaml', hash: 'h'.repeat(64), id: 'a', name: 'A', version: 1, errors: [], definition: null }],
      read: async () => null,
      readSource: async () => null,
      write: async (projectId, workflowId, raw, options) => { calls.push(['write', { projectId, workflowId, raw, options }]); return { file: `${workflowId}.yaml`, id: workflowId, hash: 'h'.repeat(64) }; },
      remove: async (projectId, workflowId) => { calls.push(['remove', { projectId, workflowId }]); return true; },
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
      releaseSandbox: async (value) => { calls.push(['releaseSandbox', value]); return run; },
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
    expect(response.body).toEqual({ definitions: [{ file: 'a.yaml', hash: 'h'.repeat(64), id: 'a', name: 'A', version: 1, errors: [], steps: [], inputs: [], sandbox: null }] });
  });

  it('returns the declared steps of a valid definition', async () => {
    const { app } = createApp({
      definitions: {
        list: async () => [{
          file: 'a.yaml', id: 'a', name: 'A', version: 1, errors: [],
          definition: { id: 'a', name: 'A', version: 1, sandbox: 'working-tree', inputs: [], steps: [{ id: 'first', title: 'First', prompt: 'x', session: 'new', permissions: 'ask', verify: { artifacts: [], commands: [] } }] },
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

  it('releases a finished run\'s checkout through the engine', async () => {
    const { app, calls } = createApp();
    const response = await request(app).post('/api/workflows/runs/11111111-2222-4333-8444-555555555555/sandbox/release').set(SCOPE).send({});
    expect(response.status).toBe(200);
    // The project path is forwarded with the run, because releasing a checkout
    // needs the repository the worktree belongs to.
    expect(calls[0]).toEqual(['releaseSandbox', { projectId: 'proj-1', projectPath: '/tmp/proj', runId: '11111111-2222-4333-8444-555555555555' }]);
    expect(response.body).toEqual({ run });
  });

  it('refuses to release a worktree while the run is still going', async () => {
    // The refusal is the engine's rule, so the route is driven with the real
    // engine over a store that answers a live run: a stub would only prove the
    // stub. Everything else about the request is the route under test.
    const running = { ...run, status: 'running', sandbox: 'worktree', worktreeBranch: 'omp/wf/x', directory: '/tmp/proj/wt' };
    const store = { read: async () => running, write: async (_projectId, value) => value, list: async () => [], remove: async () => true, create: async (value) => value };
    const engine = createWorkflowEngine({
      store,
      definitions: { read: async () => null },
      host: {},
      turn: async () => 'completed',
      listProjectIds: async () => [],
    });
    const { app } = createApp({ engine, store });
    const response = await request(app).post('/api/workflows/runs/11111111-2222-4333-8444-555555555555/sandbox/release').set(SCOPE).send({});
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/still running/);
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

// The definition routes are the one place a person's text becomes a file, so they
// are driven over the real definitions module and a real temporary project: a
// mock could agree with the routes about a shape the parser would never accept.
const SOURCE = `id: two-step
name: Two steps
version: 1
steps:
  - id: first
    prompt: "Do the first thing."
`;

const createDefinitionApp = async (overrides = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-definition-routes-'));
  const definitions = createWorkflowDefinitions({ fsPromises: fs, path, projectPathFromId: () => root });
  return { ...createApp({ definitions, ...overrides }), root, file: path.join(root, '.openchamber/workflows/two-step.yaml') };
};

describe('workflow definition routes', () => {
  it('writes a definition a person may run, and answers its hash', async () => {
    const { app, file } = await createDefinitionApp();
    const response = await request(app).put('/api/workflows/definitions/two-step').set(SCOPE).send({ raw: SOURCE });

    expect(response.status).toBe(200);
    expect(response.body.written).toMatchObject({ file: 'two-step.yaml', id: 'two-step' });
    expect(response.body.written.hash).toHaveLength(64);
    expect(await fs.readFile(file, 'utf8')).toBe(SOURCE);
  });

  it('refuses text the parser rejects, with the parser\'s own message, and writes nothing', async () => {
    const { app, file } = await createDefinitionApp();
    const response = await request(app)
      .put('/api/workflows/definitions/two-step')
      .set(SCOPE)
      .send({ raw: 'id: two-step\nname: Two steps\nversion: 1\nsteps: []\n' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('steps: must be a non-empty list');
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it('refuses a body whose id is not the definition being written', async () => {
    const { app, file } = await createDefinitionApp();
    const response = await request(app)
      .put('/api/workflows/definitions/two-step')
      .set(SCOPE)
      .send({ raw: SOURCE.replace('id: two-step', 'id: other') });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/id "other" does not match/);
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it('answers a conflict, not a silent overwrite, when the file changed since it was read', async () => {
    const { app } = await createDefinitionApp();
    const written = await request(app).put('/api/workflows/definitions/two-step').set(SCOPE).send({ raw: SOURCE });
    const changed = SOURCE.replace('version: 1', 'version: 2');

    const stale = await request(app)
      .put('/api/workflows/definitions/two-step')
      .set(SCOPE)
      .send({ raw: changed, expectedHash: 'a'.repeat(64) });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/changed on disk/);

    const fresh = await request(app)
      .put('/api/workflows/definitions/two-step')
      .set(SCOPE)
      .send({ raw: changed, expectedHash: written.body.written.hash });
    expect(fresh.status).toBe(200);
  });

  it('gives one definition back with the text it was written from', async () => {
    const { app } = await createDefinitionApp();
    const written = await request(app).put('/api/workflows/definitions/two-step').set(SCOPE).send({ raw: SOURCE });

    const response = await request(app).get('/api/workflows/definitions/two-step').set(SCOPE);
    expect(response.status).toBe(200);
    expect(response.body.raw).toBe(SOURCE);
    expect(response.body.hash).toBe(written.body.written.hash);
    expect(response.body.definition.steps.map((step) => step.id)).toEqual(['first']);
  });

  it('answers 404 for a definition that is not there yet, which is how an editor opens a new one', async () => {
    const { app } = await createDefinitionApp();
    const response = await request(app).get('/api/workflows/definitions/two-step').set(SCOPE);
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('workflow "two-step" was not found');
  });

  it('deletes one definition and answers 404 when there is none', async () => {
    const { app, file } = await createDefinitionApp();
    await request(app).put('/api/workflows/definitions/two-step').set(SCOPE).send({ raw: SOURCE });

    expect((await request(app).delete('/api/workflows/definitions/two-step').set(SCOPE)).body).toEqual({ removed: true });
    await expect(fs.stat(file)).rejects.toThrow();
    expect((await request(app).delete('/api/workflows/definitions/two-step').set(SCOPE)).status).toBe(404);
  });

  it('refuses to delete a definition a run that has not finished still needs', async () => {
    // The engine re-reads the definition from disk on every advance, so this run
    // could never move again if the file went away.
    const live = { ...run, runId: '99999999-2222-4333-8444-555555555555', workflowId: 'two-step', status: 'waiting' };
    const store = { list: async () => [live], read: async () => live, create: async (value) => value, remove: async () => true };
    const { app, file } = await createDefinitionApp({ store });
    await request(app).put('/api/workflows/definitions/two-step').set(SCOPE).send({ raw: SOURCE });

    const response = await request(app).delete('/api/workflows/definitions/two-step').set(SCOPE);

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('99999999-2222-4333-8444-555555555555');
    expect(response.body.error).toMatch(/has not finished/);
    expect(await fs.readFile(file, 'utf8')).toBe(SOURCE);
  });

  it('deletes a definition once every run of it has finished', async () => {
    const finished = { ...run, workflowId: 'two-step', status: 'done' };
    const store = { list: async () => [finished], read: async () => finished, create: async (value) => value, remove: async () => true };
    const { app, file } = await createDefinitionApp({ store });
    await request(app).put('/api/workflows/definitions/two-step').set(SCOPE).send({ raw: SOURCE });

    const response = await request(app).delete('/api/workflows/definitions/two-step').set(SCOPE);

    expect(response.body).toEqual({ removed: true });
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it('refuses a write with no text in it', async () => {
    const { app, file } = await createDefinitionApp();
    const response = await request(app).put('/api/workflows/definitions/two-step').set(SCOPE).send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('the definition text is required');
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it('asks for a project directory on every definition route', async () => {
    const { app } = await createDefinitionApp();
    expect((await request(app).put('/api/workflows/definitions/two-step').send({ raw: SOURCE })).status).toBe(400);
    expect((await request(app).get('/api/workflows/definitions/two-step')).status).toBe(400);
    expect((await request(app).delete('/api/workflows/definitions/two-step')).status).toBe(400);
  });

  it('hands the body and the expected hash to the writer, and answers what it answered', async () => {
    const { app, calls } = createApp();
    const response = await request(app)
      .put('/api/workflows/definitions/two-step')
      .set(SCOPE)
      .send({ raw: 'id: two-step\n', expectedHash: 'b'.repeat(64) });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ written: { file: 'two-step.yaml', id: 'two-step', hash: 'h'.repeat(64) } });
    expect(calls).toContainEqual(['write', { projectId: 'proj-1', workflowId: 'two-step', raw: 'id: two-step\n', options: { expectedHash: 'b'.repeat(64) } }]);
  });
});
