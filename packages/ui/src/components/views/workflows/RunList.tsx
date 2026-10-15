/**
 * The runs of one project, newest first, with the actions a person takes on a
 * run itself: start one from a definition, open one, delete one.
 *
 * Delete asks first and names the run. It removes the run file only; commits and
 * artifacts stay in the project, so the dialog says so.
 *
 * A definition may declare inputs, and the create route rejects a missing
 * required one; the start dialog collects them before the run exists, and a
 * definition with no inputs starts on one click. A failure shows inside the
 * dialog that asked for the action, so it is never hidden behind the overlay;
 * the list banner carries a failure that happened with no dialog open.
 */
import { useState } from 'react';

import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
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
  // The definition whose start is being set up, once it declares inputs.
  const [startFor, setStartFor] = useState<WorkflowDefinitionSummary | null>(null);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  // `WorkflowDefinitionSummary` carries `id: string | null`, not the parsed definition.
  const usable = definitions.filter((definition) => definition.id !== null);
  const missingRequired = startFor
    ? startFor.inputs.some((input) => input.required && !(inputValues[input.name] ?? '').trim())
    : false;
  const dialogOpen = startFor !== null || pendingDelete !== null;

  const closeStart = () => {
    setStartFor(null);
    setError(null);
  };

  const closeDelete = () => {
    setPendingDelete(null);
    setError(null);
  };

  // Resolves true when the run was created; on a failure the dialog stays open
  // and the message renders inside it.
  const start = async (definition: WorkflowDefinitionSummary, inputs: Record<string, string>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const run = await createWorkflowRun(project.path, { workflowId: definition.id as string, inputs });
      setRun(project, run);
      onSelect(run.runId);
      setStartFor(null);
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('workflows.error.actionFailed'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const beginStart = (definition: WorkflowDefinitionSummary) => {
    setError(null);
    if (definition.inputs.length === 0) {
      void start(definition, {});
      return;
    }
    setInputValues({});
    setStartFor(definition);
  };

  const remove = async (runId: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await deleteWorkflowRun(project.path, runId);
      removeRun(project, runId);
      setPendingDelete(null);
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('workflows.error.actionFailed'));
      return false;
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
            <Button key={definition.file} size="xs" variant="ghost" disabled={busy} onClick={() => beginStart(definition)}>
              {definition.name ?? definition.id}
              {/* The mode the run will execute in, before one exists: rendered the
                  way a run's own header renders it (`RunDetail.tsx`), raw. */}
              {definition.sandbox ? <span className="text-[11px] text-muted-foreground">{definition.sandbox}</span> : null}
            </Button>
          ))}
        </div>
      </div>
      {error && !dialogOpen ? <div role="status" className="px-3 py-2 text-xs text-destructive">{error}</div> : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {runs.map((run) => {
          const status = describeRunStatus(run.status, t);
          // A run with a step executing would be written back when that turn
          // settles, so deleting it now would not stick.
          const executing = run.steps.some((step) => step.status === 'running');
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
                disabled={busy || executing}
                title={t('workflows.run.delete')}
                aria-label={t('workflows.run.delete')}
                onClick={() => {
                  setError(null);
                  setPendingDelete(run);
                }}
              >
                <Icon name="delete-bin" className="size-3.5" aria-hidden />
              </Button>
            </div>
          );
        })}
      </div>
      <Dialog open={startFor !== null} onOpenChange={(open) => { if (!open) closeStart(); }}>
        <DialogContent className="max-w-sm gap-5">
          <DialogHeader>
            <DialogTitle>{t('workflows.run.start')}</DialogTitle>
            <DialogDescription>{startFor?.name ?? startFor?.id}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            {startFor?.inputs.map((input) => (
              <label key={input.name} className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">{input.description || input.name}</span>
                <Input
                  value={inputValues[input.name] ?? ''}
                  aria-required={input.required}
                  onChange={(event) => setInputValues((current) => ({ ...current, [input.name]: event.target.value }))}
                />
              </label>
            ))}
          </div>
          {error ? <div role="alert" className="text-xs text-destructive">{error}</div> : null}
          <DialogFooter>
            <Button variant="ghost" size="sm" disabled={busy} onClick={closeStart}>
              {t('workflows.run.startCancel')}
            </Button>
            <Button
              size="sm"
              disabled={busy || missingRequired}
              onClick={() => {
                if (!startFor) return;
                void start(startFor, inputValues);
              }}
            >
              {t('workflows.run.startConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open) closeDelete(); }}>
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
          {error ? <div role="alert" className="text-xs text-destructive">{error}</div> : null}
          <DialogFooter>
            <Button variant="ghost" size="sm" disabled={busy} onClick={closeDelete}>
              {t('workflows.run.deleteCancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => {
                if (!pendingDelete) return;
                void remove(pendingDelete.runId);
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
