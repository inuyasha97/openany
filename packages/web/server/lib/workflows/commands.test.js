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

  it('runs in the given directory', async () => {
    const result = await runCommandCheck({ directory: root, run: 'node -e "console.log(process.cwd())"', expectExit: 0, timeoutMs: 20000 });
    expect(result.stdout.trim()).toBe(await fs.realpath(root));
  });
});
