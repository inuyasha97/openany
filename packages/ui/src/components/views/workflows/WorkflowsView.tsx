/**
 * The workflows surface: the runs of one project on the left, the selected run's
 * detail on the right, and a tab for the declared workflow itself.
 *
 * The list and the detail are separate components; this file owns which run is
 * selected, which definition is being edited, and the loading, error and empty
 * states, so a failure is never rendered as "no runs".
 */
import { useEffect, useMemo, useState } from 'react';

import { useI18n } from '@/lib/i18n';
import { useWorkflowStore } from '@/stores/useWorkflowStore';
import { RunList } from './RunList';
import { RunDetail } from './RunDetail';
import { DefinitionEditor } from './DefinitionEditor';
import type { WorkflowDefinitionSummary } from '@/lib/workflowsApi';
import type { ProjectRef } from '@/lib/projectContextApi';

export interface WorkflowsViewProps {
  project: ProjectRef | null;
}

export const WorkflowsView = ({ project }: WorkflowsViewProps) => {
  const { t } = useI18n();
  // Keyed on the id and the path, never on the owner object: `useProjectContextOwner`
  // rebuilds that object whenever the project list or the worktree topology
  // changes (an icon discovery, a label edit, a worktree publish), and each
  // rebuild would re-issue both reads and clear an error already on screen.
  const projectId = project?.id;
  const projectPath = project?.path;
  const entry = useWorkflowStore((state) => (projectId ? state.getEntry({ id: projectId }) : null));
  const load = useWorkflowStore((state) => state.load);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  // Held as the summary the action was taken from, not as an id resolved against
  // the entry: a save re-reads the definitions, and an editor that swapped its
  // summary mid-edit would throw away the buffer's baseline with it.
  const [editing, setEditing] = useState<WorkflowDefinitionSummary | null>(null);

  // `path_…` is the real project-id shape (`createProjectIdFromPath`); anything
  // else is a synthetic owner, so there is nothing to read for it.
  const isProject = projectId !== undefined && projectId.startsWith('path_');

  useEffect(() => {
    if (projectId && projectPath && isProject) void load({ id: projectId, path: projectPath });
  }, [projectId, projectPath, isProject, load]);

  const selected = useMemo(
    () => entry?.runs.find((run) => run.runId === selectedRunId) ?? entry?.runs[0] ?? null,
    [entry?.runs, selectedRunId],
  );

  // The detail's diagram tab needs the declared workflow of the run it shows;
  // resolving it here keeps the lookup beside the selection that owns it.
  const definition = useMemo(
    () => (selected ? entry?.definitions.find((candidate) => candidate.id === selected.workflowId) ?? null : null),
    [entry?.definitions, selected],
  );

  // A run the loaded list does not declare has no definition to draw: the detail
  // tells that apart from the definitions still being read.
  const definitionsLoaded = entry?.loaded === true;

  // A chat-draft or chats-root directory resolves to a synthetic owner that is
  // not a project (`useProjectContextOwner`), and a project id is `path_…`; the
  // surface has nothing to read for either, so it shows the no-project state
  // instead of asking the routes for a directory that is not a checkout.
  if (!project || !isProject) {
    return <Empty text={t('workflows.empty.noProject')} />;
  }
  // The store's `EMPTY` entry is truthy with no runs and no error, so a project
  // that has simply not been read yet would paint "No run yet" for a frame.
  // Compared against `null`, not falsiness: the server can fail with an empty
  // message (`{"error":""}`), and that failure must read as a failure.
  if (!entry?.loaded && entry?.error === null) {
    return <Empty text={t('workflows.empty.loading')} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {entry && entry.error !== null ? (
        <div role="alert" className="border-b border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {t('workflows.error.readFailed')}: {entry.error}
        </div>
      ) : null}
      {entry && entry.runs.length === 0 && entry.error === null ? (
        <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
          {t('workflows.empty.noRuns')} <code className="text-foreground">.openchamber/workflows/</code>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <RunList
          runs={entry?.runs ?? []}
          selectedRunId={selected?.runId ?? null}
          onSelect={setSelectedRunId}
          definitions={entry?.definitions ?? []}
          project={project}
        />
        {editing ? (
          /* Keyed on the file, so opening another definition reads its text
             instead of carrying the previous buffer into it. */
          <DefinitionEditor key={editing.file} project={project} summary={editing} onClose={() => setEditing(null)} />
        ) : selected ? (
          <RunDetail
            run={selected}
            project={project}
            definition={definition}
            definitionsLoaded={definitionsLoaded}
            onEditDefinition={setEditing}
          />
        ) : (
          <Empty text={t('workflows.empty.selectRun')} />
        )}
      </div>
    </div>
  );
};

const Empty = ({ text }: { text: string }) => (
  <div className="flex h-full flex-1 items-center justify-center p-4 text-xs text-muted-foreground">{text}</div>
);

// No default export: the panel imports the named one through the chunk-recovery
// wrapper, so a second binding would be dead weight.
