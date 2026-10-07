import { describe, expect, it, vi } from 'vitest';

import { createGlobalMessageStreamHub } from './global-hub.js';

const deltaPayload = (text, ordinal = 1) => ({
  type: 'session.text.delta',
  data: { sessionID: 'ses_1', assistantMessageID: 'msg_1', ordinal, delta: text },
});

const endedPayload = (id) => ({
  id,
  type: 'session.text.ended',
  data: { sessionID: 'ses_1', assistantMessageID: 'msg_1', ordinal: 1, text: '' },
});

// What a browser holds after applying frames in order: text per stream
// ordinal, and the text each stream had when a snapshot barrier passed.
const applyFrames = (frames) => {
  const text = {};
  const barriers = [];
  for (const frame of frames) {
    const payload = frame.payload;
    if (payload.type === 'session.text.delta') {
      text[payload.data.ordinal] = (text[payload.data.ordinal] ?? '') + payload.data.delta;
    } else {
      barriers.push({ id: payload.id, seen: { ...text } });
    }
  }
  return { text, barriers };
};

const waitForAssertion = async (assertion) => {
  const deadline = Date.now() + 1000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw lastError;
};

const inject = (hub, payload, directory = 'global') => hub.injectEvent({ payload, directory });

describe('createGlobalMessageStreamHub replay', () => {
  it('bounds a contiguous replay suffix by UTF-8 bytes and event count', async () => {
    const hub = createGlobalMessageStreamHub({ replayLimit: 3, replayByteLimit: 600, deltaCoalesceWindowMs: 0 });
    const received = [];
    hub.subscribeEvent((event) => received.push(event));
    try {
      for (let index = 0; index < 8; index += 1) {
        inject(hub, { id: `e${index}`, type: 'message', properties: { text: '界'.repeat(40) } });
      }
      await waitForAssertion(() => expect(received).toHaveLength(8));
      // Only a bounded suffix is retained, so an evicted cursor reports a miss
      // (null) rather than a wrong tail.
      expect(hub.replayAfter(received[0].eventId)).toBeNull();
      const tail = hub.replayAfter(received[received.length - 2].eventId);
      expect(tail.map((entry) => entry.eventId)).toEqual([received.at(-1).eventId]);
      expect(Buffer.byteLength(tail[0].serializedFrame)).toBeLessThanOrEqual(600);
    } finally {
      // nothing to tear down: the hub owns no upstream
    }
  });

  it('numbers id-less events so a reconnect resumes from any cursor', async () => {
    const hub = createGlobalMessageStreamHub({ deltaCoalesceWindowMs: 0 });
    const received = [];
    hub.subscribeEvent((event) => received.push(event));
    for (let index = 0; index < 30; index += 1) inject(hub, deltaPayload(`a${index}.`));
    inject(hub, endedPayload('snapshot-1'));
    for (let index = 0; index < 30; index += 1) inject(hub, deltaPayload(`b${index}.`));
    await waitForAssertion(() => expect(received).toHaveLength(61));

    const ids = received.map((event) => event.eventId);
    expect(ids.every((eventId) => typeof eventId === 'string' && eventId.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);

    const complete = applyFrames(received);
    for (let cut = 0; cut < received.length; cut += 1) {
      const tail = hub.replayAfter(received[cut].eventId);
      expect(tail).not.toBeNull();
      const replayed = tail.map((entry) => ({ payload: JSON.parse(entry.serializedFrame).payload }));
      expect(applyFrames([...received.slice(0, cut + 1), ...replayed])).toEqual(complete);
    }

    // A cursor minted by another server process must miss, never match by
    // sequence number: the bridge then reports replayReset.
    const foreign = ids[0].replace(/^oc-[^-]+-/, 'oc-00000000-');
    expect(foreign).not.toBe(ids[0]);
    expect(hub.replayAfter(foreign)).toBeNull();
  });

  it('spaces subscribers see space events, plain subscribers do not', async () => {
    const hub = createGlobalMessageStreamHub({ deltaCoalesceWindowMs: 0 });
    const hostOnly = [];
    const withSpaces = [];
    hub.subscribeEvent((event) => hostOnly.push(event.spaceId));
    hub.subscribeEvent((event) => withSpaces.push(event.spaceId), { spaces: true });
    inject(hub, { type: 'host.event' });
    hub.injectEvent({ payload: { type: 'space.event' }, directory: 'global', spaceId: 'space-1' });
    await waitForAssertion(() => expect(withSpaces).toEqual([null, 'space-1']));
    expect(hostOnly).toEqual([null]);
  });
});

describe('delta coalescing in the global hub', () => {
  it('delivers the same text in far fewer frames', async () => {
    const hub = createGlobalMessageStreamHub({ deltaCoalesceWindowMs: 0 });
    const received = [];
    hub.subscribeEvent((event) => received.push(event));
    const words = Array.from({ length: 120 }, (_, index) => `w${index} `);
    for (const word of words) inject(hub, deltaPayload(word));
    await waitForAssertion(() => expect(applyFrames(received).text[1]).toBe(words.join('')));
  });

  it('keeps pending text for replay when the client reads the tail', async () => {
    const hub = createGlobalMessageStreamHub({ deltaCoalesceWindowMs: 60_000 });
    const received = [];
    hub.subscribeEvent((event) => received.push(event));
    for (const text of ['one ', 'two ', 'three']) inject(hub, deltaPayload(text));
    // The window is a minute, so only the leading delta has been delivered.
    await waitForAssertion(() => expect(received).toHaveLength(1));

    hub.flushPending();

    const tail = hub.replayAfter(received[0].eventId).map((entry) => ({ payload: JSON.parse(entry.serializedFrame).payload }));
    expect(applyFrames(tail).text[1]).toBe('two three');
  });
});

describe('createGlobalMessageStreamHub subscriber isolation', () => {
  it('continues fanout when an event subscriber throws', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const received = [];
    const hub = createGlobalMessageStreamHub({ deltaCoalesceWindowMs: 0 });
    hub.subscribeEvent(() => {
      throw new Error('subscriber failed');
    });
    hub.subscribeEvent((event) => received.push(event.eventId));
    try {
      inject(hub, { id: 'evt-1', type: 'session.updated', properties: {} });
      expect(received).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('continues fanout when an async event subscriber rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const received = [];
    const hub = createGlobalMessageStreamHub({ deltaCoalesceWindowMs: 0 });
    hub.subscribeEvent(async () => {
      throw new Error('async subscriber failed');
    });
    hub.subscribeEvent((event) => received.push(event.eventId));
    try {
      inject(hub, { id: 'evt-1', type: 'session.updated', properties: {} });
      await waitForAssertion(() => expect(received).toHaveLength(1));
      await waitForAssertion(() => expect(warnSpy).toHaveBeenCalled());
    } finally {
      warnSpy.mockRestore();
    }
  });
});
