import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runVerifiers, verifyCheckpoint } from './verifiers.js';

let root;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-ver-'));
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/design.md'), 'one');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const step = (verify) => ({ id: 'spec', verify });

describe('runVerifiers', () => {
  it('passes when every check passed, and records each one', async () => {
    const result = await runVerifiers({
      step: step({ artifacts: [{ glob: 'docs/*.md', hash: true }], commands: [{ run: 'node -e ""', expectExit: 0, timeoutMs: 20000 }] }),
      directory: root,
    });
    expect(result.ok).toBe(true);
    expect(result.artifacts[0]).toMatchObject({ path: 'docs/design.md', exists: true });
    expect(result.commands[0].ok).toBe(true);
  });

  it('fails when an artifact pattern matched nothing', async () => {
    const result = await runVerifiers({ step: step({ artifacts: [{ glob: 'docs/zzz.md', hash: false }], commands: [] }), directory: root });
    expect(result.ok).toBe(false);
    expect(result.artifacts[0]).toMatchObject({ exists: false, path: null });
  });

  it('fails when a command failed, and keeps the output', async () => {
    const result = await runVerifiers({
      step: step({ artifacts: [], commands: [{ run: 'node -e "console.error(\'bad\'); process.exit(2)"', expectExit: 0, timeoutMs: 20000 }] }),
      directory: root,
    });
    expect(result.ok).toBe(false);
    expect(result.commands[0].stderr).toContain('bad');
  });

  it('fails when a toggle command throws instead of answering', async () => {
    const runCommand = vi.fn(async () => { throw new Error('spawn failed'); });
    const result = await runVerifiers({
      step: step({ artifacts: [], commands: [{ run: 'x', expectExit: 0, timeoutMs: 1000 }] }),
      directory: root,
      deps: { runCommand },
    });
    expect(result.ok).toBe(false);
    expect(result.commands[0]).toMatchObject({ exitCode: null, ok: false });
    expect(result.commands[0].stderr).toContain('spawn failed');
  });

  it('fails when the artifact inspection throws, instead of letting it escape', async () => {
    const inspectArtifacts = vi.fn(async () => { throw new Error('EACCES: permission denied'); });
    const result = await runVerifiers({
      step: step({ artifacts: [{ glob: 'docs/*.md', hash: true }], commands: [] }),
      directory: root,
      deps: { inspectArtifacts },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('EACCES');
    expect(result.artifacts).toEqual([{ glob: 'docs/*.md', path: null, exists: false, size: null, sha256: null }]);
  });
});

describe('verifyCheckpoint', () => {
  it('passes while the hashed artifact is unchanged', async () => {
    const hashed = await runVerifiers({ step: step({ artifacts: [{ glob: 'docs/design.md', hash: true }], commands: [] }), directory: root });
    const checkpoint = { artifacts: hashed.artifacts.map(({ path: file, size, sha256 }) => ({ path: file, size, sha256 })) };
    expect(await verifyCheckpoint({ checkpoint, directory: root })).toEqual({ ok: true, mismatches: [] });
  });

  it('reports a changed artifact and a missing one', async () => {
    const checkpoint = { artifacts: [{ path: 'docs/design.md', size: 3, sha256: 'a'.repeat(64) }, { path: 'docs/gone.md', size: 1, sha256: 'b'.repeat(64) }] };
    const result = await verifyCheckpoint({ checkpoint, directory: root });
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([
      { path: 'docs/design.md', reason: 'changed' },
      { path: 'docs/gone.md', reason: 'missing' },
    ]);
  });

  it('checks existence only for an artifact the checkpoint recorded without a digest', async () => {
    // A plain-string pattern in the definition means `hash: false`, so the
    // checkpoint holds `sha256: null`. Comparing a real digest against that
    // null would report the step broken on every restart.
    const checkpoint = { artifacts: [{ path: 'docs/design.md', size: 1, sha256: null }] };
    expect(await verifyCheckpoint({ checkpoint, directory: root })).toEqual({ ok: true, mismatches: [] });

    await fs.writeFile(path.join(root, 'docs/design.md'), 'a much longer body');
    expect(await verifyCheckpoint({ checkpoint, directory: root })).toEqual({ ok: true, mismatches: [] });

    await fs.rm(path.join(root, 'docs/design.md'));
    expect(await verifyCheckpoint({ checkpoint, directory: root })).toEqual({ ok: false, mismatches: [{ path: 'docs/design.md', reason: 'missing' }] });
  });
});
