/**
 * The runs of one project, newest first, with the actions a person takes on a
 * run itself: start one from a definition, open one, delete one.
 *
 * Delete asks first and names the run. It removes the run file only; commits and
 * artifacts stay in the project, so the dialog says so.
 *
 * A definition may declare inputs, and the create route rejects a missing
 * required one; the start dialog collects them before the run exists, and it
 * also asks where the run executes, pre-selected from the definition's own
 * declaration — the mode is chosen for every run, never defaulted. A failure
 * shows inside the dialog that asked for the action, so it is never hidden
 * behind the overlay; the list banner carries a failure that happened with no
 * dialog open.
 *
 * Each definition carries both actions a person takes on it: start a run, and
 * open its YAML in the editor. The second one lives here because a definition
 * with no run at all would otherwise be visible and unusable. A file that does
 * not parse carries the second one only — it declares no workflow to start a run
 * of — and that is the repair path for it.
 */
import { useState } from 'react';

import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import { Radio } from '@/components/ui/radio';
import { createWorkflowRun, deleteWorkflowRun, type WorkflowDefinitionSummary, type WorkflowRun, type WorkflowSandbox } from '@/lib/workflowsApi';
import { useWorkflowStore } from '@/stores/useWorkflowStore';
import { describeRunStatus } from '@/lib/workflows/status';
import type { ProjectRef } from '@/lib/projectContextApi';

export interface RunListProps {
  runs: WorkflowRun[];
  definitions: WorkflowDefinitionSummary[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  /** Opens one definition's YAML. The diagram's edit action needs a selected run, so this is how a definition with no run reaches the editor. */
  onEditDefinition: (definition: WorkflowDefinitionSummary) => void;
  /** Opens the editor for a definition that does not exist yet: the id is asked for there. */
  onNewDefinition: () => void;
  project: ProjectRef;
}

export const RunList = ({ runs, definitions, selectedRunId, onSelect, onEditDefinition, onNewDefinition, project }: RunListProps) => {
  const { t } = useI18n();
  const setRun = useWorkflowStore((state) => state.setRun);
  const removeRun = useWorkflowStore((state) => state.removeRun);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The run whose delete is being confirmed; the dialog asks before anything is removed.
  const [pendingDelete, setPendingDelete] = useState<WorkflowRun | null>(null);
  // The definition whose start is being set up.
  const [startFor, setStartFor] = useState<WorkflowDefinitionSummary | null>(null);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  // The mode this run executes in, pre-selected from the definition's
  // declaration and sent with the create so the run records the choice.
  const [sandbox, setSandbox] = useState<WorkflowSandbox>('worktree');
  // A row with no `id` is a file that does not parse: there is no declared
  // workflow to start a run of, but it is still a file this screen can open.
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
  const start = async (definition: WorkflowDefinitionSummary, inputs: Record<string, string>, mode: WorkflowSandbox): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const run = await createWorkflowRun(project.path, { workflowId: definition.id as string, inputs, sandbox: mode });
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
    // The dialog asks for the mode even when the definition declares no input:
    // where a run executes is a choice, so it is never started without one.
    setInputValues({});
    setSandbox(definition.sandbox ?? 'worktree');
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
          {/* A definition is a file, so creating one starts from an id and the
              shipped template; the editor asks for both. */}
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            title={t('workflows.editor.newDefinition')}
            aria-label={t('workflows.editor.newDefinition')}
            onClick={onNewDefinition}
          >
            <Icon name="add" className="size-3.5" aria-hidden />
          </Button>
          {definitions.map((definition) => (
            <span key={definition.file} className="flex items-center">
              {definition.id === null ? (
                /* A file that does not parse declares no workflow, so there is no
                   run to start from it. It is still a file on disk, and the edit
                   action beside it is the repair: the pane shows the text as it
                   is, and the save validates it. */
                <span className="px-1 font-mono text-xs text-muted-foreground" title={t('workflows.definition.invalid')}>
                  {definition.file}
                </span>
              ) : (
                <Button size="xs" variant="ghost" disabled={busy} onClick={() => beginStart(definition)}>
                  {definition.name ?? definition.id}
                  {/* The mode the run will execute in, before one exists: rendered the
                      way a run's own header renders it (`RunDetail.tsx`), raw. */}
                  {definition.sandbox ? <span className="text-[11px] text-muted-foreground">{definition.sandbox}</span> : null}
                </Button>
              )}
              {/* Every listed definition opens its YAML, whether or not a run of
                  it exists: the diagram's own edit action is reachable only
                  through a selected run. */}
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                title={t('workflows.editor.open')}
                aria-label={`${t('workflows.editor.open')}: ${definition.name ?? definition.id ?? definition.file}`}
                onClick={() => onEditDefinition(definition)}
              >
                <Icon name="edit" className="size-3.5" aria-hidden />
              </Button>
            </span>
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
            {/* Where the run executes: asked for every run, with the definition's
                own declaration pre-selected, so the mode is a choice rather than
                a default the engine applies. */}
            <div role="radiogroup" aria-label={t('workflows.run.startSandbox')} className="flex flex-col gap-2">
              <span className="text-muted-foreground">{t('workflows.run.startSandbox')}</span>
              {(['worktree', 'working-tree'] as const).map((mode) => {
                const label = mode === 'worktree' ? t('workflows.run.startSandboxWorktree') : t('workflows.run.startSandboxWorkingTree');
                return (
                  <label key={mode} className="flex items-center gap-2 text-xs">
                    <Radio checked={sandbox === mode} onChange={() => setSandbox(mode)} ariaLabel={label} />
                    <span>{label}</span>
                  </label>
                );
              })}
            </div>
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
                void start(startFor, inputValues, sandbox);
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
