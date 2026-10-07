import { describe, expect, it, vi } from 'vitest';

import { OMP_FRAME_TYPE, createOmpRuntimeHost } from './omp-runtime-host.js';

const createFakeAdapter = ({ projectImpl } = {}) => {
  const sessions = [];
  let subscriber = null;
  const runtime = {
    prompted: [],
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
    async prompt(id, text) {
      runtime.prompted.push([id, text]);
      return true;
    },
    async getSession(id) {
      return { id };
    },
    async sendToSession(id, frame) {
      runtime.sent.push([id, frame]);
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
    projectOmpHistory: (id, messages) => ({ items: messages.map((info) => ({ info, parts: [] })), cursor: {} }),
    createOmpEventProjector: vi.fn(() => ({
      project: projectImpl ?? ((sessionId, event) => (
        event.type === 'agent_end' ? [{ type: 'session.idle', properties: { sessionID: sessionId } }] : []
      )),
      expectUserMessage: vi.fn(),
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
    expect(runtime.prompted).toEqual([['ses_a', 'hi']]);
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
});