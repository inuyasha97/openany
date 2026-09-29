/**
 * Server-side OMP runtime host.
 *
 * Wires the fork-owned `@openchamber/omp-adapter` runtime to the shared
 * control stream: every OMP session event is projected into canonical
 * `SyncEvent`s by a per-session projector and broadcast as one
 * `openchamber:omp` frame. The adapter is injected so this file never imports
 * the OMP SDK and stays unit-testable with a fake.
 *
 * The frame carries the already-projected events: the UI translates nothing
 * OMP-specific, it routes each event like any other. The directory is the
 * session cwd when known, so the client can scope the events to a project
 * instead of the global queue. A newly seen session is also announced once as
 * `session.created`, because the UI store cannot hold messages for a session
 * it does not know.
 */

export const OMP_FRAME_TYPE = 'openchamber:omp';

/**
 * @param {object} options
 * @param {object} options.adapter the `@openchamber/omp-adapter` module
 * @param {{ (payload: { type: string, properties: unknown }): void }} options.broadcast
 * @param {() => number} [options.now]
 */
export function createOmpRuntimeHost({ adapter, broadcast, now }) {
  const clock = now ?? Date.now;
  const runtime = new adapter.OmpRuntime(adapter.createOmpHost());
  const projectors = new Map();
  const directories = new Map();
  const announced = new Set();

  const rememberDirectory = (sessionId, directory) => {
    if (directory) {
      directories.set(sessionId, directory);
    }
  };

  const projectorFor = (sessionId) => {
    let projector = projectors.get(sessionId);
    if (!projector) {
      projector = adapter.createOmpEventProjector(now ? { now } : undefined);
      projectors.set(sessionId, projector);
    }
    return projector;
  };

  const emit = (sessionId, events) => {
    if (!Array.isArray(events) || events.length === 0) return;
    const directory = directories.get(sessionId);
    const properties = { sessionID: sessionId, events };
    if (directory) properties.directory = directory;
    broadcast({ type: OMP_FRAME_TYPE, properties });
  };

  /** Announces a session once, so the UI store materializes it before its messages. */
  const announceSession = (record) => {
    if (announced.has(record.id)) return;
    announced.add(record.id);
    rememberDirectory(record.id, record.cwd);
    emit(record.id, [{ type: 'session.created', properties: { info: adapter.projectOmpSession(record, clock()) } }]);
  };

  const unsubscribe = runtime.subscribe((sessionId, event) => {
    let events;
    try {
      events = projectorFor(sessionId).project(sessionId, event);
    } catch (error) {
      console.warn('[omp] event projection failed:', error instanceof Error ? error.message : error);
      return;
    }
    emit(sessionId, events);
  });

  return {
    async listSessions() {
      const sessions = await runtime.listSessions();
      for (const session of sessions) announceSession(session);
      return sessions;
    },

    async createSession(input = {}) {
      const handle = await runtime.createSession(input);
      announceSession({ id: handle.id, cwd: input.cwd ?? '', title: '' });
      return handle;
    },

    getSession: (id) => runtime.getSession(id),

    async getMessages(id) {
      return adapter.projectOmpHistory(id, await runtime.getMessages(id));
    },

    prompt(id, text, messageID) {
      if (messageID) {
        projectorFor(id).expectUserMessage(id, messageID);
      }
      return runtime.prompt(id, text);
    },

    abort: (id) => runtime.abort(id),

    async dispose() {
      unsubscribe();
      projectors.clear();
      directories.clear();
      announced.clear();
      await runtime.dispose();
    },
  };
}
