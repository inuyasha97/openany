import type { InitFailure } from '@/stores/useConfigStore';

type InitRecoveryDescriptionKey =
  | 'startup.initRecovery.openCodeUnavailable'
  | 'startup.initRecovery.serverUnreachable'
  | 'startup.initRecovery.loadAgentsFailed'
  | 'startup.initRecovery.unexpected';

// Only a network failure asks the user to check the server; every other
// failure names what went wrong so a live server is not blamed.
export const getInitRecoveryDescriptionKey = (
  failure: InitFailure | null,
): InitRecoveryDescriptionKey => {
  switch (failure?.step) {
    case 'serverUnreachable': return 'startup.initRecovery.serverUnreachable';
    case 'openCodeUnavailable': return 'startup.initRecovery.openCodeUnavailable';
    case 'loadAgents': return 'startup.initRecovery.loadAgentsFailed';
    default: return 'startup.initRecovery.unexpected';
  }
};
