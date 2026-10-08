import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  listSnippets,
  getSnippet,
  createSnippet,
  updateSnippet,
  deleteSnippet,
  expandSnippets,
} from './snippets.js';
import { registerConfigSnippetRoutes } from './config-snippet-routes.js';

vi.mock('./snippets.js', () => ({
  listSnippets: vi.fn(() => []),
  getSnippet: vi.fn(() => null),
  createSnippet: vi.fn(() => ({ name: 'made' })),
  updateSnippet: vi.fn(() => ({ name: 'made' })),
  deleteSnippet: vi.fn(() => true),
  expandSnippets: vi.fn((text) => `expanded:${text}`),
}));

const createRouteRegistry = () => {
  const routes = new Map();

  return {
    app: {
      get(routePath, handler) {
        routes.set(`GET ${routePath}`, handler);
      },
      post(routePath, handler) {
        routes.set(`POST ${routePath}`, handler);
      },
      patch(routePath, handler) {
        routes.set(`PATCH ${routePath}`, handler);
      },
      delete(routePath, handler) {
        routes.set(`DELETE ${routePath}`, handler);
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

const createRequest = ({ params = {}, query = {}, body } = {}) => ({ params, query, body });

const register = (overrides = {}) => {
  const registry = createRouteRegistry();
  const resolveOptionalProjectDirectory = overrides.resolveOptionalProjectDirectory
    ?? vi.fn(async () => ({ directory: '/workspace/app', error: null }));
  registerConfigSnippetRoutes(registry.app, { resolveOptionalProjectDirectory });
  return { getRoute: registry.getRoute, resolveOptionalProjectDirectory };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  listSnippets.mockReturnValue([]);
  getSnippet.mockReturnValue(null);
  createSnippet.mockReturnValue({ name: 'made' });
  updateSnippet.mockReturnValue({ name: 'made' });
  deleteSnippet.mockReturnValue(true);
  expandSnippets.mockImplementation((text) => `expanded:${text}`);
});

describe('config snippet routes', () => {
  it('lists snippets for the resolved directory', async () => {
    listSnippets.mockReturnValue([{ name: 'review', content: 'body', aliases: [], filePath: '/x/review.md', source: 'global' }]);
    const { getRoute } = register();

    const res = createMockResponse();
    await getRoute('GET', '/api/config/snippets')(createRequest(), res);

    expect(listSnippets).toHaveBeenCalledWith('/workspace/app');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([
      { name: 'review', content: 'body', aliases: [], filePath: '/x/review.md', source: 'global' },
    ]);
  });

  it('rejects a directory that cannot be resolved with 400', async () => {
    const { getRoute } = register({
      resolveOptionalProjectDirectory: vi.fn(async () => ({ directory: null, error: 'Path is outside the active workspace' })),
    });

    const res = createMockResponse();
    await getRoute('GET', '/api/config/snippets')(createRequest(), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Path is outside the active workspace' });
    expect(listSnippets).not.toHaveBeenCalled();
  });

  it('expands hashtags and defaults a missing text field to an empty string', async () => {
    const { getRoute } = register();

    const res = createMockResponse();
    await getRoute('POST', '/api/config/snippets/expand')(createRequest({ body: { text: '#review' } }), res);
    expect(res.body).toEqual({ text: 'expanded:#review' });

    const empty = createMockResponse();
    await getRoute('POST', '/api/config/snippets/expand')(createRequest(), empty);
    expect(expandSnippets).toHaveBeenLastCalledWith('', '/workspace/app');
    expect(empty.body).toEqual({ text: 'expanded:' });
  });

  it('answers 404 for a snippet that is not on disk', async () => {
    const { getRoute } = register();

    const res = createMockResponse();
    await getRoute('GET', '/api/config/snippets/:name')(createRequest({ params: { name: 'missing' } }), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Snippet "missing" not found' });
  });

  it('returns the created snippet and maps a name conflict to 409', async () => {
    const { getRoute } = register();

    const created = createMockResponse();
    await getRoute('POST', '/api/config/snippets/:name')(
      createRequest({ params: { name: 'review' }, body: { content: 'body', scope: 'project' } }),
      created,
    );
    expect(createSnippet).toHaveBeenCalledWith('review', { content: 'body', scope: 'project' }, '/workspace/app', 'project');
    expect(created.statusCode).toBe(200);
    expect(created.body).toEqual({ success: true, snippet: { name: 'made' } });

    createSnippet.mockImplementation(() => {
      throw new Error('Snippet "review" already exists at /workspace/app/.omp/snippets/review.md');
    });
    const conflict = createMockResponse();
    await getRoute('POST', '/api/config/snippets/:name')(
      createRequest({ params: { name: 'review' }, body: { content: 'body' } }),
      conflict,
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body.error).toContain('already exists');
  });

  it('maps an invalid snippet name on create to 400', async () => {
    createSnippet.mockImplementation(() => {
      throw new Error('Snippet name must match [a-z0-9_-]+');
    });
    const { getRoute } = register();

    const res = createMockResponse();
    await getRoute('POST', '/api/config/snippets/:name')(
      createRequest({ params: { name: 'Bad Name' }, body: { content: 'x' } }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('Snippet name');
  });

  it('maps a missing snippet on update to 404 and returns the updated snippet otherwise', async () => {
    updateSnippet.mockImplementation(() => {
      throw new Error('Snippet "review" not found');
    });
    const { getRoute } = register();

    const missing = createMockResponse();
    await getRoute('PATCH', '/api/config/snippets/:name')(
      createRequest({ params: { name: 'review' }, body: { content: 'x' } }),
      missing,
    );
    expect(missing.statusCode).toBe(404);

    updateSnippet.mockReturnValue({ name: 'review', content: 'x' });
    const updated = createMockResponse();
    await getRoute('PATCH', '/api/config/snippets/:name')(
      createRequest({ params: { name: 'review' }, body: { content: 'x' } }),
      updated,
    );
    expect(updated.statusCode).toBe(200);
    expect(updated.body).toEqual({ success: true, snippet: { name: 'review', content: 'x' } });
  });

  it('deletes a snippet and maps a missing one to 404', async () => {
    const { getRoute } = register();

    const deleted = createMockResponse();
    await getRoute('DELETE', '/api/config/snippets/:name')(createRequest({ params: { name: 'review' } }), deleted);
    expect(deleteSnippet).toHaveBeenCalledWith('review', '/workspace/app');
    expect(deleted.statusCode).toBe(200);
    expect(deleted.body).toEqual({ success: true });

    deleteSnippet.mockImplementation(() => {
      throw new Error('Snippet "review" not found');
    });
    const missing = createMockResponse();
    await getRoute('DELETE', '/api/config/snippets/:name')(createRequest({ params: { name: 'review' } }), missing);
    expect(missing.statusCode).toBe(404);
  });
});
