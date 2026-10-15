/**
 * Which runs still need their definition's file.
 *
 * The engine reads a definition from disk again on every step it advances, so a
 * run it has not stopped at for good cannot move once that file is gone. The
 * screen therefore refuses the delete the route refuses too, instead of offering
 * an action the server answers with a 409.
 */
import type { WorkflowRun, WorkflowRunStatus } from '@/lib/workflowsApi';

// The statuses a run stops at for good: `engine.js`'s `TERMINAL_RUN_STATUSES`,
// mirrored here because the two packages share no code. The server is the gate;
// this copy is what keeps the screen from offering a delete that would fail.
const TERMINAL_RUN_STATUSES: Partial<Record<WorkflowRunStatus, true>> = { done: true, failed: true, cancelled: true };

/** True while the engine could still advance this run. */
export const runIsLive = (status: WorkflowRunStatus): boolean => TERMINAL_RUN_STATUSES[status] !== true;

/**
 * The run that deleting `<workflowId>.yaml` would strand, or `null`. A run names
 * the definition by its declared id, and the engine resolves that id to a file
 * of the same name, so the comparison is on the id the file is named by.
 */
export const liveRunForDefinition = (runs: WorkflowRun[], workflowId: string): WorkflowRun | null =>
  runs.find((run) => run.workflowId === workflowId && runIsLive(run.status)) ?? null;
