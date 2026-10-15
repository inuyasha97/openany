/**
 * The workflow routes' shapes, mirrored for the client.
 *
 * The server owns run state; these are the wire types a screen reads. The
 * HTTP client itself lands with its own task.
 */

export type WorkflowStepStatus =
  | 'pending' | 'running' | 'waiting_confirm' | 'needs_work' | 'done' | 'failed' | 'skipped' | 'blocked' | 'interrupted';

export type WorkflowRunStatus = 'idle' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';

export type WorkflowConfirmDecision = 'done' | 'not_done' | 'skip';

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

export interface WorkflowCheckpoint {
  at: number;
  commit: string;
  clean: boolean;
  artifacts: Array<{ path: string; size: number; sha256: string | null }>;
}

export interface WorkflowAttempt {
  index: number;
  sessionId: string | null;
  prompt: string;
  startedAt: number;
  endedAt: number | null;
  status: 'running' | 'completed' | 'failed' | 'blocked' | 'interrupted';
  turn: null | { outcome?: string };
  verify: WorkflowVerifyResult | null;
  error: null | { code: string; message: string };
}

export interface WorkflowStep {
  id: string;
  status: WorkflowStepStatus;
  attempts: WorkflowAttempt[];
  checkpoint: WorkflowCheckpoint | null;
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
  sandbox: string;
  steps: WorkflowStep[];
}

export interface WorkflowStepDefinition {
  id: string;
  title: string;
  prompt: string;
  session: 'new' | 'reuse';
  permissions: 'ask' | 'auto';
  verify: { artifacts: Array<{ glob: string; hash: boolean }>; commands: Array<{ run: string; expectExit: number; timeoutMs: number }> };
  confirm: 'human' | 'auto';
}

export interface WorkflowDefinitionSummary {
  file: string;
  id: string | null;
  name: string | null;
  version: number | null;
  errors: Array<{ field: string; message: string }>;
  /** The declared steps, so a diagram needs one request instead of one per file. */
  steps: WorkflowStepDefinition[];
}
