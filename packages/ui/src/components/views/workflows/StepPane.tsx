/**
 * One step, shown as evidence: what the step is waiting for, what each attempt
 * ran in which session, and what the verifiers recorded — each artifact with its
 * digest, each command with its exit code and output. That record is the whole of
 * what a `done` step leaves behind: whether its work was committed is decided by
 * the step's own prompt, so the engine writes no commit to show here.
 *
 * Nothing here summarizes a model's claim. The verifier block shows the command
 * that ran and its exit code and output, because a person deciding whether to
 * confirm needs the evidence, not a sentence about it.
 */
import { useState } from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  cancelWorkflowRun,
  confirmWorkflowStep,
  promptWorkflowStep,
  runWorkflow,
  runWorkflowStep,
  verifyWorkflowStep,
} from '@/lib/workflowsApi';
import type { WorkflowRun, WorkflowRunStatus, WorkflowStep, WorkflowStepStatus } from '@/lib/workflowsApi';
import { describeRunStatus, describeStepStatus } from '@/lib/workflows/status';
import type { ProjectRef } from '@/lib/worktrees/worktreeManager';
import { useWorkflowStore } from '@/stores/useWorkflowStore';

export interface StepPaneProps {
  run: WorkflowRun;
  step: WorkflowStep;
  project: ProjectRef;
}

