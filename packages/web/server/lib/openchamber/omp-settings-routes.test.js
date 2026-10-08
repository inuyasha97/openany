import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createRouteRegistry = () => {
  const routes = new Map();

  return {
    app: {
      get(routePath, handler) {
        routes.set(`GET ${routePath}`, handler);
      },
      put(routePath, handler) {
        routes.set(`PUT ${routePath}`, handler);
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
