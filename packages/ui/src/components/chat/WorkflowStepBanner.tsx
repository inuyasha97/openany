/**
 * The banner a step's own session shows.
 *
 * A person working in the transcript should not have to find the run screen to
 * answer the step they are looking at. The banner only appears when the open
 * session is the session of a step attempt, and it names the run and the step so
 * the answer cannot land on the wrong one.
 *
 * The store is the source: the frame stream patches the step's status, so the
 * banner becomes live without polling. The one read it issues is the entry for
 * the session's own project, because nothing else in the app has loaded the runs
 * by the time a person opens a step's session.
 */
import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import type { ProjectRef } from '@/lib/projectContextApi';
import { confirmWorkflowStep, fetchWorkflowRun, type WorkflowRun, type WorkflowStep } from '@/lib/workflowsApi';
import { describeRunStatus, describeStepStatus } from '@/lib/workflows/status';
import { cn } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useWorkflowStore } from '@/stores/useWorkflowStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

export interface WorkflowStepBannerProps {
  /** The session on screen; the banner is silent without one. */
  sessionId: string | null;
  /** That session's directory, which owns the project whose runs are searched. */
  directory: string | null;
}

type FoundStep = { run: WorkflowRun; step: WorkflowStep };

/**
 * The step that is live in this session.
 *
 * A `session: reuse` step continues the session of the nearest preceding
 * attempt, so two steps can name the same session: the earlier one keeps the id
 * in its finished attempt while the later one is working in it. The run's own
 * cursor names the step that is live, so it wins; without a cursor the last
 * match wins, because later steps in a run are the ones a session moves forward
 * into.
 */
const findStepInSession = (entry: { runs: WorkflowRun[] }, sessionId: string | null): FoundStep | null => {
  if (!sessionId) return null;
  let last: FoundStep | null = null;
  for (const run of entry.runs) {
    for (const step of run.steps) {
      if (step.attempts.at(-1)?.sessionId !== sessionId) continue;
      if (run.cursor === step.id) return { run, step };
      last = { run, step };
    }
  }
  return last;
};

export const WorkflowStepBanner = React.memo(({ sessionId, directory }: WorkflowStepBannerProps) => {
  const { t } = useI18n();
  const projects = useProjectsStore((state) => state.projects);
  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const load = useWorkflowStore((state) => state.load);
  const setRun = useWorkflowStore((state) => state.setRun);
  const [busy, setBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const project: ProjectRef | null = React.useMemo(() => {
    const resolved = resolveProjectForSessionDirectory(projects, availableWorktreesByProject, directory);
    return resolved ? { id: resolved.id, path: resolved.path } : null;
  }, [availableWorktreesByProject, directory, projects]);

  const entry = useWorkflowStore((state) => state.getEntry(project));
  const { loaded, loading, error } = entry;

  // One read per project: a failed read is not retried in a loop, and the
  // workflows surface reports that failure on its own. Until runs are known the
  // banner stays out of the way rather than guessing that the session is not a
  // step's session.
  React.useEffect(() => {
    if (!project || loaded || loading || error !== null) return;
    void load(project);
  }, [error, load, loaded, loading, project]);

  const found = React.useMemo(() => findStepInSession(entry, sessionId), [entry, sessionId]);
  const projectId = project?.id ?? null;
  const projectPath = project?.path ?? null;
  const runId = found?.run.runId ?? null;
  const stepId = found?.step.id ?? null;
  const stepStatus = found?.step.status ?? null;
  const attemptStatus = found?.step.attempts.at(-1)?.status ?? null;
  const needsAnswer = stepStatus === 'waiting_confirm' || stepStatus === 'needs_work' || stepStatus === 'blocked' || stepStatus === 'interrupted';

  // A frame carries each step's status and nothing else (`useWorkflowStore`'s
  // `patchRun`), so a step that reached a stop after this project was loaded
  // still shows its last attempt as `running`, and the confirm would stay
  // disabled forever. One read of that run settles it. The dependencies are
  // primitives on purpose: one read per step and status, not one per frame.
  React.useEffect(() => {
    if (!needsAnswer || projectId === null || projectPath === null || runId === null || stepId === null) return;
    if (attemptStatus === 'completed') return;
    let cancelled = false;
    void fetchWorkflowRun(projectPath, runId)
      .then((next) => { if (!cancelled) setRun({ id: projectId }, next); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [attemptStatus, needsAnswer, projectId, projectPath, runId, setRun, stepId, stepStatus]);

  // A refusal belongs to the step the person answered, not to whatever session
  // they look at next.
  React.useEffect(() => { setActionError(null); }, [sessionId]);

  if (!project || !found) return null;

  const status = describeStepStatus(found.step.status, t);
  // The run being over and the attempt not having finished are the two facts the
  // engine refuses a confirm on (`packages/web/server/lib/workflows/engine.js`),
  // so the button is gated on them and carries why it is gated.
  const runIsOpen = found.run.status !== 'done' && found.run.status !== 'failed' && found.run.status !== 'cancelled';
  const attemptSettled = attemptStatus === 'completed';
  const refusedTitle = runIsOpen ? (attemptSettled ? undefined : status.label) : describeRunStatus(found.run.status, t).label;

  const confirm = async () => {
    setBusy(true);
    setActionError(null);
    try {
      setRun(project, await confirmWorkflowStep(project.path, found.run.runId, found.step.id, 'done'));
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : t('workflows.error.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pb-2 w-full px-1">
      {/* The chrome matches the docks beside it in the composer column
          (AutoReviewBanner, RevertedMessageDock). */}
      <div className="rounded-xl border border-border/60 bg-[var(--surface-elevated)] text-[var(--surface-elevated-foreground)] shadow-sm overflow-hidden">
        <div className="flex w-full items-center gap-2 px-3 py-2">
          <Icon
            name={status.icon}
            className={cn('h-4 w-4 shrink-0', status.className, found.step.status === 'running' && 'animate-spin')}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <div className="typography-ui-label font-medium text-foreground truncate">
              {t('workflows.banner.title')}
            </div>
            <div className="typography-meta text-muted-foreground truncate">
              {found.run.workflowId} · {found.step.id}
            </div>
          </div>
          <span className="typography-meta shrink-0 text-muted-foreground">
            {needsAnswer
              ? (found.step.status === 'blocked' ? t('workflows.banner.blocked') : t('workflows.banner.waiting'))
              : status.label}
          </span>
          {actionError ? (
            <span className="typography-meta shrink-0 max-w-[16rem] truncate text-destructive" title={actionError}>
              {actionError}
            </span>
          ) : null}
          {needsAnswer ? (
            <span className="inline-flex shrink-0" title={refusedTitle}>
              <Button
                type="button"
                size="xs"
                aria-label={t('workflows.step.confirmDone')}
                disabled={busy || !runIsOpen || !attemptSettled}
                onClick={() => { void confirm(); }}
              >
                {t('workflows.step.confirmDone')}
              </Button>
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
});

WorkflowStepBanner.displayName = 'WorkflowStepBanner';
