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

// The real service creates the checkout and the branch and the real service
// removes them; only the readiness answer is overridden, so the leftover a
// failed preparation must clean up is a real one and its teardown is real too.
const gitAnswering = (status, created) => ({
  createWorktree: async (...args) => {
    const worktree = await gitService.createWorktree(...args);
    created.push(worktree.path);
    return worktree;
  },
  removeWorktree: gitService.removeWorktree,
  getWorktreeBootstrapStatus: async () => status,
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

  it('releases the checkout and the branch when the bootstrap fails', async () => {
    const subject = run();
    const created = [];
    const git = gitAnswering({ status: 'failed', phase: 'directory-created', error: 'the checkout could not be populated' }, created);

    await expect(prepareSandbox({ run: subject, projectPath: root, git }))
      .rejects.toThrow('the worktree could not be prepared: the checkout could not be populated');

    expect(created).toHaveLength(1);
    await expect(fs.stat(created[0])).rejects.toThrow();
    expect(execFileSync('git', ['branch', '--list', `omp/wf/${subject.runId}`], { cwd: root }).toString().trim()).toBe('');
  });

  it('releases the checkout and the branch when the checkout never becomes ready', async () => {
    const subject = run();
    const created = [];
    const git = gitAnswering({ status: 'pending', phase: 'directory-created', error: null }, created);

    await expect(prepareSandbox({ run: subject, projectPath: root, git, waitOptions: { timeoutMs: 50, pollMs: 10 } }))
      .rejects.toThrow('timed out waiting for the worktree checkout');

    expect(created).toHaveLength(1);
    await expect(fs.stat(created[0])).rejects.toThrow();
    expect(execFileSync('git', ['branch', '--list', `omp/wf/${subject.runId}`], { cwd: root }).toString().trim()).toBe('');
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

  it('refuses to release a checkout that still holds uncommitted work, naming the paths', async () => {
    const subject = run();
    const prepared = await prepareSandbox({ run: subject, projectPath: root, git: gitService });
    const preparedRun = { ...subject, directory: prepared.directory, worktreeBranch: prepared.branch };
    // A step whose prompt asked for no commit leaves its output only here.
    await fs.writeFile(path.join(prepared.directory, 'step-output.txt'), 'uncommitted');

    await expect(releaseSandbox({ run: preparedRun, projectPath: root, git: gitService }))
      .rejects.toMatchObject({ name: 'WorkflowError', code: 'conflict', status: 409, message: expect.stringContaining('step-output.txt') });

    // The checkout and the branch are still there for the person to act on.
    expect(await fs.readFile(path.join(prepared.directory, 'step-output.txt'), 'utf8')).toBe('uncommitted');
    expect(execFileSync('git', ['branch', '--list', prepared.branch], { cwd: root }).toString()).toContain(prepared.branch);

    // Once the work is committed, the release goes through.
    execFileSync('git', ['add', 'step-output.txt'], { cwd: prepared.directory });
    execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'step output'], { cwd: prepared.directory });
    expect(await releaseSandbox({ run: preparedRun, projectPath: root, git: gitService })).toEqual({ removed: true });
    await expect(fs.stat(prepared.directory)).rejects.toThrow();
  });

  it('deletes the uncommitted work it names, but only when the release asks it to', async () => {
    const subject = run();
    const prepared = await prepareSandbox({ run: subject, projectPath: root, git: gitService });
    const preparedRun = { ...subject, directory: prepared.directory, worktreeBranch: prepared.branch };
    await fs.writeFile(path.join(prepared.directory, 'scratch.txt'), 'x');

    // Without the flag the guard refuses exactly as it did before it could
    // delete, and the work is still there.
    await expect(releaseSandbox({ run: preparedRun, projectPath: root, git: gitService }))
      .rejects.toThrow(/uncommitted changes/);
    expect(await fs.readFile(path.join(prepared.directory, 'scratch.txt'), 'utf8')).toBe('x');

    // With it, the same read that refused answers what was removed.
    const released = await releaseSandbox({ run: preparedRun, projectPath: root, git: gitService, deleteUncommitted: true });
    expect(released).toMatchObject({ removed: true, deleted: ['scratch.txt'] });
    await expect(fs.stat(prepared.directory)).rejects.toThrow();
    // The branch is still the work a person merges, so it survives the deletion.
    expect(execFileSync('git', ['branch', '--list', prepared.branch], { cwd: root }).toString()).toContain(prepared.branch);
  });

  it('refuses to release when the checkout status cannot be read, and removes nothing', async () => {
    const subject = run();
    const prepared = await prepareSandbox({ run: subject, projectPath: root, git: gitService });
    const preparedRun = { ...subject, directory: prepared.directory, worktreeBranch: prepared.branch };
    const removals = [];
    const git = {
      getStatus: async () => { throw new Error('the status read failed'); },
      removeWorktree: async (...args) => { removals.push(args); return gitService.removeWorktree(...args); },
    };

    // The read failed for a reason other than a missing checkout, so it says
    // nothing about the work in there and the release must refuse.
    await expect(releaseSandbox({ run: preparedRun, projectPath: root, git }))
      .rejects.toMatchObject({ name: 'WorkflowError', code: 'conflict', status: 409, message: expect.stringContaining('could not be read') });

    expect(removals).toEqual([]);
    expect(await fs.stat(prepared.directory)).toBeTruthy();
  });

  it('refuses even when asked to delete, when the status read failed for another reason', async () => {
    const subject = run();
    const prepared = await prepareSandbox({ run: subject, projectPath: root, git: gitService });
    const preparedRun = { ...subject, directory: prepared.directory, worktreeBranch: prepared.branch };
    const removals = [];
    const git = {
      getStatus: async () => { throw new Error('the status read failed'); },
      removeWorktree: async (...args) => { removals.push(args); return gitService.removeWorktree(...args); },
    };

    // The override may delete what a read saw; it may not turn a read that said
    // nothing into a deletion.
    await expect(releaseSandbox({ run: preparedRun, projectPath: root, git, deleteUncommitted: true }))
      .rejects.toMatchObject({ name: 'WorkflowError', code: 'conflict', status: 409, message: expect.stringContaining('could not be read') });

    expect(removals).toEqual([]);
    expect(await fs.stat(prepared.directory)).toBeTruthy();
    await releaseSandbox({ run: preparedRun, projectPath: root, git: gitService });
  });

  it('releases when the status read fails because the checkout is gone', async () => {
    const subject = run();
    const prepared = await prepareSandbox({ run: subject, projectPath: root, git: gitService });
    const preparedRun = { ...subject, directory: prepared.directory, worktreeBranch: prepared.branch };
    const git = {
      getStatus: async () => { throw new Error('fatal: not a git repository (or any of the parent directories): .git'); },
      removeWorktree: gitService.removeWorktree,
    };

    // A checkout that is gone cannot hold work, so the removal proceeds.
    expect(await releaseSandbox({ run: preparedRun, projectPath: root, git })).toEqual({ removed: true });
    await expect(fs.stat(prepared.directory)).rejects.toThrow();
  });

  it('does nothing for a run that has no worktree', async () => {
    expect(await releaseSandbox({ run: { ...run(), directory: root }, projectPath: root, git: gitService })).toEqual({ removed: false });
  });
});
