import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureOmpRuntimeHost } from '../agents/omp-host-access.js';
import { createMessageQueueRuntime, parseQueuedItemInput } from './runtime.js';

const SESSION = 'ses_queue_test_1';
const DIRECTORY = '/repo';

const item = (overrides = {}) => ({
  content: 'follow up',
  text: 'follow up',
  attachments: [],
  sendConfig: { providerID: 'anthropic', modelID: 'claude' },
  ...overrides,
});

const tempDirs = [];
const runtimes = [];
const makeDataDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-message-queue-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  vi.useRealTimers();
  // A live runtime keeps its dispatch timers armed; without stopping them a
  // later test's send log would collect their retries.
  while (runtimes.length > 0) runtimes.pop().stop();
  configureOmpRuntimeHost(null);
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A canonical `{ info, parts }` record, the shape the OMP host serves. */
const assistantItem = (time, { text = 'reply', ...info } = {}) => ({
  info: { id: `msg_${time.created}`, sessionID: SESSION, role: 'assistant', time, ...info },
  parts: text ? [{ type: 'text', text }] : [],
});

/**
 * A fake OMP runtime: one busy flag per session, the canonical message page,
 * the command list, and a log of the model switches and prompts it received.
 * `fail` makes the next call to one operation reject, the way an unavailable
 * runtime does.
 */
const createOmpHost = () => {
  const state = {
    busy: {},
    items: [],
    commands: [],
    sent: [],
    switched: [],
    fail: null,
  };
  const failIf = (op) => {
    if (state.fail?.op === op) {
      const { error } = state.fail;
      state.fail = null;
      throw error;
    }
  };
  const host = {
    listSessions: vi.fn(async () => [{ id: SESSION, sessionPath: '/sessions/queue.jsonl', cwd: DIRECTORY, title: '' }]),
    getSessionStatus: vi.fn(async (id) => {
      failIf('status');
      return { busy: state.busy[id] === true };
    }),
    getMessages: vi.fn(async () => {
      failIf('messages');
      return { items: state.items, cursor: {} };
    }),
    setModel: vi.fn(async (id, provider, modelId) => {
      failIf('model');
      state.switched.push({ sessionId: id, provider, modelId });
    }),
    prompt: vi.fn(async (id, text, _messageId, images) => {
      failIf('prompt');
      state.sent.push({ sessionId: id, text, images });
      return true;
    }),
    listCommands: vi.fn(async () => {
      failIf('commands');
      return state.commands;
    }),
  };
  return { state, host };
};

const createRuntime = ({ dataDir = makeDataDir(), omp = createOmpHost(), knowledge = null, retryDelayMs, resolveAutoSelection, now } = {}) => {
  configureOmpRuntimeHost(() => omp.host);
  let eventHandler = () => {};
  let statusHandler = () => {};
  const broadcasts = [];
  const promptSent = [];
  const options = {
    globalEventHub: {
      subscribeEvent(handler) { eventHandler = handler; return () => {}; },
      subscribeStatus(handler) { statusHandler = handler; return () => {}; },
    },
    sessionKnowledgeRuntime: knowledge,
    broadcastGlobalUiEvent: (event) => broadcasts.push(event),
    onPromptSent: (sessionId) => promptSent.push(sessionId),
    dataDir,
    dispatchQuietMs: 0,
    abortHoldMs: 50,
  };
  if (retryDelayMs) options.retryDelayMs = retryDelayMs;
  if (resolveAutoSelection) options.resolveAutoSelection = resolveAutoSelection;
  if (now) options.now = now;
  const runtime = createMessageQueueRuntime(options);
  runtimes.push(runtime);
  return {
    runtime,
    omp,
    dataDir,
    broadcasts,
    promptSent,
    // The hub hands server-side subscribers already-translated events.
    emit: (payload, directory = DIRECTORY) => eventHandler({ payload, directory, translated: () => [payload] }),
    connect: () => statusHandler({ type: 'connect' }),
  };
};