export const StepPane = ({ run, step, project }: StepPaneProps) => {
  const { t } = useI18n();
  const status = describeStepStatus(step.status, t);
  const setRun = useWorkflowStore((state) => state.setRun);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');

  // The engine refuses three classes of action with `conflict` (409): any action
  // aimed at a run that has already finished; `run`, `prompt` and `verify` on a
  // step that is already settled; and `confirm` on a step whose last attempt
  // never completed. The bar computes the same three facts once, so it never
  // offers a button the server would refuse.
  const TERMINAL_RUN_STATUSES: Partial<Record<WorkflowRunStatus, true>> = { done: true, failed: true, cancelled: true };
  const SETTLED_STEP_STATUSES: Partial<Record<WorkflowStepStatus, true>> = { done: true, skipped: true };
  const runIsOpen = TERMINAL_RUN_STATUSES[run.status] !== true;
  const stepIsSettled = SETTLED_STEP_STATUSES[step.status] === true;
  const attemptSettled = step.attempts.at(-1)?.status === 'completed';

  // A gated control carries the reason it is refused, because a control that
  // refuses silently reads as a bug. A disabled `Button` is `pointer-events-none`
  // (`components/ui/button.tsx`), so its own `title` never appears in a browser;
  // each control is therefore wrapped in a `<span title={reason}>`, which is the
  // hit target that can show it. The reason is the localized status of whatever
  // blocks the action, so the bar introduces no new strings.
  const runClosedTitle = runIsOpen ? undefined : describeRunStatus(run.status, t).label;
  const stepSettledTitle = stepIsSettled ? status.label : undefined;
  const attemptUnsettledTitle = attemptSettled ? undefined : status.label;
  const noAttemptsTitle = step.attempts.length === 0 ? t('workflows.step.status.pending') : undefined;

  const act = async (action: () => Promise<WorkflowRun>) => {
    setBusy(true);
    setActionError(null);
    try {
      setRun(project, await action());
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : t('workflows.error.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  /**
   * The action bar.
   *
   * Every action is disabled while one is in flight: two clicks on "run this step"
   * must not start two attempts, and the server answers `busy` for the second one
   * anyway. A refused action shows the server's own message, because "the verifier
   * failed" is more useful than "the action failed".
   */
  const actionBar = (
    <div className="flex flex-col gap-2 border-t border-border p-2">
      {actionError ? (
        <p role="status" className="text-[11px] text-destructive">
          {actionError}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1">
        <span
          className="inline-flex"
          title={runClosedTitle ?? stepSettledTitle ?? (step.status === 'running' ? status.label : undefined)}
        >
          <Button
            size="xs"
            aria-label={t('workflows.step.run')}
            disabled={busy || !runIsOpen || stepIsSettled || step.status === 'running'}
            onClick={() => void act(() => runWorkflowStep(project.path, run.runId, step.id))}
          >
            {t('workflows.step.run')}
          </Button>
        </span>
        <span className="inline-flex" title={runClosedTitle}>
          <Button
            size="xs"
            variant="ghost"
            aria-label={t('workflows.step.runAll')}
            disabled={busy || !runIsOpen}
            onClick={() => void act(() => runWorkflow(project.path, run.runId))}
          >
            {t('workflows.step.runAll')}
          </Button>
        </span>
        <span className="inline-flex" title={runClosedTitle ?? stepSettledTitle ?? noAttemptsTitle}>
          <Button
            size="xs"
            variant="ghost"
            aria-label={t('workflows.step.verify')}
            disabled={busy || !runIsOpen || stepIsSettled || step.attempts.length === 0}
            onClick={() => void act(() => verifyWorkflowStep(project.path, run.runId, step.id))}
          >
            {t('workflows.step.verify')}
          </Button>
        </span>
        <span className="inline-flex" title={runClosedTitle}>
          <Button
            size="xs"
            variant="ghost"
            aria-label={t('workflows.step.cancelRun')}
            disabled={busy || !runIsOpen}
            onClick={() => void act(() => cancelWorkflowRun(project.path, run.runId))}
          >
            {t('workflows.step.cancelRun')}
          </Button>
        </span>
      </div>
      {step.status === 'waiting_confirm' ||
      step.status === 'needs_work' ||
      step.status === 'blocked' ||
      step.status === 'interrupted' ? (
        <div className="flex flex-col gap-1">
          <textarea
            className="min-h-16 rounded border border-border bg-transparent p-1.5 text-xs"
            placeholder={t('workflows.step.promptPlaceholder')}
            aria-label={t('workflows.step.prompt')}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
          <div className="flex flex-wrap gap-1">
            <span className="inline-flex" title={runClosedTitle ?? stepSettledTitle}>
              <Button
                size="xs"
                aria-label={t('workflows.step.prompt')}
                disabled={busy || !runIsOpen || stepIsSettled || prompt.trim().length === 0}
                onClick={() =>
                  void act(async () => {
                    const next = await promptWorkflowStep(project.path, run.runId, step.id, prompt.trim());
                    setPrompt('');
                    return next;
                  })
                }
              >
                {t('workflows.step.prompt')}
              </Button>
            </span>
            <span className="inline-flex" title={runClosedTitle ?? attemptUnsettledTitle}>
              <Button
                size="xs"
                variant="ghost"
                aria-label={t('workflows.step.confirmDone')}
                disabled={busy || !runIsOpen || !attemptSettled}
                onClick={() => void act(() => confirmWorkflowStep(project.path, run.runId, step.id, 'done'))}
              >
                {t('workflows.step.confirmDone')}
              </Button>
            </span>
            <span className="inline-flex" title={runClosedTitle}>
              <Button
                size="xs"
                variant="ghost"
                aria-label={t('workflows.step.confirmNotDone')}
                disabled={busy || !runIsOpen}
                onClick={() => void act(() => confirmWorkflowStep(project.path, run.runId, step.id, 'not_done'))}
              >
                {t('workflows.step.confirmNotDone')}
              </Button>
            </span>
            <span className="inline-flex" title={runClosedTitle}>
              <Button
                size="xs"
                variant="ghost"
                aria-label={t('workflows.step.skip')}
                disabled={busy || !runIsOpen}
                onClick={() => void act(() => confirmWorkflowStep(project.path, run.runId, step.id, 'skip'))}
              >
                {t('workflows.step.skip')}
              </Button>
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Icon name={status.icon} className={cn(status.className, step.status === 'running' && 'animate-spin')} />
          <span className="text-sm font-medium">{step.id}</span>
          <span className="text-xs text-muted-foreground">{status.label}</span>
        </div>
        {step.note ? <p className="text-xs text-muted-foreground">{step.note}</p> : null}
      </div>

      <section className="flex flex-col gap-2">
        <h4 className="text-[11px] font-medium text-muted-foreground">{t('workflows.step.attempts')}</h4>
        {step.attempts.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('workflows.step.status.pending')}</p>
        ) : null}
        {step.attempts.map((attempt) => (
          <div key={attempt.index} className="rounded border border-border p-2">
            <div className="flex items-center gap-2 text-[11px]">
              <span className="font-medium">#{attempt.index + 1}</span>
              <span className={attempt.status === 'completed' ? 'text-muted-foreground' : 'text-destructive'}>
                {attempt.status}
              </span>
              {attempt.sessionId ? (
                <span className="ml-auto font-mono text-muted-foreground">{attempt.sessionId.slice(0, 8)}</span>
              ) : null}
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words text-[11px] text-muted-foreground">{attempt.prompt}</p>
            {attempt.error ? <p className="mt-1 text-[11px] text-destructive">{attempt.error.message}</p> : null}
            {attempt.verify ? <VerifierBlock verify={attempt.verify} /> : null}
          </div>
        ))}
      </section>
      {actionBar}
    </div>
  );
};

const VerifierBlock = ({ verify }: { verify: NonNullable<WorkflowStep['attempts'][number]['verify']> }) => {
  const { t } = useI18n();
  // A step may declare no checks at all, and the engine records an empty verdict
  // for it. A heading over an empty list reads as a bug, so the block simply is
  // not there.
  if (!verify.error && verify.artifacts.length === 0 && verify.commands.length === 0) return null;
  return (
    <div className="mt-2 border-t border-border pt-2">
      <h5 className="text-[11px] font-medium text-muted-foreground">{t('workflows.step.verifier')}</h5>
      {verify.error ? <p className="mt-1 text-[11px] text-destructive">{verify.error}</p> : null}
      <ul className="mt-1 flex flex-col gap-1">
        {verify.artifacts.map((artifact) => (
          <li key={`${artifact.glob}:${artifact.path ?? 'none'}`} className="flex items-center gap-2 text-[11px]">
            <span className={artifact.exists ? 'text-chart-2' : 'text-destructive'}>{artifact.exists ? '✓' : '✗'}</span>
            <span className="truncate font-mono">{artifact.path ?? artifact.glob}</span>
            {artifact.sha256 ? (
              // The digest is the record a restart re-checks, so the pane shows
              // it beside the path rather than only in the run file.
              <span className="ml-auto font-mono text-muted-foreground">{artifact.sha256.slice(0, 8)}</span>
            ) : null}
            {!artifact.exists ? (
              <span className="text-muted-foreground">
                {t('workflows.step.verifier')}: {artifact.glob}
              </span>
            ) : null}
          </li>
        ))}
        {verify.commands.map((command, index) => (
          <li key={`${command.run}:${index}`} className="text-[11px]">
            <div className="flex items-center gap-2">
              <span className={command.ok ? 'text-chart-2' : 'text-destructive'}>{command.ok ? '✓' : '✗'}</span>
              <span className="truncate font-mono">{command.run}</span>
              <span className="ml-auto text-muted-foreground">
                {command.timedOut ? t('workflows.step.timeout') : t('workflows.step.exit', { code: command.exitCode ?? '—' })} · {(command.durationMs / 1000).toFixed(1)}s
              </span>
            </div>
            {command.truncated ? (
              <span className="ml-1 text-muted-foreground">({t('workflows.step.truncated')})</span>
            ) : null}
            {command.stdout ? (
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
                {command.stdout}
              </pre>
            ) : null}
            {command.stderr ? (
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] text-destructive">
                {command.stderr}
              </pre>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
};
