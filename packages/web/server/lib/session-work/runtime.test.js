import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureOmpRuntimeHost } from '../agents/omp-host-access.js';
import { mergeMetadataPatch } from '../openchamber-sessions/session-metadata-store.js';
import { decideAssist, decideOpen } from './questions.js';
import { createSessionWorkRuntime } from './runtime.js';
import { createSessionLineage } from '../session-lineage.js';

const ENDPOINT = { url: 'https://jev.test', model: 'jev', headers: {} };

// The canonical `{ info, parts }` records the OMP runtime serves, oldest first.
const user = (id, text, created = 1) => ({
  info: { id, role: 'user', time: { created } },
  parts: text ? [{ type: 'text', text }] : [],
});
const assistant = (id, text, { created = 1, completed = 2, finish = 'stop' } = {}) => ({
  info: { id, role: 'assistant', time: { created, completed }, finish, providerID: 'provider', modelID: 'model' },
  parts: text ? [{ type: 'text', text }] : [],
});

const settledPair = [
  user('msg_u1', 'How does the sidebar work?', 1),
  assistant('msg_a1', 'Here is how it works.', { created: 1, completed: 2 }),
];
const answeredTurn = [
  ...settledPair,
  user('msg_u2', 'Implement it', 3),
  assistant('msg_a2', 'Done, try it.', { created: 3, completed: 4 }),
];

const DEFAULT_SESSION = { id: 'ses_1', sessionPath: '/sessions/ses_1.json', cwd: '/repo', title: 'Session' };

const stubOmp = ({ sessions = [DEFAULT_SESSION], records = answeredTurn } = {}) => {
  const host = {
    listSessions: vi.fn(async () => sessions),
    getMessages: vi.fn(async () => ({ items: records, cursor: {} })),
  };
  configureOmpRuntimeHost(() => host);
  return host;
};

const makeRuntime = ({ metadata = {}, answers = {}, askError = null, settings = {}, endpoint = ENDPOINT, lineage = null } = {}) => {
  const records = new Map([['ses_1', metadata]]);
  const updateMetadata = vi.fn(async (id, decide) => {
    const current = records.get(id) ?? {};
    const patch = decide(current);
    if (!patch) return { metadata: current, changed: false };
    const merged = mergeMetadataPatch(current, patch);
    records.set(id, merged);
    return { metadata: merged, changed: true };
  });
  const jev = { ask: vi.fn(async () => { if (askError) throw askError; return { answers, ms: 5 }; }) };
  let time = 100;
  const runtime = createSessionWorkRuntime({
    getSettings: () => ({ enabled: true, autoOpen: true, ...settings }),
    classifierEndpoint: async () => endpoint,
    jev,
    readMetadata: async (id) => records.get(id) ?? {},
    updateMetadata,
    chatRoots: ['/home/me/.config/openchamber/chats'],
    lineage,
    now: () => time++,
  });
  return { runtime, jev, updateMetadata, records };
};

const sent = (id = 'msg_new', text = 'Now fix the header') => ({
  type: 'message.updated',
  properties: { sessionID: 'ses_1', info: { id, role: 'user', text, time: { created: 50 } } },
});

