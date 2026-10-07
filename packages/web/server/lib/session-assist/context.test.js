import { describe, expect, it } from 'vitest';
import { excerpt, loadAssistContext, loadSettledTurns, newestContentId } from './context.js';
import { buildAssistPrompt } from './prompt.js';

// A canonical record is `{ info, parts }`, listed oldest first, and the OMP
// runtime serves the whole history in one page.
const SES = 'ses_1';
const textPart = (messageID, text, ordinal = 0) => ({
  id: `${messageID}:text:${ordinal}`,
  sessionID: SES,
  messageID,
  type: 'text',
  text,
});
const record = (info, parts = []) => ({ info, parts });

const user = (id, text, extra = {}) => record(
  { id, sessionID: SES, role: 'user', time: { created: 1 }, ...extra },
  typeof text === 'string' ? [textPart(id, text)] : [],
);
const assistant = (id, text, extra = {}) => record(
  {
    id,
    sessionID: SES,
    role: 'assistant',
    time: { created: 1, completed: 2 },
    agent: '',
    providerID: 'provider',
    modelID: 'model',
    finish: 'stop',
    ...extra,
  },
  text ? [textPart(id, text)] : [],
);
const synthetic = (id, text, extra = {}) => record(
  { id, sessionID: SES, role: 'synthetic', time: { created: 1 }, text, ...extra },
  [],
);
const idle = (id, outcome = 'succeeded') => record({ id, sessionID: SES, role: 'idle', time: { created: 2 }, outcome }, []);
const modelSwitch = (id) => record({
  id,
  sessionID: SES,
  role: 'model-switched',
  time: { created: 2 },
  model: { providerID: 'p', modelID: 'm' },
}, []);
const compaction = (id, summary) => record({
  id,
  sessionID: SES,
  role: 'compaction',
  time: { created: 2 },
  status: 'completed',
  reason: 'auto',
  summary,
}, []);

const pair = (id) => [user(`u${id}`, `request ${id}`), assistant(`a${id}`, `answer ${id}`)];

const page = (items) => ({ items, cursor: {} });
const load = (readPage) => loadAssistContext({ readPage, signal: new AbortController().signal });
const loadItems = (items) => load(async () => page(items));

