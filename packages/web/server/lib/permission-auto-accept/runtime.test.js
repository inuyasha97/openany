import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPermissionAutoAcceptRuntime } from './runtime.js';
import { listPermissions, readSessions, replyPermission } from '../agents/omp-host-access.js';

vi.mock('../agents/omp-host-access.js', () => ({
  readSessions: vi.fn(async () => []),
  listPermissions: vi.fn(async () => []),
  replyPermission: vi.fn(async () => true),
}));

beforeEach(() => {
  readSessions.mockReset().mockResolvedValue([]);
  listPermissions.mockReset().mockResolvedValue([]);
  replyPermission.mockReset().mockResolvedValue(true);
});

const createRuntime = ({ stored, evaluatePermission, onPermissionReplied, resolveLegacyEnabledMode } = {}) => {
  let settings = stored ?? { permissionAutoAccept: { sessions: {} } };
  let eventHandler;
  const runtime = createPermissionAutoAcceptRuntime({
    globalEventHub: {
      subscribeEvent(handler) { eventHandler = handler; return () => {}; },
    },
    readSettingsFromDiskMigrated: async () => settings,
    persistSettings: async (changes) => { settings = { ...settings, ...changes }; },
    retryDelaysMs: [0, 0],
    evaluatePermission,
    onPermissionReplied,
    resolveLegacyEnabledMode,
  });
  runtime.start();
  return {
    runtime,
    getSettings: () => settings,
    // The hub hands server-side subscribers already-translated events.
    emit: (payload, directory = '/project') => eventHandler({ payload, directory, translated: () => [payload] }),
  };
};

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

