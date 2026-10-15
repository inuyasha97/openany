/**
 * One run: the step sequence down the left, the selected step on the right.
 *
 * The timeline is theme-colored markup rather than a diagram renderer: a step's
 * status changes on every frame, and re-rendering a full SVG each time is work
 * for nothing. The declared workflow itself is drawn separately, on the
 * definition tab, where it does not change.
 */
import { useEffect, useState } from 'react';

import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { fetchWorkflowRun, type WorkflowDefinitionSummary, type WorkflowRun } from '@/lib/workflowsApi';
import { describeRunStatus, describeStepStatus } from '@/lib/workflows/status';
import type { ProjectRef } from '@/lib/worktrees/worktreeManager';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { StepPane } from './StepPane';
import { WorkflowDiagram } from './WorkflowDiagram';

export interface RunDetailProps {
  run: WorkflowRun;
  project: ProjectRef;
  /** The declared workflow, for the diagram tab; `null` while it does not load. */
  definition: WorkflowDefinitionSummary | null;
}

export const RunDetail = ({ run, project, definition }: RunDetailProps) => {
  const [tab, setTab] = useState<'steps' | 'definition'>('steps');
  const { t } = useI18n();
  const [full, setFull] = useState<WorkflowRun>(run);
  const [stepId, setStepId] = useState<string | null>(run.cursor ?? run.steps[0]?.id ?? null);
  const [error, setError] = useState<string | null>(null);

  // The parent swaps the `run` prop when a person selects another run, without
  // remounting this component. Without this the pane would show the previous
  // run's steps under the new selection until the re-read landed, and forever if
  // that read failed.
  if (full.runId !== run.runId) {
    setFull(run);
    setStepId(run.cursor ?? run.steps[0]?.id ?? null);
    setError(null);
  }
  const runStatus = describeRunStatus(run.status, t);

  // The frame the server pushes carries a step summary, not the attempts and
  // verifier output. When a step's status moved, re-read the run so the pane
  // shows what the new state actually contains.
  useEffect(() => {
    void fetchWorkflowRun(project.path, run.runId)
      .then((next) => {
        setError(null);
        setFull(next);
        setStepId((current) => current ?? next.cursor ?? next.steps[0]?.id ?? null);
      })
      .catch((failure) => setError(failure instanceof Error ? failure.message : t('workflows.error.readFailed')));
  }, [project.path, run.runId, run.updatedAt, run.status, run.steps.map((step) => `${step.id}:${step.status}`).join(',')]);

  const step = full.steps.find((candidate) => candidate.id === stepId) ?? full.steps[0] ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon name={runStatus.icon} className={runStatus.className} aria-hidden />
        <span className="text-xs font-medium">{full.workflowId}</span>
        <span className="text-xs text-muted-foreground">{runStatus.label}</span>
        <span className="ml-auto text-[11px] text-muted-foreground">{full.sandbox}</span>
      </div>
      <div className="flex items-center gap-1 border-b border-border px-2 py-1" role="tablist">
        <Button size="xs" variant={tab === 'steps' ? 'secondary' : 'ghost'} role="tab" aria-selected={tab === 'steps'} onClick={() => setTab('steps')}>
          {t('workflows.step.attempts')}
        </Button>
        <Button size="xs" variant={tab === 'definition' ? 'secondary' : 'ghost'} role="tab" aria-selected={tab === 'definition'} onClick={() => setTab('definition')}>
          {t('workflows.definition.tab')}
        </Button>
      </div>
      {error ? <div role="status" className="px-3 py-2 text-xs text-destructive">{error}</div> : null}
      <div className="flex min-h-0 flex-1">
        <ol className="w-56 shrink-0 overflow-y-auto border-r border-border py-1">
          {full.steps.map((candidate) => {
            const status = describeStepStatus(candidate.status, t);
            return (
              <li key={candidate.id}>
                <button
                  type="button"
                  onClick={() => setStepId(candidate.id)}
                  className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs', candidate.id === step?.id ? 'bg-accent' : 'hover:bg-accent/50')}
                >
                  <Icon name={status.icon} className={cn(status.className, candidate.status === 'running' && 'animate-spin')} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{candidate.id}</span>
                  <span className="text-[11px] text-muted-foreground">{status.label}</span>
                </button>
              </li>
            );
          })}
        </ol>
        {tab === 'definition'
          ? (definition
            ? <WorkflowDiagram summary={definition} />
            : <div className="flex-1 p-3 text-xs text-muted-foreground">{t('workflows.empty.loading')}</div>)
          : (step ? <StepPane run={full} step={step} project={project} /> : null)}
      </div>
    </div>
  );
};
