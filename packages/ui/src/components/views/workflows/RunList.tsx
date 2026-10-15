/**
 * The runs of one project, newest first, with the actions a person takes on a
 * run itself: start one from a definition, open one, delete one.
 *
 * Delete asks first and names the run. It removes the run file only; commits and
 * artifacts stay in the project, so the dialog says so.
 */
import { useState } from 'react';

import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { createWorkflowRun, deleteWorkflowRun, type WorkflowDefinitionSummary, type WorkflowRun } from '@/lib/workflowsApi';
import { useWorkflowStore } from '@/stores/useWorkflowStore';
import { describeRunStatus } from '@/lib/workflows/status';
import type { ProjectRef } from '@/lib/projectContextApi';

export interface RunListProps {
  runs: WorkflowRun[];
  definitions: WorkflowDefinitionSummary[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  project: ProjectRef;
}

export const RunList = ({ runs, definitions, selectedRunId, onSelect, project }: RunListProps) => {
  const { t } = useI18n();
  const setRun = useWorkflowStore((state) => state.setRun);
  const removeRun = useWorkflowStore((state) => state.removeRun);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The run whose delete is being confirmed; the dialog asks before anything is removed.
  const [pendingDelete, setPendingDelete] = useState<WorkflowRun | null>(null);
  const usable = definitions.filter((definition) => definition.id !== null);

  const start = async (workflowId: string) => {
    setBusy(true);
    setError(null);
    try {
      const run = await createWorkflowRun(project.path, { workflowId });
      setRun(project, run);
      onSelect(run.runId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('workflows.error.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (runId: string) => {
    setBusy(true);
    setError(null);
    try {
      await deleteWorkflowRun(project.path, runId);
      removeRun(project, runId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('workflows.error.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex w-64 shrink-0 flex-col border-r border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="text-xs font-medium">{t('workflows.title')}</span>
        <div className="flex gap-1">
          {usable.map((definition) => (
            <Button key={definition.file} size="xs" variant="ghost" disabled={busy} onClick={() => void start(definition.id as string)}>
              {definition.name ?? definition.id}
            </Button>
          ))}
        </div>
      </div>
      {error ? <div role="status" className="px-3 py-2 text-xs text-destructive">{error}</div> : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {runs.map((run) => {
          const status = describeRunStatus(run.status, t);
          return (
            <div
              key={run.runId}
              className={run.runId === selectedRunId ? 'flex items-center gap-2 bg-accent px-3 py-2' : 'flex items-center gap-2 px-3 py-2 hover:bg-accent/50'}
            >
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onSelect(run.runId)}>
                <span className="flex items-center gap-1.5 text-xs">
                  <Icon name={status.icon} className={status.className} aria-hidden />
                  <span className="truncate">{run.workflowId}</span>
                  <span className="text-muted-foreground">{status.label}</span>
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">{run.cursor ?? run.runId.slice(0, 8)}</span>
              </button>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                aria-label={t('workflows.run.delete')}
                onClick={() => setPendingDelete(run)}
              >
                <Icon name="delete-bin" />
              </Button>
            </div>
          );
        })}
      </div>
      <Dialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open) setPendingDelete(null); }}>
        <DialogContent showCloseButton={false} className="max-w-sm gap-5">
          <DialogHeader>
            <DialogTitle>{t('workflows.run.delete')}</DialogTitle>
            <DialogDescription>
              {pendingDelete ? (
                <span className="block font-mono text-[11px] text-muted-foreground">
                  {pendingDelete.workflowId} · {pendingDelete.runId.slice(0, 8)}
                </span>
              ) : null}
              {t('workflows.run.deleteConfirm')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPendingDelete(null)}>
              {t('workflows.run.deleteCancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => {
                if (!pendingDelete) return;
                void remove(pendingDelete.runId).finally(() => setPendingDelete(null));
              }}
            >
              {t('workflows.run.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
