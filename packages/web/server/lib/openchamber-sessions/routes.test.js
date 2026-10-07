import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const createWorktreeMock = vi.fn(async () => ({
  head: 'abc123',
  name: 'side-task',
  branch: 'openchamber/side-task',
  path: '/repo/worktrees/side-task',
}));
const getWorktreeBootstrapStatusMock = vi.fn(async () => ({
  status: 'ready',
  phase: 'setup-ready',
  error: null,
  updatedAt: Date.now(),
}));

// The OMP runtime host, wired through the real seam (`omp-host-access.js`), so
// the routes are exercised against the same mappers production uses: the model
// catalogue, the session process calls, the message page and the prompt.
const hostCreateSessionMock = vi.fn(async () => ({ id: 'ses_123' }));
const hostRenameSessionMock = vi.fn(async () => undefined);
const hostGetMessagesMock = vi.fn(async () => ({ items: [], cursor: null }));
const hostPromptMock = vi.fn(async () => true);
const hostSetModelMock = vi.fn(async () => undefined);
const hostListModelsMock = vi.fn(async () => []);
const hostListCommandsMock = vi.fn(async () => []);

const ompHost = {
  listSessions: async () => [],
  createSession: (...args) => hostCreateSessionMock(...args),
  getSession: async (id) => {
    throw new Error(`the host does not expose session records: ${id}`);
  },
  getMessages: (...args) => hostGetMessagesMock(...args),
  prompt: (id, text) => hostPromptMock(id, text),
  abort: async () => undefined,
  renameSession: (...args) => hostRenameSessionMock(...args),
  deleteSession: async () => false,
  moveSession: async () => undefined,
  setModel: (...args) => hostSetModelMock(...args),
  getSessionStatus: async () => ({ busy: false }),
  listModels: (...args) => hostListModelsMock(...args),
  listCommands: (...args) => hostListCommandsMock(...args),
  listMcpServers: async () => [],
  setMcpEnabled: async () => undefined,
  removeMcpServer: async () => undefined,
  addMcpServer: async () => undefined,
  listPermissions: async () => [],
  replyPermission: async () => false,
  disposeSessionsInDirectory: async () => 0,
};

// The runtime's model catalogue arrives in OMP's shape (`{ provider, id }`);
// only the list calls envelope their answer.
const CATALOG_MODELS = [
  { provider: 'openai', id: 'gpt-5.5' },
  { provider: 'anthropic', id: 'claude-sonnet-5' },
];
const useCatalog = ({ models = CATALOG_MODELS, commands = [] } = {}) => {
  hostListModelsMock.mockImplementation(async () => models);
  hostListCommandsMock.mockImplementation(async () => commands);
};

let sessionItems = [];

const setSessionMessages = (items) => {
  sessionItems = items;
};

/** One canonical assistant message (`{ info, parts }`), as the seam serves it. */
const assistantMessage = (id, created, completed, extra = {}) => ({
  info: {
    id,
    role: 'assistant',
    time: { created, ...(completed === undefined ? {} : { completed }) },
    ...extra,
  },
  parts: [],
});

globalThis.__openchamberCreateWorktreeMock = createWorktreeMock;
globalThis.__openchamberGetWorktreeBootstrapStatusMock = getWorktreeBootstrapStatusMock;

let registerOpenChamberSessionRoutes;
let createSessionMetadataStore;

vi.mock('../git/index.js', () => ({
  createWorktree: (...args) => globalThis.__openchamberCreateWorktreeMock(...args),
  getWorktreeBootstrapStatus: (...args) => globalThis.__openchamberGetWorktreeBootstrapStatusMock(...args),
  resolvePrimaryWorktreeRoot: async (directory) => ({ root: directory === '/repo/worktrees/side-task' ? '/repo/app' : directory }),
}));

/**
 * Session metadata is OpenChamber's own state now, so the routes take a store
 * rather than talking to the runtime. The tests use an in-memory one with the
 * same contract as `session-metadata-store.js`.
 */
