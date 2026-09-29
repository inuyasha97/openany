import { describe, expect, it, vi } from 'vitest';

import { ACP_FRAME_TYPE, createAcpRuntimeHost } from './acp-runtime-host.js';

const createFakeAdapter = ({ projectImpl } = {}) => {
  const sessions = [];
  let subscriber = null;
  const runtime = {
    replies: [],
    disposed: false,
    emit(sessionId, event) {
      subscriber?.(sessionId, event);
    },
    async listSessions() {
      return sessions;
    },
    async createSession(input) {
      return { id: 'ses_new', cwd: input.cwd };
    },
    async prompt() {
      return true;
    },
    async cancel() {},
    async replyPermission(id, reply) {
      runtime.replies.push([id, reply]);
      return true;
    },
    async getSession(id) {
      return { id };
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
    AcpRuntime: class {
      constructor() {
        return runtime;
      }
    },
    createAcpHost: () => ({}),
    projectAcpSession: (record, now) => ({
      id: record.id,
      runtimeId: 'acp',
      nativeSessionId: record.id,
      projectID: '',
      directory: record.cwd,
      title: record.title ?? '',
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: now, updated: now },
    }),
    createAcpEventProjector: vi.fn(() => ({
      project: projectImpl ?? ((sessionId, event) => (
        event.type === 'turn_ended' ? [{ type: 'session.idle', properties: { sessionID: sessionId } }] : []
      )),
    })),
  };
  return { adapter, runtime, sessions };
};

const createHost = (overrides) => {
  const { adapter, runtime, sessions } = createFakeAdapter(overrides);
  const frames = [];
  const host = createAcpRuntimeHost({
    adapter,
    broadcast: (frame) => frames.push(frame),
    createTransport: () => ({}),
    now: () => 42,
  });
  return { host, adapter, runtime, sessions, frames };
};

const eventFrames = (frames) => frames.filter((frame) => frame.properties.events[0]?.type !== 'session.created');

describe('createAcpRuntimeHost', () => {
  it('announces a created session before its events', () => {
    const { host, frames } = createHost();
    return host.createSession({ cwd: '/repo' }).then(() => {
      expect(frames[0].type).toBe(ACP_FRAME_TYPE);
      expect(frames[0].properties.events[0].type).toBe('session.created');
      expect(frames[0].properties.events[0].properties.info.runtimeId).toBe('acp');
      expect(frames[0].properties.directory).toBe('/repo');
    });
  });

  it('broadcasts projected events with the session directory', async () => {
    const { host, runtime, frames } = createHost();
    await host.createSession({ cwd: '/repo' });
    runtime.emit('ses_new', { type: 'turn_ended' });
    expect(eventFrames(frames)).toEqual([
      { type: ACP_FRAME_TYPE, properties: { sessionID: 'ses_new', directory: '/repo', events: [{ type: 'session.idle', properties: { sessionID: 'ses_new' } }] } },
    ]);
  });

  it('maps a permission reply onto the offered ACP option', async () => {
    const { host, runtime } = createHost();
    await host.createSession({ cwd: '/repo' });
    runtime.emit('ses_new', { type: 'permission_request', requestId: 'req_1', options: [{ optionId: 'opt-a', kind: 'allow_always' }, { optionId: 'opt-r', kind: 'reject_once' }] });
    expect(await host.replyPermission('ses_new', 'req_1', 'always')).toBe(true);
    expect(runtime.replies).toEqual([['ses_new', { requestId: 'req_1', optionId: 'opt-a' }]]);
    // The reply consumed the request; a second one falls back to cancelled.
    await host.replyPermission('ses_new', 'req_1', 'reject');
    expect(runtime.replies[1]).toEqual(['ses_new', { requestId: 'req_1', optionId: 'cancelled' }]);
  });

  it('disposes the runtime', async () => {
    const { host, runtime } = createHost();
    await host.dispose();
    expect(runtime.disposed).toBe(true);
  });
});
