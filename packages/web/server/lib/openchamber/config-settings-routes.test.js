import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerConfigSettingsRoutes } from './config-settings-routes.js';

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

const createRequest = ({ query = {}, headers = {}, body } = {}) => ({
  query,
  body,
  get(name) {
    return headers[name.toLowerCase()] ?? undefined;
  },
});

const createDependencies = (overrides = {}) => ({
  readSettingsFromDiskMigrated: vi.fn(async () => ({ themeId: 'stored-theme' })),
  persistSettings: vi.fn(async (changes) => ({ ...changes, persisted: true })),
  formatSettingsResponse: vi.fn((settings) => ({ ...settings, formatted: true })),
  ...overrides,
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('config settings routes', () => {
  it('reads settings for the requested surface and answers in the formatted read shape', async () => {
    const { app, getRoute } = createRouteRegistry();
    const dependencies = createDependencies();
    registerConfigSettingsRoutes(app, dependencies);

    const res = createMockResponse();
    await getRoute('GET', '/api/config/settings')(createRequest({ query: { surface: 'mobile' } }), res);

    expect(dependencies.readSettingsFromDiskMigrated).toHaveBeenCalledWith({ surface: 'mobile' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ themeId: 'stored-theme', formatted: true });
  });

  it('takes the surface from the header when the query omits it', async () => {
    const { app, getRoute } = createRouteRegistry();
    const dependencies = createDependencies();
    registerConfigSettingsRoutes(app, dependencies);

    await getRoute('GET', '/api/config/settings')(
      createRequest({ headers: { 'x-openchamber-surface': 'vscode' } }),
      createMockResponse(),
    );

    expect(dependencies.readSettingsFromDiskMigrated).toHaveBeenCalledWith({ surface: 'vscode' });
  });

  it('ignores an unknown surface and reads the base document', async () => {
    const { app, getRoute } = createRouteRegistry();
    const dependencies = createDependencies();
    registerConfigSettingsRoutes(app, dependencies);

    await getRoute('GET', '/api/config/settings')(
      createRequest({ query: { surface: 'toaster' } }),
      createMockResponse(),
    );

    expect(dependencies.readSettingsFromDiskMigrated).toHaveBeenCalledWith({ surface: null });
  });

  it('answers 500 when the settings read fails', async () => {
    const { app, getRoute } = createRouteRegistry();
    const dependencies = createDependencies({
      readSettingsFromDiskMigrated: vi.fn(async () => {
        throw new Error('disk on fire');
      }),
    });
    registerConfigSettingsRoutes(app, dependencies);

    const res = createMockResponse();
    await getRoute('GET', '/api/config/settings')(createRequest(), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to read settings' });
  });

  it('persists the body for the requested surface and returns the stored document', async () => {
    const { app, getRoute } = createRouteRegistry();
    const dependencies = createDependencies();
    registerConfigSettingsRoutes(app, dependencies);

    const res = createMockResponse();
    await getRoute('PUT', '/api/config/settings')(
      createRequest({ query: { surface: 'desktop' }, body: { themeId: 'new-theme' } }),
      res,
    );

    expect(dependencies.persistSettings).toHaveBeenCalledWith({ themeId: 'new-theme' }, { surface: 'desktop' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ themeId: 'new-theme', persisted: true });
  });

  it('treats a missing body as an empty change set instead of failing', async () => {
    const { app, getRoute } = createRouteRegistry();
    const dependencies = createDependencies();
    registerConfigSettingsRoutes(app, dependencies);

    const res = createMockResponse();
    await getRoute('PUT', '/api/config/settings')(createRequest(), res);

    expect(dependencies.persistSettings).toHaveBeenCalledWith({}, { surface: null });
    expect(res.statusCode).toBe(200);
  });

  it('answers 500 when the persist fails', async () => {
    const { app, getRoute } = createRouteRegistry();
    const dependencies = createDependencies({
      persistSettings: vi.fn(async () => {
        throw new Error('read-only volume');
      }),
    });
    registerConfigSettingsRoutes(app, dependencies);

    const res = createMockResponse();
    await getRoute('PUT', '/api/config/settings')(createRequest({ body: { themeId: 'x' } }), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to save settings' });
  });
});
