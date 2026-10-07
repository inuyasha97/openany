import { beforeEach, describe, expect, it, vi } from 'vitest';

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { createOpenChamberControlService } from './service.js';

// The service reads sessions through the OMP runtime seam; a test drives the
// runtime by answering these instead of standing up a server.
const omp = vi.hoisted(() => ({
  readSessions: vi.fn(),
  readSessionStatus: vi.fn(),
  readSessionMessages: vi.fn(),
}));

vi.mock('../agents/omp-host-access.js', () => ({
  readSessions: omp.readSessions,
  readSessionStatus: omp.readSessionStatus,
  readSessionMessages: omp.readSessionMessages,
}));

const createService = (overrides = {}) => {
  const scheduledTaskService = {
    status: vi.fn(async () => ({ enabledScheduledTasksCount: 0 })),
    resolveProjectID: vi.fn(async () => 'project-1'),
    list: vi.fn(async () => []),
    upsert: vi.fn(),
    run: vi.fn(),
    remove: vi.fn(),
    setEnabled: vi.fn(),
  };
  const service = createOpenChamberControlService({
    readSettingsFromDiskMigrated: vi.fn(async () => ({
      projects: [{ id: 'project-1', path: '/repo', label: 'Repo' }],
      defaultModel: 'provider/model',
      favoriteModels: [],
      recentModels: [],
    })),
    sanitizeProjects: (projects) => projects,
    scheduledTaskService,
    ...overrides,
  });
  return { service, scheduledTaskService };
};

beforeEach(() => {
  omp.readSessions.mockReset().mockResolvedValue([]);
  omp.readSessionStatus.mockReset().mockResolvedValue({ busy: false });
  omp.readSessionMessages.mockReset().mockResolvedValue({ items: [], cursor: {} });
});

