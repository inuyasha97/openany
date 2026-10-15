/**
 * The workflows surface: the runs of one project on the left, the selected run's
 * detail on the right, and a tab for the declared workflow itself.
 *
 * The list and the detail are separate components; this file owns which run is
 * selected and the loading, error and empty states, so a failure is never
 * rendered as "no runs".
 */
import { useEffect, useMemo, useState } from 'react';

import { useI18n } from '@/lib/i18n';
import { useWorkflowStore } from '@/stores/useWorkflowStore';
import { RunList } from './RunList';
import { RunDetail } from './RunDetail';
import type { ProjectRef } from '@/lib/projectContextApi';

export interface WorkflowsViewProps {
  project: ProjectRef | null;
}

export const WorkflowsView = ({ project }: WorkflowsViewProps) => {
  const { t } = useI18n();
  const entry = useWorkflowStore((state) => (project ? state.getEntry(project) : null));
  const load = useWorkflowStore((state) => state.load);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  useEffect(() => {
    if (project) void load(project);
  }, [project?.id, project?.path, load]);

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

  if (!project) {
    return <Empty text={t('workflows.empty.noProject')} />;
  }
  if (entry?.loading && !entry.loaded) {
    return <Empty text={t('workflows.empty.loading')} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {entry?.error ? (
        <div role="status" className="border-b border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {t('workflows.error.readFailed')}: {entry.error}
        </div>
      ) : null}
      {entry && entry.runs.length === 0 && !entry.error ? (
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
        {selected ? (
          <RunDetail run={selected} project={project} definition={definition} />
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

export default WorkflowsView;
