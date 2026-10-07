import { afterEach, describe, expect, it, vi } from 'vitest';

import { configureOmpRuntimeHost } from '../agents/omp-host-access.js';
import { createSessionGoalRuntime } from './runtime.js';

/**
 * The goal record — status, turns, token accounting — lives in
 * OpenChamber's own session metadata store (the runtime reads it through the
 * injected `readSessionMetadata`/`persistSessionGoal` seams).
 *
 * What is pinned here is the wiring and the loop's reads of the OMP runtime:
 * the runtime stays inert and costs nothing when no store is given, it reads
 * the goal from the store rather than from the session record, and a goal that
 * starts or resumes arms the loop through `notifyGoalChanged` rather than
 * through a `session.updated` event (which no longer carries our metadata).
 *
 * The history the loop reads is the canonical `{ info, parts }` page the OMP
 * host serves, oldest first. OMP lists no subagent sessions, so the parent's
 * idle really is the end of the turn.
 */

const SESSION_ID = 'ses_parent';
const SESSION_RECORD = { id: SESSION_ID, sessionPath: '/sessions/parent.jsonl', cwd: '/repo', title: 'Parent' };
const runtimes = [];

const activeGoal = (extra = {}) => ({
  id: 'goal_1',
  objective: 'Finish the task',
  status: 'active',
  turnsUsed: 0,
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

const makeRuntime = (overrides = {}) => {
  const getSmallModelService = vi.fn(async () => {
    throw new Error('the small model must not be consulted in this test');
  });
  const emitGoalNotification = vi.fn();
  const runtime = createSessionGoalRuntime({
    getSmallModelService,
    emitGoalNotification,
    isEnabled: () => true,
    // Never the user's settings file: the classifier stays chosen, and with
    // no endpoint injected the small model checks, as on a fresh install.
    getChecker: () => 'classifier',
    idleQuietMs: 1,
    kickoffQuietMs: 1,
    ...overrides,
  });
  runtimes.push(runtime);
  return { runtime, getSmallModelService, emitGoalNotification };
};

const wired = (metadata = {}) => ({
  readSessionMetadata: vi.fn(async () => metadata),
  persistSessionGoal: vi.fn(async () => undefined),
});

const idle = (sessionID = SESSION_ID) => ({
  type: 'session.status',
  properties: { sessionID, status: { type: 'idle' } },
});

afterEach(() => {
  while (runtimes.length > 0) runtimes.pop().stop?.();
  configureOmpRuntimeHost(null);
  vi.restoreAllMocks();
});

/**
 * A fake OMP runtime: one session record, a busy flag per session, and the
 * canonical `{ info, parts }` history the host serves for every session.
 */
const stubOmp = ({ sessions = [SESSION_RECORD], items = [], busy = {} } = {}) => {
  const host = {
    listSessions: vi.fn(async () => sessions),
    getSessionStatus: vi.fn(async (id) => ({ busy: busy[id] === true })),
    getMessages: vi.fn(async () => ({ items, cursor: {} })),
    prompt: vi.fn(async () => true),
  };
  configureOmpRuntimeHost(() => host);
  return host;
};

/** Canonical `{ info, parts }` records, oldest first. */
const canonicalUser = (id, text, created = 1) => ({
  info: { id, sessionID: SESSION_ID, role: 'user', time: { created } },
  parts: text ? [{ type: 'text', text }] : [],
});

const canonicalAssistant = ({ text = 'Done with step one.', parts, ...info } = {}) => ({
  info: {
    id: 'msg_a1',
    sessionID: SESSION_ID,
    role: 'assistant',
    agent: 'build',
    providerID: 'anthropic',
    modelID: 'claude-sonnet-5',
    time: { created: 10, completed: 20 },
    finish: 'stop',
    tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 20, write: 0 } },
    ...info,
  },
  parts: parts ?? (text ? [{ type: 'text', text }] : []),
});

/** A finished compaction: the summary turn that closes a token segment. */
const canonicalCompaction = (created = 30) => ({
  info: {
    id: 'msg_c1',
    sessionID: SESSION_ID,
    role: 'compaction',
    status: 'completed',
    reason: 'auto',
    summary: 'Summary so far',
    time: { created },
  },
  parts: [{ type: 'text', text: 'Summary so far' }],
});

const smallModelSays = (answers) => JSON.stringify({ all_done: false, remaining: false, needs_user: false, ...answers });
const jevSays = (scores) => ({
  answers: Object.fromEntries(Object.entries({ all_done: 0.05, remaining: 0.05, needs_user: 0.05, ...scores }).map(([id, noul]) => [id, { noul }])),
  ms: 5,
});
const JEV_ENDPOINT = { url: 'https://jev.test', model: 'jev-1.13-free', headers: {} };

const quiet = () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
};