describe('OpenChamber control service', () => {
  it('serves project and model projections without an HTTP or CLI round trip', async () => {
    const { service } = createService();
    await expect(service.execute('projects.list')).resolves.toEqual({
      projects: [{ id: 'project-1', path: '/repo', label: 'Repo' }],
    });
    await expect(service.execute('models.list')).resolves.toEqual(expect.objectContaining({
      defaultModel: 'provider/model',
      favoriteModels: [],
    }));
  });

  it('maps schedule creation into the shared scheduled-task service', async () => {
    const { service, scheduledTaskService } = createService();
    scheduledTaskService.upsert.mockResolvedValue({ task: { id: 'task-1' }, created: true });
    await expect(service.execute('schedule.create', {
      directory: '/repo',
      name: 'Daily',
      prompt: 'Run checks',
      model: 'provider/model',
      daily: ' 09:00 ',
      goal: true,
      goalTokenBudget: 5000,
    })).resolves.toEqual({ task: { id: 'task-1' }, created: true });
    expect(scheduledTaskService.resolveProjectID).toHaveBeenCalledWith({ projectId: undefined, directory: '/repo' });
    expect(scheduledTaskService.upsert).toHaveBeenCalledWith('project-1', expect.objectContaining({
      name: 'Daily',
      schedule: { kind: 'daily', times: ['09:00'] },
      execution: expect.objectContaining({ providerID: 'provider', modelID: 'model', goalEnabled: true, goalTokenBudget: 5000 }),
    }));
  });

  it('does not combine an explicit schedule project with the tool context directory', async () => {
    const { service, scheduledTaskService } = createService();
    await service.execute('schedule.list', { projectId: ' project-1 ' }, '/current-session');
    expect(scheduledTaskService.resolveProjectID).toHaveBeenCalledWith({ projectId: 'project-1', directory: undefined });
  });

  it('includes scheduler status alongside listed tasks', async () => {
    const { service, scheduledTaskService } = createService();
    scheduledTaskService.list.mockResolvedValue([{ id: 'task-1' }]);
    await expect(service.execute('schedule.list', {}, '/repo')).resolves.toEqual({
      scheduler: { enabledScheduledTasksCount: 0 },
      tasks: [{ id: 'task-1' }],
    });
  });

  it('toggles a scheduled task through the required disabled boolean', async () => {
    const { service, scheduledTaskService } = createService();
    scheduledTaskService.setEnabled.mockResolvedValue({ id: 'task-1', enabled: false });
    await expect(service.execute('schedule.toggle', { taskId: 'task-1' }, '/repo')).rejects.toThrow('disabled is required for schedule.toggle');
    await expect(service.execute('schedule.toggle', { taskId: 'task-1', disabled: true }, '/repo')).resolves.toEqual({
      task: { id: 'task-1', enabled: false },
      enabled: false,
    });
    expect(scheduledTaskService.setEnabled).toHaveBeenCalledWith('project-1', 'task-1', false);
  });

  it('returns an actionable taskId error before resolving schedule scope', async () => {
    const { service, scheduledTaskService } = createService();
    await expect(service.execute('schedule.run', {}, '/repo')).rejects.toThrow('taskId is required');
    expect(scheduledTaskService.resolveProjectID).not.toHaveBeenCalled();
    expect(scheduledTaskService.run).not.toHaveBeenCalled();
  });

  it.each([
    'session.create',
    'session.send',
    'session.fork',
  ])('answers %s as unsupported on the OMP runtime', async (action) => {
    const { service } = createService();
    await expect(service.execute(action, { sessionId: 'ses_1', directory: '/repo', prompt: 'Continue' }))
      .rejects.toMatchObject({ statusCode: 501, message: `${action} is not supported on the OMP runtime` });
  });

  it('resolves a session directory from the runtime session index', async () => {
    const { service } = createService();
    omp.readSessions.mockResolvedValue([
      { id: 'ses_other', sessionPath: '/s/other.jsonl', cwd: '/repo/worktrees/other', title: 'Other' },
      { id: 'ses_target', sessionPath: '/s/target.jsonl', cwd: '/repo/worktrees/target', title: 'Target' },
    ]);

    await expect(service.resolveSessionDirectory('ses_target')).resolves.toBe('/repo/worktrees/target');
  });

  it('answers no directory when the session is unknown or the runtime cannot list sessions', async () => {
    const { service } = createService();
    await expect(service.resolveSessionDirectory('ses_missing')).resolves.toBe(null);
    omp.readSessions.mockRejectedValue(new Error('store unavailable'));
    await expect(service.resolveSessionDirectory('ses_target')).resolves.toBe(null);
  });

  it('lists runtime sessions scoped to the requested directory and hides archived ones', async () => {
    const { service } = createService({
      archiveStore: { isArchived: (id) => (id === 'ses_archived' ? 100 : null) },
    });
    omp.readSessions.mockResolvedValue([
      { id: 'ses_active', sessionPath: '/s/a.jsonl', cwd: '/repo', title: 'Active' },
      { id: 'ses_archived', sessionPath: '/s/b.jsonl', cwd: '/repo', title: 'Archived' },
      { id: 'ses_other', sessionPath: '/s/c.jsonl', cwd: '/other', title: 'Other' },
    ]);

    await expect(service.execute('session.list', { directory: '/repo', limit: 10 })).resolves.toEqual({
      sessions: [{ id: 'ses_active', directory: '/repo', title: 'Active' }],
      limit: 10,
      directory: '/repo',
      archived: 'excluded',
    });
  });

  it('includes archived sessions and their archive time when all is asked for', async () => {
    const { service } = createService({
      archiveStore: { isArchived: (id) => (id === 'ses_archived' ? 100 : null) },
    });
    omp.readSessions.mockResolvedValue([
      { id: 'ses_archived', sessionPath: '/s/b.jsonl', cwd: '/repo', title: 'Archived' },
      { id: 'ses_active', sessionPath: '/s/a.jsonl', cwd: '/repo', title: 'Active' },
    ]);

    await expect(service.execute('session.list', { directory: '/repo', all: true })).resolves.toEqual({
      sessions: [
        { id: 'ses_archived', directory: '/repo', title: 'Archived', time: { archived: 100 } },
        { id: 'ses_active', directory: '/repo', title: 'Active' },
      ],
      limit: 10,
      directory: '/repo',
      archived: 'included',
    });
  });

  it('applies the requested limit to the listed sessions', async () => {
    const { service } = createService();
    omp.readSessions.mockResolvedValue([
      { id: 'ses_1', sessionPath: '/s/1.jsonl', cwd: '/repo', title: 'One' },
      { id: 'ses_2', sessionPath: '/s/2.jsonl', cwd: '/repo', title: 'Two' },
      { id: 'ses_3', sessionPath: '/s/3.jsonl', cwd: '/repo', title: 'Three' },
    ]);

    const result = await service.execute('session.list', { limit: 2 });

    expect(result.sessions.map((session) => session.id)).toEqual(['ses_1', 'ses_2']);
    expect(result.limit).toBe(2);
  });

  it('matches a session directory that differs only in path shape', async () => {
    const { service } = createService();
    omp.readSessions.mockResolvedValue([{ id: 'ses_1', sessionPath: '/s/1.jsonl', cwd: '/repo/', title: 'One' }]);

    const result = await service.execute('session.list', { directory: '/repo' });

    expect(result.sessions.map((session) => session.id)).toEqual(['ses_1']);
  });

  it('adds a per-session status when withStatus is asked for', async () => {
    const { service } = createService();
    omp.readSessions.mockResolvedValue([
      { id: 'ses_busy', sessionPath: '/s/a.jsonl', cwd: '/repo', title: 'Busy' },
      { id: 'ses_idle', sessionPath: '/s/b.jsonl', cwd: '/repo', title: 'Idle' },
    ]);
    omp.readSessionStatus.mockImplementation(async (id) => ({ busy: id === 'ses_busy' }));

    await expect(service.execute('session.list', { limit: 10, withStatus: true })).resolves.toEqual({
      sessions: [
        { id: 'ses_busy', directory: '/repo', title: 'Busy', status: { type: 'busy' } },
        { id: 'ses_idle', directory: '/repo', title: 'Idle', status: { type: 'idle' } },
      ],
      limit: 10,
      directory: null,
      archived: 'excluded',
    });
  });

  it('reports unknown status for a session whose status read fails', async () => {
    const { service } = createService();
    omp.readSessions.mockResolvedValue([{ id: 'ses_active', sessionPath: '/s/a.jsonl', cwd: '/repo', title: 'Active' }]);
    omp.readSessionStatus.mockRejectedValue(new Error('unavailable'));

    await expect(service.execute('session.list', { limit: 10, withStatus: true })).resolves.toEqual({
      sessions: [{ id: 'ses_active', directory: '/repo', title: 'Active', status: { type: 'unknown' } }],
      limit: 10,
      directory: null,
      archived: 'excluded',
    });
  });

  it('names limit in positive-integer validation errors', async () => {
    const { service } = createService();
    await expect(service.execute('session.list', { limit: 0 })).rejects.toThrow('limit must be a positive integer');
    expect(omp.readSessions).not.toHaveBeenCalled();
  });

  it('reports one session status in the busy/idle contract', async () => {
    const { service } = createService();
    omp.readSessionStatus.mockResolvedValue({ busy: true });

    await expect(service.execute('session.status', { sessionId: 'ses_1', directory: '/repo' })).resolves.toEqual({
      sessionId: 'ses_1',
      directory: '/repo',
      sessionStatus: { type: 'busy' },
    });
    expect(omp.readSessionStatus).toHaveBeenCalledWith('ses_1');
  });

  it('answers 503 when the runtime is not mounted', async () => {
    const { service } = createService();
    omp.readSessions.mockResolvedValue(null);
    omp.readSessionStatus.mockResolvedValue(null);
    omp.readSessionMessages.mockResolvedValue(null);

    await expect(service.execute('session.list', {})).rejects.toMatchObject({ statusCode: 503 });
    await expect(service.execute('session.status', { sessionId: 'ses_1', directory: '/repo' }))
      .rejects.toMatchObject({ statusCode: 503 });
    await expect(service.execute('session.messages', { sessionId: 'ses_1', directory: '/repo' }))
      .rejects.toMatchObject({ statusCode: 503 });
  });

  it('projects only ordered text content from session messages', async () => {
    const { service } = createService();
    omp.readSessionMessages.mockResolvedValue({ items: [
      {
        info: {
          id: 'msg_assistant', sessionID: 'ses_1', role: 'assistant', providerID: 'openai', modelID: 'gpt-5.4-mini',
          time: { created: 20, completed: 30 },
        },
        parts: [
          { id: 'part_1', type: 'reasoning', text: 'hidden' },
          { id: 'part_2', type: 'text', text: 'First ' },
          { id: 'part_3', type: 'tool', state: { status: 'completed', input: {}, output: 'ignored' } },
          { id: 'part_4', type: 'text', text: 'answer' },
        ],
      },
      { info: { id: 'msg_user', sessionID: 'ses_1', role: 'user', time: { created: 10 } }, parts: [{ id: 'part_5', type: 'text', text: 'Question' }] },
      { info: { id: 'msg_tool', sessionID: 'ses_1', role: 'assistant', providerID: '', modelID: '', time: { created: 15 } }, parts: [{ id: 'part_6', type: 'tool', state: { status: 'pending', input: {}, raw: '{}' } }] },
      { info: { id: 'msg_shell', sessionID: 'ses_1', role: 'shell', time: { created: 5 } }, parts: [{ id: 'part_7', type: 'text', text: 'not the conversation' }] },
    ] });

    await expect(service.execute('session.messages', {
      sessionId: 'ses_1',
      directory: '/repo',
      role: 'all',
      all: true,
    })).resolves.toEqual({
      sessionId: 'ses_1',
      directory: '/repo',
      role: 'all',
      sessionStatus: { type: 'idle' },
      messages: [
        { id: 'msg_user', role: 'user', createdAt: 10, completedAt: null, model: null, text: 'Question' },
        { id: 'msg_assistant', role: 'assistant', createdAt: 20, completedAt: 30, model: 'openai/gpt-5.4-mini', text: 'First answer' },
      ],
    });
    expect(omp.readSessionMessages).toHaveBeenCalledWith('ses_1');
  });

  it('returns only the newest text messages when a limit is given', async () => {
    const { service } = createService();
    const text = (id, created) => ({
      info: { id, sessionID: 'ses_1', role: 'assistant', time: { created } },
      parts: [{ id: `${id}_text`, type: 'text', text: id }],
    });
    omp.readSessionMessages.mockResolvedValue({ items: [text('msg_1', 1), text('msg_2', 2), text('msg_3', 3)] });

    const result = await service.execute('session.messages', { sessionId: 'ses_1', directory: '/repo', limit: 2 });

    expect(result.messages.map((message) => message.id)).toEqual(['msg_2', 'msg_3']);
  });

  it('validates wait modifiers before reading the runtime', async () => {
    const { service } = createService();
    await expect(service.execute('session.messages', { sessionId: 'ses_1', directory: '/repo', timeout: 30 }))
      .rejects.toThrow('timeout requires wait');
    expect(omp.readSessionMessages).not.toHaveBeenCalled();
  });

  it('waits through a busy turn until the session goes idle', async () => {
    const { service } = createService({ sleep: async () => {} });
    omp.readSessionStatus.mockResolvedValueOnce({ busy: true }).mockResolvedValue({ busy: false });

    const result = await service.execute('session.messages', {
      sessionId: 'ses_1',
      directory: '/repo',
      wait: true,
      timeout: 2,
    });

    expect(result.sessionStatus).toEqual({ type: 'idle' });
    expect(omp.readSessionStatus).toHaveBeenCalledTimes(2);
  });

  it('fails a wait that outruns its timeout instead of reporting idle', async () => {
    let timestamp = 1000;
    const { service } = createService({
      now: () => timestamp,
      sleep: async (duration) => { timestamp += duration; },
    });
    omp.readSessionStatus.mockResolvedValue({ busy: true });

    await expect(service.execute('session.messages', {
      sessionId: 'ses_1',
      directory: '/repo',
      wait: true,
      timeout: 2,
    })).rejects.toThrow('Session did not become idle within 2 seconds');
  });

  it('rejects actions outside the fixed contract', async () => {
    const { service } = createService();
    await expect(service.execute('session.delete')).rejects.toThrow('Unsupported OpenChamber action');
  });
});

