import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureOmpRuntimeHost } from '../agents/omp-host-access.js';
import { createSessionLineage } from '../session-lineage.js';
import { createSessionAssistRuntime } from './runtime.js';

/**
 * The recap and the suggestion live in OpenChamber's own session metadata
 * store, because the runtime accepts session metadata only at create time.
 * `persistSessionAssist` is the seam. What is pinned here is the wiring: no
 * store means no work and no cost, and injecting one turns generation back on.
 *
 * The runtime is the OMP host: reads go through `readSessions` /
 * `readSessionMessages`, whose records are the canonical `{ info, parts }`
 * shape. The reader itself is covered by `context.test.js`.
 */

const SES = 'ses_1';

const userItem = (id, text) => ({
  info: { id, sessionID: SES, role: 'user', time: { created: 1 } },
  parts: [{ id: `${id}:text:0`, sessionID: SES, messageID: id, type: 'text', text }],
});

const assistantItem = (id, text, extra = {}) => ({
  info: {
    id,
    sessionID: SES,
    role: 'assistant',
    time: { created: 1, completed: 2 },
    agent: '',
    providerID: 'p',
    modelID: 'm',
    finish: 'stop',
    ...extra,
  },
  parts: [{ id: `${id}:text:0`, sessionID: SES, messageID: id, type: 'text', text }],
});

const createHost = (overrides = {}) => ({
  listSessions: vi.fn(async () => [{ id: SES, sessionPath: '/s/ses_1.json', cwd: '/repo', title: '' }]),
  getMessages: vi.fn(async () => ({
    items: [userItem('msg_u', 'Do the thing'), assistantItem('msg_a', 'All done.')],
    cursor: {},
  })),
  ...overrides,
});

const runtimes = [];

const makeRuntime = (overrides = {}) => {
  const getSmallModelService = vi.fn(async () => {
    throw new Error('the small model must not be consulted while assist is parked');
  });
  const runtime = createSessionAssistRuntime({
    getSmallModelService,
    getTargets: () => ({ recap: true, suggestion: true }),
    quietMs: 1,
    ...overrides,
  });
  runtimes.push(runtime);
  return { runtime, getSmallModelService };
};

const idle = (sessionId = SES) => ({
  type: 'session.status',
  properties: { sessionID: sessionId, status: { type: 'idle' } },
});

afterEach(() => {
  while (runtimes.length > 0) runtimes.pop().stop();
  configureOmpRuntimeHost(null);
  vi.restoreAllMocks();
});

