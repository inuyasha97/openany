import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stopEmbeddedServer } from './server-shutdown.mjs';

test('waits for backend-owned children before allowing Electron to exit', async () => {
  let release;
  let stopped = false;
  let options;
  const cleanup = new Promise((resolve) => { release = resolve; });
  const stopping = stopEmbeddedServer({ stop(input) { options = input; return cleanup; } }, {
    warn() { assert.fail('normal shutdown must succeed'); },
  }).then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.deepEqual(options, { exitProcess: false });
  release();
  await stopping;
  assert.equal(stopped, true);
});

// The server handle exposes no OpenCode accessor since the desktop runs OMP
// in-process; shutdown must still run and report a failure on the handle alone.
for (const failure of ['error', 'deadline']) {
  test(`reports a backend ${failure} without consulting an OpenCode process`, async () => {
    const warnings = [];
    await stopEmbeddedServer({
      stop: () => failure === 'error' ? Promise.reject(new Error('fixture')) : new Promise(() => {}),
    }, { timeoutMs: 10, warn: (error) => warnings.push(error) });
    assert.equal(warnings.length, 1);
  });
}

test('remote-only Desktop has no local backend to stop', async () => {
  await stopEmbeddedServer(null, {
    warn() { assert.fail('missing local backend is normal'); },
  });
});

test('the default deadline leaves room for terminal grace and subsequent cleanup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release;
  let stopped = false;
  const cleanup = new Promise(resolve => { release = resolve; });
  const stopping = stopEmbeddedServer({ stop: () => cleanup }, {
    warn() { assert.fail('a 20-second terminal shutdown is within the desktop deadline'); },
  }).then(() => { stopped = true; });
  t.mock.timers.tick(25_000);
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await stopping;
});
