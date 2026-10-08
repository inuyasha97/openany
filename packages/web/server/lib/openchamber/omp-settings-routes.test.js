import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readConfigFile, writeConfig } from './agent-config-files.js';
import { registerOmpSettingsRoutes } from './omp-settings-routes.js';

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

const mount = (agentDir) => {
  const configFile = path.join(agentDir, 'config.yml');
  const { app, getRoute } = createRouteRegistry();
  registerOmpSettingsRoutes(app, { readConfigFile, writeConfig, configFile });
  return { getRoute, configFile };
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

  beforeEach(() => {
    agentDir = createTempAgentDir();
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it('reads and writes providers.cacheRetention', async () => {
    const { getRoute, configFile } = mount(agentDir);

    const putRes = createMockResponse();
    await getRoute('PUT', '/api/config/cache-retention')(
      createRequest({ body: { retention: 'short' } }),
      putRes,
    );

    expect(putRes.statusCode).toBe(200);
    expect(putRes.body).toEqual({ retention: 'short', changed: true });
    expect(readConfigFile(configFile).providers.cacheRetention).toBe('short');

    const getRes = createMockResponse();
    await getRoute('GET', '/api/config/cache-retention')(createRequest(), getRes);

    expect(getRes.statusCode).toBe(200);
    expect(getRes.body).toEqual({ retention: 'short' });
  });

  it('answers the OMP default when the key is absent', async () => {
    const { getRoute } = mount(agentDir);

    const res = createMockResponse();
    await getRoute('GET', '/api/config/cache-retention')(createRequest(), res);

    expect(res.body).toEqual({ retention: 'auto' });
  });

  it('preserves every other key in config.yml', async () => {
    const { getRoute, configFile } = mount(agentDir);
    writeConfig(
      {
        model: 'anthropic/claude',
        providers: { anthropic: { apiKey: 'secret' }, cacheRetention: 'long' },
        nested: { keep: [1, 2, 3] },
      },
      configFile,
    );

    const res = createMockResponse();
    await getRoute('PUT', '/api/config/cache-retention')(
      createRequest({ body: { retention: 'none' } }),
      res,
    );

    expect(res.body).toEqual({ retention: 'none', changed: true });
    expect(readConfigFile(configFile)).toEqual({
      model: 'anthropic/claude',
      providers: { anthropic: { apiKey: 'secret' }, cacheRetention: 'none' },
      nested: { keep: [1, 2, 3] },
    });
  });

  it('reports changed: false when the value already matches', async () => {
    const { getRoute, configFile } = mount(agentDir);
    writeConfig({ providers: { cacheRetention: 'auto' } }, configFile);

    const res = createMockResponse();
    await getRoute('PUT', '/api/config/cache-retention')(
      createRequest({ body: { retention: 'auto' } }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ retention: 'auto', changed: false });
  });

  it('rejects a value OMP does not accept with the accepted ones named', async () => {
    const { getRoute, configFile } = mount(agentDir);

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
    expect(fs.existsSync(configFile)).toBe(false);
  });

  it('rejects a missing or non-string retention', async () => {
    const { getRoute } = mount(agentDir);

    for (const body of [undefined, {}, { retention: 5 }]) {
      const res = createMockResponse();
      await getRoute('PUT', '/api/config/cache-retention')(createRequest({ body }), res);
      expect(res.statusCode).toBe(400);
    }
  });

  it('answers 500 when the config file cannot be written', async () => {
    // A directory where the config file should be makes the write fail.
    const unwritable = path.join(agentDir, 'config.yml');
    fs.mkdirSync(unwritable);
    const { app, getRoute } = createRouteRegistry();
    registerOmpSettingsRoutes(app, { readConfigFile, writeConfig, configFile: unwritable });

    const res = createMockResponse();
    await getRoute('PUT', '/api/config/cache-retention')(
      createRequest({ body: { retention: 'short' } }),
      res,
    );

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to save cache retention' });
  });

  it('answers 500 when an unparseable config file cannot be read safely', async () => {
    const { getRoute, configFile } = mount(agentDir);
    fs.writeFileSync(configFile, 'providers: [unclosed\n', 'utf8');

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