describe('session assist runtime', () => {
  it('does no work and reaches no service while no assist store is injected', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const host = createHost();
    configureOmpRuntimeHost(() => host);
    const { runtime, getSmallModelService } = makeRuntime();

    runtime.processPayload(idle());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(host.listSessions).not.toHaveBeenCalled();
    expect(host.getMessages).not.toHaveBeenCalled();
    expect(getSmallModelService).not.toHaveBeenCalled();
  });

  it('explains itself once, not on every idle session', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    configureOmpRuntimeHost(() => createHost());
    const { runtime } = makeRuntime();

    runtime.processPayload(idle('ses_1'));
    runtime.processPayload(idle('ses_2'));
    runtime.processPayload(idle('ses_3'));

    const notices = log.mock.calls.filter(([line]) => String(line).includes('[session-assist] parked'));
    expect(notices).toHaveLength(1);
  });

  it('ignores everything after stop', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    configureOmpRuntimeHost(() => createHost());
    const { runtime } = makeRuntime();

    runtime.stop();
    runtime.processPayload(idle());

    expect(log).not.toHaveBeenCalled();
  });

  it('leaves an archived session alone: no context is loaded and no model is called', async () => {
    const persistSessionAssist = vi.fn(async () => undefined);
    const getSmallModelService = vi.fn(async () => {
      throw new Error('the small model must not be consulted for an archived session');
    });
    const host = createHost();
    configureOmpRuntimeHost(() => host);
    const { runtime } = makeRuntime({
      persistSessionAssist,
      getSmallModelService,
      isSessionArchived: async (sessionId) => sessionId === SES,
    });

    runtime.processPayload(idle());
    await new Promise((resolve) => setTimeout(resolve, 40));

    // The session record was read (that is where the existence check lives),
    // then the archive check stopped everything else.
    expect(host.listSessions).toHaveBeenCalledTimes(1);
    expect(host.getMessages).not.toHaveBeenCalled();
    expect(getSmallModelService).not.toHaveBeenCalled();
    expect(persistSessionAssist).not.toHaveBeenCalled();
  });

  it('generates and saves an assist for the newest settled answer', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const persistSessionAssist = vi.fn(async () => undefined);
    const host = createHost();
    configureOmpRuntimeHost(() => host);
    const { runtime } = makeRuntime({
      persistSessionAssist,
      isSessionArchived: async () => false,
      getSmallModelService: async () => ({
        describeSmallModel: async () => ({ inputCharBudget: 20_000 }),
        generateSmallModelText: async () => ({ text: '{"recap":"Did the thing.","suggestion":"Verify it."}' }),
      }),
    });

    runtime.processPayload(idle());
    for (let i = 0; i < 20 && persistSessionAssist.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(persistSessionAssist).toHaveBeenCalledTimes(1);
    expect(persistSessionAssist.mock.calls[0][2]).toMatchObject({ recap: 'Did the thing.', suggestion: 'Verify it.', forMessageID: 'msg_a' });
    // The pre-write re-check re-read the history before writing.
    expect(host.getMessages.mock.calls.length).toBeGreaterThanOrEqual(2);

    // A new turn deletes the stored assist, once.
    const busy = { type: 'session.status', properties: { sessionID: SES, status: { type: 'busy' } } };
    runtime.processPayload(busy);
    runtime.processPayload(busy);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(persistSessionAssist).toHaveBeenCalledTimes(2);
    expect(persistSessionAssist.mock.calls[1][2]).toBeNull();
  });

  it('does not save an assist whose answer is no longer the newest message', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const persistSessionAssist = vi.fn(async () => undefined);
    let reads = 0;
    const host = createHost({
      // The re-read sees a newer request the user sent while the model ran.
      getMessages: vi.fn(async () => {
        reads += 1;
        return {
          items: reads === 1
            ? [userItem('msg_u', 'Do the thing'), assistantItem('msg_a', 'All done.')]
            : [userItem('msg_u', 'Do the thing'), assistantItem('msg_a', 'All done.'), userItem('msg_next', 'Now this')],
          cursor: {},
        };
      }),
    });
    configureOmpRuntimeHost(() => host);
    const { runtime } = makeRuntime({
      persistSessionAssist,
      isSessionArchived: async () => false,
      getSmallModelService: async () => ({
        describeSmallModel: async () => ({ inputCharBudget: 20_000 }),
        generateSmallModelText: async () => ({ text: '{"recap":"Did the thing.","suggestion":"Verify it."}' }),
      }),
    });

    runtime.processPayload(idle());
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(persistSessionAssist).not.toHaveBeenCalled();
  });

  it('asks the turn-end gate first and arms nothing when it rules both fields out', async () => {
    const persistSessionAssist = vi.fn(async () => undefined);
    const getSmallModelService = vi.fn(async () => {
      throw new Error('the small model must not be woken');
    });
    const evaluateTurn = vi.fn(async () => ({ recap: false, suggestion: false }));
    const host = createHost();
    configureOmpRuntimeHost(() => host);
    const { runtime } = makeRuntime({ persistSessionAssist, getSmallModelService, evaluateTurn });

    runtime.processPayload(idle());
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(evaluateTurn).toHaveBeenCalledWith({ sessionId: SES, directory: '', assist: { recap: true, suggestion: true } });
    expect(host.listSessions).not.toHaveBeenCalled();
    expect(getSmallModelService).not.toHaveBeenCalled();
  });

  it('arms nothing for a known subsession: no gate, no timer, no read', async () => {
    const lineage = createSessionLineage();
    lineage.remember(SES, 'ses_parent');
    const evaluateTurn = vi.fn(async () => null);
    const host = createHost();
    configureOmpRuntimeHost(() => host);
    const { runtime } = makeRuntime({ persistSessionAssist: vi.fn(async () => undefined), evaluateTurn, lineage });

    runtime.processPayload(idle());
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(evaluateTurn).not.toHaveBeenCalled();
    expect(host.listSessions).not.toHaveBeenCalled();
  });

  it('drops a gate answer that arrives after the next turn started', async () => {
    const persistSessionAssist = vi.fn(async () => undefined);
    let answer;
    const evaluateTurn = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    const host = createHost();
    configureOmpRuntimeHost(() => host);
    const { runtime } = makeRuntime({ persistSessionAssist, evaluateTurn });

    runtime.processPayload(idle());
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtime.processPayload({ type: 'session.status', properties: { sessionID: SES, status: { type: 'busy' } } });
    answer({ recap: true, suggestion: true });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(host.listSessions).not.toHaveBeenCalled();
  });

  it('arms generation again as soon as a store is injected', async () => {
    const persistSessionAssist = vi.fn(async () => undefined);
    const getSmallModelService = vi.fn(async () => {
      throw new Error('stop here: the runtime read is what this test observes');
    });
    const host = createHost();
    configureOmpRuntimeHost(() => host);

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtime } = makeRuntime({ persistSessionAssist, getSmallModelService, isSessionArchived: async () => false });
    runtime.processPayload(idle());
    await new Promise((resolve) => setTimeout(resolve, 30));

    // The idle timer fired and the generation path ran, which is what the gate
    // above suppresses.
    expect(host.listSessions).toHaveBeenCalled();
    expect(host.getMessages).toHaveBeenCalled();
  });
});
