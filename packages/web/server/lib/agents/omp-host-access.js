/**
 * The OMP runtime host, reachable from the OpenChamber server features.
 *
 * The server features that used `@opencode/client` are wired once from
 * `server/index.js` and read the host per call, so a feature module needs no
 * dependency threading through the shared route runtime. An uninstalled host
 * reads as "unavailable" instead of throwing, and every reader below answers
 * `null`/empty rather than pretending to have data.
 *
 * The session and message shapes are the canonical domain model the UI already
 * consumes (`Message`/`Part`), not OpenCode's wire shapes: OMP has no OpenCode
 * message shape, and the canonical one is the vocabulary both sides share.
 */

import { listSubagentTranscripts, readSubagentMessages } from './subagent-transcripts.js';

let hostProvider = null;

/**
 * Wires the module to the OMP runtime host. Pass `null` to detach. The provider
 * is read per call because the host is installed after the feature routes
 * register and is disposed on shutdown.
 */
export const configureOmpRuntimeHost = (provider) => {
  hostProvider = typeof provider === 'function' ? provider : null;
};

/** The host, or `null` while the runtime is not mounted. */
export const getOmpRuntimeHost = async () => {
  if (!hostProvider) return null;
  try {
    return await Promise.resolve(hostProvider());
  } catch {
    return null;
  }
};

/**
 * A session's canonical message page (`{ items: [{ info, parts }], cursor }`),
 * or `null` when the runtime is unavailable. A failure propagates: the caller
 * must not read "could not read" as "no messages".
 */
export const readSessionMessages = async (sessionId) => {
  const host = await getOmpRuntimeHost();
  if (!host) return null;
  return host.getMessages(sessionId);
};

/** Every known session (`OmpSessionInfo[]`), or `null` when the runtime is unavailable. */
export const readSessions = async () => {
  const host = await getOmpRuntimeHost();
  if (!host) return null;
  return host.listSessions();
};

/** One session's busy state, or `null` when the runtime is unavailable. */
export const readSessionStatus = async (sessionId) => {
  const host = await getOmpRuntimeHost();
  if (!host) return null;
  return host.getSessionStatus(sessionId);
};

/** Sends a prompt and answers whether the agent took it; `null` when unavailable. */
export const promptSession = async (sessionId, text, messageId, images) => {
  const host = await getOmpRuntimeHost();
  if (!host) return null;
  return host.prompt(sessionId, text, messageId, images);
};

/**
 * A session file path by id, from the runtime's own session index: the sessions
 * root's layout is an OMP implementation detail, so the path is never
 * constructed from an id.
 */
const sessionFilePath = async (host, sessionId) => {
  const sessions = await host.listSessions();
  const session = (Array.isArray(sessions) ? sessions : []).find((entry) => entry?.id === sessionId);
  if (!session?.sessionPath) throw new Error(`unknown omp session: ${sessionId}`);
  return session.sessionPath;
};

/**
 * The sub-agent transcripts a session spawned (`listSubagentTranscripts`'s
 * shape), or `null` when the runtime is unavailable. An id the runtime does not
 * know rejects with the message every other session read uses, so a route can
 * answer 404 without inventing one.
 */
export const readSessionChildren = async (sessionId) => {
  const host = await getOmpRuntimeHost();
  if (!host) return null;
  return listSubagentTranscripts({ sessionPath: await sessionFilePath(host, sessionId) });
};

/**
 * One sub-agent's transcript page (`{ items, cursor }`, the shape the session's
 * own messages route answers with), or `null` when the runtime is unavailable or
 * the session has no sub-agent under that id.
 */
export const readChildMessages = async (sessionId, childId) => {
  const host = await getOmpRuntimeHost();
  if (!host) return null;
  const sessionPath = await sessionFilePath(host, sessionId);
  return readSubagentMessages({ sessionPath, childId });
};

/**
 * Switches a session's model; `null` when the runtime is unavailable.
 */
export const setSessionModel = async (sessionId, provider, modelId) => {
  const host = await getOmpRuntimeHost();
  if (!host) return null;
  await host.setModel(sessionId, provider, modelId);
  return true;
};

/** The session's pending tool approvals (`PermissionRequest[]`), or `null` when unavailable. */
export const listPermissions = async (sessionId) => {
  const host = await getOmpRuntimeHost();
  if (!host) return null;
  return host.listPermissions(sessionId);
};

/**
 * Answers one tool approval and answers whether it was known; `null` when the
 * runtime is unavailable.
 */
export const replyPermission = async (sessionId, requestId, reply, value) => {
  const host = await getOmpRuntimeHost();
  if (!host) return null;
  return host.replyPermission(sessionId, requestId, reply, value);
};
