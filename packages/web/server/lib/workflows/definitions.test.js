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
    confirm: human
  - id: verify
    title: Verify
    prompt: "Run the checks."
    session: reuse
    verify:
      commands:
        - run: "bun run type-check:web"
    confirm: auto
`;

describe('parseDefinition', () => {
  it('fills defaults and normalizes verify entries', () => {
    const result = parseDefinition(valid, { file: 'sdlc-feature.yaml' });
    expect(result.ok).toBe(true);
    const [spec, verify] = result.definition.steps;
    expect(spec.session).toBe('new');
    expect(spec.permissions).toBe('ask');
    expect(spec.confirm).toBe('human');
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

  it('rejects confirm: auto with nothing to verify', () => {
    const result = parseDefinition(valid.replace('    verify:\n      commands:\n        - run: "bun run type-check:web"\n', ''), { file: 'a.yaml' });
    expect(result.ok).toBe(false);
    expect(result.errors[0].field).toBe('steps[1]');
    expect(result.errors[0].message).toMatch(/confirm: auto needs a verifier/);
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