const createMemorySessionMetadataStore = () => {
  const entries = new Map();
  const merge = (current, patch) => {
    const base = { ...(current ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete base[key];
      else if (value && typeof value === 'object' && !Array.isArray(value)) base[key] = merge(base[key], value);
      else base[key] = value;
    }
    return base;
  };
  return {
    entries,
    get: async (id) => entries.get(id) ?? {},
    setSessionMetadata: async (id, patch) => {
      const merged = merge(entries.get(id), patch);
      if (Object.keys(merged).length === 0) entries.delete(id);
      else entries.set(id, merged);
      return merged;
    },
  };
};

const createMemoryArchiveStore = () => {
  const entries = new Map();
  let failFor = new Set();
  return {
    failIds: (ids) => { failFor = new Set(ids); },
    entries,
    getAll: async () => Object.fromEntries(entries),
    list: async () => Object.fromEntries(entries),
    isArchived: async (id) => entries.has(id),
    archivedAt: async (id) => entries.get(id) ?? null,
    archive: async (ids, archivedAt) => {
      const stamp = Number.isSafeInteger(archivedAt) && archivedAt > 0 ? archivedAt : 1;
      const archived = [];
      const failedIds = [];
      for (const id of ids) {
        if (failFor.has(id)) { failedIds.push(id); continue; }
        entries.set(id, stamp);
        archived.push({ id, archivedAt: stamp });
      }
      return { archived, failedIds };
    },
    unarchive: async (ids) => {
      const restored = [];
      const failedIds = [];
      for (const id of ids) {
        if (failFor.has(id)) { failedIds.push(id); continue; }
        entries.delete(id);
        restored.push({ id, archivedAt: null });
      }
      return { restored, failedIds };
    },
  };
};

const createApp = (overrides = {}, options = {}) => {
  const app = express();
  if (options.globalJson !== false) {
    app.use(express.json());
  }
  const archiveStore = overrides.archiveStore ?? createMemoryArchiveStore();
  const sessionMetadataStore = overrides.sessionMetadataStore ?? createMemorySessionMetadataStore();
  const broadcastGlobalUiEvent = overrides.broadcastGlobalUiEvent ?? vi.fn();
  registerOpenChamberSessionRoutes(app, {
    archiveStore,
    sessionMetadataStore,
    broadcastGlobalUiEvent,
    readSettingsFromDiskMigrated: async () => ({ projects: [{ id: 'proj_1', path: '/repo/app' }] }),
    sanitizeProjects: (projects) => projects,
    validateDirectoryPath: async (directory) => ({ ok: true, directory }),
    buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
    ...overrides,
  });
  return { app, archiveStore, sessionMetadataStore, broadcastGlobalUiEvent };
};

describe('openchamber session routes', () => {
  beforeAll(async () => {
    ({ registerOpenChamberSessionRoutes } = await import('./routes.js'));
    ({ createSessionMetadataStore } = await import('./session-metadata-store.js'));
    const { configureOmpRuntimeHost } = await import('../agents/omp-host-access.js');
    configureOmpRuntimeHost(() => ompHost);
  });

  beforeEach(() => {
    createWorktreeMock.mockClear();
    getWorktreeBootstrapStatusMock.mockClear();
    getWorktreeBootstrapStatusMock.mockImplementation(async () => ({
      status: 'ready',
      phase: 'setup-ready',
      error: null,
      updatedAt: Date.now(),
    }));
    hostCreateSessionMock.mockClear();
    hostCreateSessionMock.mockImplementation(async () => ({ id: 'ses_123' }));
    hostRenameSessionMock.mockClear();
    hostPromptMock.mockReset();
    hostPromptMock.mockImplementation(async () => true);
    hostSetModelMock.mockClear();
    hostListModelsMock.mockReset();
    hostListCommandsMock.mockReset();
    sessionItems = [];
    hostGetMessagesMock.mockReset();
    hostGetMessagesMock.mockImplementation(async () => ({ items: sessionItems, cursor: null }));
    useCatalog();
  });

  describe('archiving a batch of sessions', () => {
    it('archives every id and reports what it stored', async () => {
      const { app, archiveStore, broadcastGlobalUiEvent } = createApp();
      const response = await request(app)
        .post('/api/openchamber/sessions/archive')
        .send({ ids: ['ses_a', 'ses_b'], archivedAt: 1700 })
        .expect(200);

      expect(response.body.archived).toEqual([
        { id: 'ses_a', archivedAt: 1700 },
        { id: 'ses_b', archivedAt: 1700 },
      ]);
      expect(response.body.failedIds).toEqual([]);
      await expect(archiveStore.getAll()).resolves.toEqual({ ses_a: 1700, ses_b: 1700 });
      expect(broadcastGlobalUiEvent).toHaveBeenCalledWith({
        type: 'openchamber:session-archived',
        properties: { sessionID: 'ses_a', archivedAt: 1700 },
      });
    });

    it('keeps archiving after a failed session and reports it as failed', async () => {
      const archiveStore = createMemoryArchiveStore();
      archiveStore.failIds(['ses_b']);
      const { app } = createApp({ archiveStore });

      const response = await request(app)
        .post('/api/openchamber/sessions/archive')
        .send({ ids: ['ses_a', 'ses_b', 'ses_c'] })
        .expect(200);

      expect(response.body.archived.map((session) => session.id)).toEqual(['ses_a', 'ses_c']);
      expect(response.body.failedIds).toEqual(['ses_b']);
    });

    it('does not announce a session it failed to store', async () => {
      const archiveStore = createMemoryArchiveStore();
      archiveStore.failIds(['ses_b']);
      const { app, broadcastGlobalUiEvent } = createApp({ archiveStore });

      await request(app)
        .post('/api/openchamber/sessions/archive')
        .send({ ids: ['ses_a', 'ses_b'] })
        .expect(200);

      const announced = broadcastGlobalUiEvent.mock.calls.map(([event]) => event.properties.sessionID);
      expect(announced).toEqual(['ses_a']);
    });

    it('restores a batch and announces the cleared state', async () => {
      const { app, archiveStore, broadcastGlobalUiEvent } = createApp();
      await request(app).post('/api/openchamber/sessions/archive').send({ ids: ['ses_a'] }).expect(200);
      broadcastGlobalUiEvent.mockClear();

      const response = await request(app)
        .post('/api/openchamber/sessions/unarchive')
        .send({ ids: ['ses_a'] })
        .expect(200);

      expect(response.body.restored).toEqual([{ id: 'ses_a', archivedAt: null }]);
      expect(response.body.failedIds).toEqual([]);
      await expect(archiveStore.getAll()).resolves.toEqual({});
      expect(broadcastGlobalUiEvent).toHaveBeenCalledWith({
        type: 'openchamber:session-archived',
        properties: { sessionID: 'ses_a', archivedAt: null },
      });
    });

    it('rejects an empty batch, an oversized batch, and non-string ids', async () => {
      const { app, archiveStore } = createApp();

      await request(app).post('/api/openchamber/sessions/archive').send({ ids: [] }).expect(400);
      await request(app)
        .post('/api/openchamber/sessions/archive')
        .send({ ids: Array.from({ length: 501 }, (_, index) => `ses_${index}`) })
        .expect(400);
      await request(app)
        .post('/api/openchamber/sessions/archive')
        .send({ ids: ['ses_a', ''] })
        .expect(400);
      await request(app)
        .post('/api/openchamber/sessions/archive')
        .send({ ids: ['ses_a'], archivedAt: -1 })
        .expect(400);
      await request(app).post('/api/openchamber/sessions/unarchive').send({ ids: [] }).expect(400);

      await expect(archiveStore.getAll()).resolves.toEqual({});
    });
  });

  describe('session metadata OpenChamber owns', () => {
    it('merge-patches metadata through the store, returns the merged object, and announces it', async () => {
      const { app, sessionMetadataStore, broadcastGlobalUiEvent } = createApp();

      await request(app)
        .post('/api/openchamber/sessions/ses_a/metadata')
        .send({ patch: { openchamber: { assist: { recap: 'first' } } } })
        .expect(200);

      const response = await request(app)
        .post('/api/openchamber/sessions/ses_a/metadata')
        .send({ patch: { openchamber: { goal: { status: 'active' } } } })
        .expect(200);

      // The second write must not erase the first: the store merges key by key.
      expect(response.body).toEqual({
        metadata: { openchamber: { assist: { recap: 'first' }, goal: { status: 'active' } } },
      });
      await expect(sessionMetadataStore.get('ses_a')).resolves.toEqual(response.body.metadata);
      expect(broadcastGlobalUiEvent).toHaveBeenLastCalledWith({
        type: 'openchamber:session-metadata',
        properties: { sessionID: 'ses_a', metadata: response.body.metadata },
      });
    });

    it('keeps the state in the data dir when the real store is used', async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-routes-metadata-'));
      const { app } = createApp({ sessionMetadataStore: createSessionMetadataStore({ dataDir }) });

      const response = await request(app)
        .post('/api/openchamber/sessions/ses_v1/metadata')
        .send({ patch: { openchamber: { goal: { status: 'active' } } } })
        .expect(200);

      const merged = { openchamber: { goal: { status: 'active' } } };
      expect(response.body.metadata).toEqual(merged);
      expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'sessions-metadata.json'), 'utf8')))
        .toEqual({ ses_v1: merged });
      fs.rmSync(dataDir, { recursive: true, force: true });
    });

    it('deletes a key when the patch value is null', async () => {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions/ses_a/metadata')
        .send({ patch: { openchamber: { goal: { id: 'g1' }, assist: { recap: 'r' } } } })
        .expect(200);

      const response = await request(app)
        .post('/api/openchamber/sessions/ses_a/metadata')
        .send({ patch: { openchamber: { assist: null } } })
        .expect(200);

      expect(response.body).toEqual({ metadata: { openchamber: { goal: { id: 'g1' } } } });
    });

    it('reads back what it stored, per session', async () => {
      const { app } = createApp();
      await request(app).post('/api/openchamber/sessions/ses_a/metadata').send({ patch: { a: 1 } }).expect(200);

      await expect(request(app).get('/api/openchamber/sessions/ses_a/metadata').expect(200))
        .resolves.toMatchObject({ body: { metadata: { a: 1 } } });
      await expect(request(app).get('/api/openchamber/sessions/ses_b/metadata').expect(200))
        .resolves.toMatchObject({ body: { metadata: {} } });
    });

    it('rejects a missing or non-object patch', async () => {
      const { app, broadcastGlobalUiEvent } = createApp();

      await request(app).post('/api/openchamber/sessions/ses_a/metadata').send({}).expect(400);
      await request(app).post('/api/openchamber/sessions/ses_a/metadata').send({ patch: 'nope' }).expect(400);
      await request(app).post('/api/openchamber/sessions/ses_a/metadata').send({ patch: ['a'] }).expect(400);

      expect(broadcastGlobalUiEvent).not.toHaveBeenCalled();
    });

    it('routes every write through the server-owned writer when one is injected', async () => {
      const persistSessionMetadata = vi.fn(async () => ({ openchamber: { goal: { status: 'active' } } }));
      const { app, sessionMetadataStore } = createApp({ persistSessionMetadata });

      const response = await request(app)
        .post('/api/openchamber/sessions/ses_a/metadata')
        .send({ patch: { openchamber: { goal: { status: 'active' } } }, directory: '/repo/app' })
        .expect(200);

      expect(persistSessionMetadata).toHaveBeenCalledWith(
        'ses_a',
        { openchamber: { goal: { status: 'active' } } },
        { directory: '/repo/app' },
      );
      expect(response.body.metadata).toEqual({ openchamber: { goal: { status: 'active' } } });
      // The injected writer owns the store; the route must not write twice.
      await expect(sessionMetadataStore.get('ses_a')).resolves.toEqual({});
    });
  });

  it('creates a session for a directory and names it', async () => {
    const { app } = createApp();
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', title: 'Side task' })
      .expect(200);

    expect(response.body.sessionId).toBe('ses_123');
    expect(response.body.directory).toBe('/repo/app');
    expect(response.body.promptDispatched).toBe(false);
    expect(hostCreateSessionMock).toHaveBeenCalledWith({ cwd: '/repo/app' });
    // OMP opens the session on a directory and names it afterwards.
    expect(hostRenameSessionMock).toHaveBeenCalledWith('ses_123', 'Side task');
  });

  it('hands a non-ASCII checkout path to the runtime unchanged', async () => {
    const { app } = createApp();
    await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/home/user/Masaüstü/projeler', title: 'Side task' })
      .expect(200);

    expect(hostCreateSessionMock).toHaveBeenCalledWith({ cwd: '/home/user/Masaüstü/projeler' });
  });

  it('parses JSON body without global middleware', async () => {
    const { app } = createApp({}, { globalJson: false });
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app' })
      .expect(200);

    expect(response.body.sessionId).toBe('ses_123');
    expect(response.body.directory).toBe('/repo/app');
  });

  it('emits a session-created event after creating a session', async () => {
    const emitSessionCreatedEvent = vi.fn();
    const { app } = createApp({ emitSessionCreatedEvent });
    await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', title: 'Side task' })
      .expect(200);

    expect(emitSessionCreatedEvent).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_123',
      directory: '/repo/app',
      title: 'Side task',
      promptDispatched: false,
      dispatchedAsCommand: false,
    }));
  });

  it('answers a requested agent as unsupported before creating a session or worktree', async () => {
    const { app } = createApp();
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({
        directory: '/repo/app',
        prompt: 'Run this',
        agent: 'plan',
        worktree: { name: 'side-task' },
      })
      .expect(501);

    expect(response.body.error).toMatch(/plan/);
    expect(createWorktreeMock).not.toHaveBeenCalled();
    expect(hostCreateSessionMock).not.toHaveBeenCalled();
    expect(hostPromptMock).not.toHaveBeenCalled();
  });

  it('answers a requested model variant as unsupported before creating a session', async () => {
    const { app } = createApp();
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run this', model: 'openai/gpt-5.5', variant: 'high' })
      .expect(501);

    expect(response.body.error).toMatch(/variant/);
    expect(hostCreateSessionMock).not.toHaveBeenCalled();
    expect(hostSetModelMock).not.toHaveBeenCalled();
  });

  it('resolves the default model when the prompt omits one', async () => {
    const { app } = createApp({
      readSettingsFromDiskMigrated: async () => ({
        defaultModel: 'openai/gpt-5.5',
        defaultAgent: 'build',
        projects: [{ id: 'proj_1', path: '/repo/app' }],
      }),
    });
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run this' })
      .expect(200);

    expect(response.body.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.5' });
    // OMP serves no agent catalogue, so no default agent is resolved or applied.
    expect(response.body.agent).toBeUndefined();
    expect(hostListModelsMock).toHaveBeenCalled();
    expect(hostSetModelMock).toHaveBeenCalledWith('ses_123', 'openai', 'gpt-5.5');
  });

  it('resolves an Auto default through the routing hook before switching the session', async () => {
    const resolveAutoSelection = vi.fn(async () => ({
      model: { providerID: 'openai', id: 'gpt-5.5' },
      agent: null,
      decision: {},
    }));
    const { app } = createApp({
      readSettingsFromDiskMigrated: async () => ({
        defaultModel: 'openchamber/auto',
        projects: [{ id: 'proj_1', path: '/repo/app' }],
      }),
      resolveAutoSelection,
    });
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run this' })
      .expect(200);

    expect(resolveAutoSelection).toHaveBeenCalledWith({
      sessionId: 'ses_123',
      directory: '/repo/app',
      model: { providerID: 'openchamber', id: 'auto' },
      agent: null,
      requestText: 'Run this',
    });
    expect(response.body.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.5' });
    expect(hostSetModelMock).toHaveBeenCalledWith('ses_123', 'openai', 'gpt-5.5');
  });

  it('answers a routed category agent as unsupported instead of running on another one', async () => {
    const resolveAutoSelection = vi.fn(async () => ({
      model: { providerID: 'openai', id: 'gpt-5.5' },
      agent: 'plan',
      decision: {},
    }));
    const { app } = createApp({
      readSettingsFromDiskMigrated: async () => ({
        defaultModel: 'openchamber/auto',
        projects: [{ id: 'proj_1', path: '/repo/app' }],
      }),
      resolveAutoSelection,
    });
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run this' })
      .expect(501);

    expect(response.body.error).toMatch(/plan/);
    expect(hostSetModelMock).not.toHaveBeenCalled();
    expect(hostPromptMock).not.toHaveBeenCalled();
  });

  it('refuses an Auto default when routing is not wired in', async () => {
    const { app } = createApp({
      readSettingsFromDiskMigrated: async () => ({
        defaultModel: 'openchamber/auto',
        projects: [{ id: 'proj_1', path: '/repo/app' }],
      }),
    });
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run this' });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/not available/);
    expect(hostSetModelMock).not.toHaveBeenCalled();
  });

  it.each([
    ['', { projectId: 'proj_1' }],
    ['', { directory: '/repo/app', worktree: { name: 'side-task' } }],
    ['', { directory: '/repo/worktrees/side-task' }],
    ['/ses_existing/send', { directory: '/repo/worktrees/side-task' }],
  ])('prefers project defaults for %s with %j', async (endpoint, scope) => {
    const { app } = createApp({
      readSettingsFromDiskMigrated: async () => ({
        defaultModel: 'openai/gpt-5.5',
        projects: [{ id: 'proj_1', path: '/repo/app', defaultModel: 'anthropic/claude-sonnet-5' }],
      }),
    });

    const response = await request(app)
      .post(`/api/openchamber/sessions${endpoint}`)
      .send({ ...scope, prompt: 'Run this' })
      .expect(200);

    expect(response.body.model).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-5' });
    expect(hostSetModelMock).toHaveBeenCalledWith(expect.any(String), 'anthropic', 'claude-sonnet-5');
  });

  it('dispatches an initial prompt when model is provided', async () => {
    const { app } = createApp();
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run this', model: 'openai/gpt-5.5' })
      .expect(200);

    expect(response.body.sessionId).toBe('ses_123');
    expect(response.body.promptDispatched).toBe(true);
    expect(hostPromptMock).toHaveBeenCalledWith('ses_123', 'Run this');
  });

  it('creates goal metadata, then answers the goal reminder as unsupported', async () => {
    const createSessionGoal = vi.fn(async () => undefined);
    const { app } = createApp({ createSessionGoal });
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({
        directory: '/repo/app',
        prompt: 'Finish and verify the migration',
        model: 'openai/gpt-5.5',
        goal: true,
        goalTokenBudget: 200000,
      })
      .expect(501);

    expect(createSessionGoal).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_123',
      directory: '/repo/app',
      objective: 'Finish and verify the migration',
      tokenBudget: 200000,
      providerID: 'openai',
      modelID: 'gpt-5.5',
    }));
    expect(createSessionGoal.mock.invocationCallOrder[0])
      .toBeLessThan(hostPromptMock.mock.invocationCallOrder[0]);
    // The reminder is a message that must not start a run; OMP has no such call,
    // so the dispatch says so instead of dropping it. The goal already exists.
    expect(response.body.error).toMatch(/the goal reminder without starting a run/);
  });

  it('rejects invalid goal requests before creating a session', async () => {
    const { app } = createApp();
    await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', goal: true })
      .expect(400, { error: 'prompt is required when goal is enabled' });
    await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run', goalTokenBudget: 200000 })
      .expect(400, { error: 'goalTokenBudget requires goal' });
    await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run', goal: true, goalTokenBudget: 999 })
      .expect(400, { error: 'goalTokenBudget must be an integer from 1000 to 100000000' });

    expect(hostCreateSessionMock).not.toHaveBeenCalled();
  });

  it('creates a worktree before creating a session', async () => {
    const { app } = createApp();
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({
        directory: '/repo/app',
        worktree: { name: 'side-task', branchName: 'openchamber/side-task', startRef: 'main' },
        setUpstream: false,
        prompt: 'Run this',
        model: 'openai/gpt-5.5',
      })
      .expect(200);

    expect(createWorktreeMock).toHaveBeenCalledWith('/repo/app', {
      mode: 'new',
      name: 'side-task',
      branchName: 'openchamber/side-task',
      startRef: 'main',
      setUpstream: false,
    });
    expect(response.body.directory).toBe('/repo/worktrees/side-task');
    expect(response.body.worktree.path).toBe('/repo/worktrees/side-task');
    expect(hostCreateSessionMock).toHaveBeenCalledWith({ cwd: '/repo/worktrees/side-task' });
    expect(hostPromptMock).toHaveBeenCalledWith('ses_123', 'Run this');
  });

  it('waits for the worktree bootstrap to complete before creating the session', async () => {
    const statuses = [
      { status: 'pending', phase: 'directory-created', error: null, updatedAt: 1 },
      { status: 'pending', phase: 'git-ready', error: null, updatedAt: 2 },
      { status: 'ready', phase: 'setup-ready', error: null, updatedAt: 3 },
    ];
    getWorktreeBootstrapStatusMock.mockImplementation(async () => statuses.shift() || statuses[statuses.length - 1]);

    const { app } = createApp();
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({
        directory: '/repo/app',
        worktree: { name: 'side-task' },
        prompt: 'Run this',
        model: 'openai/gpt-5.5',
      })
      .expect(200);

    expect(response.body.promptDispatched).toBe(true);
    expect(getWorktreeBootstrapStatusMock).toHaveBeenCalled();
    expect(getWorktreeBootstrapStatusMock.mock.invocationCallOrder[0])
      .toBeLessThan(hostCreateSessionMock.mock.invocationCallOrder[0]);
    expect(hostCreateSessionMock.mock.invocationCallOrder[0])
      .toBeLessThan(hostPromptMock.mock.invocationCallOrder[0]);
  });

  it('fails the create when the worktree bootstrap failed', async () => {
    getWorktreeBootstrapStatusMock.mockImplementation(async () => ({
      status: 'failed',
      phase: 'directory-created',
      error: 'branch already exists',
      updatedAt: Date.now(),
    }));

    const { app } = createApp();
    await request(app)
      .post('/api/openchamber/sessions')
      .send({
        directory: '/repo/app',
        worktree: { name: 'side-task' },
        prompt: 'Run this',
        model: 'openai/gpt-5.5',
      })
      .expect(500, { error: 'Worktree bootstrap failed: branch already exists' });

    expect(hostPromptMock).not.toHaveBeenCalled();
  });

  it('sends to an existing session and reports the assistant baseline', async () => {
    setSessionMessages([
      assistantMessage('msg_before', 10, 20, { providerID: 'anthropic', modelID: 'claude-sonnet-5' }),
    ]);

    const { app } = createApp();
    const response = await request(app)
      .post('/api/openchamber/sessions/ses_source/send')
      .send({
        directory: '/repo/app',
        prompt: 'Apply and verify the review feedback',
        model: 'openai/gpt-5.5',
      })
      .expect(200);

    expect(response.body).toMatchObject({
      action: 'send',
      sessionId: 'ses_source',
      directory: '/repo/app',
      model: { providerID: 'openai', modelID: 'gpt-5.5' },
      promptDispatched: true,
      baselineAssistantMessageId: 'msg_before',
    });
    expect(hostPromptMock).toHaveBeenCalledWith('ses_source', 'Apply and verify the review feedback');
  });

  it('reuses the session model the runtime last ran when send omits one', async () => {
    setSessionMessages([
      assistantMessage('msg_before', 10, 20, { providerID: 'anthropic', modelID: 'claude-sonnet-5' }),
      { info: { id: 'msg_user', role: 'user', time: { created: 30 } }, parts: [] },
    ]);

    const { app } = createApp({
      readSettingsFromDiskMigrated: async () => ({
        defaultModel: 'openai/gpt-5.5',
        projects: [{ id: 'proj_1', path: '/repo/app' }],
      }),
    });
    const response = await request(app)
      .post('/api/openchamber/sessions/ses_source/send')
      .send({ directory: '/repo/app', prompt: 'Continue where you left off' })
      .expect(200);

    expect(response.body).toMatchObject({
      action: 'send',
      sessionId: 'ses_source',
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-5' },
      promptDispatched: true,
    });
    // The default-selection catalogue must not be consulted.
    expect(hostListModelsMock).not.toHaveBeenCalled();
    expect(hostSetModelMock).toHaveBeenCalledWith('ses_source', 'anthropic', 'claude-sonnet-5');
  });

  it('fails the send when the session read fails instead of moving it onto the default', async () => {
    hostGetMessagesMock.mockRejectedValue(new Error('session process is gone'));

    const { app } = createApp({
      readSettingsFromDiskMigrated: async () => ({
        defaultModel: 'openai/gpt-5.5',
        projects: [{ id: 'proj_1', path: '/repo/app' }],
      }),
    });
    const response = await request(app)
      .post('/api/openchamber/sessions/ses_source/send')
      .send({ directory: '/repo/app', prompt: 'Continue where you left off' })
      .expect(500);

    expect(response.body.error).toMatch(/session process is gone/);
    // The model must not be switched onto a default the caller never asked for.
    expect(hostSetModelMock).not.toHaveBeenCalled();
    expect(hostPromptMock).not.toHaveBeenCalled();
  });

  it('creates the goal record and then answers the goal reminder as unsupported for an existing session', async () => {
    const createSessionGoal = vi.fn(async () => undefined);
    setSessionMessages([assistantMessage('msg_before', 10, 20)]);

    const { app } = createApp({ createSessionGoal });
    const response = await request(app)
      .post('/api/openchamber/sessions/ses_source/send')
      .send({
        directory: '/repo/app',
        prompt: 'Apply and verify the review feedback',
        model: 'openai/gpt-5.5',
        goal: true,
        goalTokenBudget: 200000,
      })
      .expect(501);

    expect(createSessionGoal).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_source',
      directory: '/repo/app',
      objective: 'Apply and verify the review feedback',
    }));
    expect(response.body).toMatchObject({
      partial: true,
      partialAction: 'goal-configured',
      sessionId: 'ses_source',
    });
  });

  it('answers a catalogue command as unsupported instead of dispatching it', async () => {
    const { app } = createApp();
    useCatalog({ commands: [{ name: 'issue--to-pr', description: 'Issue to PR' }] });

    const response = await request(app)
      .post('/api/openchamber/sessions/ses_source/send')
      .send({ directory: '/repo/app', prompt: '/issue--to-pr LIN-123', model: 'openai/gpt-5.5' })
      .expect(501);

    expect(hostListCommandsMock).toHaveBeenCalled();
    expect(response.body.error).toMatch(/issue--to-pr/);
    expect(hostPromptMock).not.toHaveBeenCalled();
  });

  it('keeps the typed prompt as the goal objective of a slash command', async () => {
    const createSessionGoal = vi.fn(async () => undefined);
    useCatalog({ commands: [{ name: 'issue--to-pr', description: 'Issue to PR' }] });

    const { app } = createApp({ createSessionGoal });
    const response = await request(app)
      .post('/api/openchamber/sessions/ses_source/send')
      .send({ directory: '/repo/app', prompt: '/issue--to-pr LIN-123', model: 'openai/gpt-5.5', goal: true })
      .expect(501);

    // The runtime publishes no command template, so the objective is what the
    // user typed. The goal was recorded before the command was answered.
    expect(createSessionGoal).toHaveBeenCalledWith(expect.objectContaining({
      objective: '/issue--to-pr LIN-123',
    }));
    expect(response.body).toMatchObject({
      partial: true,
      partialAction: 'goal-configured',
      sessionId: 'ses_source',
    });
  });

  it('answers pending standing context as unsupported rather than dropping it', async () => {
    const recordDelivered = vi.fn(async () => undefined);
    const sessionKnowledgeRuntime = {
      resolvePendingForSession: vi.fn(async () => ({ text: 'Memory guidance', signature: 'sig_1' })),
      recordDelivered,
    };

    const { app } = createApp({ sessionKnowledgeRuntime });
    const response = await request(app)
      .post('/api/openchamber/sessions/ses_source/send')
      .send({ directory: '/repo/app', prompt: 'Run this', model: 'openai/gpt-5.5' })
      .expect(501);

    expect(response.body.error).toMatch(/without starting a run/);
    expect(hostPromptMock).not.toHaveBeenCalled();
    // Nothing was delivered, so the cursor must not move.
    expect(recordDelivered).not.toHaveBeenCalled();
  });

  it('answers a fork as unsupported without creating a session', async () => {
    const emitSessionCreatedEvent = vi.fn();
    const { app } = createApp({ emitSessionCreatedEvent });
    const response = await request(app)
      .post('/api/openchamber/sessions/ses_source/fork')
      .send({ directory: '/repo/app', messageId: 'msg_branch_point', prompt: 'Try the alternative' })
      .expect(501);

    expect(response.body.error).toMatch(/Forking a session/);
    expect(hostCreateSessionMock).not.toHaveBeenCalled();
    expect(hostPromptMock).not.toHaveBeenCalled();
    expect(emitSessionCreatedEvent).not.toHaveBeenCalled();
  });

  it('rejects send and fork requests without a prompt before reaching the runtime', async () => {
    const { app } = createApp();
    await request(app)
      .post('/api/openchamber/sessions/ses_source/send')
      .send({ directory: '/repo/app' })
      .expect(400, { error: 'prompt is required' });
    await request(app)
      .post('/api/openchamber/sessions/ses_source/fork')
      .send({ directory: '/repo/app' })
      .expect(400, { error: 'prompt is required' });

    expect(hostCreateSessionMock).not.toHaveBeenCalled();
    expect(hostPromptMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown model before dispatching', async () => {
    const { app } = createApp();
    await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run this', model: 'openai/gpt-nope' })
      .expect(400, { error: "Unknown model 'openai/gpt-nope' for /repo/app" });

    expect(hostPromptMock).not.toHaveBeenCalled();
  });

  it('reports promptDispatched false when the runtime records the prompt without starting the agent', async () => {
    hostPromptMock.mockResolvedValue(false);

    const { app } = createApp();
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run this', model: 'openai/gpt-5.5' })
      .expect(200);

    expect(response.body.sessionId).toBe('ses_123');
    expect(response.body.promptDispatched).toBe(false);
    expect(response.body.promptError).toBeTruthy();
  });
});
