/**
 * Which runs still need their definition's file.
 *
 * The engine reads a definition from disk again on every step it advances, so a
 * run it has not stopped at for good cannot move once that file is gone. The
 * screen therefore refuses the delete the route refuses too, instead of offering
 * an action the server answers with a 409.
 *
 * The rule, stated once, because the route's refusals and this screen have to
 * agree on it: a run resolves to the *definition* whose declared `id` — the
 * `id:` in the body, never the file name — equals the run's `workflowId`, because
 * that is how `definitions.read` finds it when the engine advances a step. A file
 * named `alpha.yaml` that declares `id: beta` is therefore the definition a run of
 * `beta` resolves to. So the id to hand this module is the id the definition
 * declares, and a file that does not parse declares none: no run resolves to it.
 */
import type { WorkflowRun, WorkflowRunStatus } from '@/lib/workflowsApi';

// The statuses a run stops at for good: `engine.js`'s `TERMINAL_RUN_STATUSES`,
// mirrored here because the two packages share no code. The server is the gate;
// this copy is what keeps the screen from offering a delete that would fail.
const TERMINAL_RUN_STATUSES: Partial<Record<WorkflowRunStatus, true>> = { done: true, failed: true, cancelled: true };

/** True while the engine could still advance this run. */
export const runIsLive = (status: WorkflowRunStatus): boolean => TERMINAL_RUN_STATUSES[status] !== true;

/**
 * The live run that resolves to the definition declaring `declaredId`, or `null`.
 * The id comes from the definition the screen has, not from its file name: a file
 * named `alpha.yaml` declaring `id: beta` holds the run of `beta`, and a file
 * that does not parse declares no id to hold a run by.
 */
export const liveRunForDefinition = (runs: WorkflowRun[], declaredId: string | null): WorkflowRun | null => {
  if (declaredId === null) return null;
  return runs.find((run) => run.workflowId === declaredId && runIsLive(run.status)) ?? null;
};
