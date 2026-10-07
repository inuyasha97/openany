import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { clearRuntimeUrlAuthToken, setRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';

const savedDocument = globalThis.document;
const savedWindow = globalThis.window;
const savedNavigator = globalThis.navigator;

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

/** The transport's rejection: one HTTP status on the error, as the old path carried it. */
const statusError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

const streams = [];
// One entry per connection attempt: an Error the opener throws (a rejected
// upgrade) or `undefined` for a scripted socket that opens.
let socketPlan = [];
let openAttempts = 0;

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
  openRuntimeWebSocket: () => {
    openAttempts += 1;
    const next = socketPlan.shift();
    if (next instanceof Error) throw next;
    return createScriptedStream().socket;
  },
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

/** Fires `online` until the pipeline has started `target` attempts. */
const driveToAttempt = async (target) => {
  for (let tick = 0; tick < 50 && openAttempts < target; tick += 1) {
    globalThis.window.dispatch('online');
    await until(() => false);
  }
  return openAttempts;
};

beforeEach(() => {
  jest.useFakeTimers();
  streams.length = 0;
  socketPlan = [];
  openAttempts = 0;
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

describe('createEventPipeline — permanent server errors', () => {
  it('uses the long backoff cap for 4xx so we do not hammer at 5s intervals', async () => {
    // The first two attempts are rejected with a permanent 404. Under the
    // exponential path the second retry would fire after 250ms; under the
    // permanent-error override both land on the long (60s) cap, so only the
    // `online` interrupt can advance the loop.
    socketPlan = [statusError(404), statusError(404)];

    let advanced = 0;
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
      await until(() => openAttempts === 1);
      await until(() => disconnects.length === 1);
      expect(streams).toHaveLength(0);

      // Phase 1: the whole visible exponential window (5s cap) elapses without
      // the loop starting another attempt.
      await until(() => false);
      jest.advanceTimersByTime(5_000);
      advanced += 5_000;
      await until(() => false);
      expect(openAttempts).toBe(1);

      // Phase 2: `online` interrupts the long wait; the second attempt is also
      // a 404 and again lands on the long cap.
      expect(await driveToAttempt(2)).toBe(2);
      await until(() => false);
      jest.advanceTimersByTime(5_000);
      advanced += 5_000;
      await until(() => false);
      expect(openAttempts).toBe(2);

      // A third `online` reaches the attempt that opens a socket.
      expect(await driveToAttempt(3)).toBe(3);
      await until(() => streams.length === 1);
      streams[0].push({ type: 'ready' });
      await until(() => reconnects.length === 1);

      // Never needed anything close to the 60s cap: the interrupters recovered
      // inside the 10s of clock this test advanced.
      expect(advanced).toBeLessThan(15_000);
      expect(openAttempts).toBe(3);
      expect(reconnects).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('retries 408 and 429 on the normal exponential path (not the permanent cap)', async () => {
    socketPlan = [statusError(429)];

    let advanced = 0;
    const reconnects = [];
    const { cleanup } = createEventPipeline({
      heartbeatTimeoutMs: 60_000,
      reconnectDelayMs: 60_000,
      onEvent: () => {},
      onReconnect: () => reconnects.push(1),
    });

    try {
      await until(() => openAttempts === 1);
      await until(() => false);

      // 429 went through computeRetryDelay (consecutiveFailures=1) -> 250ms,
      // not the 60s permanent cap: the next attempt fires on the timer alone.
      jest.advanceTimersByTime(250);
      advanced += 250;
      await until(() => streams.length === 1);
      streams[0].push({ type: 'ready' });
      await until(() => reconnects.length === 1);

      expect(advanced).toBeLessThan(2_000);
      expect(openAttempts).toBe(2);
      expect(reconnects).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});
