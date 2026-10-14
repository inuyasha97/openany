import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkflowRunStore, isValidRunId, isValidProjectId } from './store.js';
import { projectConfigFileStemOf } from '../projects/project-id.js';

let root;
let store;

const run = (overrides = {}) => ({
  runId: '11111111-2222-4333-8444-555555555555',
  projectId: 'proj-1',
  directory: '/tmp/proj',
  workflowId: 'sdlc-feature',
  workflowVersion: 1,
  workflowHash: 'hash',
  inputs: { request: 'x' },
  status: 'idle',
  cursor: 'spec',
  createdAt: 1,
  updatedAt: 1,
  sandbox: 'working-tree',
  steps: [],
  ...overrides,
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-store-'));
  store = createWorkflowRunStore({ fsPromises: fs, path, projectsDirPath: root, now: () => 42 });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('identifiers', () => {
  it('rejects a path escape in a project id or a run id', () => {
    expect(isValidProjectId('../etc')).toBe(false);
    expect(isValidProjectId('proj-1')).toBe(true);
    expect(isValidProjectId('proj/1')).toBe(false);
    expect(isValidRunId('..')).toBe(false);
    expect(isValidRunId('11111111-2222-4333-8444-555555555555')).toBe(true);
  });

  it('accepts a path-derived project id, whose length follows the path', () => {
    // `path_<base64url>` of a long directory exceeds any short cap, and the run
    // store is where that id lands.
    const longId = `path_${Buffer.from('/Users/someone/'.padEnd(200, 'x'), 'utf8').toString('base64url')}`;
    expect(longId.length).toBeGreaterThan(200);
    expect(isValidProjectId(longId)).toBe(true);
  });

  it('keeps the run directory name inside the file name limit for a long project id', async () => {
    const longId = `path_${Buffer.from('/Users/someone/'.padEnd(200, 'x'), 'utf8').toString('base64url')}`;
    const store = createWorkflowRunStore({ fsPromises: fs, path, projectsDirPath: root, now: () => 42 });
    const created = await store.create(run({ projectId: longId }));
    const directoryName = path.basename(path.dirname(store.directoryFor(longId)));
    expect(directoryName.length).toBeLessThanOrEqual(200);
    expect(directoryName).toBe(projectConfigFileStemOf(longId));
    expect(await store.read(longId, created.runId)).toMatchObject({ runId: created.runId });
  });
});

describe('run store', () => {
  it('creates a run file under the project directory', async () => {
    const created = await store.create(run());
    expect(created.updatedAt).toBe(42);
    expect(await store.read('proj-1', run().runId)).toMatchObject({ runId: run().runId, status: 'idle' });
  });

  it('lists runs newest first and skips an unreadable file', async () => {
    await store.create(run({ runId: 'aaaaaaaa-2222-4333-8444-555555555555', createdAt: 2 }));
    await store.create(run({ runId: 'bbbbbbbb-2222-4333-8444-555555555555', createdAt: 5 }));
    await fs.writeFile(store.pathFor('proj-1', 'cccccccc-2222-4333-8444-555555555555'), '{not json');
    const listed = await store.list('proj-1');
    expect(listed.map((entry) => entry.runId)).toEqual(['bbbbbbbb-2222-4333-8444-555555555555', 'aaaaaaaa-2222-4333-8444-555555555555']);
  });

  it('ignores a file in the runs directory that is not a run', async () => {
    await store.create(run({ runId: 'eeeeeeee-2222-4333-8444-555555555555' }));
    await fs.writeFile(path.join(store.directoryFor('proj-1'), 'notes.json'), '{"note":"backup"}');
    const listed = await store.list('proj-1');
    expect(listed.map((entry) => entry.runId)).toEqual(['eeeeeeee-2222-4333-8444-555555555555']);
  });

  it('reads null for a run that is not there, rather than an empty run', async () => {
    expect(await store.read('proj-1', 'dddddddd-2222-4333-8444-555555555555')).toBeNull();
    expect(await store.list('missing-project')).toEqual([]);
  });

  it('serializes concurrent writes to one run', async () => {
    const created = await store.create(run());
    await Promise.all([
      store.write({ ...created, status: 'running' }),
      store.write({ ...created, status: 'done' }),
      store.write({ ...created, status: 'waiting' }),
    ]);
    const read = await store.read('proj-1', created.runId);
    expect(['running', 'done', 'waiting']).toContain(read.status);
    expect(JSON.parse(await fs.readFile(store.pathFor('proj-1', created.runId), 'utf8')).updatedAt).toBe(42);
  });

  it('removes exactly one run file', async () => {
    const created = await store.create(run());
    expect(await store.remove('proj-1', created.runId)).toBe(true);
    expect(await store.read('proj-1', created.runId)).toBeNull();
    expect(await store.remove('proj-1', created.runId)).toBe(false);
  });

  it('refuses to write outside the projects directory', async () => {
    await expect(store.create(run({ projectId: '../escape' }))).rejects.toThrow(/invalid project id/);
  });
});
