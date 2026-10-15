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

  it('refuses an id that would name a file outside the workflows directory, and creates nothing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-traversal-'));
    const local = createWorkflowDefinitions({ fsPromises: fs, path, projectPathFromId: () => root });

    for (const workflowId of ['../../evil', 'nested/evil', '..', '..%2Fevil']) {
      // The write is refused whatever refuses it — the parser rejects the id in
      // the body before the file name is ever joined — and nothing is created.
      await expect(local.write('proj-1', workflowId, valid.replace('id: sdlc-feature', `id: ${workflowId}`)))
        .rejects.toThrow();
      // Both of these refuse the name itself, which is the guard that keeps the
      // join from happening at all.
      await expect(local.readSource('proj-1', workflowId)).resolves.toBeNull();
      await expect(local.remove('proj-1', workflowId)).rejects.toThrow(/invalid workflow id/);
    }
    // Neither the workflows directory nor a file beside the project was created.
    expect(await fs.readdir(root)).toEqual([]);
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

  it('keeps a string hash meaning a change check: the same hash still meets a file that a removal left missing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-write-'));
    const directory = path.join(root, '.openchamber/workflows');
    const local = createWorkflowDefinitions({ fsPromises: fs, path, projectPathFromId: () => root });
    const first = await local.write('proj-1', 'sdlc-feature', valid);
    await fs.rm(path.join(directory, 'sdlc-feature.yaml'));

    // A re-create after an out-of-band removal is legitimate, so a string hash
    // says nothing about existence: it only refuses a file that is there and differs.
    const again = await local.write('proj-1', 'sdlc-feature', valid, { expectedHash: first.hash });
    expect(again.hash).toBe(first.hash);
    expect(await fs.readFile(path.join(directory, 'sdlc-feature.yaml'), 'utf8')).toBe(valid);
  });

  it('reads `null` as "this definition must not exist yet", and refuses a file that is there for that reason', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-create-'));
    const file = path.join(root, '.openchamber/workflows/sdlc-feature.yaml');
    const local = createWorkflowDefinitions({ fsPromises: fs, path, projectPathFromId: () => root });
    await local.write('proj-1', 'sdlc-feature', valid);

    await expect(local.write('proj-1', 'sdlc-feature', valid.replace('version: 3', 'version: 4'), { expectedHash: null }))
      .rejects.toThrow('sdlc-feature.yaml already exists');
    // The refusal is about existence, and the file it found is untouched.
    expect(await fs.readFile(file, 'utf8')).toBe(valid);
  });

  it('writes when `null` names an id that has no file yet, and refuses the second one', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-create-'));
    const directory = path.join(root, '.openchamber/workflows');
    const local = createWorkflowDefinitions({ fsPromises: fs, path, projectPathFromId: () => root });

    const created = await local.write('proj-1', 'sdlc-feature', valid, { expectedHash: null });
    expect(created).toMatchObject({ id: 'sdlc-feature', file: 'sdlc-feature.yaml' });
    expect(created.hash).toHaveLength(64);
    expect(await fs.readdir(directory)).toEqual(['sdlc-feature.yaml']);

    await expect(local.write('proj-1', 'sdlc-feature', valid, { expectedHash: null })).rejects.toThrow(/already exists/);
  });

  it('refuses `null` for a name it can see but cannot read, instead of reading it as absent', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-create-'));
    const directory = path.join(root, '.openchamber/workflows');
    // A name that exists as a directory is exactly the state a hash comparison
    // cannot see: `readFile` throws, so the old guard took it for "no file" and
    // let the create flow replace what was there. `access` sees it.
    await fs.mkdir(path.join(directory, 'sdlc-feature.yaml'), { recursive: true });
    const local = createWorkflowDefinitions({ fsPromises: fs, path, projectPathFromId: () => root });

    await expect(local.write('proj-1', 'sdlc-feature', valid, { expectedHash: null }))
      .rejects.toThrow('sdlc-feature.yaml already exists');
    // Nothing was written over or beside the name it found.
    expect((await fs.stat(path.join(directory, 'sdlc-feature.yaml'))).isDirectory()).toBe(true);
    expect(await fs.readdir(directory)).toEqual(['sdlc-feature.yaml']);
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

describe('concurrent writes', () => {
  it('gives each write its own temporary, so the file is one of the bodies and the surviving save is not stale', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-concurrent-'));
    const directory = path.join(root, '.openchamber/workflows');
    const first = valid.replace('version: 3', 'version: 7');
    const second = valid.replace('name: SDLC, feature work', 'name: SDLC, feature work, edited in another window');

    // Holds one write between its writeFile and its rename so the other runs
    // entirely inside that window: the interleaving a double-click, or a second
    // window saving the same definition, produces — made deterministic.
    let writes = 0;
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const gatedFs = {
      ...fs,
      writeFile: async (file, data, options) => {
        await fs.writeFile(file, data, options);
        writes += 1;
        if (writes === 1) await held;
        else release();
      },
    };
    const local = createWorkflowDefinitions({ fsPromises: gatedFs, path, projectPathFromId: () => root });

    const [a, b] = await Promise.all([
      local.write('proj-1', 'sdlc-feature', first),
      local.write('proj-1', 'sdlc-feature', second),
    ]);

    const onDisk = await fs.readFile(path.join(directory, 'sdlc-feature.yaml'), 'utf8');
    expect([first, second]).toContain(onDisk);
    const winner = onDisk === first ? a : b;
    expect(winner.hash).toBe(createHash('sha256').update(onDisk, 'utf8').digest('hex'));
    // The save whose bytes survived is not refused as stale by its own hash.
    await expect(local.write('proj-1', 'sdlc-feature', onDisk, { expectedHash: winner.hash }))
      .resolves.toMatchObject({ hash: winner.hash });
    expect(await fs.readdir(directory)).toEqual(['sdlc-feature.yaml']);
  });
});
