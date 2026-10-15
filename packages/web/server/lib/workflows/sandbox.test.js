import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { prepareSandbox, releaseSandbox } from './sandbox.js';
import * as gitService from '../git/service.js';

let root;
let counter = 0;
const run = () => ({
  runId: `run-${counter += 1}`,
  projectId: 'proj-1',
  sandbox: 'worktree',
  directory: root,
  steps: [],
});

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-sandbox-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(root, 'a.txt'), 'a');
  git('add', '.');
  git('commit', '-q', '-m', 'seed');
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('prepareSandbox', () => {
  it('creates one worktree per run, away from the project directory', async () => {
    const subject = run();
    const prepared = await prepareSandbox({ run: subject, projectPath: root, git: gitService });
    expect(prepared.created).toBe(true);
    expect(prepared.directory).not.toBe(root);
    expect(prepared.branch).toContain(subject.runId);
    expect(await fs.readFile(path.join(prepared.directory, 'a.txt'), 'utf8')).toBe('a');
    await releaseSandbox({ run: { ...subject, directory: prepared.directory, worktreeBranch: prepared.branch }, projectPath: root, git: gitService });
  });

  it('is idempotent: a run that already has a worktree keeps it', async () => {
    const subject = run();
    const first = await prepareSandbox({ run: subject, projectPath: root, git: gitService });
    const second = await prepareSandbox({ run: { ...subject, directory: first.directory, worktreeBranch: first.branch }, projectPath: root, git: gitService });
    expect(second).toMatchObject({ directory: first.directory, branch: first.branch, created: false });
    await releaseSandbox({ run: { ...subject, directory: first.directory, worktreeBranch: first.branch }, projectPath: root, git: gitService });
  });

  it('asks for a different directory for every run, so two runs cannot share one', async () => {
    const leftSubject = run();
    const rightSubject = run();
    const left = await prepareSandbox({ run: leftSubject, projectPath: root, git: gitService });
    const right = await prepareSandbox({ run: rightSubject, projectPath: root, git: gitService });
    expect(left.directory).not.toBe(right.directory);
    expect(left.branch).not.toBe(right.branch);
    await releaseSandbox({ run: { ...leftSubject, directory: left.directory, worktreeBranch: left.branch }, projectPath: root, git: gitService });
    await releaseSandbox({ run: { ...rightSubject, directory: right.directory, worktreeBranch: right.branch }, projectPath: root, git: gitService });
  });

  it('surfaces a git refusal instead of running in the project directory', async () => {
    const notARepo = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-notrepo-'));
    await expect(prepareSandbox({ run: run(), projectPath: notARepo, git: gitService }))
      .rejects.toThrow();
    await fs.rm(notARepo, { recursive: true, force: true });
  });
});

describe('releaseSandbox', () => {
  it('removes the worktree and leaves the branch', async () => {
    const subject = run();
    const prepared = await prepareSandbox({ run: subject, projectPath: root, git: gitService });
    const preparedRun = { ...subject, directory: prepared.directory, worktreeBranch: prepared.branch };
    expect(await releaseSandbox({ run: preparedRun, projectPath: root, git: gitService })).toEqual({ removed: true });
    await expect(fs.stat(prepared.directory)).rejects.toThrow();
    expect(execFileSync('git', ['branch', '--list', prepared.branch], { cwd: root }).toString()).toContain(prepared.branch);
  });

  it('does nothing for a run that has no worktree', async () => {
    expect(await releaseSandbox({ run: { ...run(), directory: root }, projectPath: root, git: gitService })).toEqual({ removed: false });
  });
});
