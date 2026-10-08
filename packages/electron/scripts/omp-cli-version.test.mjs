import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseOmpCliVersion, readPinnedOmpCliVersion } from './omp-cli-version.mjs';

describe('staged OMP CLI version', () => {
  test('reads the version out of the omp --version line', () => {
    assert.equal(parseOmpCliVersion('omp/18.1.11\n'), '18.1.11');
    assert.equal(parseOmpCliVersion('18.2.6'), '18.2.6');
    assert.equal(parseOmpCliVersion('omp/18.2.0-beta.3'), '18.2.0-beta.3');
  });

  test('answers empty for output that names no version', () => {
    assert.equal(parseOmpCliVersion('command not found'), '');
    assert.equal(parseOmpCliVersion(''), '');
  });

  test('defaults the pin to an exact version', () => {
    assert.match(readPinnedOmpCliVersion(), /^\d+\.\d+\.\d+/);
  });
});
