import { describe, expect, it } from 'vitest';

import { createHmrStateRuntime } from './hmr-state-runtime.js';

const createRuntime = (globalThisLike = {}, stateKey = '__testHmrState') =>
  createHmrStateRuntime({ globalThisLike, stateKey });

describe('hmr state runtime', () => {
  it('creates one state per key and hands back the same object on every call', () => {
    const globalThisLike = {};
    const runtime = createRuntime(globalThisLike);

    const state = runtime.getOrCreateHmrState();
    expect(state).toBe(runtime.getOrCreateHmrState());
    // The state lives on the global object: that is what carries it across a
    // reload of the replaced module.
    expect(globalThisLike.__testHmrState).toBe(state);
  });

  it('gives a different key its own state', () => {
    const globalThisLike = {};
    const first = createRuntime(globalThisLike, '__firstHmrState').getOrCreateHmrState();
    const second = createRuntime(globalThisLike, '__secondHmrState').getOrCreateHmrState();

    expect(second).not.toBe(first);
    expect(Object.keys(globalThisLike).sort()).toEqual(['__firstHmrState', '__secondHmrState']);
  });

  it('carries exactly the two latches, and nothing else', () => {
    const state = createRuntime().getOrCreateHmrState();

    expect(Object.keys(state).sort()).toEqual(['isShuttingDown', 'signalsAttached']);
    expect(state).toEqual({ isShuttingDown: false, signalsAttached: false });
  });

  it('round-trips both latches, true values included', () => {
    const runtime = createRuntime();
    const hmrState = runtime.getOrCreateHmrState();

    runtime.syncStateFromRuntime(hmrState, { isShuttingDown: true, signalsAttached: false });
    expect(hmrState).toEqual({ isShuttingDown: true, signalsAttached: false });
    expect(runtime.restoreRuntimeFromState({ hmrState })).toEqual({ isShuttingDown: true, signalsAttached: false });

    runtime.syncStateFromRuntime(hmrState, { isShuttingDown: true, signalsAttached: true });
    expect(hmrState).toEqual({ isShuttingDown: true, signalsAttached: true });
    expect(runtime.restoreRuntimeFromState({ hmrState })).toEqual({ isShuttingDown: true, signalsAttached: true });
  });
});