const runTick = async (runtime) => {
  await runtime.notifyGoalChanged(SESSION_ID, '/repo', { openchamber: { goal: activeGoal() } });
  // idleQuietMs / kickoffQuietMs are 1 ms; the tick itself is async.
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

describe('session goal tick on OMP messages', () => {
  it('reads the canonical assistant record, audits it, and continues on the same model and agent', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const host = stubOmp({ items: [canonicalUser('msg_u1', 'Finish the task', 1), canonicalAssistant()] });
    const seam = wired({ openchamber: { goal: activeGoal() } });
    const generate = vi.fn(async () => ({ text: smallModelSays({ remaining: true }), providerID: 'anthropic', modelID: 'claude-haiku-5' }));
    const { runtime } = makeRuntime({
      ...seam,
      getSmallModelService: async () => ({ generateSmallModelText: generate }),
    });

    await runTick(runtime);

    // The check saw the assistant's text and ran within the session's provider.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0]).toMatchObject({ preferredProviderID: 'anthropic', preferredModelID: 'claude-sonnet-5', restrictToPreferredProvider: true });
    expect(generate.mock.calls[0][0].prompt).toContain('Done with step one.');
    // Tokens were accounted from the canonical record: input + cache.read + output.
    const written = seam.persistSessionGoal.mock.calls.at(-1)[2];
    expect(written).toMatchObject({ turnsUsed: 1, tokensUsed: 170, evaluationProviderID: 'anthropic', evaluationModelID: 'claude-haiku-5' });
    // The continuation is one plain prompt: the session keeps its own model
    // and agent, nothing is re-selected.
    expect(host.prompt).toHaveBeenCalledTimes(1);
    expect(host.prompt.mock.calls[0][0]).toBe(SESSION_ID);
    expect(host.prompt.mock.calls[0][1]).toContain('Finish the task');
    runtime.stop();
  });

  it('settles the goal as complete when the report says all is done, without a continuation', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const host = stubOmp({ items: [canonicalAssistant()] });
    const seam = wired({ openchamber: { goal: activeGoal() } });
    const { runtime, emitGoalNotification } = makeRuntime({
      ...seam,
      getSmallModelService: async () => ({
        generateSmallModelText: async () => ({ text: smallModelSays({ all_done: true }) }),
      }),
    });

    await runTick(runtime);

    expect(seam.persistSessionGoal.mock.calls.at(-1)[2]).toMatchObject({ status: 'complete' });
    expect(host.prompt).not.toHaveBeenCalled();
    expect(emitGoalNotification).toHaveBeenCalledTimes(1);
    runtime.stop();
  });

  it('treats a finished compaction as a summary turn: no audit, continuation sent', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const host = stubOmp({ items: [canonicalAssistant(), canonicalCompaction()] });
    const seam = wired({ openchamber: { goal: activeGoal() } });
    const generate = vi.fn();
    const { runtime } = makeRuntime({ ...seam, getSmallModelService: async () => ({ generateSmallModelText: generate }) });

    await runTick(runtime);

    expect(generate).not.toHaveBeenCalled();
    expect(host.prompt).toHaveBeenCalledTimes(1);
    runtime.stop();
  });

  it('a compaction closes the token segment, so the goal keeps counting what came before it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubOmp({
      items: [
        canonicalAssistant(),
        canonicalCompaction(),
        canonicalAssistant({ id: 'msg_d1', tokens: { input: 30, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 40, completed: 50 } }),
      ],
    });
    const seam = wired({ openchamber: { goal: activeGoal() } });
    const { runtime } = makeRuntime(seam);

    await runTick(runtime);

    // 170 from the turn before the compaction, 50 from the one after it.
    expect(seam.persistSessionGoal.mock.calls.at(-1)[2]).toMatchObject({ tokensUsed: 220 });
    runtime.stop();
  });

  it('waits when the session is still running or the user just sent a message', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const generate = vi.fn();
    const busy = stubOmp({ items: [canonicalAssistant()], busy: { [SESSION_ID]: true } });
    const seam = wired({ openchamber: { goal: activeGoal() } });
    const { runtime } = makeRuntime({ ...seam, getSmallModelService: async () => ({ generateSmallModelText: generate }) });
    await runTick(runtime);
    expect(busy.prompt).not.toHaveBeenCalled();
    runtime.stop();

    const trailing = stubOmp({ items: [canonicalAssistant(), canonicalUser('msg_u2', 'wait', 50)] });
    const { runtime: second } = makeRuntime({ ...wired({ openchamber: { goal: activeGoal() } }), getSmallModelService: async () => ({ generateSmallModelText: generate }) });
    await runTick(second);
    expect(trailing.prompt).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    second.stop();
  });
});