const settle = async (ms = 30) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

describe('auto routing', () => {
  it('routes a queued prompt onto the resolved model', async () => {
    const resolveAutoSelection = vi.fn(async ({ model }) => (model?.id === 'auto'
      ? { model: { providerID: 'openai', id: 'gpt-6-astra' }, agent: null, decision: {} }
      : null));
    const { runtime, omp, emit } = createRuntime({ resolveAutoSelection });
    runtime.start();
    const auto = { providerID: 'openchamber', modelID: 'auto' };
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'plain', text: 'plain', sendConfig: auto }));
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'second', text: 'second', sendConfig: auto }));

    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    // OMP switches the model on the session; the prompt carries one text.
    expect(omp.state.switched).toEqual([
      { sessionId: SESSION, provider: 'openai', modelId: 'gpt-6-astra' },
      { sessionId: SESSION, provider: 'openai', modelId: 'gpt-6-astra' },
    ]);
    expect(omp.state.sent.map((entry) => entry.text)).toEqual(['plain', 'second']);
    expect(resolveAutoSelection).toHaveBeenCalledTimes(2);
    expect(resolveAutoSelection.mock.calls[0][0]).toMatchObject({ sessionId: SESSION, directory: DIRECTORY, requestText: 'plain' });
  });

  it('fails a routed send that needs an agent rather than dropping the choice', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resolveAutoSelection = vi.fn(async () => ({ model: { providerID: 'openai', id: 'gpt-6-astra' }, agent: 'plan', decision: {} }));
    const { runtime, omp, emit } = createRuntime({ resolveAutoSelection });
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'plain', text: 'plain', sendConfig: { providerID: 'openchamber', modelID: 'auto' } }));

    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    // The agent is checked before the model is touched, so the session was left
    // as it was and the item stays queued.
    expect(omp.state.switched).toEqual([]);
    expect(omp.state.sent).toEqual([]);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
  });
});

describe('parseQueuedItemInput', () => {
  it('rejects an item the server could not deliver later', () => {
    expect(() => parseQueuedItemInput({ content: 'x' })).toThrow(TypeError);
    expect(() => parseQueuedItemInput(item({ content: '', text: '' }))).toThrow(TypeError);
    expect(() => parseQueuedItemInput(item({ attachments: [{ filename: 'a.png' }] }))).toThrow(TypeError);
  });

  it('keeps delivery fields and trims blank edges of the content', () => {
    const parsed = parseQueuedItemInput(item({ content: '\n\nhello\n', text: 'hello', agentMention: 'reviewer' }));
    expect(parsed).toEqual({
      content: 'hello',
      text: 'hello',
      agentMention: 'reviewer',
      attachments: [],
      context: [],
      sendConfig: { providerID: 'anthropic', modelID: 'claude' },
    });
  });

  it('keeps captured context and rejects a malformed part', () => {
    const context = [
      { kind: 'context', text: 'Comment on `a.ts`', metadata: { openchamberContext: { kind: 'code-comment' } }, instructions: '' },
      { kind: 'instruction', text: 'use the skill' },
      { kind: 'synthetic', text: 'conflict payload' },
    ];
    expect(parseQueuedItemInput(item({ context })).context).toEqual([
      { kind: 'context', text: 'Comment on `a.ts`', metadata: { openchamberContext: { kind: 'code-comment' } } },
      { kind: 'instruction', text: 'use the skill' },
      { kind: 'synthetic', text: 'conflict payload' },
    ]);
    expect(() => parseQueuedItemInput(item({ context: [{ kind: 'context', text: 'no metadata' }] }))).toThrow(TypeError);
    expect(() => parseQueuedItemInput(item({ context: [{ kind: 'other', text: 'x' }] }))).toThrow(TypeError);
  });

  it('accepts an item that is only context', () => {
    const parsed = parseQueuedItemInput(item({ content: '', text: '', context: [{ kind: 'synthetic', text: 'just context' }] }));
    expect(parsed.text).toBe('');
    expect(parsed.context).toHaveLength(1);
  });
});

