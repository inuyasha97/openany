import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { registerConfigSkillRoutes } from './config-skill-routes.js';
import { scanSkillsRepository } from '../skills-catalog/scan.js';
import { installSkillsFromRepository } from '../skills-catalog/install.js';
import { getProfiles } from '../git/identity-storage.js';

vi.mock('../skills-catalog/scan.js', () => ({
  scanSkillsRepository: vi.fn(async () => ({ ok: true, items: [] })),
}));

vi.mock('../skills-catalog/install.js', () => ({
  installSkillsFromRepository: vi.fn(async () => ({ ok: true, installed: [], skipped: [] })),
}));

vi.mock('../skills-catalog/github-meta.js', () => ({
  fetchGitHubRepoMetas: vi.fn(async () => ({})),
}));

vi.mock('../git/identity-storage.js', () => ({
  getProfiles: vi.fn(() => []),
  getProfile: vi.fn(() => null),
}));

const createTempProject = () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-skill-routes-'));
  fs.mkdirSync(path.join(projectRoot, '.git'));
  return projectRoot;
};

const isUnsafeRelativePath = (value) => (
  typeof value !== 'string'
  || value.startsWith('/')
  || value.split(/[\\/]/).includes('..')
);

const startSkillsApp = ({ projectRoot, overrides = {} } = {}) => {
  const app = express();
  app.use(express.json());

  registerConfigSkillRoutes(app, {
    resolveProjectDirectory: async () => ({ directory: projectRoot, error: null }),
    resolveOptionalProjectDirectory: async (req) => {
      const queryDirectory = Array.isArray(req.query?.directory)
        ? req.query.directory[0]
        : req.query?.directory;
      if (!queryDirectory) {
        return { directory: null, error: null };
      }
      return { directory: String(queryDirectory), error: null };
    },
    readSettingsFromDisk: async () => ({}),
    sanitizeSkillCatalogs: (value) => value,
    isUnsafeSkillRelativePath: isUnsafeRelativePath,
    ...overrides,
  });

  const server = app.listen(0);
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
};

