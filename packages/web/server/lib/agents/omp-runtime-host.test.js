import { describe, expect, it, vi } from 'vitest';

import { OMP_FRAME_TYPE, createOmpRuntimeHost } from './omp-runtime-host.js';

const createFakeAdapter = ({ projectImpl } = {}) => {
  const sessions = [];
  let subscriber = null;
  const runtime = {
    prompted: [],
    promptOptions: [],
    aborted: [],
    disposed: false,
    messages: [],
    sent: [],
    disposedDirectories: [],
    disposedSessionIds: [],
    emit(sessionId, event) {
      subscriber?.(sessionId, event);
    },
    async listSessions() {
      return sessions;
    },
    async createSession(input) {
      return { id: 'ses_new', sessionFile: '/s/new.json', cwd: input.cwd };
    },
    async getMessages() {
      return runtime.messages;
    },
    async prompt(id, text, options) {
      runtime.prompted.push([id, text]);
      runtime.promptOptions.push(options);
      runtime.order.push('prompt');
      return true;
    },
    models: [],
    order: [],
    async setModel(id, provider, modelId) {
      runtime.models.push([id, provider, modelId]);
      runtime.order.push('set_model');
    },
    async getSession(id) {
      return { id };
    },
    loginCalls: [],
    loginReplies: [],
    onLoginFrame: null,
    settleLogin: null,
    rejectLogin: null,
    async listLoginProviders() {
      return [{ id: 'anthropic', name: 'Anthropic', available: true, authenticated: false }];
    },
    login(providerId, options) {
      runtime.loginCalls.push(providerId);
      runtime.onLoginFrame = (frame) => options.onFrame(frame, (reply) => runtime.loginReplies.push(reply));
      return new Promise((resolve, reject) => {
        runtime.settleLogin = resolve;
        runtime.rejectLogin = reject;
      });
    },
    emitLoginFrame(frame) {
      runtime.onLoginFrame?.(frame);
    },
    async sendToSession(id, frame) {
      runtime.sent.push([id, frame]);
    },
    async setThinkingLevel(id, level) {
      runtime.thinkingLevels.push([id, level]);
    },
    thinkingLevels: [],
    fastModes: [],
    async setFastMode(id, enabled) {
      runtime.fastModes.push([id, enabled]);
      return { enabled, active: enabled };
    },
    async cycleThinkingLevel() {
      return 'high';
    },
    branchCalls: [],
    forkResult: null,
    async forkSession(input) {
      runtime.branchCalls.push(input);
      return runtime.forkResult ?? { id: 'ses_fork', sessionPath: '/s/fork.json', cwd: '/repo', title: 'fork' };
    },
    async abort(id) {
      runtime.aborted.push(id);
    },
    async dispose() {
      runtime.disposed = true;
    },
    async disposeIdle() {
      return 0;
    },
    async moveSession() {},
    async disposeSessionsInDirectory(directory) {
      runtime.disposedDirectories.push(directory);
      return runtime.disposedSessionIds;
    },
    subscribe(listener) {
      subscriber = listener;
      return () => {
        subscriber = null;
      };
    },
  };
  const adapter = {
    // The constructor returns the shared fake instance.
    OmpRuntime: class {
      constructor() {
        return runtime;
      }
    },
    createOmpHost: () => ({}),
    ompMessageId: (sessionId, role, timestamp) => `omp:${sessionId}:${role}:${timestamp}`,
    projectOmpSession: (record, now) => ({
      id: record.id,
      runtimeId: 'omp',
      nativeSessionId: record.id,
      projectID: '',
      directory: record.cwd,
      title: record.title,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: now, updated: now },
    }),
    projectOmpHistory: (id, messages, options = {}) => ({
      items: messages.map((info) => {
        const messageID = info.role === 'user' ? options.userMessageId?.(info) ?? info.id : info.id;
        return { info: { ...info, id: messageID }, parts: [] };
      }),
      cursor: {},
    }),
    createOmpEventProjector: vi.fn(() => ({
      project: projectImpl ?? ((sessionId, event) => (
        event.type === 'agent_end' ? [{ type: 'session.idle', properties: { sessionID: sessionId } }] : []
      )),
      expectUserMessage: vi.fn(),
      expectCommand: vi.fn(),
    })),
  };
  return { adapter, runtime, sessions };
};

const eventFrames = (frames) => frames.filter((frame) => frame.properties.events[0]?.type !== 'session.created');