describe('permission auto-accept runtime', () => {
  it('persists explicit session modes across runtime restarts', async () => {
    const first = createRuntime();
    await first.runtime.setSessionPolicy('root', 'safety');
    await first.runtime.setSessionPolicy('manual', 'ask');

    const second = createRuntime({ stored: first.getSettings() });
    await expect(second.runtime.load()).resolves.toEqual({
      sessions: { root: true, manual: false },
      modes: { root: 'safety', manual: 'ask' },
      revision: 2,
    });
  });

  it('takes on/off from clients that predate the modes as auto and ask', async () => {
    const { runtime } = createRuntime();
    await runtime.setSessionPolicy('on', true);
    await runtime.setSessionPolicy('off', false);
    expect((await runtime.load()).modes).toEqual({ on: 'auto', off: 'ask' });
    await expect(runtime.setSessionPolicy('bad', 'always')).rejects.toThrow(TypeError);
  });

  it('converts a pre-modes policy once, as safety when the old safety net was on', async () => {
    const resolveLegacyEnabledMode = vi.fn(async () => 'safety');
    const { runtime, getSettings } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { root: true, child: false }, revision: 3 } },
      resolveLegacyEnabledMode,
    });
    expect((await runtime.load()).modes).toEqual({ root: 'safety', child: 'ask' });
    expect(getSettings().permissionAutoAccept).toEqual({ sessions: { root: 'safety', child: 'ask' }, revision: 3 });

    const restarted = createRuntime({ stored: getSettings(), resolveLegacyEnabledMode });
    await restarted.runtime.load();
    expect(resolveLegacyEnabledMode).toHaveBeenCalledTimes(1);
  });

  it('writes the default mode onto a new top-level session only', async () => {
    const { runtime, emit, getSettings } = createRuntime();
    await runtime.load();
    getSettings().permissionDefaultMode = 'safety';
    emit({ type: 'session.created', properties: { info: { id: 'root' } } });
    emit({ type: 'session.created', properties: { info: { id: 'child', parentID: 'root' } } });
    await flush();
    await expect(runtime.resolveSessionMode('root', '/project')).resolves.toBe('safety');
    expect((await runtime.load()).modes).toEqual({ root: 'safety' });
    await expect(runtime.resolveSessionMode('child', '/project')).resolves.toBe('safety');
  });

  it('keeps a mode the creating flow already set over the default', async () => {
    const { runtime, emit, getSettings } = createRuntime();
    await runtime.setSessionPolicy('root', 'ask');
    getSettings().permissionDefaultMode = 'auto';
    emit({ type: 'session.created', properties: { info: { id: 'root' } } });
    await flush();
    await expect(runtime.resolveSessionMode('root', '/project')).resolves.toBe('ask');
  });

  it('increments the authoritative policy revision', async () => {
    const { runtime, getSettings } = createRuntime();

    await expect(runtime.setSessionPolicy('root', true)).resolves.toMatchObject({ revision: 1 });
    await expect(runtime.setSessionPolicy('child', false)).resolves.toMatchObject({ revision: 2 });
    expect(getSettings().permissionAutoAccept.revision).toBe(2);
  });

  it('uses nearest explicit ancestor policy for subagents', async () => {
    const { runtime, emit } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { root: true, child: false } } },
    });
    emit({ type: 'session.created', properties: { info: { id: 'child', parentID: 'root' } } });
    emit({ type: 'session.created', properties: { info: { id: 'grandchild', parentID: 'child' } } });
    await expect(runtime.isSessionAutoAccepting('grandchild', '/project')).resolves.toBe(false);
    await runtime.setSessionPolicy('child', true);
    await expect(runtime.isSessionAutoAccepting('grandchild', '/project')).resolves.toBe(true);
  });

  it('keeps a subagent\'s lineage when a later partial update names only its title', async () => {
    const { runtime, emit } = createRuntime();
    await runtime.setSessionPolicy('root', true);
    emit({ type: 'session.created', properties: { info: { id: 'child', parentID: 'root', directory: '/project' } } });
    // Renames arrive as partial session records without parentID.
    emit({ type: 'session.updated', properties: { info: { id: 'child', title: 'Subagent' } } });
    emit({ type: 'permission.asked', properties: { id: 'p1', sessionID: 'child', permission: 'bash', metadata: {} } });
    await flush();
    expect(replyPermission).toHaveBeenCalledWith('child', 'p1', 'once');
  });

  it('replies to a permission of a session the runtime lists', async () => {
    readSessions.mockResolvedValue([{ id: 'child', cwd: '/project' }]);
    const { runtime } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { child: true } } },
    });
    await expect(runtime.processPermission({ id: 'perm', sessionID: 'child' }, '/project')).resolves.toBe(true);
    expect(replyPermission).toHaveBeenCalledWith('child', 'perm', 'once');
  });

  it('retries a transient reply failure and deduplicates concurrent events', async () => {
    replyPermission
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 503 }))
      .mockResolvedValue(true);
    const { runtime } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { root: true } } },
    });
    const permission = { id: 'perm', sessionID: 'root' };
    const first = runtime.processPermission(permission, '/project');
    const second = runtime.processPermission(permission, '/project');
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(replyPermission).toHaveBeenCalledTimes(2);
  });

  it('reconciles pending permissions on demand', async () => {
    readSessions.mockResolvedValue([{ id: 'root', cwd: '/project' }]);
    listPermissions.mockResolvedValue([{ id: 'pending', sessionID: 'root' }]);
    const { runtime } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { root: true } } },
    });
    await runtime.reconcilePending();
    expect(replyPermission).toHaveBeenCalledWith('root', 'pending', 'once');
  });

  it('accepts existing pending permissions when a session policy is enabled', async () => {
    readSessions.mockResolvedValue([
      { id: 'root', cwd: '/project' },
      { id: 'other', cwd: '/elsewhere' },
    ]);
    listPermissions.mockImplementation(async (id) => (id === 'root' ? [{ id: 'root-pending', sessionID: 'root' }] : []));
    const { runtime } = createRuntime();

    await runtime.setSessionPolicy('root', true, '/project');

    expect(replyPermission).toHaveBeenCalledTimes(1);
    expect(replyPermission).toHaveBeenCalledWith('root', 'root-pending', 'once');
    expect(await runtime.load()).toEqual({ sessions: { root: true }, modes: { root: 'auto' }, revision: 1 });
  });

  it('leaves a request held by the safety net unanswered and forgets it once replied', async () => {
    const verdicts = { held: { action: 'hold', score: 0.9, kind: 'git_history' }, safe: { action: 'accept', score: 0.1 } };
    const evaluatePermission = vi.fn(async (permission) => verdicts[permission.id]);
    const onPermissionReplied = vi.fn();
    const { runtime, emit } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { root: 'safety' } } },
      evaluatePermission,
      onPermissionReplied,
    });
    await runtime.load();

    emit({ type: 'permission.asked', properties: { id: 'held', sessionID: 'root', permission: 'bash', metadata: {} } });
    emit({ type: 'permission.asked', properties: { id: 'safe', sessionID: 'root', permission: 'bash', metadata: {} } });
    await flush();

    expect(replyPermission.mock.calls.map(([sessionId, requestId]) => `${sessionId}/${requestId}`)).toEqual(['root/safe']);
    expect(evaluatePermission).toHaveBeenCalledTimes(2);

    await expect(runtime.isPermissionAutoAnswered('root', '/project', 'safe')).resolves.toBe(true);
    await expect(runtime.isPermissionAutoAnswered('root', '/project', 'held')).resolves.toBe(false);

    emit({ type: 'permission.replied', properties: { sessionID: 'root', requestID: 'held', reply: 'once' } });
    expect(onPermissionReplied).toHaveBeenCalledWith('held');
  });

  it('never consults the safety net in an auto session', async () => {
    const evaluatePermission = vi.fn(async () => ({ action: 'hold' }));
    const { runtime, emit } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { root: 'auto' } } },
      evaluatePermission,
    });
    await runtime.load();
    emit({ type: 'permission.asked', properties: { id: 'p', sessionID: 'root', permission: 'bash', metadata: {} } });
    await flush();
    expect(evaluatePermission).not.toHaveBeenCalled();
    expect(replyPermission).toHaveBeenCalledWith('root', 'p', 'once');
    await expect(runtime.isPermissionAutoAnswered('root', '/project', 'p')).resolves.toBe(true);
  });

  it('leaves a safety request for the user when the safety net gives no verdict', async () => {
    const { runtime, emit } = createRuntime({
      stored: { permissionAutoAccept: { sessions: { root: 'safety' } } },
      evaluatePermission: async () => ({ action: 'hold', skipped: 'Jev timed out' }),
    });
    await runtime.load();
    emit({ type: 'permission.asked', properties: { id: 'p', sessionID: 'root', permission: 'bash', metadata: {} } });
    await flush();
    expect(replyPermission).not.toHaveBeenCalled();
  });

  it('does not consult the safety net for sessions that are not auto-accepting', async () => {
    const evaluatePermission = vi.fn(async () => ({ action: 'hold' }));
    const { runtime, emit } = createRuntime({ evaluatePermission });
    await runtime.load();
    emit({ type: 'permission.asked', properties: { id: 'p', sessionID: 'manual', permission: 'bash', metadata: {} } });
    await flush();
    expect(evaluatePermission).not.toHaveBeenCalled();
  });
});