describe('file.open', () => {
  it('hands the path, the session directory and the session to the file viewer', async () => {
    const request = vi.fn(async () => ({ path: '/repo/out.csv', size: 3, opened: true }));
    const { service } = createService({ fileOpen: { request } });

    const result = await service.execute('file.open', { path: 'out.csv' }, '/repo', { contextSessionId: 'ses_1' });

    expect(request).toHaveBeenCalledWith({ path: 'out.csv', directory: '/repo', sessionId: 'ses_1' });
    expect(result).toEqual({ path: '/repo/out.csv', size: 3, opened: true });
  });

  it('lets an explicit directory win over the session directory', async () => {
    const request = vi.fn(async () => ({ path: '/other/out.csv', size: 3, opened: true }));
    const { service } = createService({ fileOpen: { request } });

    await service.execute('file.open', { path: 'out.csv', directory: '/other' }, '/repo');

    expect(request).toHaveBeenCalledWith({ path: 'out.csv', directory: '/other', sessionId: null });
  });

  it('answers 503 when this server has no file viewer wired', async () => {
    const { service } = createService({});
    await expect(service.execute('file.open', { path: 'out.csv' }, '/repo')).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('notify.send', () => {
  it('sends the notice for the calling session and returns what was delivered', async () => {
    const notifyUser = vi.fn(async () => ({ status: 200, body: { delivered: true } }));
    const { service } = createService({ notifyUser });

    const result = await service.execute('notify.send', { title: 'Done', body: 'All green', showWhenFocused: true }, '/repo', { contextSessionId: 'ses_1' });

    expect(notifyUser).toHaveBeenCalledWith({ title: 'Done', body: 'All green', showWhenFocused: true, sessionId: 'ses_1', directory: '/repo' });
    expect(result).toEqual({ delivered: true });
  });

  it('turns a refused notice into an error the agent can read', async () => {
    const notifyUser = vi.fn(async () => ({ status: 429, retryAfter: 4, body: { error: 'too many notifications' } }));
    const { service } = createService({ notifyUser });

    await expect(service.execute('notify.send', { title: 'Done' }, '/repo'))
      .rejects.toMatchObject({ statusCode: 429, message: 'too many notifications' });
  });

  it('answers 503 when this server has no notifier wired', async () => {
    const { service } = createService({});
    await expect(service.execute('notify.send', { title: 'Done' }, '/repo')).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('browser capture', () => {
  const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  const createBrowserService = async (capture) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-capture-'));
    const request = vi.fn(async () => capture);
    const { service } = createService({ browserControl: { request } });
    return { service, directory, request };
  };

  it('saves the image beside the code and hands back a path the answer can use', async () => {
    const { service, directory } = await createBrowserService({
      base64: pixel,
      mime: 'image/png',
      url: 'http://localhost:3000/',
      title: 'App',
      viewport: { mode: 'mobile', width: 390, height: 844 },
      width: 390,
      height: 844,
    });

    const result = await service.execute('browser.capture', { label: 'After fix' }, directory);

    expect(result.path.startsWith('.openchamber/screenshots/after-fix-')).toBe(true);
    expect(result.path.endsWith('.png')).toBe(true);
    expect(result.url).toBe('http://localhost:3000/');
    expect(result.viewport).toEqual({ mode: 'mobile', width: 390, height: 844 });
    // The bytes stay on disk; a tool result is not a place to carry an image.
    expect('base64' in result).toBe(false);
    const written = await fs.readFile(path.join(directory, result.path));
    expect(written.length > 0).toBe(true);
  });

  it('tells the agent how to actually show the image', async () => {
    const { service, directory } = await createBrowserService({ base64: pixel, mime: 'image/png' });
    const result = await service.execute('browser.capture', {}, directory);
    expect(result.hint).toContain(`![](${result.path})`);
  });

  it('refuses to capture with no project to save into', async () => {
    const { service } = await createBrowserService({ base64: pixel, mime: 'image/png' });
    await expect(service.execute('browser.capture', {})).rejects.toThrow(/directory is required/);
  });

  it('passes the tab the agent named to the browser', async () => {
    const { service, directory, request } = await createBrowserService({ base64: pixel, mime: 'image/png' });
    await service.execute('browser.capture', { tabId: ' tab-2 ' }, directory);
    expect(request).toHaveBeenCalledWith('browser.capture', { tabId: 'tab-2' }, expect.anything());
  });

  it('passes a label through to the browser and leaves other actions untouched', async () => {
    const { service, directory, request } = await createBrowserService({ base64: pixel, mime: 'image/png' });
    await service.execute('browser.capture', { label: 'before' }, directory);
    expect(request).toHaveBeenCalledWith('browser.capture', { label: 'before' }, expect.anything());
  });

  it('tells the browser which project and chat the action came from', async () => {
    const { service, directory, request } = await createBrowserService({ base64: pixel, mime: 'image/png' });
    await service.execute('browser.capture', {}, directory, { contextSessionId: 'ses_1' });
    expect(request).toHaveBeenCalledWith('browser.capture', {}, expect.objectContaining({
      context: { directory, sessionId: 'ses_1' },
    }));
    await service.execute('browser.capture', {}, directory);
    expect(request).toHaveBeenLastCalledWith('browser.capture', {}, expect.objectContaining({
      context: { directory, sessionId: null },
    }));
  });
});
