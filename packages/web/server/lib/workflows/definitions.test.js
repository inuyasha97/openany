import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorkflowDefinitions, parseDefinition } from './definitions.js';

const valid = `
id: sdlc-feature
name: SDLC, feature work
version: 3
inputs:
  - name: request
    description: What to build
    required: true
steps:
  - id: spec
    title: Design the change
    prompt: "Design {{request}}."
    session: new
    permissions: ask
    verify:
      artifacts:
        - glob: "docs/superpowers/specs/*-design.md"
          hash: true
      commands:
        - run: "bun run type-check:web"
          expectExit: 0
  - id: verify
    title: Verify
    prompt: "Run the checks."
    session: reuse
    verify:
      commands:
        - run: "bun run type-check:web"
`;

describe('parseDefinition', () => {
  it('fills defaults and normalizes verify entries', () => {
    const result = parseDefinition(valid, { file: 'sdlc-feature.yaml' });
    expect(result.ok).toBe(true);
    const [spec, verify] = result.definition.steps;
    expect(spec.session).toBe('new');
    expect(spec.permissions).toBe('ask');
    expect(spec.verify.commands[0]).toEqual({ run: 'bun run type-check:web', expectExit: 0, timeoutMs: 600000 });
    expect(spec.verify.artifacts).toEqual([{ glob: 'docs/superpowers/specs/*-design.md', hash: true }]);
    expect(verify.verify.artifacts).toEqual([]);
    expect(verify.verify.commands[0].expectExit).toBe(0);
  });

  it('defaults the sandbox to worktree and rejects an unknown one', () => {
    expect(parseDefinition(valid, { file: 'a.yaml' }).definition.sandbox).toBe('worktree');
    const explicit = parseDefinition(`${valid}\nsandbox: working-tree\n`, { file: 'a.yaml' });
    expect(explicit.definition.sandbox).toBe('working-tree');
    const bad = parseDefinition(`${valid}\nsandbox: container\n`, { file: 'a.yaml' });
    expect(bad.ok).toBe(false);
    expect(bad.errors).toEqual([{ field: 'sandbox', message: 'must be "worktree" or "working-tree"' }]);
  });

  it('reports a placeholder with no declared input', () => {
    const result = parseDefinition(valid.replace('{{request}}', '{{nope}}'), { file: 'a.yaml' });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([{ field: 'steps[0].prompt', message: 'unknown input "nope"' }]);
  });

  it('rejects a definition that still declares confirm, and says why', () => {
    const result = parseDefinition(valid.replace('    session: new', '    session: new\n    confirm: human'), { file: 'a.yaml' });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([{ field: 'steps[0].confirm', message: '"confirm" is gone: every step becomes done only when a person confirms it' }]);
  });

  it('rejects a duplicate step id', () => {
    const result = parseDefinition(valid.replace('id: verify', 'id: spec'), { file: 'a.yaml' });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([{ field: 'steps[1].id', message: 'duplicate step id "spec"' }]);
  });

  it('rejects an unknown step field instead of ignoring it', () => {
    const result = parseDefinition(valid.replace('    session: new', '    session: new\n    sandbox: worktree'), { file: 'a.yaml' });
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toMatch(/unknown field "sandbox"/);
  });

  it('rejects a file that is not an object', () => {
    const result = parseDefinition('- one\n- two\n', { file: 'a.yaml' });
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toMatch(/must be a mapping/);
  });
});

describe('createWorkflowDefinitions', () => {
  it('lists every yaml file with its errors, and reads a valid one by id', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-defs-'));
    await fs.mkdir(path.join(root, '.openchamber/workflows'), { recursive: true });
    await fs.writeFile(path.join(root, '.openchamber/workflows/two-step.yaml'), valid);
    await fs.writeFile(path.join(root, '.openchamber/workflows/broken.yaml'), 'id: Broken\nsteps: []\n');
    const local = createWorkflowDefinitions({ fsPromises: fs, path, projectPathFromId: () => root });

    const listed = await local.list('proj-1');
    expect(listed.map((entry) => entry.file)).toEqual(['broken.yaml', 'two-step.yaml']);
    expect(listed[0].errors[0].field).toBe('id');
    expect(listed[1].id).toBe('sdlc-feature');
    expect((await local.read('proj-1', 'sdlc-feature')).steps.map((step) => step.id)).toEqual(['spec', 'verify']);
    expect(await local.read('proj-1', 'broken')).toBeNull();
  });

  it('answers an empty list for a project with no workflows directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-defs-empty-'));
    const local = createWorkflowDefinitions({ fsPromises: fs, path, projectPathFromId: () => root });
    expect(await local.list('proj-1')).toEqual([]);
    expect(await local.list('unknown-project')).toEqual([]);
  });

  it('reports an unreadable entry without breaking the listing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-defs-unreadable-'));
    await fs.mkdir(path.join(root, '.openchamber/workflows/odd.yaml'), { recursive: true });
    await fs.writeFile(path.join(root, '.openchamber/workflows/two-step.yaml'), valid);
    const local = createWorkflowDefinitions({ fsPromises: fs, path, projectPathFromId: () => root });

    const listed = await local.list('proj-1');
    const odd = listed.find((entry) => entry.file === 'odd.yaml');
    const good = listed.find((entry) => entry.file === 'two-step.yaml');
    expect(listed.map((entry) => entry.file)).toEqual(['odd.yaml', 'two-step.yaml']);
    expect(odd.definition).toBeNull();
    expect(odd.errors.length).toBeGreaterThan(0);
    expect(good.id).toBe('sdlc-feature');
    expect((await local.read('proj-1', 'sdlc-feature')).steps.map((step) => step.id)).toEqual(['spec', 'verify']);
  });
});