describe('session goal tick and subagent sessions', () => {
  it('audits without waiting: the OMP runtime lists no subagent sessions', async () => {
    quiet();
    const host = stubOmp({ items: [canonicalAssistant()] });
    const seam = wired({ openchamber: { goal: activeGoal() } });
    const { runtime } = makeRuntime({
      ...seam,
      getSmallModelService: async () => ({
        generateSmallModelText: async () => ({ text: smallModelSays({ all_done: true }) }),
      }),
    });

    await runTick(runtime);

    expect(host.listSessions).toHaveBeenCalled();
    expect(host.getMessages).toHaveBeenCalled();
    expect(seam.persistSessionGoal).toHaveBeenCalled();
  });

  it('does not treat an unreadable session list as "no subagents"', async () => {
    quiet();
    const host = {
      listSessions: vi.fn(async () => { throw new Error('session store unavailable'); }),
      getSessionStatus: vi.fn(async () => ({ busy: false })),
      getMessages: vi.fn(async () => ({ items: [canonicalAssistant()], cursor: {} })),
      prompt: vi.fn(async () => true),
    };
    configureOmpRuntimeHost(() => host);
    const seam = wired({ openchamber: { goal: activeGoal() } });
    const { runtime } = makeRuntime(seam);

    await runTick(runtime);

    expect(host.listSessions).toHaveBeenCalled();
    expect(host.getMessages).not.toHaveBeenCalled();
    expect(host.prompt).not.toHaveBeenCalled();
    expect(seam.persistSessionGoal).not.toHaveBeenCalled();
  });
});