const settle = async (check) => {
  for (let i = 0; i < 50 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

afterEach(() => {
  configureOmpRuntimeHost(null);
  vi.restoreAllMocks();
});

describe('session work decisions', () => {
  it('opens when either measured question passes its threshold', () => {
    expect(decideOpen({ change: { noul: 0.86 } })).toBe(true);
    expect(decideOpen({ change: { noul: 0.84 }, toward_change: { noul: 0.91 } })).toBe(true);
    expect(decideOpen({ change: { noul: 0.84 }, toward_change: { noul: 0.89 } })).toBe(false);
    expect(decideOpen({})).toBe(false);
  });

  it('keeps an assist field Jev did not answer, and drops only a clear no', () => {
    expect(decideAssist({})).toEqual({ recap: true, suggestion: true });
    expect(decideAssist({ recap: { noul: 0.2 }, next_step: { noul: 0.1 } })).toEqual({ recap: false, suggestion: false });
    expect(decideAssist({ recap: { noul: 0.6 }, next_step: { noul: 0.7 } })).toEqual({ recap: true, suggestion: true });
  });
});

describe('session work runtime: a message was sent', () => {
  it('asks Jev on the new message with the settled turns as history, and opens the session', async () => {
    stubOmp({ records: [...settledPair, user('msg_new', 'Now fix the header', 50)] });
    const { runtime, jev, records } = makeRuntime({ answers: { change: { noul: 0.95 }, toward_change: { noul: 0.9 } } });

    runtime.processPayload(sent());
    await settle(() => records.get('ses_1').openchamber);

    const [request] = jev.ask.mock.calls[0];
    expect(request.state.request).toBe('Now fix the header');
    expect(request.state.history.map((entry) => entry.role)).toEqual(['user', 'assistant']);
    expect(Object.keys(request.questions)).toEqual(['change', 'toward_change']);
    expect(records.get('ses_1')).toMatchObject({ openchamber: { work: { state: 'open', openedBy: 'jev' } } });
  });

  it('does not ask again for a session already in work, or for the same message twice', async () => {
    stubOmp();
    const open = makeRuntime({ metadata: { openchamber: { work: { state: 'open' } } } });
    open.runtime.processPayload(sent());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(open.jev.ask).not.toHaveBeenCalled();

    const fresh = makeRuntime({ answers: { change: { noul: 0.1 } } });
    fresh.runtime.processPayload(sent('msg_x'));
    fresh.runtime.processPayload(sent('msg_x'));
    await settle(() => fresh.jev.ask.mock.calls.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fresh.jev.ask).toHaveBeenCalledTimes(1);
    expect(fresh.updateMetadata).not.toHaveBeenCalled();
  });

  it('skips a known subsession without reading it, and learns one it had to read', async () => {
    const lineage = createSessionLineage();
    lineage.remember('ses_1', 'ses_parent');
    const host = stubOmp();
    const known = makeRuntime({ lineage, answers: { change: { noul: 1 } } });
    known.runtime.processPayload(sent());
    expect(await known.runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: true, suggestion: true } })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.listSessions).not.toHaveBeenCalled();
    expect(host.getMessages).not.toHaveBeenCalled();
    expect(known.jev.ask).not.toHaveBeenCalled();

    // OMP exposes no parent, so a session read anyway is learned as top-level.
    const learning = createSessionLineage();
    stubOmp();
    const unknown = makeRuntime({ lineage: learning });
    await unknown.runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: true, suggestion: true } });
    expect(learning.isChild('ses_1')).toBe(false);
  });

  it('asks nothing with auto-open off, without Jev, or in a review or chat session', async () => {
    for (const setup of [
      { runtime: { settings: { autoOpen: false } } },
      { runtime: { endpoint: null } },
      { runtime: { metadata: { openchamber: { kind: 'review', originalSessionID: 'ses_0' } } } },
      { sessions: [{ ...DEFAULT_SESSION, cwd: '/home/me/.config/openchamber/chats/2026-09-27/hello' }] },
    ]) {
      stubOmp({ sessions: setup.sessions });
      const { runtime, jev } = makeRuntime({ answers: { change: { noul: 1 } }, ...setup.runtime });
      runtime.processPayload(sent());
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(jev.ask).not.toHaveBeenCalled();
    }
  });
});

