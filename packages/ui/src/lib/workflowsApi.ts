/**
 * The workflow routes' shapes and the client that speaks to them.
 *
 * The server owns run state; these are the wire types a screen reads, and the
 * functions below are how it reads them. The client only speaks HTTP and throws
 * on failure, because a caller that rendered "no runs" after a failed read
 * would be telling the person their runs are gone.
 */
import { runtimeFetch } from '@/lib/runtime-fetch';

export type WorkflowStepStatus =
  | 'pending' | 'running' | 'waiting_confirm' | 'needs_work' | 'done' | 'failed' | 'skipped' | 'blocked' | 'interrupted';

export type WorkflowRunStatus = 'idle' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';

export type WorkflowConfirmDecision = 'done' | 'not_done' | 'skip';

/** Where a workflow's steps run: the declaration's own mode, and the run's recorded one. */
export type WorkflowSandbox = 'worktree' | 'working-tree';

export interface WorkflowVerifyCommandResult {
  run: string;
  expectExit: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when either stream was cut at the engine's 64 KiB cap. */
  truncated: boolean;
  durationMs: number;
  ok: boolean;
}

export interface WorkflowVerifyArtifactResult {
  glob: string;
  path: string | null;
  exists: boolean;
  size: number | null;
  sha256: string | null;
}

export interface WorkflowVerifyResult {
  ok: boolean;
  artifacts: WorkflowVerifyArtifactResult[];
  commands: WorkflowVerifyCommandResult[];
  /** Present when the artifact inspection itself failed; every pattern then reads unmatched. */
  error?: string;
}

export interface WorkflowAttempt {
  index: number;
  sessionId: string | null;
  prompt: string;
  startedAt: number;
  endedAt: number | null;
  status: 'running' | 'completed' | 'failed' | 'blocked' | 'interrupted';
  turn: string | { outcome: string } | null;
  verify: WorkflowVerifyResult | null;
  error: null | { code: string; message: string };
}

export interface WorkflowStep {
  id: string;
  status: WorkflowStepStatus;
  attempts: WorkflowAttempt[];
  note: string | null;
}

export interface WorkflowRun {
  runId: string;
  projectId: string;
  directory: string;
  workflowId: string;
  workflowVersion: number;
  workflowHash: string;
  inputs: Record<string, string>;
  status: WorkflowRunStatus;
  cursor: string | null;
  createdAt: number;
  updatedAt: number;
  sandbox: WorkflowSandbox;
  /**
   * The branch a `worktree` run's checkout was created on. Absent until the run
   * takes its checkout, which is why the screen treats a missing one as "no
   * worktree to release".
   */
  worktreeBranch?: string | null;
  /** When the checkout was removed. The branch stays behind for a person to merge. */
  worktreeReleasedAt?: number | null;
  steps: WorkflowStep[];
}

export interface WorkflowStepDefinition {
  id: string;
  title: string;
  prompt: string;
  session: 'new' | 'reuse';
  permissions: 'ask' | 'auto';
  verify: { artifacts: Array<{ glob: string; hash: boolean }>; commands: Array<{ run: string; expectExit: number; timeoutMs: number }> };
}

export interface WorkflowInput {
  name: string;
  description: string;
  required: boolean;
}

export interface WorkflowDefinitionSummary {
  file: string;
  /**
   * The hash of the bytes on disk. A screen passes it back on a save so the
   * server can refuse a file another window changed in between, and `null` for
   * a row whose file could not be read.
   */
  hash: string | null;
  id: string | null;
  name: string | null;
  version: number | null;
  errors: Array<{ field: string; message: string }>;
  /** The declared steps, so a diagram needs one request instead of one per file. */
  steps: WorkflowStepDefinition[];
  /** The declared inputs, so a screen can ask for the values the create route requires. */
  inputs: WorkflowInput[];
  /**
   * The mode a run started from this file executes in. `null` for a row that
   * failed to parse, the same way its `id`, `name` and `version` are.
   */
  sandbox: WorkflowSandbox | null;
}

/**
 * A row whose file parses. Its `id` and its `sandbox` are `null` together — a
 * file that does not parse declares neither, because the parser requires the
 * mode — so a screen that needs the declaration proves it here instead of
 * defaulting one. The create route requires a mode and the engine refuses to
 * apply one, so a guessed mode in the client would be a run in a place nobody
 * chose.
 */
