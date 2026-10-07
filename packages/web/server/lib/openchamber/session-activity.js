/**
 * Whether a session's turn has really ended, on the OMP runtime.
 *
 * OpenCode answered two questions: which sessions run right now
 * (`/api/session/active`) and which subagent sessions belong to a parent
 * (`GET /api/session?parentID=`). A parent went idle while a background
 * subagent kept working, so anything that treated idle as "done" (goal audits,
 * ready notifications, queued sends) had to check the children too.
 *
 * OMP answers one session's busy state (`getSessionStatus`) and lists no child
 * sessions: a subagent runs inside its parent's own turn, and the session store
 * treats a subagent transcript as not-a-session. There is therefore no children
 * page to walk — the busy flag is the whole answer.
 *
 * Every read answers `null` when the runtime could not be asked: "could not
 * look" must never pass for "nothing is running".
 */

import { readSessionStatus, readSessions } from '../agents/omp-host-access.js';

export const createSessionActivityProbe = () => {
  /**
   * The sessions running right now, keyed by id, or `null` when the runtime is
   * unavailable. Only an open session can be busy — an unopened one answers
   * `{ busy: false }` — so an absent id is idle, exactly as it was with
   * OpenCode's active map.
   */
  const fetchActiveSessionStatuses = async () => {
    const sessions = await readSessions().catch(() => null);
    if (!Array.isArray(sessions)) return null;
    const statuses = {};
    for (const session of sessions) {
      const id = typeof session?.id === 'string' ? session.id : '';
      if (!id) continue;
      const status = await readSessionStatus(id).catch(() => null);
      if (status?.busy === true) statuses[id] = { busy: true };
    }
    return statuses;
  };

  /**
   * A parent's subagent sessions. OMP records no parent/child link on a session
   * and lists none (`createSessionStore` skips a subagent transcript), so once
   * the runtime has answered the answer is always "none"; `null` still means
   * the runtime could not be asked.
   */
  const fetchChildSessionIds = async () => {
    const sessions = await readSessions().catch(() => null);
    if (!Array.isArray(sessions)) return null;
    return [];
  };

  /**
   * True when a subagent of the session is still running. There are no child
   * sessions on OMP, so this is `false`; `null` means the caller's own status
   * read already told it the runtime was unavailable.
   */
  const hasWorkingChildren = async (_sessionId, statuses) => {
    if (!statuses || typeof statuses !== 'object') return null;
    return false;
  };

  return { fetchActiveSessionStatuses, fetchChildSessionIds, hasWorkingChildren };
};
