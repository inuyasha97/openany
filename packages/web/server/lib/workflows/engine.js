/**
 * The run loop.
 *
 * One attempt is: create or adopt a session, send the prompt, wait for the turn
 * to end, run the verifiers, then stop for a person or advance. Every fact the
 * engine records comes from the runtime, from disk, or from git; a step never
 * advances because a model said it was done.
 *
 * Two writers are impossible by construction: an in-flight map holds the project
 * ids currently executing, and `runUntilStop` stops at the first stop, so a
 * second click answers `busy` instead of starting a second attempt.
 */
import { substituteInputs } from './prompts.js';
import { runVerifiers } from './verifiers.js';

export class WorkflowError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
    this.status = status ?? (code === 'not-found' ? 404 : code === 'busy' || code === 'conflict' ? 409 : code === 'unavailable' ? 503 : 400);
  }
}

const TERMINAL_RUN_STATUSES = new Set(['done', 'failed', 'cancelled']);
const STOPS = new Set(['waiting_confirm', 'needs_work', 'blocked', 'failed', 'interrupted']);

/**
 * The session a `session: reuse` step continues: the nearest preceding attempt
 * that has one, starting from this step's own last attempt. Walking the steps
 * from the front would hand a later step the first session the run ever opened,
 * which is not "the previous attempt".
 */
const previousSessionId = (run, stepId) => {
  const index = run.steps.findIndex((step) => step.id === stepId);
  if (index < 0) return null;
  for (let position = index; position >= 0; position -= 1) {
    const attempts = run.steps[position].attempts;
    for (let attempt = attempts.length - 1; attempt >= 0; attempt -= 1) {
      if (attempts[attempt].sessionId) return attempts[attempt].sessionId;
    }
  }
  return null;
};

/** Step statuses that still owe the run something before it can be called done. */
const OPEN_STEP_STATUSES = new Set(['pending', 'running', 'waiting_confirm', 'needs_work', 'blocked', 'interrupted']);

const hasOpenWork = (run) => run.steps.some((step) => OPEN_STEP_STATUSES.has(step.status));