describe('session assist context', () => {
  it('reads one history page and stops at three human turns, excluding tools', async () => {
    let calls = 0;
    const records = [...pair(1), ...pair(2), ...pair(3), ...pair(4)];
    records.at(-1).parts.push({
      id: 'call_1',
      sessionID: SES,
      messageID: 'a4',
      type: 'tool',
      callID: 'call_1',
      tool: 'bash',
      state: { status: 'completed', input: {}, output: 'TOOL_PAYLOAD' },
    });
    const context = await load(async () => {
      calls++;
      return page(records);
    });
    expect(calls).toBe(1);
    expect(context.turns.map((t) => t.user.id)).toEqual(['u2', 'u3', 'u4']);
    expect(context.last.text).toBe('answer 4');
    expect(JSON.stringify(context)).not.toContain('TOOL_PAYLOAD');
  });

  it('finds the real user past a compaction', async () => {
    const context = await loadItems([
      ...pair(1),
      ...pair(2),
      user('human', 'Finish the requested work'),
      compaction('summary', 'INTERNAL SUMMARY'),
      assistant('final', 'All requested work done'),
    ]);
    expect(context.last.id).toBe('final');
    expect(context.turns.at(-1).user.id).toBe('human');
    expect(context.turns.at(-1).assistant.id).toBe('final');
    expect(JSON.stringify(context)).not.toContain('INTERNAL SUMMARY');
  });

  it('retains interrupted requests as progress, not as completed turns', async () => {
    const context = await loadItems([
      user('u1', 'Implement both fixes'),
      assistant('a1', 'First fix done', { finish: 'tool-calls' }),
      ...pair(2),
    ]);
    expect(context.turns[0].complete).toBe(false);
    expect(context.turns[0].assistant.text).toBe('First fix done');
    expect(context.turns[1].complete).toBe(true);
  });

  it('folds an attached synthetic into the user message it belongs to', async () => {
    // v1 carried an attachment as a synthetic part of the user message; some
    // transports keep it as its own `synthetic` record just before the prompt.
    const attachment = synthetic('s', 'Serialized attachment', {
      metadata: { openchamberContext: { kind: 'chat-quote', quote: 'English quoted source', text: 'Виправ саме це' } },
    });
    const context = await loadItems([attachment, user('u', 'Fix it'), assistant('a', 'Done')]);
    expect(context.turns).toHaveLength(1);
    expect(context.turns[0].user.text).toContain('> English quoted source');
    expect(context.turns[0].user.text).toContain('User comment:\nВиправ саме це');
    expect(context.turns[0].user.text).toContain('Fix it');
    expect(context.turns[0].user.authored).toContain('Виправ саме це');
  });

  it('retains the comment after a large quote and the conclusion after a long answer', async () => {
    const attachment = synthetic('s', 'attachment', {
      metadata: {
        openchamberContext: { kind: 'browser-annotation', prompt: 'x'.repeat(30_000), text: 'USER_REQUEST_END' },
      },
    });
    const context = await loadItems([
      attachment,
      user('u', 'Look at this'),
      assistant('a', `START${'x'.repeat(30_000)}CONCLUSION`),
    ]);
    expect(context.turns[0].user.text).toContain('USER_REQUEST_END');
    expect(context.last.text).toMatch(/^START/);
    expect(context.last.text).toMatch(/CONCLUSION$/);
    expect(context.last.text.length).toBeLessThanOrEqual(16_000);
  });

  it('fails explicitly on malformed annotation text instead of losing the comment', async () => {
    const attachment = synthetic('s', 'attachment', {
      metadata: { openchamberContext: { kind: 'chat-quote', quote: 'source', text: 42 } },
    });
    await expect(loadItems([attachment, user('u', 'Fix'), assistant('a', 'done')])).rejects.toThrow();
  });

  it('treats a failed read as failure, not as an empty history', async () => {
    await expect(load(async () => ({ items: undefined }))).rejects.toThrow('unavailable');
    await expect(load(async () => null)).rejects.toThrow('unavailable');
    await expect(load(async () => {
      throw new Error('offline');
    })).rejects.toThrow('offline');
  });

  it('refuses to invent a user for an orphaned answer', async () => {
    expect(await loadItems([assistant('a1', 'answer')])).toBeNull();
  });

  it('looks past the idle marker that closes a finished turn', async () => {
    // The answer is still the last content record when the turn is closed by
    // an `idle`, possibly followed by a switch the user made afterwards.
    for (const tail of [[idle('i')], [idle('i'), modelSwitch('m')], [modelSwitch('m'), idle('i')]]) {
      const context = await loadItems([...pair(1), ...tail]);
      expect(context?.last.id).toBe('a1');
      expect(context.turns).toHaveLength(1);
      expect(context.turns[0].assistant.id).toBe('a1');
    }
  });

  it('keeps an attachment glued to its prompt across a switch, and a turn across an idle', async () => {
    const attachment = synthetic('s', 'Attached note');
    const context = await loadItems([
      ...pair(1), idle('i1'),
      attachment, modelSwitch('m'), user('u2', 'Use the note'), assistant('a2', 'Used'), idle('i2'),
    ]);
    expect(context.turns.map((turn) => turn.user.id)).toEqual(['u1', 'u2']);
    expect(context.turns[1].user.text).toBe('Attached note\n\nUse the note');
    expect(context.turns[0].complete).toBe(true);
  });

  it('treats a failed or interrupted idle as evidence the turn did not finish', async () => {
    for (const outcome of ['failed', 'interrupted']) {
      expect(await loadItems([...pair(1), idle('i', outcome)])).toBeNull();
    }
  });

  it('reads a history that holds only service records as no context', async () => {
    expect(await loadItems([idle('i1'), modelSwitch('m'), idle('i2')])).toBeNull();
  });

  it('names the newest content record', () => {
    expect(newestContentId([user('u', 'y'), assistant('a', 'x'), modelSwitch('m'), idle('i')])).toBe('a');
    expect(newestContentId([assistant('a', 'x'), idle('i', 'failed')])).toBe('i');
    expect(newestContentId([idle('i')])).toBeNull();
    expect(newestContentId(undefined)).toBeNull();
  });

  it('skips unfinished, failed, compaction, and user tails', async () => {
    for (const tail of [
      user('tail', 'New request'),
      assistant('tail', 'Working', { finish: 'tool-calls' }),
      assistant('tail', 'Failed', { error: { type: 'APIError', message: 'boom' } }),
      compaction('tail', 'Summary'),
    ]) expect(await loadItems([...pair(1), tail])).toBeNull();
  });

  it('keeps both sides of the newest exchange within a small model budget', async () => {
    const context = await loadItems([
      ...pair(1),
      ...pair(2),
      user('latest', `REQUEST_START${'u'.repeat(8000)}REQUEST_END`),
      assistant('answer', `ANSWER_START${'a'.repeat(16000)}ANSWER_END`),
    ]);
    for (const budget of [1_000, 4_000, 14_000, 32_000, 1_000_000]) {
      const prompt = buildAssistPrompt(context.turns, { recap: true, suggestion: true }, budget);
      expect(prompt.text.length).toBeLessThanOrEqual(Math.min(budget, 32_000));
      for (const marker of ['REQUEST_START', 'REQUEST_END', 'ANSWER_START', 'ANSWER_END']) expect(prompt.text).toContain(marker);
    }
    expect(buildAssistPrompt(context.turns, { recap: true }, 500)).toBeNull();
  });

  it('excerpts from both ends so the start and the end both survive', () => {
    expect(excerpt('abcdef', 10)).toBe('abcdef');
    const trimmed = excerpt(`START${'x'.repeat(500)}END`, 100);
    expect(trimmed.length).toBeLessThanOrEqual(100);
    expect(trimmed).toMatch(/^START/);
    expect(trimmed).toMatch(/END$/);
  });

  it('reads the settled turns before a message that was just sent', async () => {
    const signal = new AbortController().signal;
    // The new request is already stored and has no answer yet.
    const sent = await loadSettledTurns({
      signal,
      readPage: async () => page([...pair(1), ...pair(2), ...pair(3), ...pair(4), user('new', 'fresh request')]),
    });
    expect(sent.map((turn) => turn.user.id)).toEqual(['u2', 'u3', 'u4']);

    // It may not be stored yet: the newest record is the previous answer.
    const notStored = await loadSettledTurns({ signal, readPage: async () => page([...pair(1)]) });
    expect(notStored.map((turn) => turn.user.id)).toEqual(['u1']);

    // A session without a settled turn is an empty history, not a failure.
    expect(await loadSettledTurns({ signal, readPage: async () => page([user('only', 'first message')]) })).toEqual([]);
  });

  it('leaves an unfinished final turn out of the settled turns', async () => {
    const turns = await loadSettledTurns({
      signal: new AbortController().signal,
      readPage: async () => page([
        ...pair(1),
        ...pair(2),
        user('u3', 'third request'),
        assistant('a3', '', { finish: 'tool-calls' }),
      ]),
    });
    expect(turns.map((turn) => turn.user.id)).toEqual(['u1', 'u2']);
  });

  it('treats a failed page as failure, not as an empty history', async () => {
    await expect(loadSettledTurns({
      signal: new AbortController().signal,
      readPage: async () => ({}),
    })).rejects.toThrow('Session message page is unavailable');
  });
});
