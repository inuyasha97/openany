import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { clearRuntimeUrlAuthToken, setRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';

const savedDocument = globalThis.document;
const savedWindow = globalThis.window;
const savedNavigator = globalThis.navigator;

// Multi-listener event-target stub. `waitForRetry` and the pipeline's own
// `onOnline`/`onOffline` handlers both register for `online`/`offline`, so a
// single-slot stub would drop one of them.
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
 * The transport double: a socket whose frames are yielded by an async
 * generator that ends when the pipeline tears the socket down, exactly as a
 * real socket reader does when its attempt is aborted. The pipeline's own
 * `onopen`/`onmessage` handlers are what the double calls.
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

  const stream = {
    socket,
    push: (frame) => {
      pending.push(frame);
      wake?.();
    },
    /** Closes the socket before it ever reported ready, like a rejected upgrade. */
    fail: (code = 1006) => {
      closed = true;
      controller.abort();
      wake?.();
      socket.onclose?.({ code, wasClean: false });
    },
  };
  streams.push(stream);
  return stream;
};

mock.module('@/lib/relay/runtime-socket', () => ({
  openRuntimeWebSocket: () => createScriptedStream().socket,
}));

// The mock has to be registered before the pipeline module is evaluated, so a
// static import cannot work here.
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
  globalThis.navigator = { onLine: true };
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
  globalThis.navigator = savedNavigator;
});

describe('createEventPipeline — online event', () => {
  it('cuts the inter-attempt wait short when `online` fires after disconnect', async () => {
    globalThis.navigator = { onLine: false };

    const disconnects = [];
    const reconnects = [];
    const { cleanup } = createEventPipeline({
      heartbeatTimeoutMs: 60_000,
      reconnectDelayMs: 60_000,
      onEvent: () => {},
      onDisconnect: (reason) => disconnects.push(reason),
      onReconnect: () => reconnects.push(1),
    });

    try {
      // First attempt: the socket closes before it reports ready.
      await until(() => streams.length === 1);
      streams[0].fail();
      await until(() => disconnects.length === 1);

      // A pre-ready close drops the cached url token, so mint a fresh one for
      // the recovery attempt instead of going to the network.
      setRuntimeUrlAuthToken('test-url-token', Date.now() + 60_000);

      // Offline, so the failed attempt landed on the long (60s) cap. A second
      // of clock time must not be enough to start the next attempt.
      jest.advanceTimersByTime(1_000);
      await until(() => false);
      expect(streams).toHaveLength(1);
      expect(disconnects).toEqual(['ws_closed_before_ready']);

      // Flip the browser back online and fire the event; `waitForRetry`
      // resolves early and the next attempt connects at once.
      globalThis.navigator = { onLine: true };
      globalThis.window.dispatch('online');
      await until(() => streams.length > 1);
      streams[1].push({ type: 'ready' });
      await until(() => reconnects.length > 0);

      // Two attempts: the failed one + the recovery one, recovered well inside
      // the 60s offline cap.
      expect(reconnects).toHaveLength(1);
      expect(streams).toHaveLength(2);
    } finally {
      cleanup();
    }
  });
});