describe('session goal progress check', () => {
  it('asks Jev when it is the checker and a provider answers, and settles on its word', async () => {
    quiet();
    const host = stubOmp({ items: [canonicalAssistant()] });
    const seam = wired({ openchamber: { goal: activeGoal({ evaluationProviderID: 'anthropic', evaluationModelID: 'claude-haiku-5' }) } });
    const jev = { ask: vi.fn(async () => jevSays({ all_done: 0.9 })) };
    const { runtime, getSmallModelService } = makeRuntime({ ...seam, jev, classifierEndpoint: async () => JEV_ENDPOINT });

    await runTick(runtime);

    const [request, endpoint] = jev.ask.mock.calls[0];
    expect(endpoint).toBe(JEV_ENDPOINT);
    expect(request.state).toEqual({ objective: 'Finish the task', answer: 'Done with step one.' });
    expect(Object.keys(request.questions)).toEqual(['all_done', 'remaining', 'needs_user']);
    expect(getSmallModelService).not.toHaveBeenCalled();
    // Jev has no provider: a leftover small-model provider must not be paired with Jev's model.
    expect(seam.persistSessionGoal.mock.calls.at(-1)[2]).toMatchObject({ status: 'complete', evaluationProviderID: '', evaluationModelID: 'jev-1.13-free' });
    expect(host.prompt).not.toHaveBeenCalled();
  });

  it('keeps going while the report names work the agent still has to do', async () => {
    quiet();
    const host = stubOmp({ items: [canonicalAssistant()] });
    const seam = wired({ openchamber: { goal: activeGoal() } });
    const jev = { ask: vi.fn(async () => jevSays({ all_done: 0.9, remaining: 0.8 })) };
    const { runtime } = makeRuntime({ ...seam, jev, classifierEndpoint: async () => JEV_ENDPOINT });

    await runTick(runtime);

    expect(seam.persistSessionGoal.mock.calls.at(-1)[2]).toMatchObject({ status: 'active', turnsUsed: 1 });
    expect(host.prompt).toHaveBeenCalledTimes(1);
  });

  it('settles as blocked on the first turn that waits for the user, without a continuation', async () => {
    quiet();
    const host = stubOmp({ items: [canonicalAssistant()] });
    const seam = wired({ openchamber: { goal: activeGoal() } });
    const jev = { ask: vi.fn(async () => jevSays({ all_done: 0.9, needs_user: 0.9 })) };
    const { runtime, emitGoalNotification } = makeRuntime({ ...seam, jev, classifierEndpoint: async () => JEV_ENDPOINT });

    await runTick(runtime);

    expect(seam.persistSessionGoal.mock.calls.at(-1)[2]).toMatchObject({ status: 'blocked', statusReason: 'waiting for user input' });
    expect(host.prompt).not.toHaveBeenCalled();
    expect(emitGoalNotification).toHaveBeenCalledTimes(1);
  });

  it('checks with the small model when Jev fails this time', async () => {
    quiet();
    stubOmp({ items: [canonicalAssistant()] });
    const seam = wired({ openchamber: { goal: activeGoal() } });
    const jev = { ask: vi.fn(async () => { throw new Error('Jev responded 503'); }) };
    const generate = vi.fn(async () => ({ text: smallModelSays({ all_done: true }), providerID: 'anthropic', modelID: 'claude-haiku-5' }));
    const { runtime } = makeRuntime({
      ...seam,
      jev,
      classifierEndpoint: async () => JEV_ENDPOINT,
      getSmallModelService: async () => ({ generateSmallModelText: generate }),
    });

    await runTick(runtime);

    expect(jev.ask).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(seam.persistSessionGoal.mock.calls.at(-1)[2]).toMatchObject({ status: 'complete', evaluationModelID: 'claude-haiku-5' });
  });

  it('never asks Jev when the user picked the small model', async () => {
    quiet();
    stubOmp({ items: [canonicalAssistant()] });
    const seam = wired({ openchamber: { goal: activeGoal() } });
    const jev = { ask: vi.fn() };
    const generate = vi.fn(async () => ({ text: smallModelSays({ remaining: true }), providerID: 'anthropic', modelID: 'claude-haiku-5' }));
    const { runtime } = makeRuntime({
      ...seam,
      jev,
      classifierEndpoint: async () => JEV_ENDPOINT,
      getChecker: () => 'small-model',
      getSmallModelService: async () => ({ generateSmallModelText: generate }),
    });

    await runTick(runtime);

    expect(jev.ask).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('counts a small-model reply that is not the asked-for JSON as no check', async () => {
    quiet();
    const host = stubOmp({ items: [canonicalAssistant()] });
    const seam = wired({ openchamber: { goal: activeGoal() } });
    const generate = vi.fn(async () => ({ text: '{"verdict":"complete"}' }));
    const { runtime } = makeRuntime({ ...seam, getSmallModelService: async () => ({ generateSmallModelText: generate }) });

    await runTick(runtime);

    // One unchecked continuation is tolerated; the goal is not settled on a guess.
    expect(seam.persistSessionGoal.mock.calls.at(-1)[2]).toMatchObject({ status: 'active', auditFailStreak: 1 });
    expect(host.prompt).toHaveBeenCalledTimes(1);
  });
});

describe('session goal runtime', () => {
  it('arms the loop when a goal starts, without reading the runtime for it', async () => {
    const host = stubOmp();
    const seam = wired();
    const { runtime } = makeRuntime(seam);

    await runtime.notifyGoalChanged('ses_1', '/repo', { openchamber: { goal: activeGoal() } });
    // The kickoff timer is armed; the directory came with the notification, so
    // nothing had to be looked up.
    expect(host.listSessions).not.toHaveBeenCalled();
    runtime.stop();
  });

  it('looks the directory up when a UI patch does not name one', async () => {
    const host = stubOmp({ sessions: [{ id: 'ses_1', sessionPath: '/sessions/1.jsonl', cwd: '/resolved', title: '' }] });
    const seam = wired();
    const { runtime } = makeRuntime(seam);

    await runtime.notifyGoalChanged('ses_1', '', { openchamber: { goal: activeGoal() } });

    expect(host.listSessions).toHaveBeenCalledTimes(1);
    runtime.stop();
  });

  it('does not arm for a goal that is not active or already under way', async () => {
    const host = stubOmp();
    const seam = wired();
    const { runtime } = makeRuntime(seam);

    await runtime.notifyGoalChanged('ses_1', '', { openchamber: { goal: activeGoal({ status: 'paused' }) } });
    await runtime.notifyGoalChanged('ses_1', '', { openchamber: { goal: activeGoal({ turnsUsed: 3 }) } });
    await runtime.notifyGoalChanged('ses_1', '', {});

    expect(host.listSessions).not.toHaveBeenCalled();
    runtime.stop();
  });

  it('does no work and reaches no service while no goal store is injected', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const host = stubOmp();
    const { runtime, getSmallModelService, emitGoalNotification } = makeRuntime();

    runtime.processPayload(idle());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(host.listSessions).not.toHaveBeenCalled();
    expect(getSmallModelService).not.toHaveBeenCalled();
    expect(emitGoalNotification).not.toHaveBeenCalled();
  });

  it('explains itself once, not on every event', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runtime } = makeRuntime();

    runtime.processPayload(idle('ses_1'));
    runtime.processPayload(idle('ses_2'));
    runtime.processPayload({ type: 'session.updated', properties: { info: { id: 'ses_3' } } });

    const notices = log.mock.calls.filter(([line]) => String(line).includes('[session-goal] parked'));
    expect(notices).toHaveLength(1);
  });

  it('ignores everything after stop', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runtime } = makeRuntime();

    runtime.stop();
    runtime.processPayload(idle());

    expect(log).not.toHaveBeenCalled();
  });

  it('reads a user abort off the aborted idle event', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    stubOmp();
    const { runtime } = makeRuntime(wired());

    expect(() => runtime.processPayload({
      type: 'session.idle',
      properties: { sessionID: SESSION_ID, aborted: true, reason: 'user' },
    })).not.toThrow();
  });
});
