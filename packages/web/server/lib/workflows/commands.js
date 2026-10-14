/**
 * One verifier command, run in the run's directory.
 *
 * `shell: true` so a definition can write `bun run type-check:web` the way a
 * person would type it in the project. The child is killed at the timeout and
 * the result says `timedOut`, so a hung check never reads as a passed one.
 *
 * `detached: true` puts the shell and everything it spawns in one process
 * group. Killing only the shell leaves its descendants alive holding the
 * stdout/stderr pipes, so `close` never fires and the engine would await a
 * check that cannot end; the group kill and the immediate `finish(null)`
 * together make the timeout authoritative.
 */
import { spawn } from 'node:child_process';

export const runCommandCheck = ({ directory, run, expectExit = 0, timeoutMs = 600_000 }) => new Promise((resolve) => {
  const startedAt = Date.now();
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let settled = false;
  const child = spawn(run, { cwd: directory, shell: true, detached: true });

  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    finish(null);
  }, timeoutMs);

  const finish = (exitCode) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({
      run,
      expectExit,
      exitCode,
      stdout,
      stderr,
      timedOut,
      durationMs: Date.now() - startedAt,
      ok: !timedOut && exitCode === expectExit,
    });
  };

  child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', (error) => {
    stderr += `${stderr ? '\n' : ''}${error.message}`;
    finish(null);
  });
  child.on('close', (code) => finish(code));
});
