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
    async abort(id) {
      runtime.aborted.push(id);
    },
    async dispose() {
      runtime.disposed = true;
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
});