describe('createOmpRuntimeHost', () => {
  it('announces a created session before its events', async () => {
    const frames = [];
    const { adapter } = createFakeAdapter();
    const host = createOmpRuntimeHost({ adapter, broadcast: (frame) => frames.push(frame), now: () => 42 });

    await host.createSession({ cwd: '/repo' });

    expect(frames).toEqual([
      {
        type: OMP_FRAME_TYPE,
        properties: {
          sessionID: 'ses_new',
          directory: '/repo',
          events: [{
            type: 'session.created',
            properties: {
              info: {
                id: 'ses_new',
                runtimeId: 'omp',
                nativeSessionId: 'ses_new',
                projectID: '',
                directory: '/repo',
                title: '',
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                time: { created: 42, updated: 42 },
              },
            },
          }],
        },
      },
    ]);
  });

  it('broadcasts projected events with the session id and its directory', async () => {
    const frames = [];
    const { adapter, runtime } = createFakeAdapter();
    const host = createOmpRuntimeHost({ adapter, broadcast: (frame) => frames.push(frame) });

    await host.createSession({ cwd: '/repo' });
    runtime.emit('ses_new', { type: 'agent_end' });

    expect(eventFrames(frames)).toEqual([
      {
        type: OMP_FRAME_TYPE,
        properties: {
          sessionID: 'ses_new',
          directory: '/repo',
          events: [{ type: 'session.idle', properties: { sessionID: 'ses_new' } }],
        },
      },
    ]);
  });

  it('announces a listed session once and omits an empty directory', async () => {
    const frames = [];
    const { adapter, runtime, sessions } = createFakeAdapter();
    sessions.push({ id: 'ses_a', sessionPath: '/s/a.json', cwd: '', title: 'a' });
    const host = createOmpRuntimeHost({ adapter, broadcast: (frame) => frames.push(frame) });

    await host.listSessions();
    await host.listSessions();
    runtime.emit('ses_a', { type: 'agent_end' });

    expect(frames.filter((frame) => frame.properties.events[0].type === 'session.created')).toHaveLength(1);
    expect(eventFrames(frames)[0].properties.directory).toBeUndefined();
  });

  it('projects messages through the adapter', async () => {
    const { adapter, runtime } = createFakeAdapter();
    runtime.messages = [{ role: 'user', content: 'hi', timestamp: 1 }];
    const host = createOmpRuntimeHost({ adapter, broadcast: () => {} });

    expect(await host.getMessages('ses_a')).toEqual({ items: [{ info: { role: 'user', content: 'hi', timestamp: 1 }, parts: [] }], cursor: {} });
  });

  it('declares the client message id before prompting', async () => {
    const frames = [];
    const { adapter, runtime } = createFakeAdapter();
    const host = createOmpRuntimeHost({ adapter, broadcast: (frame) => frames.push(frame) });

    await host.prompt('ses_a', 'hi', 'client-msg-1');

    const projector = adapter.createOmpEventProjector.mock.results[0].value;
    expect(projector.expectUserMessage).toHaveBeenCalledWith('ses_a', 'client-msg-1');
    // A slash command answers on `command_output` with no message of its own, so
    // the projector is told what the prompt carried.
    expect(projector.expectCommand).toHaveBeenCalledWith('ses_a', 'hi');
    expect(runtime.prompted).toEqual([['ses_a', 'hi']]);
  });

  // A picker choice only reaches the turn if the session is switched first:
  // OMP reads the model off the session, never out of a prompt.
  it('switches the session onto the model a prompt declares, once per change', async () => {
    const { adapter, runtime } = createFakeAdapter();
    const host = createOmpRuntimeHost({ adapter, broadcast: () => {} });

    await host.prompt('ses_a', 'one', undefined, undefined, { provider: 'anthropic', modelId: 'claude' });
    expect(runtime.models).toEqual([['ses_a', 'anthropic', 'claude']]);
    expect(runtime.order).toEqual(['set_model', 'prompt']);

    // The pair already applied is left alone; a different one is switched.
    await host.prompt('ses_a', 'two', undefined, undefined, { provider: 'anthropic', modelId: 'claude' });
    await host.prompt('ses_a', 'three', undefined, undefined, { provider: 'openai', modelId: 'gpt' });
    expect(runtime.models).toEqual([['ses_a', 'anthropic', 'claude'], ['ses_a', 'openai', 'gpt']]);
  });

  it('leaves the session model alone when a prompt declares none', async () => {
    const { adapter, runtime } = createFakeAdapter();
    const host = createOmpRuntimeHost({ adapter, broadcast: () => {} });

    await host.prompt('ses_a', 'hi');

    expect(runtime.models).toEqual([]);
    expect(runtime.order).toEqual(['prompt']);
  });

  // The live stream names the user message by the client id; a page that named
  // the timestamp-derived id instead put the same prompt in the store twice.
  it('names a page user message by the client id its prompt declared', async () => {
    const { adapter, runtime } = createFakeAdapter();
    const host = createOmpRuntimeHost({ adapter, broadcast: () => {} });

    await host.prompt('ses_a', 'hi', 'client-msg-1');
    runtime.emit('ses_a', { type: 'message_start', message: { role: 'user', content: 'hi', timestamp: 7 } });
    runtime.messages = [{ role: 'user', content: 'hi', timestamp: 7 }];

    const page = await host.getMessages('ses_a');

    expect(page.items[0].info.id).toBe('client-msg-1');
  });

  it('keeps the timestamp-derived id for a page message no prompt declared', async () => {
    const { adapter, runtime } = createFakeAdapter();
    const host = createOmpRuntimeHost({ adapter, broadcast: () => {} });
    runtime.messages = [{ role: 'user', content: 'older', timestamp: 3, id: 'omp:ses_a:user:3' }];

    const page = await host.getMessages('ses_a');

    expect(page.items[0].info.id).toBe('omp:ses_a:user:3');
  });

  it('passes a prompt\'s images through to the adapter', async () => {
    const { adapter, runtime } = createFakeAdapter();
    const host = createOmpRuntimeHost({ adapter, broadcast: () => {} });
    const images = [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }];

    await host.prompt('ses_a', 'look', undefined, images);
    expect(runtime.promptOptions).toEqual([{ images }]);

    await host.prompt('ses_a', 'plain');
    expect(runtime.promptOptions[1]).toBeUndefined();
  });

  it('reuses one projector per session and drops empty projections', async () => {
    const frames = [];
    const { adapter, runtime } = createFakeAdapter();
    const host = createOmpRuntimeHost({ adapter, broadcast: (frame) => frames.push(frame) });

    runtime.emit('ses_a', { type: 'agent_end' });
    runtime.emit('ses_a', { type: 'turn_start' });
    runtime.emit('ses_b', { type: 'agent_end' });

    expect(adapter.createOmpEventProjector).toHaveBeenCalledTimes(2);
    // `turn_start` projects to nothing and is not broadcast.
    expect(eventFrames(frames).map((frame) => frame.properties.sessionID)).toEqual(['ses_a', 'ses_b']);
  });

  it('survives a projector that throws', async () => {
    const frames = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { adapter, runtime } = createFakeAdapter({
      projectImpl: () => {
        throw new Error('boom');
      },
    });
    const host = createOmpRuntimeHost({ adapter, broadcast: (frame) => frames.push(frame) });

    runtime.emit('ses_a', { type: 'agent_end' });

    expect(frames).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('routes prompt, abort, getSession and dispose to the runtime', async () => {
    const { adapter, runtime } = createFakeAdapter();
    const host = createOmpRuntimeHost({ adapter, broadcast: () => {} });

    expect(await host.prompt('ses_a', 'hi')).toBe(true);
    await host.abort('ses_a');
    await host.getSession('ses_a');
    expect(runtime.prompted).toEqual([['ses_a', 'hi']]);
    expect(runtime.aborted).toEqual(['ses_a']);

    await host.dispose();
    expect(runtime.disposed).toBe(true);
  });

  it('drops a session\'s approvals when its process is disposed for a directory', async () => {
    const { adapter, runtime } = createFakeAdapter();
    runtime.disposedSessionIds = ['ses_new'];
    const host = createOmpRuntimeHost({ adapter, broadcast: () => {} });
    await host.createSession({ cwd: '/repo' });
    runtime.emit('ses_new', { type: 'extension_ui_request', id: 'ui_1', method: 'confirm', title: 't', message: 'm' });
    expect(host.listPermissions('ses_new')).toHaveLength(1);

    await host.disposeSessionsInDirectory('/repo');

    expect(runtime.disposedDirectories).toEqual(['/repo']);
    expect(host.listPermissions('ses_new')).toHaveLength(0);
  });

  it('routes later frames to the new directory after a move', async () => {
    const frames = [];
    const { adapter, runtime } = createFakeAdapter();
    const host = createOmpRuntimeHost({ adapter, broadcast: (frame) => frames.push(frame) });
    await host.createSession({ cwd: '/repo' });

    await host.moveSession('ses_new', '/repo/b');
    runtime.emit('ses_new', { type: 'agent_end' });

    expect(eventFrames(frames).at(-1).properties.directory).toBe('/repo/b');
  });

  it('surfaces an extension ui request as a permission and answers it', async () => {
    const frames = [];
    const { adapter, runtime } = createFakeAdapter();
    const host = createOmpRuntimeHost({ adapter, broadcast: (frame) => frames.push(frame) });
    await host.createSession({ cwd: '/repo' });

    runtime.emit('ses_new', { type: 'extension_ui_request', id: 'ui_1', method: 'confirm', title: 'Run bash?', message: 'rm -rf build' });

    const asked = frames.find((frame) => frame.properties.events[0]?.type === 'permission.asked');
    expect(asked.properties.directory).toBe('/repo');
    expect(asked.properties.events[0].properties).toMatchObject({ id: 'ui_1', sessionID: 'ses_new', resources: ['rm -rf build'] });
    // The frame is a question, not a projected event: the only event-bearing
    // frame is the permission itself.
    const projected = eventFrames(frames);
    expect(projected).toHaveLength(1);
    expect(projected[0].properties.events[0].type).toBe('permission.asked');
    expect(host.listPermissions('ses_new')).toHaveLength(1);

    expect(await host.replyPermission('ses_new', 'ui_1', 'once')).toBe(true);
    expect(runtime.sent).toEqual([['ses_new', { type: 'extension_ui_response', id: 'ui_1', confirmed: true }]]);
    expect(host.listPermissions('ses_new')).toHaveLength(0);
  });

  it('lists the login providers on the runtime', async () => {
    const { adapter } = createFakeAdapter();
    const host = createOmpRuntimeHost({ adapter, broadcast: () => {} });

    expect(await host.listLoginProviders()).toEqual([{ id: 'anthropic', name: 'Anthropic', available: true, authenticated: false }]);
  });

  it('starts a login and returns the browser URL without answering it', async () => {
    const { adapter, runtime } = createFakeAdapter();
    const host = createOmpRuntimeHost({ adapter, broadcast: () => {} });

    const pending = host.login('anthropic');
    runtime.emitLoginFrame({
      type: 'extension_ui_request',
      id: 'ui_1',
      method: 'open_url',
      url: 'https://auth.example/start',
      launchUrl: 'http://127.0.0.1:1234/launch',
      instructions: 'Finish in the browser',
    });

    expect(await pending).toEqual({
      providerId: 'anthropic',
      loginId: 'omp-login-1',
      url: 'https://auth.example/start',
      launchUrl: 'http://127.0.0.1:1234/launch',
      instructions: 'Finish in the browser',
    });
    // `open_url` is not a question: nothing is written back to OMP.
    expect(runtime.loginReplies).toEqual([]);
    runtime.settleLogin({ providerId: 'anthropic' });
  });

  it('returns a completed login without a URL', async () => {
    const { adapter, runtime } = createFakeAdapter();
    const host = createOmpRuntimeHost({ adapter, broadcast: () => {} });

    const pending = host.login('anthropic');
    runtime.settleLogin({ providerId: 'anthropic' });

    expect(await pending).toEqual({ providerId: 'anthropic' });
  });

  it('surfaces a refused login', async () => {
    const { adapter, runtime } = createFakeAdapter();
    const host = createOmpRuntimeHost({ adapter, broadcast: () => {} });

    const pending = host.login('nope');
    runtime.rejectLogin(new Error('Unknown OAuth provider: nope'));

    await expect(pending).rejects.toThrow('Unknown OAuth provider: nope');
  });

  it('maps a login input prompt to a permission and answers it on the login process', async () => {
    const frames = [];
    const { adapter, runtime } = createFakeAdapter();
    const host = createOmpRuntimeHost({ adapter, broadcast: (frame) => frames.push(frame) });

    const pending = host.login('anthropic');
    runtime.emitLoginFrame({ type: 'extension_ui_request', id: 'ui_1', method: 'open_url', url: 'https://auth.example/start' });
    const started = await pending;
    expect(started.loginId).toBe('omp-login-1');

    runtime.emitLoginFrame({ type: 'extension_ui_request', id: 'ui_2', method: 'input', title: 'Paste the authorization code' });
    const asked = frames.find((frame) => frame.properties.events[0]?.type === 'permission.asked');
    expect(asked.properties.sessionID).toBe('omp-login-1');
    expect(asked.properties.events[0].properties).toMatchObject({ id: 'ui_2', sessionID: 'omp-login-1', action: 'input' });

    expect(await host.replyPermission('omp-login-1', 'ui_2', 'once', 'the-code')).toBe(true);
    expect(runtime.loginReplies).toEqual([{ type: 'extension_ui_response', id: 'ui_2', value: 'the-code' }]);
    // The ask is settled, not tied to a session process.
    expect(runtime.sent).toEqual([]);

    runtime.settleLogin({ providerId: 'anthropic' });
  });

  it('surfaces an ask as a form and answers it over the session process', async () => {
    const frames = [];
    const { adapter, runtime } = createFakeAdapter();
    const host = createOmpRuntimeHost({ adapter, broadcast: (frame) => frames.push(frame) });
    await host.createSession({ cwd: '/repo' });

    runtime.emit('ses_new', { type: 'extension_ui_request', id: 'r1', method: 'select', title: 'Which one?', options: ['a'] });

    const created = frames.find((frame) => frame.properties.events[0]?.type === 'form.created');
    expect(created.properties.directory).toBe('/repo');
    expect(created.properties.events[0].properties.form).toMatchObject({ id: 'r1', sessionID: 'ses_new', title: 'Which one?' });
    expect(host.listForms('ses_new')).toHaveLength(1);
    expect(host.listPermissions('ses_new')).toEqual([]);

    expect(await host.replyForm('ses_new', 'r1', 'a')).toBe(true);
    expect(runtime.sent).toEqual([['ses_new', { type: 'extension_ui_response', id: 'r1', value: 'a' }]]);
    expect(host.listForms('ses_new')).toEqual([]);
  });

  it('cancels a form and refuses to answer it through the permission route', async () => {
    const { adapter, runtime } = createFakeAdapter();
    const host = createOmpRuntimeHost({ adapter, broadcast: () => {} });

    runtime.emit('ses_a', { type: 'extension_ui_request', id: 'r1', method: 'editor', title: 'Why?' });
    expect(await host.replyPermission('ses_a', 'r1', 'once', 'text')).toBe(false);
    expect(host.listForms('ses_a')).toHaveLength(1);

    expect(await host.cancelForm('ses_a', 'r1')).toBe(true);
    expect(runtime.sent).toEqual([['ses_a', { type: 'extension_ui_response', id: 'r1', cancelled: true }]]);
  });

  it('routes the thinking level, its cycle and fast mode to the runtime', async () => {
    const { adapter, runtime } = createFakeAdapter();
    const host = createOmpRuntimeHost({ adapter, broadcast: () => {} });

    expect(await host.setThinkingLevel('ses_a', 'high')).toBe('high');
    expect(await host.cycleThinkingLevel('ses_a')).toBe('high');
    expect(await host.setFastMode('ses_a', false)).toEqual({ enabled: false, active: false });
    expect(runtime.thinkingLevels).toEqual([['ses_a', 'high']]);
    expect(runtime.fastModes).toEqual([['ses_a', false]]);
  });

  it('announces the session a branch creates', async () => {
    const frames = [];
    const { adapter, runtime } = createFakeAdapter();
    const host = createOmpRuntimeHost({ adapter, broadcast: (frame) => frames.push(frame) });
    await host.createSession({ cwd: '/repo' });
    frames.length = 0;

    const forked = await host.branchSession('ses_new', 'e7');

    expect(runtime.branchCalls).toEqual([{ id: 'ses_new', entryId: 'e7', directory: '/repo' }]);
    expect(forked).toEqual({ id: 'ses_fork', sessionPath: '/s/fork.json', cwd: '/repo', title: 'fork' });
    expect(frames[0].properties.sessionID).toBe('ses_fork');
    expect(frames[0].properties.events[0].type).toBe('session.created');
    expect(frames[0].properties.events[0].properties.info.directory).toBe('/repo');
  });

  it('translates a client-minted cut into the projected id its message landed with', async () => {
    const { adapter, runtime } = createFakeAdapter();
    const host = createOmpRuntimeHost({ adapter, broadcast: () => {} });
    await host.createSession({ cwd: '/repo' });

    // The prompt declares the client's id; the user message then lands with the
    // OMP timestamp the projected id is built from.
    await host.prompt('ses_new', 'hello', 'msg_client_1');
    runtime.emit('ses_new', { type: 'message_start', message: { role: 'user', timestamp: 1234 } });

    await host.branchSession('ses_new', 'msg_client_1');
    expect(runtime.branchCalls.at(-1)).toEqual({ id: 'ses_new', entryId: 'omp:ses_new:user:1234', directory: '/repo' });

    // A projected id and a real entry id are handed to the adapter unchanged.
    await host.branchSession('ses_new', 'omp:ses_new:user:999');
    expect(runtime.branchCalls.at(-1)).toEqual({ id: 'ses_new', entryId: 'omp:ses_new:user:999', directory: '/repo' });
    await host.branchSession('ses_new', 'e7');
    expect(runtime.branchCalls.at(-1)).toEqual({ id: 'ses_new', entryId: 'e7', directory: '/repo' });
  });
});