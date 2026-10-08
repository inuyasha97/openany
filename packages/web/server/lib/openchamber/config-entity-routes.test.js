import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'node:module';

const sqlite = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite');
  } catch {
    return null;
  }
})();

const ENV_KEYS = ['PI_CODING_AGENT_DIR', 'PI_CONFIG_DIR', 'OMP_PROFILE', 'PI_PROFILE', 'PI_CONFIG_FILES'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let agentDir;
let projectDir;

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

beforeEach(() => {
  agentDir = tempDir('omp-entity-agent-');
  projectDir = tempDir('omp-entity-project-');
  for (const key of ENV_KEYS) delete process.env[key];
  // The config-entity module resolves OMP paths at import time, so point the
  // process at the temp agent dir before importing it.
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(agentDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

const createApp = () => {
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'post', 'patch', 'delete', 'put']) {
    app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
  }
  return { app, routes };
};

const createResponse = () => ({
  statusCode: 200,
  body: undefined,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(value) {
    this.body = value;
    return this;
  },
});

const createRequest = ({ params = {}, body, query = {} } = {}) => ({
  params,
  body,
  query,
  get: () => null,
});

const registerRoutes = async (options = {}) => {
  vi.resetModules();
  const { registerConfigEntityRoutes } = await import('./config-entity-routes.js');
  const { app, routes } = createApp();
  const resolvedAgentDir = options.agentDir ?? agentDir;
  const resolvedProjectDir = options.projectDir === undefined ? projectDir : options.projectDir;
  registerConfigEntityRoutes(app, {
    ompAgentDir: resolvedAgentDir,
    resolveProjectDirectory: async () => ({ directory: resolvedProjectDir, error: null }),
    resolveOptionalProjectDirectory: async () => ({ directory: resolvedProjectDir, error: null }),
  });
  return routes;
};

const invoke = async (routes, key, request) => {
  const handler = routes.get(key);
  if (!handler) throw new Error(`No route registered for ${key}`);
  const res = createResponse();
  await handler(createRequest(request), res);
  return res;
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Seed OMP's `auth_credentials` table with one active oauth row per id. */
const seedCredentials = (dir, ids) => {
  const db = new sqlite.DatabaseSync(path.join(dir, 'agent.db'));
  db.exec(
    'CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, ' +
      'credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT DEFAULT NULL, ' +
      'updated_at INTEGER NOT NULL DEFAULT 0)',
  );
  const insert = db.prepare(
    'INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause) VALUES (?, ?, ?, ?)',
  );
  for (const id of ids) insert.run(id, 'oauth', JSON.stringify({ access: 'a', refresh: 'r', expires: 1 }), null);
  db.close();
};

describe('agent markdown CRUD', () => {
  it('creates, reads, updates and deletes a user-level agent', async () => {
    const routes = await registerRoutes();

    const created = await invoke(routes, 'POST /api/config/agents/:name', {
      params: { name: 'reviewer' },
      body: {
        scope: 'user',
        description: 'Reviews code',
        model: 'openai/gpt-4#high',
        system: 'You review code.',
        permissions: [{ action: 'shell', resource: '*', effect: 'ask' }],
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.body).toMatchObject({ success: true, scope: 'user' });
    const mdPath = path.join(agentDir, 'agents', 'reviewer.md');
    expect(created.body.path).toBe(mdPath);
    expect(fs.existsSync(mdPath)).toBe(true);

    const config = await invoke(routes, 'GET /api/config/agents/:name/config', { params: { name: 'reviewer' } });
    expect(config.statusCode).toBe(200);
    expect(config.body).toEqual({
      source: 'md',
      scope: 'user',
      path: mdPath,
      legacy: false,
      config: {
        system: 'You review code.',
        description: 'Reviews code',
        model: 'openai/gpt-4#high',
        permissions: [{ action: 'shell', resource: '*', effect: 'ask' }],
      },
    });

    const updated = await invoke(routes, 'PATCH /api/config/agents/:name', {
      params: { name: 'reviewer' },
      body: { description: null, hidden: true },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.body).toMatchObject({ success: true, source: 'md', scope: 'user', path: mdPath });

    const afterUpdate = await invoke(routes, 'GET /api/config/agents/:name/config', { params: { name: 'reviewer' } });
    expect(afterUpdate.body.config.description).toBeUndefined();
    expect(afterUpdate.body.config.hidden).toBe(true);
    // The prompt body survives a frontmatter rewrite.
    expect(afterUpdate.body.config.system).toBe('You review code.');

    const deleted = await invoke(routes, 'DELETE /api/config/agents/:name', {
      params: { name: 'reviewer' },
      body: { scope: 'user' },
    });
    expect(deleted.statusCode).toBe(200);
    expect(fs.existsSync(mdPath)).toBe(false);
  });

  it('writes project-scope agents under .omp/agents', async () => {
    const routes = await registerRoutes();
    const created = await invoke(routes, 'POST /api/config/agents/:name', {
      params: { name: 'builder' },
      body: { scope: 'project', description: 'Builds', system: 'Build things.' },
    });
    expect(created.body.scope).toBe('project');
    const projectPath = path.join(projectDir, '.omp', 'agents', 'builder.md');
    expect(created.body.path).toBe(projectPath);
    expect(fs.existsSync(projectPath)).toBe(true);

    const sources = await invoke(routes, 'GET /api/config/agents/:name', { params: { name: 'builder' } });
    expect(sources.body.scope).toBe('project');
    expect(sources.body.isBuiltIn).toBe(false);
    expect(sources.body.sources.md.exists).toBe(true);
    expect(sources.body.sources.md.scope).toBe('project');
    expect(sources.body.sources.projectMd.exists).toBe(true);
  });

  it('reports permissions from the agent markdown and empty global rules', async () => {
    const routes = await registerRoutes();
    await invoke(routes, 'POST /api/config/agents/:name', {
      params: { name: 'limiter' },
      body: {
        scope: 'user',
        system: 'Careful.',
        permissions: [{ action: 'edit', resource: '*.lock', effect: 'deny' }],
      },
    });
    const permissions = await invoke(routes, 'GET /api/config/agents/:name/permissions', { params: { name: 'limiter' } });
    expect(permissions.statusCode).toBe(200);
    expect(permissions.body.global).toEqual([]);
    expect(permissions.body.agent).toEqual([{ action: 'edit', resource: '*.lock', effect: 'deny' }]);
    expect(permissions.body.effective).toEqual([
      { action: 'edit', resource: '*.lock', effect: 'deny', source: 'agent' },
    ]);
    expect(permissions.body.source).toBe('md');
  });
});

describe('markdown entity JSON half', () => {
  it('surfaces the typed unsupported error when no markdown file exists', async () => {
    const routes = await registerRoutes();
    const response = await invoke(routes, 'GET /api/config/agents/:name/config', { params: { name: 'does-not-exist' } });
    expect(response.statusCode).toBe(501);
    expect(response.body.code).toBe('OMP_UNSUPPORTED_CONFIG_SECTION');
    expect(response.body.error).toMatch(/config\.yml/);
  });

  it('surfaces the typed unsupported error for the commands JSON half too', async () => {
    const routes = await registerRoutes();
    const response = await invoke(routes, 'GET /api/config/commands/:name/config', { params: { name: 'does-not-exist' } });
    expect(response.statusCode).toBe(501);
    expect(response.body.code).toBe('OMP_UNSUPPORTED_CONFIG_SECTION');
  });

  it('keeps the markdown sources while marking JSON as unsupported', async () => {
    const routes = await registerRoutes();
    await invoke(routes, 'POST /api/config/agents/:name', {
      params: { name: 'present' },
      body: { scope: 'user', system: 'Hi.' },
    });
    const sources = await invoke(routes, 'GET /api/config/agents/:name', { params: { name: 'present' } });
    expect(sources.statusCode).toBe(200);
    expect(sources.body.sources.md.exists).toBe(true);
    expect(sources.body.sources.json).toEqual(expect.objectContaining({
      exists: false,
      unsupported: true,
      code: 'OMP_UNSUPPORTED_CONFIG_SECTION',
    }));
  });
});

describe('command markdown CRUD', () => {
  it('creates, reads, updates with the v1 subtask alias and deletes a command', async () => {
    const routes = await registerRoutes();
    const created = await invoke(routes, 'POST /api/config/commands/:name', {
      params: { name: 'ship' },
      body: { scope: 'user', description: 'Ship it', template: 'Ship the release.' },
    });
    expect(created.statusCode).toBe(200);
    expect(created.body.scope).toBe('user');
    const mdPath = path.join(agentDir, 'commands', 'ship.md');
    expect(fs.existsSync(mdPath)).toBe(true);

    const config = await invoke(routes, 'GET /api/config/commands/:name/config', { params: { name: 'ship' } });
    expect(config.body).toEqual({
      source: 'md',
      scope: 'user',
      path: mdPath,
      legacy: false,
      config: { template: 'Ship the release.', description: 'Ship it' },
    });

    await invoke(routes, 'PATCH /api/config/commands/:name', {
      params: { name: 'ship' },
      body: { subtask: true },
    });
    const after = await invoke(routes, 'GET /api/config/commands/:name/config', { params: { name: 'ship' } });
    expect(after.body.config.subagent).toBe(true);
    expect(after.body.config.subtask).toBeUndefined();

    const sources = await invoke(routes, 'GET /api/config/commands/:name', { params: { name: 'ship' } });
    expect(sources.body.sources.md.fieldNames).toBeUndefined();
    expect(sources.body.sources.md.fields).toContain('template');

    await invoke(routes, 'DELETE /api/config/commands/:name', { params: { name: 'ship' } });
    expect(fs.existsSync(mdPath)).toBe(false);
  });
});

describe('MCP mcp.json CRUD', () => {
  it('round-trips a local server through the user mcp.json file', async () => {
    const routes = await registerRoutes();
    const userMcp = path.join(agentDir, 'mcp.json');

    const created = await invoke(routes, 'POST /api/config/mcp/:name', {
      params: { name: 'filesystem' },
      body: {
        scope: 'user',
        type: 'local',
        command: ['node', 'server.js', '--root', '/tmp'],
        cwd: '/tmp/work',
        environment: { TOKEN: 'secret' },
        timeout: { execution: 5000 },
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.body).toEqual({ success: true, message: 'MCP server "filesystem" created.', path: userMcp });

    const stored = readJson(userMcp);
    expect(stored.mcpServers.filesystem).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['server.js', '--root', '/tmp'],
      cwd: '/tmp/work',
      env: { TOKEN: 'secret' },
      timeout: 5000,
    });

    const list = await invoke(routes, 'GET /api/config/mcp', {});
    expect(list.body).toEqual([
      {
        name: 'filesystem',
        type: 'local',
        command: ['node', 'server.js', '--root', '/tmp'],
        cwd: '/tmp/work',
        environment: { TOKEN: 'secret' },
        timeout: { execution: 5000 },
        scope: 'user',
        sectionKey: 'mcpServers',
        legacy: false,
        authenticated: false,
      },
    ]);

    const one = await invoke(routes, 'GET /api/config/mcp/:name', { params: { name: 'filesystem' } });
    expect(one.body).toEqual(list.body[0]);

    const updated = await invoke(routes, 'PATCH /api/config/mcp/:name', {
      params: { name: 'filesystem' },
      body: { disabled: true },
    });
    expect(updated.statusCode).toBe(200);
    expect(readJson(userMcp).mcpServers.filesystem.enabled).toBe(false);
    expect(readJson(userMcp).disabledServers).toEqual(['filesystem']);

    const disabled = await invoke(routes, 'GET /api/config/mcp/:name', { params: { name: 'filesystem' } });
    expect(disabled.body.disabled).toBe(true);

    const deleted = await invoke(routes, 'DELETE /api/config/mcp/:name', { params: { name: 'filesystem' } });
    expect(deleted.statusCode).toBe(200);
    expect(readJson(userMcp).mcpServers).toBeUndefined();
    expect(readJson(userMcp).disabledServers).toBeUndefined();
  });

  it('round-trips a remote server with OAuth onto the user file', async () => {
    const routes = await registerRoutes();
    await invoke(routes, 'POST /api/config/mcp/:name', {
      params: { name: 'remote' },
      body: {
        scope: 'user',
        type: 'remote',
        url: 'https://mcp.example.com',
        headers: { Authorization: 'Bearer x' },
        oauth: { client_id: 'cid', callback_port: 7777, redirect_uri: 'http://localhost/cb' },
      },
    });
    const stored = readJson(path.join(agentDir, 'mcp.json'));
    expect(stored.mcpServers.remote).toEqual({
      type: 'http',
      url: 'https://mcp.example.com',
      headers: { Authorization: 'Bearer x' },
      oauth: { clientId: 'cid', callbackPort: 7777, redirectUri: 'http://localhost/cb' },
    });

    const list = await invoke(routes, 'GET /api/config/mcp', {});
    expect(list.body[0]).toMatchObject({
      name: 'remote',
      type: 'remote',
      url: 'https://mcp.example.com',
      headers: { Authorization: 'Bearer x' },
      oauth: { client_id: 'cid', callback_port: 7777, redirect_uri: 'http://localhost/cb' },
      scope: 'user',
    });
  });

  it('merges project servers as project scope and lets the user file win a shared name', async () => {
    const routes = await registerRoutes();
    await invoke(routes, 'POST /api/config/mcp/:name', {
      params: { name: 'project-only' },
      body: { scope: 'project', type: 'local', command: ['project-bin'] },
    });
    const projectMcp = path.join(projectDir, '.omp', 'mcp.json');
    expect(fs.existsSync(projectMcp)).toBe(true);
    expect(readJson(projectMcp).mcpServers['project-only']).toEqual({ type: 'stdio', command: 'project-bin' });

    // A name defined in both files: the user entry is the one reported.
    fs.writeFileSync(path.join(agentDir, 'mcp.json'), JSON.stringify({
      mcpServers: { shared: { type: 'stdio', command: 'user-bin' } },
    }, null, 2));
    fs.writeFileSync(projectMcp, JSON.stringify({
      mcpServers: {
        shared: { type: 'stdio', command: 'project-bin' },
        'project-only': { type: 'stdio', command: 'project-bin' },
      },
    }, null, 2));

    const list = await invoke(routes, 'GET /api/config/mcp', {});
    const byName = Object.fromEntries(list.body.map((entry) => [entry.name, entry]));
    expect(byName['project-only'].scope).toBe('project');
    expect(byName.shared.scope).toBe('user');
    expect(byName.shared.command).toEqual(['user-bin']);
  });

  it('omits an explicit oauth:false and rejects a local server without a command', async () => {
    const routes = await registerRoutes();
    const created = await invoke(routes, 'POST /api/config/mcp/:name', {
      params: { name: 'anon' },
      body: { scope: 'user', type: 'remote', url: 'https://anon.example', oauth: false },
    });
    expect(created.statusCode).toBe(200);
    expect(readJson(path.join(agentDir, 'mcp.json')).mcpServers.anon).toEqual({
      type: 'http',
      url: 'https://anon.example',
    });

    const invalid = await invoke(routes, 'POST /api/config/mcp/:name', {
      params: { name: 'broken' },
      body: { scope: 'user', type: 'local', command: [] },
    });
    expect(invalid.statusCode).toBe(500);
    expect(invalid.body.error).toBe('MCP server "broken" requires a command');
  });

  it('answers 404 when patching a missing server', async () => {
    const routes = await registerRoutes();
    const response = await invoke(routes, 'PATCH /api/config/mcp/:name', {
      params: { name: 'ghost' },
      body: { disabled: true },
    });
    expect(response.statusCode).toBe(404);
    expect(response.body.error).toBe('MCP server "ghost" not found');
  });
});

describe.skipIf(!sqlite)('MCP credential state', () => {
  const signedId = 'mcp_oauth:profile:default:https://signed.example.com';
  const unsignedId = 'mcp_oauth:profile:default:https://unsigned.example.com';

  it('carries the credential id and whether it resolves into the entity', async () => {
    const routes = await registerRoutes();
    seedCredentials(agentDir, [signedId]);
    fs.writeFileSync(path.join(agentDir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        signed: { type: 'http', url: 'https://signed.example.com', auth: { type: 'oauth', credentialId: signedId } },
        unsigned: { type: 'http', url: 'https://unsigned.example.com', auth: { type: 'oauth', credentialId: unsignedId } },
        plain: { type: 'http', url: 'https://plain.example.com' },
      },
    }, null, 2));

    const list = await invoke(routes, 'GET /api/config/mcp', {});
    const byName = Object.fromEntries(list.body.map((entry) => [entry.name, entry]));

    expect(byName.signed).toMatchObject({ credentialId: signedId, authenticated: true });
    expect(byName.unsigned).toMatchObject({ credentialId: unsignedId, authenticated: false });
    expect(byName.plain.credentialId).toBeUndefined();
    expect(byName.plain.authenticated).toBe(false);
  });

  it('never rewrites a hand-written mcp.json on a read', async () => {
    const routes = await registerRoutes();
    const file = path.join(agentDir, 'mcp.json');
    const original = `${JSON.stringify({
      mcpServers: { keep: { type: 'http', url: 'https://keep.example.com', extra: { nested: true } } },
      someOtherTopLevel: true,
    }, null, 2)}\n`;
    fs.writeFileSync(file, original);

    await invoke(routes, 'GET /api/config/mcp', {});

    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });
});

describe('global AGENTS.md', () => {
  it('reads, writes and reports a conflict', async () => {
    const routes = await registerRoutes();
    const agentsMd = path.join(agentDir, 'AGENTS.md');

    const missing = await invoke(routes, 'GET /api/behavior/agents-md', {});
    expect(missing.body).toEqual({ content: '', exists: false, path: agentsMd });

    const saved = await invoke(routes, 'PUT /api/behavior/agents-md', { body: { content: 'Be terse.' } });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).toEqual({ success: true, message: 'AGENTS.md saved.' });
    expect(fs.readFileSync(agentsMd, 'utf8')).toBe('Be terse.');

    const present = await invoke(routes, 'GET /api/behavior/agents-md', {});
    expect(present.body).toEqual({ content: 'Be terse.', exists: true, path: agentsMd });

    const conflict = await invoke(routes, 'PUT /api/behavior/agents-md', {
      body: { content: 'Overwrite.', expectedContent: 'stale' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body.code).toBe('AGENTS_MD_CONFLICT');
    expect(fs.readFileSync(agentsMd, 'utf8')).toBe('Be terse.');

    const accepted = await invoke(routes, 'PUT /api/behavior/agents-md', {
      body: { content: 'Be terse.', expectedContent: 'Be terse.' },
    });
    expect(accepted.statusCode).toBe(200);
  });

  it('rejects content over 1 MB with 413', async () => {
    const routes = await registerRoutes();
    const response = await invoke(routes, 'PUT /api/behavior/agents-md', {
      body: { content: 'x'.repeat(1024 * 1024 + 1) },
    });
    expect(response.statusCode).toBe(413);
  });
});