export type LoadedWorkflowDefinitionSummary = WorkflowDefinitionSummary & {
  id: string;
  name: string;
  version: number;
  sandbox: WorkflowSandbox;
};

/** Whether this row is a definition a run can be started from. */
export const isLoadedDefinition = (definition: WorkflowDefinitionSummary): definition is LoadedWorkflowDefinitionSummary =>
  definition.id !== null && definition.sandbox !== null;

/** What a save answers: the file it wrote and the hash of the text now on disk. */
export interface WorkflowDefinitionWrite {
  file: string;
  id: string;
  hash: string;
}

/** One definition as the file it is: the text a person edits, and what it parses to. */
export interface WorkflowDefinitionSource {
  raw: string;
  hash: string;
  /**
   * `null` when the text no longer parses. The editor still opens such a file —
   * the text and its hash are what a person repairs it from.
   */
  definition: WorkflowDefinition | null;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  version: number;
  sandbox: WorkflowSandbox;
  inputs: WorkflowInput[];
  steps: WorkflowStepDefinition[];
  file: string;
}

/**
 * A refusal from the workflow routes: the server's own message, and the status
 * beside it. A refusal that carries structured facts — the release's
 * `uncommitted` paths, which a screen must count and name before it may ask for
 * their deletion — keeps them here rather than leaving the screen to parse the
 * message or read the checkout again.
 */
export class WorkflowRequestError extends Error {
  readonly status: number;
  readonly uncommitted: string[] | null;

  constructor(message: string, status: number, uncommitted: string[] | null = null) {
    super(message);
    this.name = 'WorkflowRequestError';
    this.status = status;
    this.uncommitted = uncommitted;
  }
}

/**
 * Every route is scoped by the `x-opencode-directory` header, and `runtimeFetch`'s
 * `directory` option is NOT that header: it only decides which isolated space a
 * request belongs to (`lib/runtime-fetch.ts:111-121`). The header has to be set
 * here, the way the other scoped clients do it
 * (`lib/contextFileOpenGuard.ts:58`, `lib/guests/files.ts:87`). `runtimeFetch`
 * percent-encodes the value and adds `x-opencode-directory-encoding: uri` when the
 * path is not Latin-1-safe, which is exactly what the routes decode for.
 */
const request = async <T>(path: string, directory: string, init: RequestInit = {}): Promise<T> => {
  const response = await runtimeFetch(path, {
    ...init,
    headers: { 'x-opencode-directory': directory, ...(init.headers ?? {}) },
  });
  const body = await response.json().catch(() => null) as (T & { error?: string; uncommitted?: string[] }) | null;
  if (!response.ok) {
    throw new WorkflowRequestError(
      body?.error ?? `The request failed with ${response.status}`,
      response.status,
      Array.isArray(body?.uncommitted) ? body.uncommitted : null,
    );
  }
  if (!body) throw new WorkflowRequestError('The server answered with no body', response.status);
  return body;
};

const post = <T>(path: string, directory: string, payload?: unknown) => request<T>(path, directory, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload ?? {}),
});

export const fetchWorkflowDefinitions = async (directory: string): Promise<WorkflowDefinitionSummary[]> =>
  (await request<{ definitions: WorkflowDefinitionSummary[] }>('/api/workflows/definitions', directory)).definitions;

/**
 * The text of one definition, with the hash it was read at. A definition that has
 * not been written yet answers 404, which is how an editor learns there is
 * nothing to open rather than being handed an empty buffer to save.
 */
export const fetchWorkflowDefinitionSource = async (directory: string, workflowId: string): Promise<WorkflowDefinitionSource> =>
  request<WorkflowDefinitionSource>(`/api/workflows/definitions/${encodeURIComponent(workflowId)}`, directory);

/**
 * Save a definition. The server validates before it writes, so a refusal leaves
 * the file a person had alone. `expectedHash` is what the caller expects to find
 * where the definition goes: the hash the text was read at, so a file someone
 * else changed since then is refused instead of overwritten, or `null` for a
 * definition that must not exist yet, which the server answers by refusing a name
 * that is already taken.
 */
export const saveWorkflowDefinition = async (
  directory: string,
  workflowId: string,
  raw: string,
  expectedHash?: string | null,
): Promise<WorkflowDefinitionWrite> =>
  (await request<{ written: WorkflowDefinitionWrite }>(`/api/workflows/definitions/${encodeURIComponent(workflowId)}`, directory, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    // `null` is sent as itself: omitting the field is "no expectation at all",
    // which is the case for a definition already open in the editor, and the
    // route reads the two differently.
    body: JSON.stringify(expectedHash === undefined ? { raw } : { raw, expectedHash }),
  })).written;

