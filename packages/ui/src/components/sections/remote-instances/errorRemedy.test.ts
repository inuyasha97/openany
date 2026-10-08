import { expect, test } from 'bun:test';

import { errorRemedy, remedyHintKey } from './errorRemedy';

// Verbatim from packages/electron/ssh-manager.mjs: the managed-remote failure
// raised when `omp` is missing on the other machine. The page must recognize it
// to render the tailored hint instead of the raw detail.
const MANAGED_REMOTE_CLI_MISSING =
  'The omp CLI is not installed on the remote machine. Install it there (`bun add -g @oh-my-pi/pi-coding-agent`), then connect again';

test('the managed-remote CLI failure resolves to the noOpencode remedy', () => {
  expect(errorRemedy(MANAGED_REMOTE_CLI_MISSING)).toBe('noOpencode');
  expect(remedyHintKey('noOpencode')).toBe('settings.remoteInstances.page.error.hint.noOpencode');
});

test('failures the page can act on resolve to their remedy', () => {
  expect(errorRemedy('The preferred remote openchamber port 3000 is taken')).toBe('externalPort');
  expect(errorRemedy('Neither bun nor npm is available on the remote machine')).toBe('noRuntime');
});

test('unrecognized failures fall back to the raw detail', () => {
  expect(errorRemedy('ssh handshake failed')).toBeNull();
  expect(errorRemedy('')).toBeNull();
  expect(errorRemedy(undefined)).toBeNull();
});