describe('session work runtime: a turn ended', () => {
  it('asks the open questions and the assist questions in one call, and opens on the answer', async () => {
    stubOmp();
    const { runtime, jev, records } = makeRuntime({
      answers: { change: { noul: 0.97 }, recap: { noul: 0.9 }, next_step: { noul: 0.1 } },
    });

    const gate = await runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: true, suggestion: true } });

    expect(jev.ask).toHaveBeenCalledTimes(1);
    expect(Object.keys(jev.ask.mock.calls[0][0].questions).sort()).toEqual(['change', 'next_step', 'recap', 'toward_change']);
    expect(jev.ask.mock.calls[0][0].state).toMatchObject({ request: 'Implement it', answer: 'Done, try it.' });
    expect(gate).toEqual({ recap: true, suggestion: false });
    expect(records.get('ses_1')).toMatchObject({ openchamber: { work: { state: 'open' } } });
  });

  it('asks only whether the work looks done in a session already in work, and a new turn retires the hint', async () => {
    stubOmp();
    const { runtime, jev, records, updateMetadata } = makeRuntime({
      metadata: { openchamber: { work: { state: 'open', openedAt: 1 } } },
      answers: { wrap_up: { noul: 0.93 } },
    });

    const gate = await runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: false, suggestion: false } });

    expect(Object.keys(jev.ask.mock.calls[0][0].questions)).toEqual(['wrap_up']);
    expect(gate).toBeNull();
    expect(records.get('ses_1').openchamber.work.suggestDoneAt).toBeTypeOf('number');

    const busy = { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } };
    runtime.processPayload(busy);
    runtime.processPayload(busy);
    await settle(() => records.get('ses_1').openchamber.work.suggestDoneAt === undefined);
    expect(records.get('ses_1').openchamber.work).not.toHaveProperty('suggestDoneAt');
    // One write for the hint, one to retire it: the second busy found nothing to retire.
    expect(updateMetadata).toHaveBeenCalledTimes(2);
  });

  it('drops a late done answer once the next turn started', async () => {
    stubOmp();
    const { runtime, jev, records } = makeRuntime({
      metadata: { openchamber: { work: { state: 'open', openedAt: 1 } } },
    });
    let answer;
    jev.ask.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));

    const busy = { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } };
    // The ordinary lifecycle, several turns in a row: every turn starts with a
    // busy, ends, gets checked, and the user moves on before Jev answers.
    for (let turn = 0; turn < 3; turn += 1) {
      answer = undefined;
      runtime.processPayload(busy);
      const pending = runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: false, suggestion: false } });
      await settle(() => answer !== undefined);
      runtime.processPayload(busy);
      answer({ answers: { wrap_up: { noul: 0.99 } }, ms: 5 });
      await pending;
      expect(records.get('ses_1').openchamber.work).not.toHaveProperty('suggestDoneAt');
    }

    // A check nobody overtook still writes its hint.
    answer = undefined;
    const current = runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: false, suggestion: false } });
    await settle(() => answer !== undefined);
    answer({ answers: { wrap_up: { noul: 0.99 } }, ms: 5 });
    await current;
    expect(records.get('ses_1').openchamber.work.suggestDoneAt).toBeTypeOf('number');
  });

  it('never closes: a closing turn in a session in work only hints', async () => {
    stubOmp();
    const { runtime, records } = makeRuntime({
      metadata: { openchamber: { work: { state: 'open', openedAt: 1 } } },
      answers: { wrap_up: { noul: 0.99 }, change: { noul: 0 } },
    });
    await runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: false, suggestion: false } });
    expect(records.get('ses_1').openchamber.work.state).toBe('open');
  });

  it('answers unknown on a Jev failure and changes nothing', async () => {
    stubOmp();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtime, updateMetadata } = makeRuntime({ askError: new Error('Jev timed out after 4000ms') });

    const gate = await runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: true, suggestion: true } });

    expect(gate).toBeNull();
    expect(updateMetadata).not.toHaveBeenCalled();
  });

  it('makes no call when the feature and both assist fields are off', async () => {
    const host = stubOmp();
    const { runtime, jev } = makeRuntime({ settings: { enabled: false } });
    expect(await runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: false, suggestion: false } })).toBeNull();
    expect(jev.ask).not.toHaveBeenCalled();
    expect(host.listSessions).not.toHaveBeenCalled();
    expect(host.getMessages).not.toHaveBeenCalled();
  });
});
