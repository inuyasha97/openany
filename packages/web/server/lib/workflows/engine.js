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
import { reconcileRuns as defaultReconcile } from './resume.js';
import { runVerifiers as defaultRunChecks, verifyCheckpoint as defaultVerifyCheckpoint } from './verifiers.js';

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
  runChecks = defaultRunChecks,
  verifyCheckpoint = defaultVerifyCheckpoint,
  reconcileRuns = defaultReconcile,
  // No default: the sweep's project list is a fact about this installation, and
  // a guessed one would walk every directory under the projects root.
  listProjectIds,
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

    run.cursor = stepId;
    return runPromptInSession({ run, step, declared, sessionId, text, projectPath });
  };

  /**
   * The "prompt, wait, verify, decide" body: a first attempt and a person's
   * continue prompt both send text into the recorded session, wait for the turn
   * to finish, run the verifiers, then stop for a person or advance. The
   * refused-prompt and never-started paths live here so they exist once.
   */
  const runPromptInSession = async ({ run, step, declared, sessionId, text, projectPath }) => {
    const bus = requireHost();
    if (declared.permissions === 'auto') {
      await bus.setAutoAccept?.(sessionId, true, projectPath).catch(() => undefined);
    }
    const attempt = { index: step.attempts.length, sessionId, prompt: text, startedAt: now(), endedAt: null, status: 'running', turn: null, verify: null, error: null };
    step.attempts.push(attempt);
    step.status = 'running';
    run.status = 'running';
    const started = await store.write(run);
    // The request that starts the attempt answers only when the turn is over, so
    // this frame is the only way a screen learns the step is running.
    emit(started);
    const accepted = await bus.prompt(sessionId, text);
    if (accepted !== true) {
      attempt.status = 'blocked';
      attempt.endedAt = now();
      attempt.error = { code: 'unavailable', message: 'the OMP runtime did not take the prompt' };
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
    return settleAttempt({ run, step, declared, attempt });
  };

  /** Run the verifiers and record the outcome of one completed attempt. */
  const settleAttempt = async ({ run, step, declared, attempt }) => {
    const verify = await runChecks({ step: declared, directory: run.directory });
    attempt.verify = verify;
    attempt.status = 'completed';
    step.note = verify.ok ? null : 'a verifier failed';
    if (declared.confirm === 'auto' && verify.ok) {
      step.status = 'done';
      step.checkpoint = await writeCheckpointFor({ run, step, attempt, verify });
      advance(run, step.id);
      run.status = run.cursor ? 'running' : hasOpenWork(run) ? 'waiting' : 'done';
    } else {
      step.status = verify.ok ? 'waiting_confirm' : 'needs_work';
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

    confirmStep: async ({ projectId, runId, stepId, decision, reason = null }) => {
      if (inFlight.has(projectId)) throw new WorkflowError('busy', 'this project already has a run executing a step', 409);
      const run = await loadRun(projectId, runId);
      const step = findStep(run, stepId);
      if (!['done', 'not_done', 'skip'].includes(decision)) throw new WorkflowError('invalid', `unknown decision "${decision}"`);
      if (decision === 'done') {
        const attempt = step.attempts.at(-1);
        // Only a turn that finished can be confirmed: confirming an attempt that
        // is still in flight would write a checkpoint for a half-written artifact
        // set and then be overwritten when that turn settles.
        if (!attempt || attempt.status !== 'completed') throw new WorkflowError('conflict', `step ${stepId} has no finished attempt to confirm`, 409);
        const verify = attempt.verify ?? { ok: false, artifacts: [], commands: [] };
        if (!verify.ok) throw new WorkflowError('conflict', 'a verifier is failing; answer not_done and prompt again, or skip the step', 409);
        step.checkpoint = await writeCheckpointFor({ run, step, attempt, verify });
        step.status = 'done';
        step.note = null;
        advance(run, stepId);
        run.status = run.cursor ? 'running' : hasOpenWork(run) ? 'waiting' : 'done';
      } else if (decision === 'skip') {
        step.status = 'skipped';
        step.note = reason;
        advance(run, stepId);
      } else {
        step.status = 'needs_work';
        step.note = reason ?? 'the person answered that the step is not done';
        run.status = 'waiting';
      }
      const saved = await store.write(run);
      emit(saved);
      return saved;
    },

    continueStep: async ({ projectId, projectPath, runId, stepId, text }) => {
      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (!trimmed) throw new WorkflowError('invalid', 'a continue prompt needs text');
      return withLock(projectId, async () => {
        const run = await loadRun(projectId, runId);
        const definition = await loadStepDefinition(projectId, run);
        const declared = definition.steps.find((entry) => entry.id === stepId);
        const step = findStep(run, stepId);
        const sessionId = step.attempts.at(-1)?.sessionId;
        if (!declared || !sessionId) throw new WorkflowError('conflict', `step ${stepId} has no session to continue`, 409);
        return runPromptInSession({ run, step, declared, sessionId, text: trimmed, projectPath });
      });
    },

    verifyStep: async ({ projectId, runId, stepId }) => {
      if (inFlight.has(projectId)) throw new WorkflowError('busy', 'this project already has a run executing a step', 409);
      const run = await loadRun(projectId, runId);
      const definition = await loadStepDefinition(projectId, run);
      const declared = definition.steps.find((entry) => entry.id === stepId);
      const step = findStep(run, stepId);
      const attempt = step.attempts.at(-1);
      if (!declared || !attempt) throw new WorkflowError('conflict', `step ${stepId} has not run yet`, 409);
      attempt.verify = await runChecks({ step: declared, directory: run.directory });
      step.note = attempt.verify.ok ? null : 'a verifier failed';
      const saved = await store.write(run);
      emit(saved);
      return saved;
    },

    cancelRun: async ({ projectId, runId }) => {
      // Cancelling writes the whole run, so it cannot run beside an attempt: that
      // attempt holds an older snapshot and would write it back over `cancelled`.
      // Stopping a turn that is in flight is the session's abort, not the run's.
      if (inFlight.has(projectId)) throw new WorkflowError('busy', 'a step is executing; stop its turn instead of the run', 409);
      const run = await loadRun(projectId, runId);
      run.status = 'cancelled';
      const saved = await store.write(run);
      emit(saved);
      return saved;
    },

    reconcile: () => reconcileRuns({
      store,
      host: requireHost(),
      verifyCheckpoint,
      listProjectIds,
      // A project with a step executing right now must not be written from a
      // snapshot taken before that attempt started.
      isProjectBusy: (projectId) => inFlight.has(projectId),
      logger,
    }),
  };
};
