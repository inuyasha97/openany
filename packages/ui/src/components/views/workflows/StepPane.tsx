/**
 * One step, shown as evidence: what the step is waiting for, what each attempt
 * ran in which session, what the verifiers actually printed, and what the
 * checkpoint recorded.
 *
 * Nothing here summarizes a model's claim. The verifier block shows the command
 * that ran and its exit code and output, because a person deciding whether to
 * confirm needs the evidence, not a sentence about it.
 */
import { useEffect, useState } from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { cn } from '@/lib/utils';
import type { WorkflowRun, WorkflowStep } from '@/lib/workflowsApi';
import { describeStepStatus } from '@/lib/workflows/status';

export interface StepPaneProps {
  run: WorkflowRun;
  step: WorkflowStep;
  project: { path: string };
}

export const StepPane = ({ run, step, project }: StepPaneProps) => {
  const { t } = useI18n();
  const status = describeStepStatus(step.status, t);

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

      {step.checkpoint ? (
        <section className="rounded border border-border p-2">
          <h4 className="text-[11px] font-medium text-muted-foreground">{t('workflows.step.checkpoint')}</h4>
          <p className="font-mono text-[11px]">{step.checkpoint.commit.slice(0, 12)}</p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {step.checkpoint.artifacts.map((artifact) => (
              <li key={artifact.path} className="truncate font-mono text-[11px] text-muted-foreground">
                {artifact.path} {artifact.sha256 ? artifact.sha256.slice(0, 8) : ''}
              </li>
            ))}
          </ul>
          {/* The diff of one commit is rendered from the same data the changes
              panel uses; do not write a second differ. */}
          <CheckpointDiff directory={project.path} commit={step.checkpoint.commit} />
        </section>
      ) : null}

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
    </div>
  );
};

const VerifierBlock = ({ verify }: { verify: NonNullable<WorkflowStep['attempts'][number]['verify']> }) => {
  const { t } = useI18n();
  // A step may declare no checks at all (`confirm: human` with no verifier), and
  // the engine records an empty verdict for it. A heading over an empty list
  // reads as a bug, so the block simply is not there.
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

/**
 * The diff of one checkpoint commit, read from the git routes the changes panel
 * already uses. This is why the checkpoint is a commit: the evidence a person
 * needs to confirm a step is the change itself, and it does not need a second
 * implementation of diffing.
 *
 * `GET /api/git/commit-files` takes `directory` and `hash` and answers
 * `{ files: [{ path, insertions, deletions, isBinary, changeType }] }`.
 */
const CheckpointDiff = ({ directory, commit }: { directory: string; commit: string }) => {
  const { t } = useI18n();
  const [files, setFiles] = useState<Array<{ path: string; insertions: number; deletions: number }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // A new commit (or a new translator identity) means the previous answer no
    // longer describes what this block is about, so nothing stale may survive
    // the refetch: an error from the last attempt would otherwise hide a
    // successful one, and the old file list would sit under the new header.
    setFiles(null);
    setError(null);
    void runtimeFetch(
      `/api/git/commit-files?directory=${encodeURIComponent(directory)}&hash=${encodeURIComponent(commit)}`,
      { directory },
    )
      .then((response) =>
        response.ok
          ? response.json()
          : response
              .json()
              .catch(() => null)
              .then((body: { error?: string } | null) =>
                Promise.reject(new Error(body?.error ?? `${t('workflows.step.diffFailed')} (${response.status})`)),
              ),
      )
      // `GET /api/git/commit-files` answers `{ files: [{ path, insertions, deletions, changeType }] }`
      // (`lib/git/service.js:5640-5677`); the field is `insertions`, not `additions`.
      .then((body: { files?: Array<{ path: string; insertions: number; deletions: number }> }) => {
        if (!cancelled) setFiles(body.files ?? []);
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : t('workflows.error.readFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, [directory, commit, t]);

  if (error) return <p className="mt-1 text-[11px] text-destructive">{error}</p>;
  if (!files) return <p className="mt-1 text-[11px] text-muted-foreground">{t('workflows.empty.loading')}</p>;
  return (
    <ul className="mt-1 flex flex-col gap-0.5">
      {files.map((file) => (
        <li key={file.path} className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{file.path}</span>
          <span className="text-chart-2">+{file.insertions}</span>
          <span className="text-destructive">-{file.deletions}</span>
        </li>
      ))}
    </ul>
  );
};
