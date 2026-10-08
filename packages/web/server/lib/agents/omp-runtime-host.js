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

import { createOmpApprovals } from './omp-approvals.js';
import { createOmpConfig } from './omp-config.js';

export const OMP_FRAME_TYPE = 'openchamber:omp';

/** A session process idle this long is disposed; the next use re-opens it. */
const IDLE_DISPOSE_MS = 30 * 60_000;
const IDLE_SWEEP_MS = 60_000;

/**
 * @param {object} options
 * @param {object} options.adapter the `@openchamber/omp-adapter` module
 * @param {{ (payload: { type: string, properties: unknown }): void }} options.broadcast
 * @param {() => number} [options.now]
 */
export function createOmpRuntimeHost({ adapter, broadcast, now }) {
  const clock = now ?? Date.now;
  const runtime = new adapter.OmpRuntime(adapter.createOmpHost());
  const config = createOmpConfig();
  const projectors = new Map();
  const directories = new Map();
  const announced = new Set();
  // A fork cut is a canonical `Message.id`. A projected message carries a
  // timestamp-derived id the adapter can resolve, but an optimistic message
  // keeps the client's own id — so the id a prompt declared and the OMP
  // timestamp it landed with are remembered to translate one into the other.
  const pendingCutIds = new Map();
  const cutTimestamps = new Map();
  // A login runs on its own short-lived process and outlives the request that
  // started it, so its reply sink is kept under a synthetic id the permission
  // route can address.
  const logins = new Map();
  let loginSeq = 0;

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

  // Approvals ride the same control stream as projected events, and the UI
  // routes a frame by its directory, so a permission frame carries the same
  // directory the session's events do.
  const approvals = createOmpApprovals({
    broadcast: (frame) => {
      const sessionId = frame.properties?.sessionID;
      const directory = sessionId ? directories.get(sessionId) : undefined;
      broadcast(directory ? { ...frame, properties: { ...frame.properties, directory } } : frame);
    },
  });

  /** Announces a session once, so the UI store materializes it before its messages. */
  const announceSession = (record) => {
    if (announced.has(record.id)) return;
    announced.add(record.id);
    rememberDirectory(record.id, record.cwd);
    emit(record.id, [{ type: 'session.created', properties: { info: adapter.projectOmpSession(record, clock()) } }]);
  };

  /** Drops every per-session map entry once the session's process is gone. */
  const forgetSession = (id) => {
    projectors.delete(id);
    directories.delete(id);
    announced.delete(id);
    pendingCutIds.delete(id);
    cutTimestamps.delete(id);
    approvals.forget(id);
  };

  // One `omp` process per open session, so sweep the idle ones: without this
  // the pool grows with every session the user opens. A swept session re-opens
  // on its next use, and its per-session state goes with its process.
  const idleSweep = setInterval(() => {
    void runtime
      .disposeIdle(IDLE_DISPOSE_MS)
      .then((disposed) => {
        for (const id of disposed) forgetSession(id);
      })
      .catch(() => {});
  }, IDLE_SWEEP_MS);
  idleSweep.unref?.();

  const unsubscribe = runtime.subscribe((sessionId, event) => {
    if (event.type === 'extension_ui_request') {
      try {
        approvals.handleRequest(sessionId, event);
      } catch (error) {
        console.warn('[omp] approval mapping failed:', error instanceof Error ? error.message : error);
      }
      return;
    }
    if (event.type === 'message_start' && event.message?.role === 'user') {
      // The user message the last prompt declared has landed; remember the
      // timestamp its projected id is built from so a fork cut naming the
      // client's own id can still be resolved.
      const clientId = pendingCutIds.get(sessionId);
      if (clientId !== undefined) {
        pendingCutIds.delete(sessionId);
        let timestamps = cutTimestamps.get(sessionId);
        if (!timestamps) {
          timestamps = new Map();
          cutTimestamps.set(sessionId, timestamps);
        }
        timestamps.set(clientId, event.message.timestamp);
      }
    }
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

    /**
     * Forks the session at the caller's cut. The cut is a canonical
     * `Message.id`; a projected id is resolved by the adapter, and one that is
     * still the client's own (an optimistic user message) is first rewritten to
     * the projected id its OMP timestamp produces. OMP branches inside the live
     * process and re-keys the session, so the returned descriptor is the only
     * description of the fork the runtime gives back; a cut that names no
     * branchable user entry rejects with a message naming it and leaves the
     * original session untouched.
     */
    async branchSession(id, entryId) {
      const timestamps = cutTimestamps.get(id);
      const timestamp = timestamps?.get(entryId);
      const cut = timestamp === undefined ? entryId : adapter.ompMessageId(id, 'user', timestamp);
      const forked = await runtime.forkSession({ id, entryId: cut, directory: directories.get(id) });
      const info = {
        id: forked.id,
        sessionPath: forked.sessionPath ?? '',
        cwd: forked.cwd ?? directories.get(id) ?? '',
        title: forked.title ?? '',
      };
      announceSession(info);
      return info;
    },

    getSession: (id) => runtime.getSession(id),

    async getMessages(id) {
      return adapter.projectOmpHistory(id, await runtime.getMessages(id));
    },

    prompt(id, text, messageID, images) {
      if (messageID) {
        projectorFor(id).expectUserMessage(id, messageID);
        pendingCutIds.set(id, messageID);
      }
      return runtime.prompt(id, text, images ? { images } : undefined);
    },

    abort: (id) => runtime.abort(id),

    renameSession: (id, title) => runtime.renameSession(id, title),

    async deleteSession(id) {
      const deleted = await runtime.deleteSession(id);
      if (deleted) forgetSession(id);
      return deleted;
    },

    listPermissions: (id) => approvals.pending(id),

    listForms: (id) => approvals.forms(id),

    async replyForm(id, requestId, value) {
      const frame = approvals.resolveForm(id, requestId, value);
      if (!frame) return false;
      await runtime.sendToSession(id, frame);
      return true;
    },

    async cancelForm(id, requestId) {
      const frame = approvals.cancelForm(id, requestId);
      if (!frame) return false;
      await runtime.sendToSession(id, frame);
      return true;
    },

    async replyPermission(id, requestId, reply, value) {
      const envelope = approvals.resolve(id, requestId, reply, value);
      if (!envelope) return false;
      // A login's `input` prompt is answered on its own process, not a session's.
      const login = logins.get(id);
      if (login) {
        login.reply(envelope);
        return true;
      }
      await runtime.sendToSession(id, envelope);
      return true;
    },

    async moveSession(id, toDirectory) {
      await runtime.moveSession(id, toDirectory);
      // Frames are routed by this directory, so the move has to follow.
      rememberDirectory(id, toDirectory);
    },

    setModel: (id, provider, modelId) => runtime.setModel(id, provider, modelId),

    /**
     * Sets the session's thinking level. OMP validates the enum and answers
     * without the level it applied, so the caller echoes the accepted level
     * unless the runtime reports one back.
     */
    async setThinkingLevel(id, level) {
      const applied = await runtime.setThinkingLevel(id, level);
      return typeof applied === 'string' ? applied : level;
    },

    cycleThinkingLevel: (id) => runtime.cycleThinkingLevel(id),

    async setFastMode(id, enabled) {
      const result = await runtime.setFastMode(id, enabled);
      if (result && typeof result === 'object') {
        return { enabled: result.enabled === true, active: result.active === true };
      }
      return { enabled, active: enabled };
    },

    getSessionStatus: (id) => runtime.getSessionStatus(id),

    /**
     * The model catalog the picker reads. The adapter normalizes each OMP
     * `Model` with top-level `reasoning`, `efforts` (empty when the model has
     * no thinking config, so the picker hides the effort control) and
     * `defaultLevel`, so the host forwards it unchanged.
     */
    listModels: () => runtime.listModels(),

    listCommands: () => runtime.listCommands(),

    listLoginProviders: () => runtime.listLoginProviders(),

    /**
     * Starts a provider login. OMP answers as soon as it has something for the
     * user (the browser URL) or the flow ends; the login keeps running
     * afterwards, so the `loginId` in the result addresses its later `input`
     * prompt through the ordinary permission reply route.
     */
    async login(providerId) {
      const loginId = `omp-login-${++loginSeq}`;
      let reply = () => {};
      let ask = null;
      const { promise: asked, resolve: settleAsk } = Promise.withResolvers();
      const running = runtime.login(providerId, {
        onFrame: (frame, send) => {
          reply = send;
          // `open_url` is not a question: OMP reads no answer for it, so it is
          // handed back to the caller and never recorded as a pending ask.
          if (frame?.type === 'extension_ui_request' && frame.method === 'open_url') {
            if (!ask) {
              ask = { url: frame.url, launchUrl: frame.launchUrl, instructions: frame.instructions };
              settleAsk();
            }
            return;
          }
          approvals.handleRequest(loginId, frame);
        },
      });
      logins.set(loginId, { reply: (frame) => reply(frame) });
      // The login outlives this call, so its rejection must not go unhandled
      // and its process must stop being addressable once it settles.
      running
        .catch(() => {})
        .finally(() => {
          logins.delete(loginId);
          approvals.forget(loginId);
        });
      const outcome = await Promise.race([
        asked.then(() => ({ ask })),
        running.then(() => ({ done: true }), (error) => ({ error })),
      ]);
      if (outcome.error) throw outcome.error;
      if (outcome.done) return { providerId };
      return { providerId, loginId, ...outcome.ask };
    },

    listMcpServers: (directory) => config.listMcp(directory),

    setMcpEnabled: (name, enabled) => config.setMcpEnabled(name, enabled),

    removeMcpServer: (name, scope, directory) => config.removeMcp(name, scope, directory),

    addMcpServer: (definition, scope, directory) => config.addMcp(definition, scope, directory),

    /**
     * Releases every session process started in `directory` and forgets its
     * per-session state. The worktree-removal path calls this so the folder is
     * not locked while it is deleted.
     */
    async disposeSessionsInDirectory(directory) {
      const disposed = await runtime.disposeSessionsInDirectory(directory);
      for (const id of disposed) forgetSession(id);
      return disposed.length;
    },

    async dispose() {
      clearInterval(idleSweep);
      unsubscribe();
      projectors.clear();
      directories.clear();
      announced.clear();
      logins.clear();
      await runtime.dispose();
    },
  };
}