describe('write', () => {
  it('refuses text that does not parse, and writes nothing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-write-'));
    const local = createWorkflowDefinitions({ fsPromises: fs, path, projectPathFromId: () => root });
    await expect(local.write('proj-1', 'two-step', 'id: Broken\nsteps: []\n')).rejects.toThrow(/id/);
    await expect(fs.stat(path.join(root, '.openchamber/workflows/two-step.yaml'))).rejects.toThrow();
  });

  it('refuses a body whose id is not the id being written', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-write-'));
    const local = createWorkflowDefinitions({ fsPromises: fs, path, projectPathFromId: () => root });
    await expect(local.write('proj-1', 'two-step', valid.replace('id: sdlc-feature', 'id: other')))
      .rejects.toThrow(/id "other" does not match/);
  });

  it('writes atomically and answers the new hash', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-write-'));
    const local = createWorkflowDefinitions({ fsPromises: fs, path, projectPathFromId: () => root });
    const written = await local.write('proj-1', 'sdlc-feature', valid);
    expect(written.id).toBe('sdlc-feature');
    expect(written.hash).toHaveLength(64);
    expect((await local.read('proj-1', 'sdlc-feature')).steps.map((step) => step.id)).toEqual(['spec', 'verify']);
  });

  it('refuses to overwrite a file that changed since the person read it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-write-'));
    const local = createWorkflowDefinitions({ fsPromises: fs, path, projectPathFromId: () => root });
    const first = await local.write('proj-1', 'sdlc-feature', valid);
    await expect(local.write('proj-1', 'sdlc-feature', valid.replace('version: 3', 'version: 4'), { expectedHash: 'a'.repeat(64) }))
      .rejects.toThrow(/changed on disk/);
    await local.write('proj-1', 'sdlc-feature', valid.replace('version: 3', 'version: 4'), { expectedHash: first.hash });
  });

  it('leaves the definition one file: a refusal writes no temporary, and a write answers the bytes on disk', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-write-'));
    const directory = path.join(root, '.openchamber/workflows');
    const local = createWorkflowDefinitions({ fsPromises: fs, path, projectPathFromId: () => root });

    await expect(local.write('proj-1', 'sdlc-feature', 'id: nope\n')).rejects.toThrow();
    expect(await fs.readdir(directory).catch(() => [])).toEqual([]);

    const written = await local.write('proj-1', 'sdlc-feature', valid);
    expect(await fs.readdir(directory)).toEqual(['sdlc-feature.yaml']);
    const onDisk = await fs.readFile(path.join(directory, 'sdlc-feature.yaml'), 'utf8');
    expect(onDisk).toBe(valid);
    expect(written.hash).toBe(createHash('sha256').update(onDisk, 'utf8').digest('hex'));
  });

  it('keeps a definition that already lives in a .yml file, instead of giving one id two files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-write-'));
    const directory = path.join(root, '.openchamber/workflows');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'sdlc-feature.yml'), valid);
    const local = createWorkflowDefinitions({ fsPromises: fs, path, projectPathFromId: () => root });

    const written = await local.write('proj-1', 'sdlc-feature', valid.replace('version: 3', 'version: 5'));
    expect(written.file).toBe('sdlc-feature.yml');
    expect(await fs.readdir(directory)).toEqual(['sdlc-feature.yml']);
    expect((await local.list('proj-1')).length).toBe(1);
  });

  it('lists the hash of the bytes on disk for every row, and null for a file it cannot read', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-write-'));
    const directory = path.join(root, '.openchamber/workflows');
    await fs.mkdir(path.join(directory, 'odd.yaml'), { recursive: true });
    await fs.writeFile(path.join(directory, 'two-step.yaml'), valid);
    const local = createWorkflowDefinitions({ fsPromises: fs, path, projectPathFromId: () => root });

    const listed = await local.list('proj-1');
    expect(listed.find((entry) => entry.file === 'two-step.yaml').hash).toBe(createHash('sha256').update(valid, 'utf8').digest('hex'));
    expect(listed.find((entry) => entry.file === 'odd.yaml').hash).toBeNull();
  });
});

describe('readSource and remove', () => {
  it('answers the raw text with its hash, and null for a file that is not there yet', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-source-'));
    const local = createWorkflowDefinitions({ fsPromises: fs, path, projectPathFromId: () => root });

    expect(await local.readSource('proj-1', 'sdlc-feature')).toBeNull();
    await local.write('proj-1', 'sdlc-feature', valid);
    expect(await local.readSource('proj-1', 'sdlc-feature')).toEqual({
      raw: valid,
      hash: createHash('sha256').update(valid, 'utf8').digest('hex'),
      file: 'sdlc-feature.yaml',
    });
  });

  it('answers null for an unreadable file rather than throwing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-source-'));
    await fs.mkdir(path.join(root, '.openchamber/workflows/two-step.yaml'), { recursive: true });
    const local = createWorkflowDefinitions({ fsPromises: fs, path, projectPathFromId: () => root });
    expect(await local.readSource('proj-1', 'two-step.yaml')).toBeNull();
    expect(await local.readSource('proj-1', 'two-step')).toBeNull();
  });

  it('removes one definition and answers false when there is none', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-remove-'));
    const local = createWorkflowDefinitions({ fsPromises: fs, path, projectPathFromId: () => root });
    await local.write('proj-1', 'sdlc-feature', valid);
    expect(await local.remove('proj-1', 'sdlc-feature')).toBe(true);
    expect(await local.readSource('proj-1', 'sdlc-feature')).toBeNull();
    expect(await local.remove('proj-1', 'sdlc-feature')).toBe(false);
  });
});