describe('message queue runtime', () => {
  it('delivers the head of the queue when the session goes idle, in order', async () => {
    const { runtime, omp, emit, promptSent, broadcasts } = createRuntime();
    runtime.start();
    omp.state.busy[SESSION] = true;

    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'first', text: 'first' }));
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'second', text: 'second' }));
    await settle();
    expect(omp.state.sent).toHaveLength(0);

    omp.state.busy[SESSION] = false;
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(omp.state.sent).toHaveLength(1);
    expect(omp.state.sent[0]).toEqual({ sessionId: SESSION, text: 'first' });
    expect(promptSent).toEqual([SESSION]);
    expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.content)).toEqual(['second']);
    // Clients learned about the in-flight item and then the removal.
    expect(broadcasts.at(-1)).toMatchObject({
      type: 'openchamber:message-queue.updated',
      properties: { session: { sessionId: SESSION, sendingId: null } },
    });

    // The next turn: busy, then idle again — the second message goes out.
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'busy' } } });
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(omp.state.sent).toHaveLength(2);
    expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
  });

  it('sends on the parent\'s own idle: the OMP runtime lists no subagent sessions', async () => {
    const { runtime, omp, emit } = createRuntime();
    runtime.start();

    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'next', text: 'next' }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(omp.state.sent).toHaveLength(1);
    expect(omp.state.sent[0]).toEqual({ sessionId: SESSION, text: 'next' });
  });

  it('does not send into a running turn even when the status event says idle', async () => {
    const { runtime, omp, emit } = createRuntime({ now: () => 10_000 });
    runtime.start();
    // Live unfinished turn: created after this runtime started.
    omp.state.items = [assistantItem({ created: 10_001 })];
    await runtime.enqueue(SESSION, DIRECTORY, item());
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(omp.state.sent).toHaveLength(0);

    // The reply completes: that alone drains the queue (a missed idle event
    // must not strand it).
    omp.state.items = [assistantItem({ created: 10_001, completed: 10_002 })];
    omp.state.busy[SESSION] = false;
    emit({ type: 'message.updated', properties: { info: { role: 'assistant', sessionID: SESSION, time: { created: 10_001, completed: 10_002 } } } });
    await settle();
    expect(omp.state.sent).toHaveLength(1);
  });

  it('delivers past an unfinished tail that predates this runtime (dead pre-restart run)', async () => {
    const { runtime, omp, emit } = createRuntime({ now: () => 10_000 });
    runtime.start();
    // Assistant reply interrupted by a server restart: unfinished, but older
    // than this runtime — no completion event will ever arrive for it, so it
    // must not block a restored queue forever.
    omp.state.items = [assistantItem({ created: 1 })];
    await runtime.enqueue(SESSION, DIRECTORY, item());
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(omp.state.sent).toHaveLength(1);
    expect(omp.state.sent[0]).toEqual({ sessionId: SESSION, text: 'follow up' });
  });

  it('treats an unreachable runtime as unknown, not idle', async () => {
    const { runtime, omp, emit } = createRuntime({ retryDelayMs: () => 10 });
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    omp.state.fail = { op: 'status', error: new Error('runtime down') };
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle(5);
    expect(omp.state.sent).toHaveLength(0);
    // Retried after the status read recovers.
    await settle(40);
    expect(omp.state.sent).toHaveLength(1);
  });

  it('keeps a failed item and retries with backoff', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtime, omp, emit, broadcasts } = createRuntime({ retryDelayMs: () => 20 });
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    omp.state.fail = { op: 'prompt', error: new Error('prompt rejected') };
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle(10);
    expect(omp.state.sent).toHaveLength(0);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
    expect(runtime.sessionSnapshot(SESSION).sendingId).toBeNull();
    expect(broadcasts.at(-1).properties.session.sendingId).toBeNull();
    await settle(40);
    expect(omp.state.sent).toHaveLength(1);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(0);
  });

  it('holds delivery briefly after a user abort', async () => {
    const { runtime, omp, emit } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    // The hub turns an interruption into an aborted `session.idle`.
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    emit({ type: 'session.idle', properties: { sessionID: SESSION, aborted: true, reason: 'user' } });
    await settle(10);
    expect(omp.state.sent).toHaveLength(0);
    await settle(80);
    expect(omp.state.sent).toHaveLength(1);
  });

  it('honors a hold until it is released', async () => {
    const { runtime, omp, emit } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    runtime.setHold(SESSION, true, 60_000);
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(omp.state.sent).toHaveLength(0);

    runtime.setHold(SESSION, false);
    await settle();
    expect(omp.state.sent).toHaveLength(1);
  });

  it('survives a restart and delivers once the runtime reconnects', async () => {
    const dataDir = makeDataDir();
    const first = createRuntime({ dataDir });
    first.runtime.start();
    first.omp.state.busy[SESSION] = true;
    await first.runtime.enqueue(SESSION, DIRECTORY, item({ content: 'persisted', text: 'persisted', contextPreview: 'Saved context preview' }));
    await first.runtime.flush();
    first.runtime.stop();

    const second = createRuntime({ dataDir });
    second.runtime.start();
    await second.runtime.load();
    expect(second.runtime.sessionSnapshot(SESSION).items.map((entry) => entry.content)).toEqual(['persisted']);
    expect(second.runtime.sessionSnapshot(SESSION).items[0].contextPreview).toBe('Saved context preview');
    second.connect();
    await settle();
    expect(second.omp.state.sent).toHaveLength(1);
    expect(second.omp.state.sent[0]).toEqual({ sessionId: SESSION, text: 'persisted' });
  });

  it('moves an unreadable queue file aside instead of treating it as empty', async () => {
    const dataDir = makeDataDir();
    fs.writeFileSync(path.join(dataDir, 'message-queue.json'), '{ not json');
    const { runtime } = createRuntime({ dataDir });
    await runtime.load();
    expect(runtime.snapshot().sessions).toEqual([]);
    expect(fs.readdirSync(dataDir).some((name) => name.startsWith('message-queue.json.corrupt-'))).toBe(true);
  });

  it('refuses to remove or take the item currently being sent', async () => {
    const { runtime, omp, emit } = createRuntime();
    runtime.start();
    let release;
    // The send is held open at the prompt until released.
    omp.host.prompt.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(true); }));
    const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, item());
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(runtime.sessionSnapshot(SESSION).sendingId).toBe(itemId);

    await expect(runtime.remove(SESSION, itemId)).rejects.toMatchObject({ status: 409 });
    await expect(runtime.take(SESSION, itemId)).rejects.toMatchObject({ status: 409 });
    const taken = await runtime.takeAll(SESSION);
    expect(taken.items).toEqual([]);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);

    release();
    await settle();
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(0);
  });

  it('take hands back the full payload and leaves the rest queued', async () => {
    const { runtime } = createRuntime();
    runtime.start();
    const attachment = { id: 'a1', filename: 'shot.png', mimeType: 'image/png', size: 3, source: 'local', dataUrl: 'data:image/png;base64,AAA=' };
    const first = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'with image', attachments: [attachment] }));
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'plain' }));

    expect(runtime.sessionSnapshot(SESSION).items[0].attachments[0]).not.toHaveProperty('dataUrl');
    const taken = await runtime.take(SESSION, first.itemId);
    expect(taken.item.attachments[0].dataUrl).toBe(attachment.dataUrl);
    expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.content)).toEqual(['plain']);

    const all = await runtime.takeAll(SESSION);
    expect(all.items.map((entry) => entry.content)).toEqual(['plain']);
    expect(runtime.snapshot().sessions).toEqual([]);
  });

  it('retains a bounded context preview in snapshots and broadcasts without exposing the full payload', async () => {
    const { runtime, broadcasts } = createRuntime();
    runtime.start();
    const context = [{ kind: 'context', text: 'Full quoted content', metadata: { openchamberContext: { kind: 'chat-quote', quote: 'Original answer', text: 'Explain this' } } }];
    const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, item({ content: '', text: '', context, contextPreview: 'Explain this' }));
    const projected = runtime.sessionSnapshot(SESSION).items[0];
    expect(projected.contextPreview).toBe('Explain this');
    expect(projected.content).toBe('');
    expect(projected.text).toBe('');
    expect(projected).not.toHaveProperty('context');
    expect(broadcasts.at(-1).properties.session.items[0].contextPreview).toBe('Explain this');
    const taken = await runtime.take(SESSION, itemId);
    expect(taken.item.context).toEqual(context);
    expect(taken.item.content).toBe('');

    await runtime.enqueue(SESSION, DIRECTORY, item({ content: '', text: '', context, contextPreview: 'a'.repeat(5000) }));
    expect(runtime.sessionSnapshot(SESSION).items[0].contextPreview).toBe('a'.repeat(100) + '...');
  });

  it('derives a preview for older queued annotations without a saved summary', async () => {
    const { runtime } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: '', text: '', context: [
      { kind: 'instruction', text: 'Use the skill' },
      { kind: 'context', text: 'Model-facing wrapper', metadata: { openchamberContext: { kind: 'browser-annotation', text: 'Fix the button\nMore detail' } } },
    ] }));
    expect(runtime.sessionSnapshot(SESSION).items[0].contextPreview).toBe('Fix the button...');
  });

  it('names the directory in the broadcast that empties a queue', async () => {
    // The UI keys its projection by directory; without it the client cannot
    // tell which queue just delivered its last message and keeps showing it.
    const { runtime, emit, broadcasts, omp } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(omp.state.sent).toHaveLength(1);
    expect(runtime.snapshot().sessions).toEqual([]);
    expect(broadcasts.at(-1).properties.session).toEqual({ sessionId: SESSION, directory: DIRECTORY, items: [], sendingId: null });
  });

  it('reorders only with a complete permutation', async () => {
    const { runtime } = createRuntime();
    runtime.start();
    const a = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'a' }));
    const b = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'b' }));
    await expect(runtime.reorder(SESSION, [b.itemId])).rejects.toThrow(TypeError);
    await runtime.reorder(SESSION, [b.itemId, a.itemId]);
    expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.content)).toEqual(['b', 'a']);
  });

  it('drops the queue of a deleted session', async () => {
    const { runtime, emit, broadcasts } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    emit({ type: 'session.deleted', properties: { info: { id: SESSION } } });
    expect(runtime.snapshot().sessions).toEqual([]);
    expect(broadcasts.at(-1).properties.session).toMatchObject({ sessionId: SESSION, items: [] });
  });

  it('folds captured context and project knowledge into the prompt, instructions first', async () => {
    const knowledge = {
      resolvePendingForSession: async () => ({ text: 'pinned notes', signature: 'sig-1' }),
      recordDelivered: async () => {},
    };
    const { runtime, omp, emit } = createRuntime({ knowledge });
    runtime.start();
    const metadata = { openchamberContext: { kind: 'github-pr', number: 7, title: 'PR', url: 'https://x/pr/7' } };
    await runtime.enqueue(SESSION, DIRECTORY, item({
      context: [
        { kind: 'context', text: 'the diff', metadata, instructions: 'how to read it' },
        { kind: 'synthetic', text: 'conflict payload' },
        { kind: 'instruction', text: 'use the skill' },
      ],
    }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    // OMP sends one authored text per turn and has no synthetic message, so the
    // context rides in front of the message instead of ahead of it.
    expect(omp.state.sent).toHaveLength(1);
    expect(omp.state.sent[0].text).toBe([
      'how to read it',
      'the diff',
      'conflict payload',
      'use the skill',
      'pinned notes',
      'follow up',
    ].join('\n\n'));
  });

  it('delivers a queued image inline, the way the composer does', async () => {
    const { runtime, omp, emit } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item({
      attachments: [{
        id: 'a',
        filename: 'shot.png',
        mimeType: 'image/png',
        size: 3,
        source: 'local',
        dataUrl: 'data:image/png;base64,QUJD',
      }],
    }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(omp.state.sent).toHaveLength(1);
    expect(omp.state.sent[0].images).toEqual([{ type: 'image', data: 'QUJD', mimeType: 'image/png' }]);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(0);
  });

  it('delivers a queued server-side file as an @path mention', async () => {
    const { runtime, omp, emit } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item({
      attachments: [{
        id: 'a',
        filename: 'notes.pdf',
        mimeType: 'application/pdf',
        size: 3,
        source: 'server',
        serverPath: '/repo/notes.pdf',
        dataUrl: 'data:application/pdf;base64,QQ==',
      }],
    }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(omp.state.sent).toHaveLength(1);
    expect(omp.state.sent[0].text).toBe('follow up @/repo/notes.pdf');
  });

  it('fails a queued attachment it cannot represent rather than dropping it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtime, omp, emit } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item({
      attachments: [{
        id: 'a',
        filename: 'remote.txt',
        mimeType: 'text/plain',
        size: 2,
        source: 'local',
        dataUrl: 'data:text/plain,hi',
      }],
    }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(omp.state.sent).toEqual([]);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
    expect(String(warn.mock.calls.at(-1)?.[1] ?? '')).toContain('the attachment "remote.txt"');
  });

  it('sends a queued command as prompt text, leading the context so OMP expands it', async () => {
    const { runtime, omp, emit } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item({
      content: '/review src',
      text: '/review src',
      context: [{ kind: 'context', text: 'quoted', metadata: {} }],
    }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(omp.state.sent).toHaveLength(1);
    expect(omp.state.sent[0].text).toBe('/review src\n\nquoted');
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(0);
  });

  it('delivers a slash prompt without consulting the command list', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtime, omp, emit } = createRuntime();
    runtime.start();
    omp.state.fail = { op: 'commands', error: new Error('command list unavailable') };
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: '/review', text: '/review' }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(omp.state.sent).toHaveLength(1);
    expect(omp.state.sent[0].text).toBe('/review');
  });

  it('keeps captured context out of snapshots and broadcasts, and hands it back on take', async () => {
    const { runtime, broadcasts } = createRuntime();
    runtime.start();
    const context = [{ kind: 'synthetic', text: 'a large diff' }];
    const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, item({ context }));
    expect(runtime.sessionSnapshot(SESSION).items[0]).not.toHaveProperty('context');
    expect(runtime.sessionSnapshot(SESSION).items[0].text).toBe('follow up');
    expect(broadcasts.at(-1).properties.session.items[0]).not.toHaveProperty('context');
    const taken = await runtime.take(SESSION, itemId);
    expect(taken.item.context).toEqual(context);
  });

  it('attaches pending project knowledge to the prompt and records its delivery', async () => {
    const recorded = [];
    const knowledge = {
      resolvePendingForSession: async () => ({ text: 'pinned notes', signature: 'sig-1' }),
      recordDelivered: async (sessionId, directory, signature) => { recorded.push({ sessionId, directory, signature }); },
    };
    const { runtime, omp, emit } = createRuntime({ knowledge });
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(omp.state.sent).toHaveLength(1);
    expect(omp.state.sent[0].text).toBe('pinned notes\n\nfollow up');
    expect(recorded).toEqual([{ sessionId: SESSION, directory: DIRECTORY, signature: 'sig-1' }]);
  });
});
