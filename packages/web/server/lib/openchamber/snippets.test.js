import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createSnippet, deleteSnippet, expandSnippets, getSnippet, listSnippets, updateSnippet } from './snippets.js';

// `snippets.js` resolves the user-level (global) directories from the home
// directory at import time, and it merges them into every list a project asks
// for. Point those roots at a scratch tree so that side of the merge is
// deterministic — and so a test that writes a user-level snippet cannot touch
// the machine's real ~/.omp or ~/.config/opencode tree.
const snippetHome = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs');
  const nodeOs = process.getBuiltinModule('node:os');
  const nodePath = process.getBuiltinModule('node:path');
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'omp-snippet-home-'));
});

vi.mock('./agent-config-files.js', () => {
  const nodePath = process.getBuiltinModule('node:path');
  return {
    OPENCODE_CONFIG_DIR: nodePath.join(snippetHome, 'agent'),
    OPENCODE_HOME_DIR: nodePath.join(snippetHome, 'opencode-home'),
    OMP_PROJECT_DIR: '.omp',
    OPENCODE_PROJECT_DIR: '.opencode',
  };
});

const createdProjects = [];
const newProject = () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-snippets-'));
  createdProjects.push(projectDir);
  return projectDir;
};

/** The snippets a project scope contributes, picked out of the merged list. */
const projectSnippets = (projectDir) => listSnippets(projectDir).filter((snippet) => snippet.source === 'project');

const removeScratchRoots = () => {
  while (createdProjects.length > 0) {
    fs.rmSync(createdProjects.pop(), { recursive: true, force: true });
  }
  fs.rmSync(snippetHome, { recursive: true, force: true });
};

beforeEach(removeScratchRoots);
afterEach(removeScratchRoots);

describe('snippet storage', () => {
  it('creates, lists, updates and deletes project snippets under .omp/snippets', () => {
    const projectDir = newProject();

    const created = createSnippet('review', { content: 'Review by name' }, projectDir, 'project');
    expect(created).toMatchObject({ name: 'review', content: 'Review by name', source: 'project' });
    expect(created.filePath).toBe(path.join(projectDir, '.omp', 'snippets', 'review.md'));

    // A project-scoped list merges the user-level snippets in, so the project's
    // own entries are the ones filtered out by source.
    expect(projectSnippets(projectDir).map((snippet) => snippet.name)).toEqual(['review']);

    updateSnippet('review', { content: 'Review again' }, projectDir);
    expect(getSnippet('review', projectDir).content).toBe('Review again');

    deleteSnippet('review', projectDir);
    expect(projectSnippets(projectDir)).toEqual([]);
    expect(fs.existsSync(created.filePath)).toBe(false);
  });

  it('rejects invalid snippet names and duplicates', () => {
    const projectDir = newProject();
    createSnippet('valid-name', { content: 'x' }, projectDir, 'project');

    expect(() => createSnippet('bad name', { content: 'x' }, projectDir, 'project')).toThrowError(/Snippet name/);
    expect(() => createSnippet('valid-name', { content: 'y' }, projectDir, 'project')).toThrowError(/already exists/);
  });

  it('requires a project directory for project snippets', () => {
    expect(() => createSnippet('needs-project', { content: 'x' }, undefined, 'project')).toThrowError(/Project directory/);
  });

  it('still loads and edits snippets left in the OpenCode tree', () => {
    const projectDir = newProject();
    const legacyDir = path.join(projectDir, '.opencode', 'snippets');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'legacy.md'), '---\naliases:\n  - old\n---\nLegacy body\n', 'utf8');

    expect(getSnippet('legacy', projectDir)).toMatchObject({
      content: 'Legacy body',
      aliases: ['old'],
      filePath: path.join(legacyDir, 'legacy.md'),
    });
    expect(getSnippet('old', projectDir).name).toBe('legacy');

    // An update edits the file where it lives instead of forking a new one.
    updateSnippet('legacy', { content: 'Edited body' }, projectDir);
    expect(fs.readFileSync(path.join(legacyDir, 'legacy.md'), 'utf8')).toContain('Edited body');
    // Still loaded and still editable: the legacy snippet is not pushed out of
    // the project scope by the OMP location being searched too.
    expect(projectSnippets(projectDir).map((snippet) => snippet.name)).toEqual(['legacy']);
  });

  it('lets the OMP location win a name collision with the legacy location', () => {
    const projectDir = newProject();
    const legacyDir = path.join(projectDir, '.opencode', 'snippets');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'shared.md'), 'Legacy content\n', 'utf8');
    createSnippet('shared', { content: 'OMP content' }, projectDir, 'project');

    expect(getSnippet('shared', projectDir).content).toBe('OMP content');
  });

  it('lists the user-level snippets alongside the project ones and lets the project shadow a shared name', () => {
    const projectDir = newProject();
    const userLevel = createSnippet('shared', { content: 'User content' }, undefined, 'global');

    expect(userLevel).toMatchObject({ name: 'shared', content: 'User content', source: 'global' });
    // The user-level write went to the scratch home this test controls, never to
    // the machine's real ~/.omp.
    expect(userLevel.filePath.startsWith(snippetHome)).toBe(true);
    expect(listSnippets(projectDir)).toEqual([expect.objectContaining({ name: 'shared', source: 'global' })]);

    const projectScoped = createSnippet('shared', { content: 'Project content' }, projectDir, 'project');

    expect(projectScoped).toMatchObject({ name: 'shared', content: 'Project content', source: 'project' });
    expect(getSnippet('shared', projectDir).content).toBe('Project content');
    // One entry, the project's: the user-level snippet of the same name is
    // shadowed rather than listed twice.
    expect(listSnippets(projectDir)).toEqual([expect.objectContaining({ name: 'shared', source: 'project' })]);
  });
});

describe('expandSnippets', () => {
  it('expands hashtag references, including through aliases', () => {
    const projectDir = newProject();
    createSnippet('review', { content: 'Review by name' }, projectDir, 'project');
    createSnippet('helper', { content: 'Review by alias', aliases: ['help'] }, projectDir, 'project');

    expect(expandSnippets('Use #review and #help', projectDir)).toBe('Use Review by name and Review by alias');
  });

  it('hoists prepend and append blocks around the inline text', () => {
    const projectDir = newProject();
    createSnippet('base', { content: 'Base text\n\n<append>After</append>' }, projectDir, 'project');
    createSnippet('review', { content: '<prepend>Before</prepend>\n\nReview #base' }, projectDir, 'project');

    expect(expandSnippets('Please #review', projectDir)).toBe('Before\n\nPlease Review Base text\n\nAfter');
  });

  it('leaves unknown hashtags and the skill-call syntax untouched', () => {
    const projectDir = newProject();
    createSnippet('review', { content: 'Review' }, projectDir, 'project');

    expect(expandSnippets('Keep #unknown and #skill(review)', projectDir)).toBe('Keep #unknown and #skill(review)');
  });

  it('stops expanding a recursive snippet at the expansion cap instead of looping forever', () => {
    const projectDir = newProject();
    createSnippet('self', { content: 'Again #self' }, projectDir, 'project');

    expect(expandSnippets('#self', projectDir)).toBe(`${'Again '.repeat(15)}#self`);
  });
});
