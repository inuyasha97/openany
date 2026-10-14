import { describe, expect, it } from 'vitest';
import { waitForTurnEnd } from './turn.js';

const harness = (statuses) => {
  let index = 0;
  let clock = 0;
  const seen = [];
  return {
    seen,
    deps: {
      host: { getSessionStatus: async () => { seen.push(index); return statuses[Math.min(index++, statuses.length - 1)]; } },
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      pollMs: 1000,
    },
  };
};

describe('waitForTurnEnd', () => {
  it('answers completed after busy then idle', async () => {
    const { deps } = harness([{ busy: true }, { busy: true }, { busy: false }]);
    expect(await waitForTurnEnd({ ...deps, sessionId: 's1' })).toBe('completed');
  });

  it('answers never_started when the runtime never reports busy', async () => {
    const { deps } = harness([{ busy: false }]);
    expect(await waitForTurnEnd({ ...deps, sessionId: 's1', graceMs: 5000 })).toBe('never_started');
  });

  it('answers unavailable when the runtime went away', async () => {
    const { deps } = harness([null]);
    expect(await waitForTurnEnd({ ...deps, sessionId: 's1' })).toBe('unavailable');
  });

  it('answers timeout when a turn never ends', async () => {
    const { deps } = harness([{ busy: true }]);
    expect(await waitForTurnEnd({ ...deps, sessionId: 's1', timeoutMs: 4000 })).toBe('timeout');
  });

  it('treats an idle runtime as started once the grace window has passed', async () => {
    const { deps } = harness([{ busy: false }]);
    expect(await waitForTurnEnd({ ...deps, sessionId: 's1', graceMs: 0 })).toBe('completed');
  });
});