export const deleteWorkflowDefinition = async (directory: string, workflowId: string): Promise<void> => {
  await request<{ removed: boolean }>(`/api/workflows/definitions/${encodeURIComponent(workflowId)}`, directory, { method: 'DELETE' });
};

export const fetchWorkflowRuns = async (directory: string): Promise<WorkflowRun[]> =>
  (await request<{ runs: WorkflowRun[] }>('/api/workflows/runs', directory)).runs;

export const fetchWorkflowRun = async (directory: string, runId: string): Promise<WorkflowRun> =>
  (await request<{ run: WorkflowRun }>(`/api/workflows/runs/${encodeURIComponent(runId)}`, directory)).run;

export const createWorkflowRun = async (
  directory: string,
  value: { workflowId: string; inputs?: Record<string, string>; sandbox?: WorkflowSandbox },
): Promise<WorkflowRun> =>
  (await post<{ run: WorkflowRun }>('/api/workflows/runs', directory, value)).run;

export const runWorkflow = async (directory: string, runId: string): Promise<WorkflowRun> =>
  (await post<{ run: WorkflowRun }>(`/api/workflows/runs/${encodeURIComponent(runId)}/run`, directory)).run;

export const cancelWorkflowRun = async (directory: string, runId: string): Promise<WorkflowRun> =>
  (await post<{ run: WorkflowRun }>(`/api/workflows/runs/${encodeURIComponent(runId)}/cancel`, directory)).run;

/**
 * What a release answers: the run, and the paths the removal deleted. `deleted`
 * is `null` when nothing was deleted, which is every release of a checkout that
 * held no uncommitted work.
 */
export interface WorkflowSandboxRelease {
  run: WorkflowRun;
  deleted: string[] | null;
}

/**
 * Remove a finished run's checkout. The branch is left behind, so this is
 * tidy-up, not a merge; the server refuses while the run is still going.
 *
 * A checkout that holds uncommitted work is refused, with the paths in the
 * refusal, because removing it would delete work no commit preserved.
 * `deleteUncommitted` is that deletion asked for on purpose, and `confirmed` is
 * the paths the person was shown — the server deletes only when a fresh status
 * read is exactly them, and refuses, deleting nothing, when the checkout changed
 * in between. The answer names the paths it deleted, which are gone from disk by
 * the time a screen could read the run.
 */
export const releaseWorkflowSandbox = async (
  directory: string,
  runId: string,
  options: { deleteUncommitted?: boolean; confirmed?: string[] } = {},
): Promise<WorkflowSandboxRelease> => {
  const payload: { deleteUncommitted?: boolean; confirmed?: string[] } = {};
  if (options.deleteUncommitted === true) {
    payload.deleteUncommitted = true;
    // Sent only with the decision to delete: a path list on its own would read
    // as consent nobody gave.
    if (options.confirmed) payload.confirmed = options.confirmed;
  }
  return post<WorkflowSandboxRelease>(`/api/workflows/runs/${encodeURIComponent(runId)}/sandbox/release`, directory, payload);
};

export const runWorkflowStep = async (directory: string, runId: string, stepId: string): Promise<WorkflowRun> =>
  (await post<{ run: WorkflowRun }>(`/api/workflows/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/run`, directory)).run;

export const verifyWorkflowStep = async (directory: string, runId: string, stepId: string): Promise<WorkflowRun> =>
  (await post<{ run: WorkflowRun }>(`/api/workflows/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/verify`, directory)).run;

export const promptWorkflowStep = async (directory: string, runId: string, stepId: string, text: string): Promise<WorkflowRun> =>
  (await post<{ run: WorkflowRun }>(`/api/workflows/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/prompt`, directory, { text })).run;

export const confirmWorkflowStep = async (
  directory: string,
  runId: string,
  stepId: string,
  decision: WorkflowConfirmDecision,
  reason?: string,
): Promise<WorkflowRun> =>
  (await post<{ run: WorkflowRun }>(
    `/api/workflows/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/confirm`,
    directory,
    reason === undefined ? { decision } : { decision, reason },
  )).run;

export const deleteWorkflowRun = async (directory: string, runId: string): Promise<void> => {
  await request<{ removed: boolean }>(`/api/workflows/runs/${encodeURIComponent(runId)}`, directory, { method: 'DELETE' });
};
