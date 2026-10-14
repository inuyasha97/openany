/**
 * What a restart means for the runs on disk.
 *
 * The run file is an index, not the record: sessions belong to OMP, artifacts
 * belong to the project, and commits belong to git. Every one of them is
 * re-checked here, and anything uncertain is reported instead of assumed. A
 * step that was running when the server stopped becomes `interrupted`, because
 * the engine cannot tell a finished turn from a turn that never returned.
 */
const ACTIVE = new Set(['running', 'waiting']);

// A step that already finished owes the run nothing, so a session that is gone
// under it is not a reason to block: the work is checkpointed and the record of
// its session is history. Only a step that still has to run is blocked when the
// session it would continue no longer exists.
const SETTLED_STEP_STATUSES = new Set(['done', 'skipped']);

export const reconcileRuns = async ({ store, host, verifyCheckpoint, listProjectIds, logger = console }) => {
  const summary = { runs: 0, interrupted: 0, blocked: 0, waiting: 0 };
  const projectIds = await listProjectIds();
  const sessions = await host.listSessions().catch(() => null);

  for (const projectId of projectIds) {
    const runs = await store.list(projectId);
    for (const run of runs) {
      if (!ACTIVE.has(run.status)) continue;
      summary.runs += 1;
      let changed = false;
      const knownSessions = sessions === null ? null : new Set(sessions.map((entry) => entry.id));

      for (const step of run.steps) {
        if (step.status === 'running') {
          step.status = 'interrupted';
          step.note = 'the server stopped while this step was running';
          summary.interrupted += 1;
          changed = true;
        }
        if (step.checkpoint) {
          const check = await verifyCheckpoint({ checkpoint: step.checkpoint, directory: run.directory });
          if (!check.ok) {
            const details = check.mismatches.map((entry) => `${entry.path} (${entry.reason})`).join(', ');
            step.note = `checkpoint no longer matches: ${details}`;
            run.status = 'waiting';
            run.cursor = step.id;
            summary.blocked += 1;
            changed = true;
            logger.warn?.(`[workflows] run ${run.runId}: ${step.note}`);
          }
        }
        const attempt = step.attempts.at(-1);
        if (!SETTLED_STEP_STATUSES.has(step.status) && attempt?.sessionId && knownSessions && !knownSessions.has(attempt.sessionId)) {
          attempt.status = 'blocked';
          attempt.error = { code: 'unavailable', message: `session ${attempt.sessionId} is no longer known` };
          if (step.status === 'running' || step.status === 'interrupted') step.status = 'interrupted';
          step.note = `session ${attempt.sessionId} is no longer known`;
          run.status = 'waiting';
          run.cursor = step.id;
          summary.blocked += 1;
          changed = true;
        }
      }

      if (changed) {
        if (run.status === 'running') {
          run.status = 'waiting';
          run.cursor = run.cursor ?? run.steps.find((step) => step.status !== 'done' && step.status !== 'skipped')?.id ?? null;
          summary.waiting += 1;
        }
        await store.write(run);
      }
    }
  }
  return summary;
};
