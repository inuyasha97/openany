import { describe, expect, test } from 'bun:test';
import { getInitRecoveryDescriptionKey } from './startupDiagnostics';

describe('startup recovery description', () => {
  test('asks to check the server only when it could not be reached', () => {
    expect(getInitRecoveryDescriptionKey({ step: 'serverUnreachable', message: null }))
      .toBe('startup.initRecovery.serverUnreachable');
    expect(getInitRecoveryDescriptionKey({ step: 'loadAgents', message: 'boom' }))
      .toBe('startup.initRecovery.loadAgentsFailed');
    expect(getInitRecoveryDescriptionKey({ step: 'openCodeUnavailable', message: null }))
      .toBe('startup.initRecovery.openCodeUnavailable');
    expect(getInitRecoveryDescriptionKey({ step: 'unexpected', message: 'boom' }))
      .toBe('startup.initRecovery.unexpected');
    expect(getInitRecoveryDescriptionKey(null)).toBe('startup.initRecovery.unexpected');
  });
});
