import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCheckpointWriter, createGitDriver } from './git-checkpoint.js';

let root;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf checkpoint '));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(root, 'seed.txt'), 'seed');
  git('add', '.');
  git('commit', '-q', '-m', 'seed');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const writer = () => createCheckpointWriter({ git: createGitDriver(), now: () => 7 });

describe('write', () => {
  it('commits the step changes and records the commit', async () => {
    await fs.writeFile(path.join(root, 'new file.txt'), 'content');
    const checkpoint = await writer().write({ directory: root, runId: 'run-1', stepId: 'spec', attemptIndex: 0 });
    expect(checkpoint.clean).toBe(false);
    expect(checkpoint.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(checkpoint.at).toBe(7);
    const message = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: root }).toString().trim();
    expect(message).toBe('step spec [run=run-1 step=spec attempt=0]');
  });

  it('records HEAD instead of an empty commit on a clean tree', async () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
    const checkpoint = await writer().write({ directory: root, runId: 'run-1', stepId: 'verify', attemptIndex: 1 });
    expect(checkpoint).toEqual({ at: 7, commit: head, clean: true, artifacts: checkpoint.artifacts });
    expect(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root }).toString().trim()).toBe('1');
  });

  it('attaches the verified artifacts', async () => {
    const checkpoint = await writer().write({
      directory: root,
      runId: 'run-1',
      stepId: 'spec',
      attemptIndex: 0,
      artifacts: [{ path: 'seed.txt', size: 4, sha256: 'c'.repeat(64) }],
    });
    expect(checkpoint.artifacts).toEqual([{ path: 'seed.txt', size: 4, sha256: 'c'.repeat(64) }]);
  });

  it('surfaces a git failure instead of reporting a checkpoint', async () => {
    const failing = createCheckpointWriter({ git: { status: async () => { throw new Error('not a git repository'); } }, now: () => 7 });
    await expect(failing.write({ directory: root, runId: 'run-1', stepId: 'spec', attemptIndex: 0 }))
      .rejects.toThrow(/not a git repository/);
  });
});
