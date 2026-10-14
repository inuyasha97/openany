// packages/web/server/lib/workflows/artifacts.test.js
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectArtifacts, matchArtifacts } from './artifacts.js';

let root;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf artifacts '));
  await fs.mkdir(path.join(root, 'docs/specs'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/specs/a-design.md'), 'a');
  await fs.writeFile(path.join(root, 'docs/specs/b-design.md'), 'bb');
  await fs.writeFile(path.join(root, 'docs/specs/notes.txt'), 'c');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('matchArtifacts', () => {
  it('matches a single star inside one segment', async () => {
    expect(await matchArtifacts({ directory: root, pattern: 'docs/specs/*-design.md' }))
      .toEqual(['docs/specs/a-design.md', 'docs/specs/b-design.md']);
  });

  it('matches a double star across segments', async () => {
    expect(await matchArtifacts({ directory: root, pattern: 'docs/**/*.md' }))
      .toEqual(['docs/specs/a-design.md', 'docs/specs/b-design.md']);
  });

  it('returns nothing for a pattern with no match, and does not throw on a missing root', async () => {
    expect(await matchArtifacts({ directory: root, pattern: 'nope/*.md' })).toEqual([]);
    expect(await matchArtifacts({ directory: path.join(root, 'gone'), pattern: '*.md' })).toEqual([]);
  });

  it('handles spaces and non-ASCII names', async () => {
    await fs.writeFile(path.join(root, 'docs/specs/đặc tả.md'), 'x');
    expect(await matchArtifacts({ directory: root, pattern: 'docs/specs/*.md' }))
      .toEqual(['docs/specs/a-design.md', 'docs/specs/b-design.md', 'docs/specs/đặc tả.md']);
  });

  it('does not escape the directory', async () => {
    expect(await matchArtifacts({ directory: root, pattern: '../*.md' })).toEqual([]);
  });
});

describe('inspectArtifacts', () => {
  it('hashes only when asked, and reports a pattern with no match', async () => {
    const [hashed, plain, missing] = await inspectArtifacts({
      directory: root,
      patterns: [
        { glob: 'docs/specs/a-design.md', hash: true },
        { glob: 'docs/specs/b-design.md', hash: false },
        { glob: 'docs/specs/zzz.md', hash: true },
      ],
    });
    expect(hashed).toMatchObject({ glob: 'docs/specs/a-design.md', path: 'docs/specs/a-design.md', exists: true, size: 1 });
    expect(hashed.sha256).toHaveLength(64);
    expect(plain).toMatchObject({ exists: true, sha256: null });
    expect(missing).toEqual({ glob: 'docs/specs/zzz.md', path: null, exists: false, size: null, sha256: null });
  });

  it('reports one entry per match of a multi-match pattern', async () => {
    const results = await inspectArtifacts({ directory: root, patterns: [{ glob: 'docs/specs/*.md', hash: false }] });
    expect(results.map((entry) => entry.path)).toEqual(['docs/specs/a-design.md', 'docs/specs/b-design.md']);
  });
});