const jsonRequest = async (url, init = {}) => {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

describe('config skill routes', () => {
  /** @type {string | null} */
  let projectRoot = null;
  /** @type {{ baseUrl: string, close: () => Promise<void> } | null} */
  let appHandle = null;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    getProfiles.mockReturnValue([]);
    scanSkillsRepository.mockResolvedValue({ ok: true, items: [] });
    installSkillsFromRepository.mockResolvedValue({ ok: true, installed: [], skipped: [] });
  });

  afterEach(async () => {
    if (appHandle) {
      await appHandle.close();
      appHandle = null;
    }
    if (projectRoot) {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      projectRoot = null;
    }
  });

  it('creates a project skill and lists it through the active-project fallback with sources and renamable', async () => {
    projectRoot = createTempProject();
    appHandle = startSkillsApp({ projectRoot });

    const created = await jsonRequest(`${appHandle.baseUrl}/api/config/skills/repo-local-skill`, {
      method: 'POST',
      body: JSON.stringify({
        description: 'Created without a list directory',
        instructions: 'Do the thing.',
        scope: 'project',
        source: 'agents',
      }),
    });
    expect(created.status).toBe(200);
    expect(created.body.success).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.agents', 'skills', 'repo-local-skill', 'SKILL.md'))).toBe(true);

    const listed = await jsonRequest(`${appHandle.baseUrl}/api/config/skills`);
    expect(listed.status).toBe(200);
    expect(Object.keys(listed.body)).toEqual(['skills']);
    const skill = listed.body.skills.find((entry) => entry.name === 'repo-local-skill');
    expect(skill).toBeTruthy();
    expect(skill.scope).toBe('project');
    expect(skill.source).toBe('agents');
    expect(skill.renamable).toBe(true);
    expect(skill.sources.md.exists).toBe(true);
    expect(skill.sources.md.name).toBe('repo-local-skill');
    expect(skill.sources.md.instructions).toContain('Do the thing.');
  });

  it('reports skill metadata for an existing skill and an absent one', async () => {
    projectRoot = createTempProject();
    appHandle = startSkillsApp({ projectRoot });

    await jsonRequest(`${appHandle.baseUrl}/api/config/skills/known-skill`, {
      method: 'POST',
      body: JSON.stringify({ description: 'Known', instructions: 'Body', scope: 'project' }),
    });

    const known = await jsonRequest(`${appHandle.baseUrl}/api/config/skills/known-skill?directory=${encodeURIComponent(projectRoot)}`);
    expect(known.status).toBe(200);
    expect(known.body).toMatchObject({ name: 'known-skill', scope: 'project', source: 'opencode', exists: true });
    expect(known.body.sources.md.path).toContain('SKILL.md');

    const absent = await jsonRequest(`${appHandle.baseUrl}/api/config/skills/nope?directory=${encodeURIComponent(projectRoot)}`);
    expect(absent.status).toBe(200);
    expect(absent.body.exists).toBe(false);
    expect(absent.body.scope).toBeNull();
  });

  it('reads, writes and deletes a skill supporting file and rejects an unsafe path', async () => {
    projectRoot = createTempProject();
    appHandle = startSkillsApp({ projectRoot });

    await jsonRequest(`${appHandle.baseUrl}/api/config/skills/with-files`, {
      method: 'POST',
      body: JSON.stringify({
        description: 'Has files',
        instructions: 'Body',
        scope: 'project',
        supportingFiles: [{ path: 'reference.md', content: 'reference body' }],
      }),
    });

    const read = await jsonRequest(
      `${appHandle.baseUrl}/api/config/skills/with-files/files/reference.md?directory=${encodeURIComponent(projectRoot)}`,
    );
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ path: 'reference.md', content: 'reference body' });

    const written = await jsonRequest(
      `${appHandle.baseUrl}/api/config/skills/with-files/files/notes.md?directory=${encodeURIComponent(projectRoot)}`,
      { method: 'PUT', body: JSON.stringify({ content: 'notes body' }) },
    );
    expect(written.status).toBe(200);
    expect(written.body.success).toBe(true);

    const deleted = await jsonRequest(
      `${appHandle.baseUrl}/api/config/skills/with-files/files/notes.md?directory=${encodeURIComponent(projectRoot)}`,
      { method: 'DELETE' },
    );
    expect(deleted.status).toBe(200);
    expect(deleted.body.success).toBe(true);

    const unsafe = await jsonRequest(
      `${appHandle.baseUrl}/api/config/skills/with-files/files/..%2Fsecret.md?directory=${encodeURIComponent(projectRoot)}`,
    );
    expect(unsafe.status).toBe(400);
    expect(unsafe.body).toEqual({ error: 'Invalid file path' });

    const missingSkill = await jsonRequest(
      `${appHandle.baseUrl}/api/config/skills/absent/files/reference.md?directory=${encodeURIComponent(projectRoot)}`,
    );
    expect(missingSkill.status).toBe(404);
    expect(missingSkill.body).toEqual({ error: 'Skill not found' });
  });

  it('renames a managed skill and answers with the new name', async () => {
    projectRoot = createTempProject();
    appHandle = startSkillsApp({ projectRoot });

    await jsonRequest(`${appHandle.baseUrl}/api/config/skills/old-name`, {
      method: 'POST',
      body: JSON.stringify({ description: 'Rename me', instructions: 'Body', scope: 'project' }),
    });

    const renamed = await jsonRequest(`${appHandle.baseUrl}/api/config/skills/old-name?directory=${encodeURIComponent(projectRoot)}`, {
      method: 'PATCH',
      body: JSON.stringify({ renameTo: 'new-name' }),
    });

    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('new-name');
    expect(renamed.body.success).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.omp', 'skills', 'new-name', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.omp', 'skills', 'old-name'))).toBe(false);
  });

  it('deletes a skill directory', async () => {
    projectRoot = createTempProject();
    appHandle = startSkillsApp({ projectRoot });

    await jsonRequest(`${appHandle.baseUrl}/api/config/skills/doomed`, {
      method: 'POST',
      body: JSON.stringify({ description: 'Doomed', instructions: 'Body', scope: 'project' }),
    });

    const deleted = await jsonRequest(`${appHandle.baseUrl}/api/config/skills/doomed?directory=${encodeURIComponent(projectRoot)}`, {
      method: 'DELETE',
    });

    expect(deleted.status).toBe(200);
    expect(deleted.body.success).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.omp', 'skills', 'doomed'))).toBe(false);
  });

  it('merges curated and custom catalog sources and strips the identity id', async () => {
    projectRoot = createTempProject();
    appHandle = startSkillsApp({
      projectRoot,
      overrides: {
        readSettingsFromDisk: async () => ({
          skillCatalogs: [{ id: 'mine', label: 'Mine', source: 'me/skills', subpath: 'pkg', gitIdentityId: 'work' }],
        }),
      },
    });

    const catalog = await jsonRequest(`${appHandle.baseUrl}/api/config/skills/catalog`);

    expect(catalog.status).toBe(200);
    expect(catalog.body.ok).toBe(true);
    expect(catalog.body.itemsBySource).toEqual({});
    const ids = catalog.body.sources.map((source) => source.id);
    expect(ids).toContain('anthropic');
    expect(ids).toContain('mine');
    const custom = catalog.body.sources.find((source) => source.id === 'mine');
    expect(custom).toMatchObject({
      id: 'mine',
      label: 'Mine',
      description: 'me/skills',
      source: 'me/skills',
      defaultSubpath: 'pkg',
      stars: null,
      repoUpdatedAt: null,
    });
    expect(custom.gitIdentityId).toBeUndefined();
  });

  it('scans one catalog source and marks already-installed skills', async () => {
    projectRoot = createTempProject();
    appHandle = startSkillsApp({ projectRoot });

    await jsonRequest(`${appHandle.baseUrl}/api/config/skills/installed-skill`, {
      method: 'POST',
      body: JSON.stringify({ description: 'Installed', instructions: 'Body', scope: 'project' }),
    });

    scanSkillsRepository.mockResolvedValue({
      ok: true,
      items: [{ skillName: 'installed-skill' }, { skillName: 'fresh-skill' }],
    });

    const scanned = await jsonRequest(
      `${appHandle.baseUrl}/api/config/skills/catalog/source?sourceId=anthropic&directory=${encodeURIComponent(projectRoot)}`,
    );

    expect(scanned.status).toBe(200);
    expect(scanned.body.ok).toBe(true);
    const byName = new Map(scanned.body.items.map((item) => [item.skillName, item]));
    expect(byName.get('installed-skill')).toMatchObject({
      sourceId: 'anthropic',
      installed: { isInstalled: true, scope: 'project', source: 'opencode' },
    });
    expect(byName.get('fresh-skill').installed).toEqual({ isInstalled: false });

    const unknown = await jsonRequest(`${appHandle.baseUrl}/api/config/skills/catalog/source?sourceId=nope`);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.kind).toBe('invalidSource');
  });

  it('maps scan failures to 401 with identities and to 400 otherwise', async () => {
    projectRoot = createTempProject();
    appHandle = startSkillsApp({ projectRoot });
    getProfiles.mockReturnValue([{ id: 'work', name: 'Work' }]);

    scanSkillsRepository.mockResolvedValue({
      ok: false,
      error: { kind: 'authRequired', message: 'Authentication required to access this repository', sshOnly: true },
    });
    const unauthorized = await jsonRequest(`${appHandle.baseUrl}/api/config/skills/scan`, {
      method: 'POST',
      body: JSON.stringify({ source: 'git@github.com:private/skills.git' }),
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body.error.identities).toEqual([{ id: 'work', name: 'Work' }]);

    scanSkillsRepository.mockResolvedValue({
      ok: false,
      error: { kind: 'invalidSource', message: 'Repository source is required' },
    });
    const invalid = await jsonRequest(`${appHandle.baseUrl}/api/config/skills/scan`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ ok: false, error: { kind: 'invalidSource', message: 'Repository source is required' } });
  });

  it('installs skills and maps project scope without a directory, conflicts and auth to their statuses', async () => {
    projectRoot = createTempProject();
    appHandle = startSkillsApp({
      projectRoot,
      overrides: {
        resolveProjectDirectory: async () => ({ directory: null, error: 'Directory parameter or active project is required' }),
      },
    });

    const noDirectory = await jsonRequest(`${appHandle.baseUrl}/api/config/skills/install`, {
      method: 'POST',
      body: JSON.stringify({ source: 'me/skills', scope: 'project', selections: [{ skillDir: 'a' }] }),
    });
    expect(noDirectory.status).toBe(400);
    expect(noDirectory.body.error.message).toContain('Directory parameter or active project is required');

    installSkillsFromRepository.mockResolvedValue({
      ok: false,
      error: { kind: 'conflicts', message: 'Existing skills conflict', conflicts: [{ skillName: 'a' }] },
    });
    const conflict = await jsonRequest(`${appHandle.baseUrl}/api/config/skills/install`, {
      method: 'POST',
      body: JSON.stringify({ source: 'me/skills', scope: 'user', selections: [{ skillDir: 'a' }] }),
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.kind).toBe('conflicts');

    installSkillsFromRepository.mockResolvedValue({ ok: true, installed: [{ skillName: 'a' }], skipped: [] });
    const installed = await jsonRequest(`${appHandle.baseUrl}/api/config/skills/install`, {
      method: 'POST',
      body: JSON.stringify({ source: 'me/skills', scope: 'user', selections: [{ skillDir: 'a' }] }),
    });
    expect(installed.status).toBe(200);
    expect(installed.body).toMatchObject({ ok: true, success: true, installed: [{ skillName: 'a' }], skipped: [] });

    installSkillsFromRepository.mockResolvedValue({ ok: true, installed: [], skipped: [{ skillName: 'a' }] });
    const skipped = await jsonRequest(`${appHandle.baseUrl}/api/config/skills/install`, {
      method: 'POST',
      body: JSON.stringify({ source: 'me/skills', scope: 'user', selections: [{ skillDir: 'a' }] }),
    });
    expect(skipped.status).toBe(200);
    expect(skipped.body).toEqual({
      ok: true,
      installed: [],
      skipped: [{ skillName: 'a' }],
      requiresReload: false,
      message: 'No skills were installed',
    });
  });

  it('rejects listing with an unresolvable directory', async () => {
    projectRoot = createTempProject();
    appHandle = startSkillsApp({
      projectRoot,
      overrides: {
        resolveOptionalProjectDirectory: async () => ({ directory: null, error: 'Path is outside the active workspace' }),
      },
    });

    const listed = await jsonRequest(`${appHandle.baseUrl}/api/config/skills`);
    expect(listed.status).toBe(400);
    expect(listed.body).toEqual({ error: 'Path is outside the active workspace' });

    const catalog = await jsonRequest(`${appHandle.baseUrl}/api/config/skills/catalog`);
    expect(catalog.status).toBe(400);
    expect(catalog.body).toEqual({ error: 'Path is outside the active workspace' });
  });
});
