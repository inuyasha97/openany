import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createRouteRegistry = () => {
  const routes = new Map();

  return {
    app: {
      get(routePath, ...handlers) {
        routes.set(`GET ${routePath}`, handlers.at(-1));
      },
      // `...handlers` because the real routes attach a body parser per route;
      // the last one is the handler under test.
      put(routePath, ...handlers) {
        routes.set(`PUT ${routePath}`, handlers.at(-1));
      },
    },
    getRoute(method, routePath) {
      return routes.get(`${method} ${routePath}`);
    },
  };
};

const createMockResponse = () => {
  const state = { statusCode: 200, body: null };

  return {
    status(code) {
      state.statusCode = code;
      return this;
    },
    json(payload) {
      state.body = payload;
      return this;
    },
    get statusCode() {
      return state.statusCode;
    },
    get body() {
      return state.body;
    },
  };
};

const createRequest = ({ body } = {}) => ({ body });

const createTempAgentDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'omp-settings-routes-'));

const ENV_KEYS = ['PI_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'OMP_PROFILE', 'PI_PROFILE', 'PI_CONFIG_FILES'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

/**
 * Import the route module fresh so the agent dir it resolves the target file
 * from is the temp directory, exactly as production wires it (the route takes
 * no path dependency; it resolves `config.yml`/`config.yaml` itself).
 */
const mount = async () => {
  vi.resetModules();
  const agentConfigFiles = await import('./agent-config-files.js');
  const { registerOmpSettingsRoutes } = await import('./omp-settings-routes.js');
  const { app, getRoute } = createRouteRegistry();
  registerOmpSettingsRoutes(app);
  return {
    getRoute,
    readConfigFile: agentConfigFiles.readConfigFile,
    writeConfig: agentConfigFiles.writeConfig,
  };
};

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('omp settings routes', () => {
  let agentDir;
  let configYml;
  let configYaml;

  beforeEach(() => {
    agentDir = createTempAgentDir();
    configYml = path.join(agentDir, 'config.yml');
    configYaml = path.join(agentDir, 'config.yaml');
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it('reads and writes providers.cacheRetention', async () => {
    const { getRoute, readConfigFile } = await mount();

    const putRes = createMockResponse();
    await getRoute('PUT', '/api/config/cache-retention')(
      createRequest({ body: { retention: 'short' } }),
      putRes,
    );

    expect(putRes.statusCode).toBe(200);
    expect(putRes.body).toEqual({ retention: 'short', changed: true });
    expect(readConfigFile(configYml).providers.cacheRetention).toBe('short');

    const getRes = createMockResponse();
    await getRoute('GET', '/api/config/cache-retention')(createRequest(), getRes);

    expect(getRes.statusCode).toBe(200);
    expect(getRes.body).toEqual({ retention: 'short' });
  });

  it('answers the OMP default when the key is absent', async () => {
    const { getRoute } = await mount();

    const res = createMockResponse();
    await getRoute('GET', '/api/config/cache-retention')(createRequest(), res);

    expect(res.body).toEqual({ retention: 'auto' });
  });

  it('preserves every other key in config.yml', async () => {
    const { getRoute, readConfigFile, writeConfig } = await mount();
    writeConfig(
      {
        model: 'anthropic/claude',
        providers: { anthropic: { apiKey: 'secret' }, cacheRetention: 'long' },
        nested: { keep: [1, 2, 3] },
      },
      configYml,
    );

    const res = createMockResponse();
    await getRoute('PUT', '/api/config/cache-retention')(
      createRequest({ body: { retention: 'none' } }),
      res,
    );

    expect(res.body).toEqual({ retention: 'none', changed: true });
    expect(readConfigFile(configYml)).toEqual({
      model: 'anthropic/claude',
      providers: { anthropic: { apiKey: 'secret' }, cacheRetention: 'none' },
      nested: { keep: [1, 2, 3] },
    });
  });

  it('reads and updates config.yaml in place when OMP falls back to it', async () => {
    const { getRoute, readConfigFile, writeConfig } = await mount();
    writeConfig({ model: 'anthropic/claude', providers: { cacheRetention: 'long' } }, configYaml);

    const getRes = createMockResponse();
    await getRoute('GET', '/api/config/cache-retention')(createRequest(), getRes);
    expect(getRes.statusCode).toBe(200);
    expect(getRes.body).toEqual({ retention: 'long' });

    const putRes = createMockResponse();
    await getRoute('PUT', '/api/config/cache-retention')(
      createRequest({ body: { retention: 'short' } }),
      putRes,
    );

    expect(putRes.body).toEqual({ retention: 'short', changed: true });
    expect(readConfigFile(configYaml)).toEqual({
      model: 'anthropic/claude',
      providers: { cacheRetention: 'short' },
    });
    // A new config.yml would shadow the file OMP is actually loading.
    expect(fs.existsSync(configYml)).toBe(false);
  });

  it('reports changed: false when the value already matches', async () => {
    const { getRoute, writeConfig } = await mount();
    writeConfig({ providers: { cacheRetention: 'auto' } }, configYml);

    const res = createMockResponse();
    await getRoute('PUT', '/api/config/cache-retention')(
      createRequest({ body: { retention: 'auto' } }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ retention: 'auto', changed: false });
  });

  it('rejects a value OMP does not accept with the accepted ones named', async () => {
    const { getRoute } = await mount();

    const res = createMockResponse();
    await getRoute('PUT', '/api/config/cache-retention')(
      createRequest({ body: { retention: 'forever' } }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('auto');
    expect(res.body.error).toContain('short');
    expect(res.body.error).toContain('long');
    expect(res.body.error).toContain('none');
    expect(fs.existsSync(configYml)).toBe(false);
  });

  it('rejects a missing or non-string retention', async () => {
    const { getRoute } = await mount();

    for (const body of [undefined, {}, { retention: 5 }]) {
      const res = createMockResponse();
      await getRoute('PUT', '/api/config/cache-retention')(createRequest({ body }), res);
      expect(res.statusCode).toBe(400);
    }
  });

  it('answers 500 when the config file cannot be written', async () => {
    // A directory where the config file should be makes the write fail.
    fs.mkdirSync(configYml);
    const { getRoute } = await mount();

    const res = createMockResponse();
    await getRoute('PUT', '/api/config/cache-retention')(
      createRequest({ body: { retention: 'short' } }),
      res,
    );

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to save cache retention' });
  });

  it('answers 500 when an unparseable config file cannot be read safely', async () => {
    const { getRoute } = await mount();
    fs.writeFileSync(configYml, 'providers: [unclosed\n', 'utf8');

    const getRes = createMockResponse();
    await getRoute('GET', '/api/config/cache-retention')(createRequest(), getRes);
    expect(getRes.statusCode).toBe(500);
    expect(getRes.body).toEqual({ error: 'Failed to read cache retention' });

    const putRes = createMockResponse();
    await getRoute('PUT', '/api/config/cache-retention')(
      createRequest({ body: { retention: 'short' } }),
      putRes,
    );
    expect(putRes.statusCode).toBe(500);
    expect(putRes.body).toEqual({ error: 'Failed to save cache retention' });
  });
});

describe('tool approval route', () => {
  let agentDir;
  let configYml;

  beforeEach(() => {
    agentDir = createTempAgentDir();
    configYml = path.join(agentDir, 'config.yml');
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("reads and writes OMP's tools.approvalMode", async () => {
    const { getRoute, readConfigFile } = await mount();

    const putRes = createMockResponse();
    await getRoute('PUT', '/api/config/tool-approval')(createRequest({ body: { mode: 'always-ask' } }), putRes);

    expect(putRes.statusCode).toBe(200);
    expect(putRes.body).toEqual({ mode: 'always-ask', changed: true });
    expect(readConfigFile(configYml).tools.approvalMode).toBe('always-ask');

    const getRes = createMockResponse();
    await getRoute('GET', '/api/config/tool-approval')(createRequest(), getRes);
    expect(getRes.body).toEqual({ mode: 'always-ask' });
  });

  it("answers OMP's own default (yolo) when the key is absent", async () => {
    const { getRoute } = await mount();

    const res = createMockResponse();
    await getRoute('GET', '/api/config/tool-approval')(createRequest(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ mode: 'yolo' });
  });

  it('reports changed:false when the mode is already the stored one', async () => {
    const { getRoute } = await mount();
    await getRoute('PUT', '/api/config/tool-approval')(createRequest({ body: { mode: 'write' } }), createMockResponse());

    const again = createMockResponse();
    await getRoute('PUT', '/api/config/tool-approval')(createRequest({ body: { mode: 'write' } }), again);

    expect(again.body).toEqual({ mode: 'write', changed: false });
  });

  it('keeps every other key: per-tool overrides, other tools keys and the rest of the document', async () => {
    // A mode write that dropped `tools.approval` would silently auto-approve a
    // tool the user had pinned to `prompt`.
    const { getRoute, writeConfig, readConfigFile } = await mount();
    writeConfig({
      model: 'anthropic/claude',
      tools: { approval: { shell: 'prompt' }, other: true },
    }, configYml);

    const res = createMockResponse();
    await getRoute('PUT', '/api/config/tool-approval')(createRequest({ body: { mode: 'always-ask' } }), res);

    expect(res.statusCode).toBe(200);
    const after = readConfigFile(configYml);
    expect(after.tools).toEqual({ approval: { shell: 'prompt' }, other: true, approvalMode: 'always-ask' });
    expect(after.model).toBe('anthropic/claude');
  });

  it('rejects an unknown mode without touching the file', async () => {
    const { getRoute, writeConfig, readConfigFile } = await mount();
    writeConfig({ tools: { approvalMode: 'write' } }, configYml);

    for (const body of [undefined, {}, { mode: 'sometimes' }, { mode: 5 }]) {
      const res = createMockResponse();
      await getRoute('PUT', '/api/config/tool-approval')(createRequest({ body }), res);
      expect(res.statusCode).toBe(400);
    }
    expect(readConfigFile(configYml).tools.approvalMode).toBe('write');
  });

  it('refuses a tools section that is not a mapping rather than clobbering it', async () => {
    const { getRoute, writeConfig, readConfigFile } = await mount();
    writeConfig({ tools: ['not', 'a', 'map'] }, configYml);

    const res = createMockResponse();
    await getRoute('PUT', '/api/config/tool-approval')(createRequest({ body: { mode: 'yolo' } }), res);

    expect(res.statusCode).toBe(500);
    expect(readConfigFile(configYml).tools).toEqual(['not', 'a', 'map']);
  });
});

const MODEL_ROLES = [
  'default', 'smol', 'slow', 'vision', 'plan', 'commit', 'tiny', 'memory', 'task', 'advisor',
  'image', 'web', 'speech', 'dictation', 'judge',
];

describe('model roles route', () => {
  let agentDir;
  let configYml;

  // Hand-written, as the user's own file is: the write must leave every line it
  // was not asked to change byte-identical, comments and ordering included.
  const HAND_EDITED = [
    '# hand-edited: keep every line you were not asked to change',
    'modelRoles:',
    '  default: opencode-go/deepseek-v4.1-flash # keep me',
    '  DEV: c/d',
    'theme:',
    '  dark: titanium',
    'providers:',
    '  anthropic:',
    '    apiKey: secret',
    'workspace:',
    '  additionalDirectories:',
    '    - /tmp/one',
    '    - /tmp/two',
    '',
  ].join('\n');

  const readRaw = () => fs.readFileSync(configYml, 'utf8');

  const writeRaw = (text) => fs.writeFileSync(configYml, text, 'utf8');

  beforeEach(() => {
    agentDir = createTempAgentDir();
    configYml = path.join(agentDir, 'config.yml');
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("reads the roles the file sets and answers OMP's own roles as unset", async () => {
    writeRaw(HAND_EDITED);
    const { getRoute } = await mount();

    const res = createMockResponse();
    await getRoute('GET', '/api/config/model-roles')(createRequest(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.known).toEqual([...MODEL_ROLES, 'DEV']);
    expect(res.body.roles.map((role) => role.name)).toEqual([...MODEL_ROLES, 'DEV']);
    expect(res.body.roles.find((role) => role.name === 'default')).toEqual({
      name: 'default',
      value: 'opencode-go/deepseek-v4.1-flash',
    });
    expect(res.body.roles.find((role) => role.name === 'DEV')).toEqual({ name: 'DEV', value: 'c/d' });
    // Every unset role is still a row, so the settings surface can offer it.
    expect(res.body.roles.filter((role) => role.value === null)).toHaveLength(MODEL_ROLES.length - 1);
  });

  it('answers every role unset for a machine with no config file and for an empty table', async () => {
    const { getRoute } = await mount();

    for (const text of [null, 'modelRoles: {}\ntheme:\n  dark: titanium\n']) {
      if (text === null) fs.rmSync(configYml, { force: true });
      else writeRaw(text);

      const res = createMockResponse();
      await getRoute('GET', '/api/config/model-roles')(createRequest(), res);

      expect(res.statusCode).toBe(200);
      expect(res.body.known).toEqual(MODEL_ROLES);
      expect(res.body.roles).toHaveLength(MODEL_ROLES.length);
      expect(res.body.roles.every((role) => role.value === null)).toBe(true);
    }
  });

  it('sets a role and leaves every other line of the file byte-identical', async () => {
    writeRaw(HAND_EDITED);
    const { getRoute, readConfigFile } = await mount();

    const res = createMockResponse();
    await getRoute('PUT', '/api/config/model-roles')(
      createRequest({ body: { role: 'smol', value: 'opencode-go/smol' } }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(readRaw()).toBe(
      HAND_EDITED.replace('  DEV: c/d\n', '  DEV: c/d\n  smol: opencode-go/smol\n'),
    );
    expect(res.body.roles.find((role) => role.name === 'smol')).toEqual({ name: 'smol', value: 'opencode-go/smol' });
    expect(readConfigFile(configYml).modelRoles).toEqual({
      default: 'opencode-go/deepseek-v4.1-flash',
      DEV: 'c/d',
      smol: 'opencode-go/smol',
    });
  });

  it('rewrites a role the file already sets and nothing else', async () => {
    writeRaw(HAND_EDITED);
    const { getRoute } = await mount();

    const res = createMockResponse();
    await getRoute('PUT', '/api/config/model-roles')(
      createRequest({ body: { role: 'DEV', value: 'e/f' } }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(readRaw()).toBe(HAND_EDITED.replace('  DEV: c/d\n', '  DEV: e/f\n'));
  });

  it('removes the key for an empty and for a null value, and nothing else', async () => {
    const { getRoute } = await mount();

    for (const value of ['', '   ', null]) {
      writeRaw(HAND_EDITED);

      const res = createMockResponse();
      await getRoute('PUT', '/api/config/model-roles')(
        createRequest({ body: { role: 'DEV', value } }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(readRaw()).toBe(HAND_EDITED.replace('  DEV: c/d\n', ''));
      // `DEV` is not a role this OMP ships, so with no key left there is no row
      // for it; a shipped role answers as an unset row instead.
      expect(res.body.roles.some((role) => role.name === 'DEV')).toBe(false);
      expect(res.body.roles.find((role) => role.name === 'plan')).toEqual({ name: 'plan', value: null });
    }
  });

  it('drops an emptied block instead of leaving an empty section behind', async () => {
    writeRaw('modelRoles:\n  plan: a/b\ntheme:\n  dark: titanium\n');
    const { getRoute } = await mount();

    const res = createMockResponse();
    await getRoute('PUT', '/api/config/model-roles')(createRequest({ body: { role: 'plan', value: '' } }), res);

    expect(res.statusCode).toBe(200);
    expect(readRaw()).toBe('theme:\n  dark: titanium\n');
  });

  it('adds the first role to a table OMP wrote as an empty flow map', async () => {
    const { getRoute } = await mount();
    const expected = 'modelRoles:\n  smol: a/b\ntheme:\n  dark: titanium\n';

    for (const before of ['modelRoles: {}\ntheme:\n  dark: titanium\n', 'modelRoles:\n  {}\ntheme:\n  dark: titanium\n']) {
      writeRaw(before);

      const res = createMockResponse();
      await getRoute('PUT', '/api/config/model-roles')(
        createRequest({ body: { role: 'smol', value: 'a/b' } }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(readRaw()).toBe(expected);
    }
  });

  it('refuses a role this OMP does not ship and the file does not set, without touching the file', async () => {
    writeRaw(HAND_EDITED);
    const { getRoute } = await mount();

    const res = createMockResponse();
    await getRoute('PUT', '/api/config/model-roles')(
      createRequest({ body: { role: 'protagonist', value: 'a/b' } }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('default');
    expect(res.body.error).toContain('advisor');
    expect(readRaw()).toBe(HAND_EDITED);
  });

  it('accepts a role the file already carries under a name this OMP does not ship', async () => {
    writeRaw(HAND_EDITED);
    const { getRoute } = await mount();

    const res = createMockResponse();
    await getRoute('PUT', '/api/config/model-roles')(
      createRequest({ body: { role: 'DEV', value: 'opencode-go/dev' } }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.roles.find((role) => role.name === 'DEV')).toEqual({ name: 'DEV', value: 'opencode-go/dev' });
  });

  it('rejects a role name that is not a role name, or a value that is not a string', async () => {
    writeRaw(HAND_EDITED);
    const { getRoute } = await mount();

    const bodies = [
      undefined,
      {},
      { role: 5 },
      { role: '' },
      { role: '9bad' },
      { role: 'has space' },
      { role: 'x'.repeat(33) },
      { role: 'smol', value: 5 },
    ];
    for (const body of bodies) {
      const res = createMockResponse();
      await getRoute('PUT', '/api/config/model-roles')(createRequest({ body }), res);
      expect(res.statusCode).toBe(400);
    }
    expect(readRaw()).toBe(HAND_EDITED);
  });

  it('refuses a modelRoles section that is not a mapping rather than clobbering it', async () => {
    writeRaw('modelRoles: [a, b]\ntheme:\n  dark: titanium\n');
    const { getRoute } = await mount();

    const res = createMockResponse();
    await getRoute('PUT', '/api/config/model-roles')(
      createRequest({ body: { role: 'smol', value: 'a/b' } }),
      res,
    );

    expect(res.statusCode).toBe(500);
    expect(readRaw()).toBe('modelRoles: [a, b]\ntheme:\n  dark: titanium\n');
  });

  it('answers 500 when an unparseable config file cannot be read safely', async () => {
    writeRaw('modelRoles: [unclosed\n');
    const { getRoute } = await mount();

    const getRes = createMockResponse();
    await getRoute('GET', '/api/config/model-roles')(createRequest(), getRes);
    expect(getRes.statusCode).toBe(500);
    expect(getRes.body).toEqual({ error: 'Failed to read model roles' });

    const putRes = createMockResponse();
    await getRoute('PUT', '/api/config/model-roles')(
      createRequest({ body: { role: 'smol', value: 'a/b' } }),
      putRes,
    );
    expect(putRes.statusCode).toBe(500);
    expect(putRes.body).toEqual({ error: 'Failed to save model role' });
  });
});

/**
 * The handler tests above call the route functions directly, so they never see
 * the request pipeline. Mounted on a real express app, a PUT without its own
 * body parser reads `req.body === undefined` and answers 400 for a body the
 * client sent — which is exactly what happened before the parser was attached.
 */
describe('the routes over real HTTP', () => {
  let agentDir;
  let configYml;
  let server;
  let base;

  beforeEach(async () => {
    agentDir = createTempAgentDir();
    configYml = path.join(agentDir, 'config.yml');
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.PI_CODING_AGENT_DIR = agentDir;

    vi.resetModules();
    const { registerOmpSettingsRoutes } = await import('./omp-settings-routes.js');
    const express = (await import('express')).default;
    const app = express();
    registerOmpSettingsRoutes(app);
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it('accepts a JSON body and writes the mode OMP reads', async () => {
    const response = await fetch(`${base}/api/config/tool-approval`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'always-ask' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mode: 'always-ask', changed: true });
    const { readConfigFile } = await import('./agent-config-files.js');
    expect(readConfigFile(configYml).tools.approvalMode).toBe('always-ask');
  });

  it('accepts a JSON body and writes the retention OMP reads', async () => {
    const response = await fetch(`${base}/api/config/cache-retention`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ retention: 'long' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ retention: 'long', changed: true });
    const { readConfigFile } = await import('./agent-config-files.js');
    expect(readConfigFile(configYml).providers.cacheRetention).toBe('long');
  });

  it('accepts a JSON body and writes the model role OMP reads', async () => {
    const response = await fetch(`${base}/api/config/model-roles`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'smol', value: 'opencode-go/smol' }),
    });

    expect(response.status).toBe(200);
    const { readConfigFile } = await import('./agent-config-files.js');
    expect(readConfigFile(configYml).modelRoles.smol).toBe('opencode-go/smol');
    expect((await response.json()).roles.find((role) => role.name === 'smol')).toEqual({
      name: 'smol',
      value: 'opencode-go/smol',
    });
  });

  it('still refuses an invalid mode over HTTP', async () => {
    const response = await fetch(`${base}/api/config/tool-approval`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'sometimes' }),
    });

    expect(response.status).toBe(400);
  });
});
