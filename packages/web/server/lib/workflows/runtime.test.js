import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorkflowRuntime } from './runtime.js';

const createRuntime = async (overrides = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-runtime-'));
  return createWorkflowRuntime({
    projectsDirPath: root,
    projectPathFromId: () => root,
    resolveProjectId: () => 'proj-1',
    getOmpRuntimeHost: async () => null,
    setSessionAutoAccept: async () => {},
    broadcast: () => {},
    logger: { warn: () => {} },
    ...overrides,
  });
};

describe('createWorkflowRuntime', () => {
  it('exposes the modules the routes need', async () => {
    const runtime = await createRuntime();
    expect(typeof runtime.definitions.list).toBe('function');
    expect(typeof runtime.store.read).toBe('function');
    expect(typeof runtime.engine.startStep).toBe('function');
    expect(runtime.resolveProjectId('/tmp/proj')).toBe('proj-1');
  });

  it('answers unavailable when the runtime is not mounted, instead of prompting nothing', async () => {
    const runtime = await createRuntime();
    const projectPath = runtime.projectPathFromId('proj-1');
    // The engine resolves the run's definition before it reaches the host, so
    // the run needs a valid one for the missing-host path to be exercised.
    await fs.mkdir(path.join(projectPath, '.openchamber/workflows'), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, '.openchamber/workflows/a.yaml'),
      'id: a\nname: A\nversion: 1\nsteps:\n  - id: first\n    prompt: "do it"\n',
    );
    await runtime.store.create({
      runId: '11111111-2222-4333-8444-555555555555',
      projectId: 'proj-1',
      directory: projectPath,
      workflowId: 'a',
      workflowVersion: 1,
      workflowHash: 'h',
      inputs: {},
      status: 'idle',
      cursor: 'first',
      sandbox: 'working-tree',
      createdAt: 1,
      steps: [{ id: 'first', status: 'pending', attempts: [], checkpoint: null, note: null }],
    });
    await expect(runtime.engine.startStep({
      projectId: 'proj-1',
      projectPath,
      runId: '11111111-2222-4333-8444-555555555555',
      stepId: 'first',
    })).rejects.toThrow(/not available/);
  });
});
