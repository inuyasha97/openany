/**
 * What a restart means for the runs on disk.
 *
 * The run file is an index, not the record: sessions belong to OMP, artifacts
 * belong to the project, and commits belong to git. Every one of them is
 * re-checked here, and anything uncertain is reported instead of assumed. A
 * step that was running when the server stopped becomes `interrupted`, because
 * the engine cannot tell a finished turn from a turn that never returned — but
 * the session can: a session that is idle settled its turn before the kill, so
 * the attempt is closed on the evidence and the person can still answer the
 * step, while a busy session keeps its attempt running and says so.
 *
 * The sweep is deliberately forgiving: one project or one run that cannot be
 * read must not cost the others their reconciliation, and a project with a step
 * executing right now is skipped rather than written from a stale snapshot.
 */
const ACTIVE = new Set(['running', 'waiting']);

/** Steps whose record is already written down; their session no longer matters. */
const SETTLED_STEP_STATUSES = new Set(['done', 'skipped']);

export const reconcileRuns = async ({
  store,
  host,
  verifyCheckpoint,
  listProjectIds,
  isProjectBusy = () => false,
  now = Date.now,
  logger = console,
}) => {
  const summary = { runs: 0, interrupted: 0, blocked: 0, waiting: 0 };
  const projectIds = await listProjectIds();
  const sessions = await host.listSessions().catch(() => null);

  for (const projectId of projectIds) {
    if (isProjectBusy(projectId)) continue;
    let runs = [];
    try {
      runs = await store.list(projectId);
    } catch (error) {
      logger.warn?.(`[workflows] could not list runs for ${projectId}: ${error?.message ?? error}`);
      continue;
    }

    for (const run of runs) {
      if (!ACTIVE.has(run.status)) continue;
      try {
        const outcome = await reconcileRun({ run, store, host, verifyCheckpoint, sessions, now, logger });
        summary.runs += outcome.changed ? 1 : 0;
        summary.interrupted += outcome.interrupted;
        summary.blocked += outcome.blocked ? 1 : 0;
        summary.waiting += outcome.waiting ? 1 : 0;
      } catch (error) {
        logger.warn?.(`[workflows] could not reconcile run ${run.runId}: ${error?.message ?? error}`);
      }
    }
  }
  return summary;
};

/**
 * One run, rebuilt from what is on disk. It answers what the run counted as, so
 * the summary counts runs and never steps.
 */
const reconcileRun = async ({ run, store, host, verifyCheckpoint, sessions, now, logger }) => {
  const knownSessions = sessions === null ? null : new Set(sessions.map((entry) => entry.id));
  let interrupted = 0;
  let blocked = false;
  let changed = false;
  // The first step this pass blocked keeps the cursor. Taking the last one would
  // hide every earlier block behind it.
  let blockedStepId = null;

  for (const step of run.steps) {
    // Only a step this pass interrupted is probed: a step an earlier sweep
    // already reattached carries the note the person has to read, and asking
    // again would overwrite it.
    let interruptedNow = false;
    if (step.status === 'running') {
      step.status = 'interrupted';
      step.note = 'the server stopped while this step was running';
      interrupted += 1;
      interruptedNow = true;
      changed = true;
    }

    if (step.checkpoint) {
      const check = await verifyCheckpoint({ checkpoint: step.checkpoint, directory: run.directory });
      if (!check.ok) {
        const details = check.mismatches.map((entry) => `${entry.path} (${entry.reason})`).join(', ');
        step.note = `checkpoint no longer matches: ${details}`;
        blocked = true;
        blockedStepId = blockedStepId ?? step.id;
        changed = true;
        logger.warn?.(`[workflows] run ${run.runId}: ${step.note}`);
      }
    }

    const attempt = step.attempts.at(-1);
    // Only a step that still owes the run something cares whether its session
    // survives: a finished step's record is its checkpoint, and re-flagging it
    // would double-count the run as blocked and overwrite a note that says
    // something more useful.
    if (!SETTLED_STEP_STATUSES.has(step.status) && attempt?.sessionId && knownSessions && !knownSessions.has(attempt.sessionId)) {
      attempt.status = 'blocked';
      attempt.error = { code: 'unavailable', message: `session ${attempt.sessionId} is no longer known` };
      if (step.status === 'running' || step.status === 'interrupted') step.status = 'interrupted';
      step.note = `session ${attempt.sessionId} is no longer known`;
      blocked = true;
      blockedStepId = blockedStepId ?? step.id;
      changed = true;
    } else if (interruptedNow && step.status === 'interrupted' && attempt?.sessionId) {
      // The turn may have finished before the server stopped, and an attempt left
      // `running` with no `endedAt` can never be confirmed: `confirmStep` only
      // accepts a settled attempt. A session that reports idle is that evidence,
      // so the attempt is closed and the step stays interrupted for the person; a
      // busy session keeps its attempt running and the step says what to do.
      let status = null;
      try {
        status = await host.getSessionStatus(attempt.sessionId);
      } catch (error) {
        logger.warn?.(`[workflows] could not read the status of session ${attempt.sessionId}: ${error?.message ?? error}`);
      }
      if (status?.busy === true) {
        step.note = 'the turn is still running; stop it before answering this step';
      } else {
        attempt.status = 'completed';
        attempt.endedAt = now();
        attempt.turn = { outcome: 'unknown-after-restart' };
      }
    }
  }

  let waiting = false;
  if (changed) {
    if (run.status === 'running') {
      run.status = 'waiting';
      run.cursor = blockedStepId
        ?? run.cursor
        ?? run.steps.find((step) => step.status !== 'done' && step.status !== 'skipped')?.id
        ?? null;
      waiting = true;
    }
    await store.write(run);
  }

  return { changed, interrupted, blocked, waiting };
};
