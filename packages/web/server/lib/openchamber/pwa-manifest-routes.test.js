import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPwaManifestRoute } from './pwa-manifest-routes.js';
import { readSessions } from '../agents/omp-host-access.js';

vi.mock('../agents/omp-host-access.js', () => ({
  readSessions: vi.fn(async () => []),
}));

beforeEach(() => {
  readSessions.mockReset().mockResolvedValue([]);
});

const createResponse = () => ({
  headers: new Map(),
  contentType: '',
  body: '',
  setHeader(name, value) {
    this.headers.set(name, value);
    return this;
  },
  type(value) {
    this.contentType = value;
    return this;
  },
  send(value) {
    this.body = value;
    return this;
  },
});

const createApp = () => {
  const routes = new Map();
  return {
    routes,
    app: {
      get(route, handler) {
        routes.set(route, handler);
      },
    },
  };
};

const register = (app, directory) => registerPwaManifestRoute(app, {
  resolveProjectDirectory: async () => ({ directory }),
  readSettingsFromDiskMigrated: async () => ({}),
  normalizePwaAppName: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
  normalizePwaOrientation: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
});

describe('PWA manifest route', () => {
  it('does not fall back to unrelated global session shortcuts for scoped manifests', async () => {
    readSessions.mockResolvedValue([
      { id: 'other-session', title: 'Other project', cwd: '/workspace/other' },
    ]);
    const { routes, app } = createApp();
    register(app, '/workspace/app');

    const res = createResponse();
    await routes.get('/manifest.webmanifest')({ query: {} }, res);

    const manifest = JSON.parse(res.body);
    expect(manifest.shortcuts).toEqual([
      {
        name: 'Appearance Settings',
        short_name: 'Settings',
        description: 'Open appearance settings',
        url: '/?settings=appearance',
        icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
      },
    ]);
  });

  it('includes child session shortcuts for root-scoped manifests', async () => {
    readSessions.mockResolvedValue([
      { id: 'root-child', title: 'Root child', cwd: '/workspace/app' },
    ]);
    const { routes, app } = createApp();
    register(app, '/');

    const res = createResponse();
    await routes.get('/manifest.webmanifest')({ query: {} }, res);

    const manifest = JSON.parse(res.body);
    expect(manifest.shortcuts).toContainEqual({
      name: 'Root child',
      short_name: 'Root child',
      description: 'Open recent session',
      url: '/?session=root-child',
      icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
    });
  });
});