export const createWorkflowEngine = ({
  store,
  definitions,
  host,
  checkpoints,
  runChecks = runVerifiers,
  turn,
  now = Date.now,
  broadcast = () => {},
  logger = console,
}) => {
  const requireHost = () => {
    if (!host) throw new WorkflowError('unavailable', 'the OMP runtime is not available');
    return host;
  };

  const emit = (run) => {
    try {
      broadcast({ type: 'openchamber:workflow', properties: { runId: run.runId, projectId: run.projectId, status: run.status, cursor: run.cursor, steps: run.steps.map((step) => ({ id: step.id, status: step.status })) } });
    } catch (error) {
      logger.warn?.('[workflows] broadcast failed', error?.message ?? error);
    }
  };

  const inFlight = new Set();

  const loadRun = async (projectId, runId) => {
    const run = await store.read(projectId, runId);
    if (!run) throw new WorkflowError('not-found', `run ${runId} was not found`, 404);
    return run;
  };

  const loadStepDefinition = async (projectId, run) => {
    const definition = await definitions.read(projectId, run.workflowId);
    if (!definition) throw new WorkflowError('not-found', `workflow ${run.workflowId} is missing or invalid`, 404);
    return definition;
  };

  const findStep = (run, stepId) => {
    const step = run.steps.find((entry) => entry.id === stepId);
    if (!step) throw new WorkflowError('not-found', `step ${stepId} is not part of the run`, 404);
    return step;
  };

  const attemptStep = async ({ projectId, projectPath, runId, stepId }) => {
    const run = await loadRun(projectId, runId);
    const definition = await loadStepDefinition(projectId, run);
    const declared = definition.steps.find((entry) => entry.id === stepId);
    if (!declared) throw new WorkflowError('not-found', `step ${stepId} is not declared by ${run.workflowId}`, 404);
    const step = findStep(run, stepId);

    const { text, missing } = substituteInputs(declared.prompt, run.inputs ?? {});
    if (missing.length > 0) {
      step.status = 'blocked';
      step.note = `missing input: ${missing.join(', ')}`;
      run.status = 'waiting';
      const saved = await store.write(run);
      emit(saved);
      return saved;
    }

    const bus = requireHost();
    let sessionId = declared.session === 'reuse' ? previousSessionId(run, stepId) : null;
    if (!sessionId) {
      const created = await bus.createSession({ cwd: projectPath });
      sessionId = created?.id;
      if (!sessionId) throw new WorkflowError('unavailable', 'the runtime created no session');
      try {
        await bus.renameSession(sessionId, `${run.workflowId} ${stepId}`);
      } catch (error) {
        logger.warn?.('[workflows] could not rename the step session', error?.message ?? error);
      }
    }
    if (declared.permissions === 'auto') {
      try {
        await bus.setAutoAccept(sessionId, true, projectPath);
      } catch (error) {
        logger.warn?.('[workflows] could not enable permission auto-accept', error?.message ?? error);
      }
    }

    const attempt = { index: step.attempts.length, sessionId, prompt: text, startedAt: now(), endedAt: null, status: 'running', turn: null, verify: null, error: null };
    step.attempts.push(attempt);
    step.status = 'running';
    run.status = 'running';
    run.cursor = stepId;
    await store.write(run);
    emit(run);

    const accepted = await bus.prompt(sessionId, text);
    if (accepted !== true) {
      attempt.status = 'blocked';
      attempt.endedAt = now();
      attempt.error = {
        code: 'unavailable',
        message: accepted === null ? 'the OMP runtime went away before it could take the prompt' : 'the OMP runtime did not take the prompt',
      };
      step.status = 'blocked';
      step.note = attempt.error.message;
      run.status = 'waiting';
      const saved = await store.write(run);
      emit(saved);
      return saved;
    }

    const outcome = await turn({ host: bus, sessionId });
    attempt.turn = outcome;
    attempt.endedAt = now();
    if (outcome !== 'completed') {
      attempt.status = 'blocked';
      attempt.error = { code: 'unavailable', message: outcome === 'timeout' ? 'the turn did not finish before the timeout' : 'the runtime never reported the turn as running' };
      step.status = 'blocked';
      step.note = attempt.error.message;
      run.status = 'waiting';
      const saved = await store.write(run);
      emit(saved);
      return saved;
    }

    const verify = await runChecks({ step: declared, directory: run.directory });
    attempt.verify = verify;
    attempt.status = 'completed';
    step.note = verify.ok ? null : 'a verifier failed';

    if (declared.confirm === 'auto' && verify.ok) {
      step.status = 'done';
      step.checkpoint = await writeCheckpointFor({ run, step, attempt, verify });
      advance(run, stepId);
      run.status = run.cursor ? 'running' : hasOpenWork(run) ? 'waiting' : 'done';
    } else if (verify.ok) {
      step.status = 'waiting_confirm';
      run.status = 'waiting';
    } else {
      step.status = 'needs_work';
      run.status = 'waiting';
    }
    const saved = await store.write(run);
    emit(saved);
    return saved;
  };

  const writeCheckpointFor = async ({ run, step, attempt, verify }) => {
    const artifacts = verify.artifacts.filter((entry) => entry.exists).map(({ path: file, size, sha256 }) => ({ path: file, size, sha256 }));
    return checkpoints.write({ directory: run.directory, runId: run.runId, stepId: step.id, attemptIndex: attempt.index, artifacts });
  };

  const advance = (run, stepId) => {
    const index = run.steps.findIndex((step) => step.id === stepId);
    const next = run.steps.slice(index + 1).find((step) => step.status === 'pending');
    run.cursor = next ? next.id : null;
  };

  /**
   * One run per project executes at a time, so the key is the project: two runs
   * of the same project would otherwise share the working tree, or two
   * worktrees' worth of steps would race on the same checkout.
   */
  const withLock = async (projectId, task) => {
    if (inFlight.has(projectId)) throw new WorkflowError('busy', 'this project already has a run executing a step', 409);
    inFlight.add(projectId);
    try {
      return await task();
    } finally {
      inFlight.delete(projectId);
    }
  };

  return {
    startStep: ({ projectId, projectPath, runId, stepId }) => withLock(projectId, () => attemptStep({ projectId, projectPath, runId, stepId })),
    runUntilStop: async ({ projectId, projectPath, runId }) => {
      const start = await loadRun(projectId, runId);
      if (TERMINAL_RUN_STATUSES.has(start.status)) throw new WorkflowError('conflict', `run ${runId} is ${start.status}`, 409);
      const firstStepId = start.cursor ?? start.steps.find((step) => step.status === 'pending')?.id;
      if (!firstStepId) throw new WorkflowError('conflict', `run ${runId} has no step left to run`, 409);
      // A run already stopped for a person is returned as it stands: running
      // until the next stop must not start a fresh turn on a step nobody has
      // answered yet.
      const cursorStep = start.steps.find((step) => step.id === firstStepId);
      if (cursorStep && STOPS.has(cursorStep.status)) return start;
      let run = await withLock(projectId, () => attemptStep({ projectId, projectPath, runId, stepId: firstStepId }));
      while (run.cursor && !STOPS.has(run.steps.find((step) => step.id === run.cursor)?.status ?? 'pending')) {
        const next = run.cursor;
        run = await withLock(projectId, () => attemptStep({ projectId, projectPath, runId, stepId: next }));
      }
      return run;
    },
  };
};
