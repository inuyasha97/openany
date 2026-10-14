/**
 * Waits for one turn to finish, watching the session's busy state.
 *
 * OMP reports a session as idle both before a turn starts and after it ends, so
 * a single idle reading proves nothing. The wait only accepts idle after having
 * seen busy once. A runtime that never reports busy within the grace window
 * answers `never_started`, which the engine records as a blocked step rather
 * than a finished one: "the turn never ran" and "the turn finished" are
 * different facts, and only one of them means the step may advance.
 */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const waitForTurnEnd = async ({
  host,
  sessionId,
  pollMs = 1000,
  graceMs = 15_000,
  timeoutMs = 30 * 60_000,
  now = Date.now,
  sleep = defaultSleep,
}) => {
  const startedAt = now();
  let sawBusy = false;
  for (;;) {
    const status = await host.getSessionStatus(sessionId);
    if (!status) return 'unavailable';
    if (status.busy === true) sawBusy = true;
    if (sawBusy && status.busy !== true) return 'completed';
    const elapsed = now() - startedAt;
    // An explicit zero grace window means the caller does not want the
    // never-started distinction: idle right away counts as finished.
    if (!sawBusy && elapsed >= graceMs) return graceMs > 0 ? 'never_started' : 'completed';
    if (elapsed >= timeoutMs) return 'timeout';
    await sleep(pollMs);
  }
};
