import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { clearRuntimeUrlAuthToken, setRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';

const savedDocument = globalThis.document;
const savedWindow = globalThis.window;

function createEventTarget(extras = {}) {
  const listeners = new Map();
  return {
    ...extras,
    addEventListener(event, handler) {
      const list = listeners.get(event);
      if (list) list.add(handler);
      else listeners.set(event, new Set([handler]));
    },
    removeEventListener(event, handler) {
      listeners.get(event)?.delete(handler);
    },
    dispatch(event) {
      const list = listeners.get(event);
      if (!list) return;
      for (const handler of Array.from(list)) {
        handler();
      }
    },
  };
}

const streams = [];

/**
 * The transport double: frames are yielded by an async generator that ends
 * when the pipeline tears the socket down, exactly as a real socket reader
 * does when its attempt is aborted.
 */
const createScriptedStream = () => {
  const pending = [];
  let wake = null;
  let closed = false;
  const controller = new AbortController();

  const socket = {
    readyState: 1,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: () => undefined,
    close: () => {
      closed = true;
      controller.abort();
      wake?.();
    },
  };

  const frames = async function* (signal) {
    while (!signal.aborted) {
      const frame = pending.shift();
      if (frame === undefined) {
        const waiting = Promise.withResolvers();
        wake = waiting.resolve;
        signal.addEventListener('abort', () => waiting.resolve(), { once: true });
        await waiting.promise;
        wake = null;
        continue;
      }
      yield frame;
    }
  };

  void (async () => {
    socket.onopen?.();
    for await (const frame of frames(controller.signal)) {
      if (closed) return;
      socket.onmessage?.({ data: JSON.stringify(frame) });
      await Promise.resolve();
    }
  })();

  const stream = { socket, push: (frame) => { pending.push(frame); wake?.(); } };
  streams.push(stream);
  return stream;
};

mock.module('@/lib/relay/runtime-socket', () => ({
  openRuntimeWebSocket: () => createScriptedStream().socket,
}));

const { createEventPipeline } = await import('../event-pipeline');

/** Lets the pipeline's own microtasks run without advancing the clock. */
const until = async (predicate) => {
  for (let tick = 0; tick < 200; tick += 1) {
    if (predicate()) return true;
    await Promise.resolve();
  }
  return predicate();
};

beforeEach(() => {
  jest.useFakeTimers();
  streams.length = 0;
  globalThis.document = createEventTarget({ visibilityState: 'visible' });
  globalThis.window = createEventTarget({
    location: { href: 'http://127.0.0.1:3000/', origin: 'http://127.0.0.1:3000' },
  });
  // The socket upgrade authenticates with the url token; a valid token keeps
  // the pipeline's pre-connect mint off the network.
  setRuntimeUrlAuthToken('test-url-token', Date.now() + 60_000);
  configureRuntimeUrlResolver({ apiBaseUrl: 'http://127.0.0.1:3000' });
});

afterEach(() => {
  clearRuntimeUrlAuthToken();
  jest.useRealTimers();
  globalThis.document = savedDocument;
  globalThis.window = savedWindow;
});

describe('createEventPipeline — system resume reconnect', () => {
  it('reconnects immediately on openchamber:system-resume event', async () => {
    const disconnectReasons = [];
    const reconnects = [];
    const { cleanup } = createEventPipeline({
      heartbeatTimeoutMs: 60_000,
      reconnectDelayMs: 60_000,
      onEvent: () => {},
      onDisconnect: (reason) => disconnectReasons.push(reason),
      onReconnect: () => reconnects.push(1),
    });

    try {
      // Initial connect: the socket opens and reports ready.
      await until(() => streams.length === 1);
      streams[0].push({ type: 'ready' });
      await until(() => reconnects.length === 1);

      // Simulate OS resume by invoking the registered handler directly. The
      // pipeline must abort the (almost certainly dead) connection and start a
      // fresh attempt with no backoff, without any clock time elapsing.
      globalThis.window.dispatch('openchamber:system-resume');
      await until(() => streams.length > 1);
      streams[1].push({ type: 'ready' });
      await until(() => reconnects.length === 2);

      // Should have made two attempts: initial connect + reconnect after resume.
      expect(streams).toHaveLength(2);
      // Disconnect reason should include system_resume.
      expect(disconnectReasons.some((reason) => reason.includes('system_resume'))).toBe(true);
    } finally {
      cleanup();
    }
  });
});
