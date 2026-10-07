import { readSessionMessages, readSessions } from '../agents/omp-host-access.js';
import { unsupportedOnOmp } from '../openchamber/omp-unsupported.js';

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const readContextState = (session) => {
  const metadata = isRecord(session?.metadata) ? session.metadata : {};
  const openchamber = isRecord(metadata.openchamber) ? metadata.openchamber : {};
  const messages = Array.isArray(openchamber.context_obligatory_messages)
    ? openchamber.context_obligatory_messages.filter((item) =>
      isRecord(item)
      && typeof item.id === 'string'
      && typeof item.createdAt === 'number'
      && (item.role === 'user' || item.role === 'assistant'))
    : [];
  return { metadata, openchamber, messages };
};

/**
 * Re-injects the messages the user pinned as obligatory after a compaction.
 *
 * Both the pinned list and the cursor live in OpenChamber's own session
 * metadata store. `readSessionMetadata` reads it and `persistContextCursor`
 * would record how far we got; without both seams the runtime stays inert.
 */
export const createContextObligatoryRuntime = ({
  sessionKnowledgeRuntime = null,
  persistContextCursor = null,
  readSessionMetadata = null,
}) => {
  const inflight = new Set();
  let stopped = false;

  const tick = async (sessionId, directory) => {
    // OMP lists only top-level sessions, so this is an existence and
    // availability check: an unknown session or an unavailable runtime ends
    // the tick. There is no parent to skip — a subagent transcript is not a
    // session in the runtime's own index.
    const sessions = await readSessions().catch(() => null);
    if (!Array.isArray(sessions) || !sessions.some((entry) => entry?.id === sessionId)) return;
    // Pins and the cursor are OpenChamber's, not the runtime's.
    const stored = { metadata: await readSessionMetadata(sessionId) };
    const state = readContextState(stored);

    /**
     * Project knowledge rides along with the pinned messages. Compaction takes
     * both away, and both are restored for the same reason, so they travel as
     * one message: two synthetic turns back to back would read as the agent
     * being interrupted twice.
     */
    const knowledge = sessionKnowledgeRuntime
      ? await sessionKnowledgeRuntime
        .resolvePending(
          directory,
          // Compaction removed the previously delivered block, so its stored
          // signature is no longer evidence that the session still carries it.
          '',
          sessionKnowledgeRuntime.readPins(stored),
        )
        .catch(() => ({ text: '', signature: '' }))
      : { text: '', signature: '' };

    if (state.messages.length === 0 && !knowledge.text) return;

    const page = await readSessionMessages(sessionId).catch(() => null);
    const items = Array.isArray(page?.items) ? page.items : [];
    if (items.length === 0) return;
    // A compaction is its own role on the canonical page, with `status` saying
    // it finished.
    const summary = items.find((item) => item?.info?.role === 'compaction' && item.info.status === 'completed');
    if (!summary?.info?.id) return;
    if (state.openchamber.context_obligatory_last_compaction_message_id === summary.info.id) return;

    const fetched = await Promise.allSettled(state.messages.map(async (pinned) => {
      const item = items.find((entry) => entry?.info?.id === pinned.id);
      const text = (Array.isArray(item?.parts) ? item.parts : [])
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text.trim())
        .filter(Boolean)
        .join('\n\n');
      return { pinned, text };
    }));
    const entries = fetched
      .filter((result) => result.status === 'fulfilled' && result.value.text)
      .map((result) => result.value)
      .sort((left, right) => left.pinned.createdAt - right.pinned.createdAt);
    if (entries.length === 0 && !knowledge.text) return;

    // OpenCode injected the restored context as a synthetic message — neither
    // a user turn nor an assistant one — and recorded the compaction cursor
    // behind it. OMP has no synthetic surface and its prompt carries a single
    // authored text, so the context cannot be restored without starting a turn
    // and reclassifying it as the user's own message: fail visibly instead, and
    // leave the cursor unadvanced so an equivalent re-injects rather than skips
    // it.
    throw unsupportedOnOmp('restoring pinned context as a synthetic message');
  };

  let parkedNoticeLogged = false;
  const processPayload = (payload, directoryHint = '') => {
    if (stopped) return;
    if (typeof persistContextCursor !== 'function' || typeof readSessionMetadata !== 'function') {
      if (!parkedNoticeLogged) {
        parkedNoticeLogged = true;
        console.log('[context-obligatory] parked: no session metadata store is wired, so the compaction cursor cannot be saved');
      }
      return;
    }
    if (payload?.type !== 'session.compacted') return;
    const sessionId = payload?.properties?.sessionID;
    if (typeof sessionId !== 'string' || inflight.has(sessionId)) return;
    const directory = payload?.properties?.directory || directoryHint;
    inflight.add(sessionId);
    return tick(sessionId, directory)
      .catch((error) => console.warn('[context-obligatory] injection failed:', error?.message || error))
      .finally(() => inflight.delete(sessionId));
  };

  const stop = () => {
    stopped = true;
  };

  return { processPayload, stop };
};
