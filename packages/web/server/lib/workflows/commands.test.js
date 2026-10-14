import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { runCommandCheck } from './commands.js';

let root;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-cmd-'));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// Spawns a grandchild that outlives the shell it was started from and writes
// `marker` 1200 ms later. Passing the marker as an argument (rather than
// inlining it) keeps the same quoting shape in both tests below: one asserts
// the timeout kill removes the writer, the other proves the writer works.
const markerCommand = (marker) => `node -e "require('child_process').spawn('node',['-e','setTimeout(()=>require(\\"fs\\").writeFileSync(process.argv[1],\\"alive\\"),1200)',process.argv[1]],{stdio:'inherit'})" '${marker}'`;

describe('runCommandCheck', () => {
  it('passes on the expected exit code and keeps the output', async () => {
    const result = await runCommandCheck({ directory: root, run: 'node -e "console.log(\'hello\')"', expectExit: 0, timeoutMs: 20000 });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, ok: true });
    expect(result.stdout).toContain('hello');
  });

  it('fails when the exit code is not the expected one', async () => {
    const result = await runCommandCheck({ directory: root, run: 'node -e "process.exit(3)"', expectExit: 0, timeoutMs: 20000 });
    expect(result).toMatchObject({ exitCode: 3, ok: false, timedOut: false });
  });

  it('accepts a non-zero expected exit code', async () => {
    const result = await runCommandCheck({ directory: root, run: 'node -e "process.exit(4)"', expectExit: 4, timeoutMs: 20000 });
    expect(result.ok).toBe(true);
  });

  it('kills a command that runs past its timeout', async () => {
    const result = await runCommandCheck({ directory: root, run: 'node -e "setTimeout(() => {}, 30000)"', expectExit: 0, timeoutMs: 500 });
    expect(result).toMatchObject({ timedOut: true, ok: false });
  });

  it('resolves when a grandchild outlives the shell and holds the output pipes', async () => {
    const run = `node -e "require('child_process').spawn('node',['-e','setTimeout(()=>{},30000)'],{stdio:'inherit'})"`;
    const startedAt = Date.now();
    const result = await runCommandCheck({ directory: root, run, expectExit: 0, timeoutMs: 500 });
    expect(Date.now() - startedAt).toBeLessThan(3000);
    expect(result).toMatchObject({ timedOut: true, ok: false, exitCode: null });
  });

  it('does not leave descendants of the killed command running', async () => {
    const marker = path.join(root, 'alive.marker');
    const result = await runCommandCheck({ directory: root, run: markerCommand(marker), expectExit: 0, timeoutMs: 500 });
    expect(result).toMatchObject({ timedOut: true, ok: false });
    await new Promise((resolve) => setTimeout(resolve, 4000));
    expect(await fs.stat(marker).catch(() => null)).toBeNull();
  });

  it('writes the marker when the same command is left to finish', async () => {
    const marker = path.join(root, 'alive-control.marker');
    const result = await runCommandCheck({ directory: root, run: markerCommand(marker), expectExit: 0, timeoutMs: 20000 });
    expect(result.timedOut).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 4000));
    expect(await fs.stat(marker).catch(() => null)).not.toBeNull();
  });

  it('runs in the given directory', async () => {
    const result = await runCommandCheck({ directory: root, run: 'node -e "console.log(process.cwd())"', expectExit: 0, timeoutMs: 20000 });
    expect(result.stdout.trim()).toBe(await fs.realpath(root));
  });
});
