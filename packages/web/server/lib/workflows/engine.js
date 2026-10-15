/**
 * The run loop.
 *
 * One attempt is: create or adopt a session, send the prompt, wait for the turn
 * to end, run the verifiers, then stop for a person. Every fact the engine
 * records comes from the runtime, from disk, or from the verifiers; a step never
 * advances because a model said it was done, and it is `done` only once a person
 * says so. Whether the step's work is committed is the step's own prompt's
 * business: the engine writes no commit.
 *
 * Two writers are impossible by construction: an in-flight map holds the project
 * ids currently executing, and `runUntilStop` stops at the first stop, so a
 * second click answers `busy` instead of starting a second attempt.
 */
import { substituteInputs } from './prompts.js';
import { reconcileRuns as defaultReconcile } from './resume.js';
import { prepareSandbox, releaseSandbox as releaseRunSandbox } from './sandbox.js';
import { runVerifiers as defaultRunChecks, recheckArtifacts as defaultRecheckArtifacts } from './verifiers.js';

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

/** Step statuses a fresh verdict moves, in the direction that verdict points. */
const VERIFIER_PASS_STATUSES = new Set(['needs_work', 'blocked', 'interrupted']);
const VERIFIER_FAIL_STATUSES = new Set(['waiting_confirm', 'interrupted', 'blocked']);
/** A note the artifact re-check wrote; a verifier has no say over it. */
const ARTIFACT_NOTE_PREFIX = 'an artifact no longer matches';

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
  runChecks = defaultRunChecks,
  recheckArtifacts = defaultRecheckArtifacts,
  reconcileRuns = defaultReconcile,
  // The git driver for a run's worktree, injected by the runtime as a lazy
  // loader so the 6000-line git service is not imported at server boot. Only
  // read on the `worktree` path, which is why a fixture without it still runs
  // every `working-tree` case.
  worktrees = null,
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
      broadcast({ type: 'openchamber:workflow', properties: { runId: run.runId, projectId: run.projectId, status: run.status, cursor: run.cursor, worktreeReleasedAt: run.worktreeReleasedAt ?? null, steps: run.steps.map((step) => ({ id: step.id, status: step.status })) } });
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

  /**
   * A run that has stopped for good has no step left to run. Without this,
   * `cancelRun` followed by any per-step call would start a fresh attempt, set
   * the run back to `running` and spend tokens on a run the person called off.
   */
  const assertRunIsOpen = (run) => {
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      throw new WorkflowError('conflict', `run ${run.runId} is ${run.status}`, 409);
    }
    return run;
  };

  /**
   * A step whose record is already written down does not run again in this run:
   * a `done` step is work a person confirmed and a skipped step is a decision
   * they made.
   */
  const assertStepIsOpen = (step) => {
    if (step.status === 'done' || step.status === 'skipped') {
      throw new WorkflowError('conflict', `step ${step.id} is already settled`, 409);
    }
    return step;
  };

  const attemptStep = async ({ projectId, projectPath, runId, stepId }) => {
    const run = assertRunIsOpen(await loadRun(projectId, runId));
    const definition = await loadStepDefinition(projectId, run);
    const declared = definition.steps.find((entry) => entry.id === stepId);
    if (!declared) throw new WorkflowError('not-found', `step ${stepId} is not declared by ${run.workflowId}`, 404);
    const step = assertStepIsOpen(findStep(run, stepId));

    const { text, missing } = substituteInputs(declared.prompt, run.inputs ?? {});
    if (missing.length > 0) {
      step.status = 'blocked';
      step.note = `missing input: ${missing.join(', ')}`;
      run.status = 'waiting';
      const saved = await store.write(projectId, run);
      emit(saved);
      return saved;
    }

    // A run in `worktree` mode executes in its own checkout from its first step
    // on. A refusal blocks the step instead of falling back: running in the
    // project's working tree while the run says `worktree` is the opposite of
    // what the person asked for, and they would only learn it from the diff.
    // This sits after the missing-input return: a step that is about to block
    // for want of an input has nothing to run, and provisioning a checkout for
    // it would leave a worktree and a branch the run never got to use.
    if (run.sandbox === 'worktree' && (!run.worktreeBranch || run.directory === projectPath)) {
      try {
        const prepared = await prepareSandbox({ run, projectPath, git: worktrees });
        run.directory = prepared.directory;
        run.worktreeBranch = prepared.branch;
        emit(await store.write(projectId, run));
      } catch (error) {
        step.status = 'blocked';
        step.note = `the run could not get its own worktree: ${error?.message ?? error}`;
        run.status = 'waiting';
        const saved = await store.write(projectId, run);
        emit(saved);
        return saved;
      }
    }

    const bus = requireHost();
    let sessionId = declared.session === 'reuse' ? previousSessionId(run, stepId) : null;
    if (!sessionId) {
      const created = await bus.createSession({ cwd: run.directory });
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
        await bus.setAutoAccept(sessionId, true, run.directory);
      } catch (error) {
        logger.warn?.('[workflows] could not enable permission auto-accept', error?.message ?? error);
      }
    }

    run.cursor = stepId;
    return runPromptInSession({ projectId, run, step, declared, sessionId, text });
  };

  /**
   * The "prompt, wait, verify, decide" body: a first attempt and a person's
   * continue prompt both send text into the recorded session, wait for the turn
   * to finish, run the verifiers, then stop for a person or advance. The
   * refused-prompt and never-started paths live here so they exist once.
   */
  const runPromptInSession = async ({ projectId, run, step, declared, sessionId, text }) => {
    const bus = requireHost();
    if (declared.permissions === 'auto') {
      // The host is wired per call and may not carry a toggle at all, so the
      // optional call is awaited directly: chaining `.catch` onto `undefined`
      // throws before the attempt has even been sent.
      try {
        await bus.setAutoAccept?.(sessionId, true, run.directory);
      } catch (error) {
        logger.warn?.('[workflows] could not enable permission auto-accept', error?.message ?? error);
      }
    }
    const attempt = { index: step.attempts.length, sessionId, prompt: text, startedAt: now(), endedAt: null, status: 'running', turn: null, verify: null, error: null };
    step.attempts.push(attempt);
    step.status = 'running';
    run.status = 'running';
    const started = await store.write(projectId, run);
    // The request that starts the attempt answers only when the turn is over, so
    // this frame is the only way a screen learns the step is running.
    emit(started);
    // Everything from the send to the settle lives inside this `try`: a
    // rejection here — the prompt, the turn's status call or the run file
    // itself — would otherwise leave the attempt `running` and the run file
    // claiming a live turn for the rest of the process's life.
    try {
      const accepted = await bus.prompt(sessionId, text);
      if (accepted !== true) {
        attempt.status = 'blocked';
        attempt.endedAt = now();
        attempt.error = { code: 'unavailable', message: 'the OMP runtime did not take the prompt' };
        step.status = 'blocked';
        step.note = attempt.error.message;
        run.status = 'waiting';
        const saved = await store.write(projectId, run);
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
        const saved = await store.write(projectId, run);
        emit(saved);
        return saved;
      }
      return await settleAttempt({ projectId, run, step, declared, attempt });
    } catch (error) {
      attempt.status = 'blocked';
      attempt.endedAt = now();
      attempt.error = { code: 'unavailable', message: error?.message ?? 'the attempt failed' };
      step.status = 'blocked';
      step.note = attempt.error.message;
      run.status = 'waiting';
      const saved = await store.write(projectId, run);
      emit(saved);
      return saved;
    }
  };

  /** Run the verifiers and record the outcome of one completed attempt. */
  const settleAttempt = async ({ projectId, run, step, declared, attempt }) => {
    const verify = await runChecks({ step: declared, directory: run.directory });
    attempt.verify = verify;
    attempt.status = 'completed';
    step.note = verify.ok ? null : 'a verifier failed';
    // A passing verifier only puts the step in front of a person: whether its
    // work is done is their answer, never the engine's.
    step.status = verify.ok ? 'waiting_confirm' : 'needs_work';
    run.status = 'waiting';
    const saved = await store.write(projectId, run);
    emit(saved);
    return saved;
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
    // One lock for the whole loop, not one per step: with a lock per step the
    // project is unheld between two iterations, and a `cancelRun` or a second
    // `run` landing in that gap would be written back over by the loop's next
    // write.
    runUntilStop: ({ projectId, projectPath, runId }) => withLock(projectId, async () => {
      const start = assertRunIsOpen(await loadRun(projectId, runId));
      const firstStepId = start.cursor ?? start.steps.find((step) => step.status === 'pending')?.id;
      if (!firstStepId) throw new WorkflowError('conflict', `run ${runId} has no step left to run`, 409);
      // A run already stopped for a person is returned as it stands: running
      // until the next stop must not start a fresh turn on a step nobody has
      // answered yet.
      const cursorStep = start.steps.find((step) => step.id === firstStepId);
      if (cursorStep && STOPS.has(cursorStep.status)) return start;
      let run = await attemptStep({ projectId, projectPath, runId, stepId: firstStepId });
      while (run.cursor && !STOPS.has(run.steps.find((step) => step.id === run.cursor)?.status ?? 'pending')) {
        const next = run.cursor;
        run = await attemptStep({ projectId, projectPath, runId, stepId: next });
      }
      return run;
    }),

    confirmStep: async ({ projectId, runId, stepId, decision, reason = null }) => {
      if (inFlight.has(projectId)) throw new WorkflowError('busy', 'this project already has a run executing a step', 409);
      const run = assertRunIsOpen(await loadRun(projectId, runId));
      const step = findStep(run, stepId);
      if (!['done', 'not_done', 'skip'].includes(decision)) throw new WorkflowError('invalid', `unknown decision "${decision}"`);
      if (decision === 'done') {
        const attempt = step.attempts.at(-1);
        // Only a turn that finished can be confirmed: confirming an attempt that
        // is still in flight would confirm a half-written artifact set and then
        // be overwritten when that turn settles.
        if (!attempt || attempt.status !== 'completed') throw new WorkflowError('conflict', `step ${stepId} has no finished attempt to confirm`, 409);
        const verify = attempt.verify ?? { ok: false, artifacts: [], commands: [] };
        if (!verify.ok) throw new WorkflowError('conflict', 'a verifier is failing; answer not_done and prompt again, or skip the step', 409);
        step.status = 'done';
        step.note = null;
        advance(run, stepId);
        run.status = run.cursor ? 'running' : hasOpenWork(run) ? 'waiting' : 'done';
      } else if (decision === 'skip') {
        step.status = 'skipped';
        step.note = reason;
        advance(run, stepId);
        // A skipped step still settles the run: without this the run keeps
        // reading `running` with no step left to run, and neither `runUntilStop`
        // nor the restart sweep can move it again.
        run.status = run.cursor ? 'running' : hasOpenWork(run) ? 'waiting' : 'done';
      } else {
        step.status = 'needs_work';
        step.note = reason ?? 'the person answered that the step is not done';
        run.status = 'waiting';
      }
      const saved = await store.write(projectId, run);
      emit(saved);
      return saved;
    },

    continueStep: async ({ projectId, runId, stepId, text }) => {
      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (!trimmed) throw new WorkflowError('invalid', 'a continue prompt needs text');
      return withLock(projectId, async () => {
        const run = assertRunIsOpen(await loadRun(projectId, runId));
        const definition = await loadStepDefinition(projectId, run);
        const declared = definition.steps.find((entry) => entry.id === stepId);
        const step = findStep(run, stepId);
        const sessionId = step.attempts.at(-1)?.sessionId;
        if (!declared || !sessionId) throw new WorkflowError('conflict', `step ${stepId} has no session to continue`, 409);
        return runPromptInSession({ projectId, run, step, declared, sessionId, text: trimmed });
      });
    },

    verifyStep: async ({ projectId, runId, stepId }) => {
      if (inFlight.has(projectId)) throw new WorkflowError('busy', 'this project already has a run executing a step', 409);
      const run = assertRunIsOpen(await loadRun(projectId, runId));
      const definition = await loadStepDefinition(projectId, run);
      const declared = definition.steps.find((entry) => entry.id === stepId);
      const step = findStep(run, stepId);
      const attempt = step.attempts.at(-1);
      if (!declared || !attempt) throw new WorkflowError('conflict', `step ${stepId} has not run yet`, 409);
      attempt.verify = await runChecks({ step: declared, directory: run.directory });
      // A fresh verdict is also a fresh status: a step waiting on a check that
      // now fails reads `needs_work`, and one whose check passes goes back to
      // waiting for the person. A note the artifact re-check wrote stays,
      // because a changed artifact is still a fact whatever this verifier says.
      if (attempt.verify.ok && VERIFIER_PASS_STATUSES.has(step.status)) step.status = 'waiting_confirm';
      if (!attempt.verify.ok && VERIFIER_FAIL_STATUSES.has(step.status)) step.status = 'needs_work';
      if (!(typeof step.note === 'string' && step.note.startsWith(ARTIFACT_NOTE_PREFIX))) {
        step.note = attempt.verify.ok ? null : 'a verifier failed';
      }
      const saved = await store.write(projectId, run);
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
      const saved = await store.write(projectId, run);
      emit(saved);
      return saved;
    },

    /**
     * Take a finished run's checkout away and leave its branch.
     *
     * The checkout is tidiness, the branch is the work: a person merges it
     * themselves, so nothing here touches a branch. An in-flight run is refused
     * because it is still writing into that checkout — and because `waiting` may
     * still be answered, which would start a fresh attempt in a directory this
     * call had just removed.
     *
     * It takes the project's lock for the same reason `cancelRun` refuses while
     * one is held: this writes the whole run. During the first step's
     * provisioning window the run on disk still reads `idle` — `attemptStep`
     * records `directory`/`worktreeBranch` before it flips the status — so
     * without the lock a release landing there would pass the status guard,
     * remove the checkout the step is about to open a session in, and stamp the
     * run; the engine would then create a session whose `cwd` is gone and the
     * next write would overwrite the stamp, leaving `prepareSandbox` to reuse
     * the dead path. Holding the lock refuses that release `busy`, and the lock
     * it holds while removing a checkout refuses the step actions too.
     */
    releaseSandbox: ({ projectId, projectPath, runId }) => withLock(projectId, async () => {
      const run = await loadRun(projectId, runId);
      if (run.status === 'running' || run.status === 'waiting') {
        throw new WorkflowError('conflict', `run ${runId} is still running`, 409);
      }
      // A run that never took a checkout — a `working-tree` run, or one that
      // stopped before its first step — has nothing to release. Answering it as
      // it stands keeps `worktreeReleasedAt` meaning "a checkout was removed".
      if (run.sandbox !== 'worktree' || !run.worktreeBranch || run.worktreeReleasedAt) return run;
      const { removed } = await releaseRunSandbox({ run, projectPath, git: worktrees });
      if (!removed) return run;
      run.worktreeReleasedAt = now();
      const saved = await store.write(projectId, run);
      emit(saved);
      return saved;
    }),

    reconcile: () => reconcileRuns({
      store,
      host: requireHost(),
      recheckArtifacts,
      listProjectIds,
      // A project with a step executing right now must not be written from a
      // snapshot taken before that attempt started.
      isProjectBusy: (projectId) => inFlight.has(projectId),
      now,
      logger,
    }),
  };
};
