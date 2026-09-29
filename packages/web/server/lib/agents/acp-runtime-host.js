/**
 * Server-side ACP runtime host.
 *
 * Mirrors `omp-runtime-host.js`: one `AcpRuntime` over the ACP client, a
 * projector per session, and one `openchamber:acp` frame per projected batch on
 * the shared control stream. ACP adds a permission round-trip: the agent asks
 * the client to approve a tool call, the frame carries `permission.asked`, and
 * the user's reply (once/always/reject) is mapped back to the ACP option the
 * agent offered.
 */

export const ACP_FRAME_TYPE = 'openchamber:acp';

/**
 * @param {object} options
 * @param {object} options.adapter the `@openchamber/acp-adapter` module
 * @param {{ (payload: { type: string, properties: unknown }): void }} options.broadcast
 * @param {(input: { cwd?: string }) => object} options.createTransport one agent process per session
 * @param {() => number} [options.now]
 */
export function createAcpRuntimeHost({ adapter, broadcast, createTransport, now }) {
  const clock = now ?? Date.now;
  const runtime = new adapter.AcpRuntime(adapter.createAcpHost({ createTransport }));
  const projectors = new Map();
  const directories = new Map();
  const announced = new Set();
  /** requestId -> the options the agent offered, for mapping a reply back. */
  const permissionOptions = new Map();

  const rememberDirectory = (sessionId, directory) => {
    if (directory) directories.set(sessionId, directory);
  };

  const projectorFor = (sessionId) => {
    let projector = projectors.get(sessionId);
    if (!projector) {
      projector = adapter.createAcpEventProjector(now ? { now } : undefined);
      projectors.set(sessionId, projector);
    }
    return projector;
  };

  const emit = (sessionId, events) => {
    if (!Array.isArray(events) || events.length === 0) return;
    const directory = directories.get(sessionId);
    const properties = { sessionID: sessionId, events };
    if (directory) properties.directory = directory;
    broadcast({ type: ACP_FRAME_TYPE, properties });
  };

  const announceSession = (record) => {
    if (announced.has(record.id)) return;
    announced.add(record.id);
    rememberDirectory(record.id, record.cwd);
    emit(record.id, [{ type: 'session.created', properties: { info: adapter.projectAcpSession(record, clock()) } }]);
  };

  const unsubscribe = runtime.subscribe((sessionId, event) => {
    if (event.type === 'permission_request') permissionOptions.set(event.requestId, event.options ?? []);
    let events;
    try {
      events = projectorFor(sessionId).project(sessionId, event);
    } catch (error) {
      console.warn('[acp] event projection failed:', error instanceof Error ? error.message : error);
      return;
    }
    emit(sessionId, events);
  });

  const optionIdForReply = (options, reply) => {
    const wanted = reply === 'always' ? 'allow_always' : reply === 'reject' ? 'reject_once' : 'allow_once';
    const match = options.find((option) => option.kind === wanted);
    return match ? match.optionId : 'cancelled';
  };

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
    prompt: (id, text) => runtime.prompt(id, text),
    abort: (id) => runtime.cancel(id),

    async replyPermission(id, requestId, reply) {
      const options = permissionOptions.get(requestId) ?? [];
      permissionOptions.delete(requestId);
      return runtime.replyPermission(id, { requestId, optionId: optionIdForReply(options, reply) });
    },

    async dispose() {
      unsubscribe();
      projectors.clear();
      directories.clear();
      announced.clear();
      permissionOptions.clear();
      await runtime.dispose();
    },
  };
}
