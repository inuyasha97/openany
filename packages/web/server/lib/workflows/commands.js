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
 *
 * The output is capped: a check may print for as long as its timeout allows, and
 * the run file stores this result, so only the first 64 KiB of each stream is
 * kept and `truncated` says the rest was dropped.
 */
import { spawn } from 'node:child_process';

const MAX_STREAM_BYTES = 64 * 1024;

/** Keeps `state.text` at or under the cap and flags the stream when it drops data. */
const appendChunk = (state, chunk) => {
  if (state.bytes >= MAX_STREAM_BYTES) {
    state.truncated = true;
    return;
  }
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const room = MAX_STREAM_BYTES - state.bytes;
  // The cap counts bytes of what the run file will hold, so the tail is cut on
  // the buffer. A character cut at the boundary decodes as U+FFFD, which is
  // wider than the byte it replaced, so the tail is dropped until it fits.
  let text = buffer.subarray(0, room).toString('utf8');
  let bytes = Buffer.byteLength(text);
  while (bytes > room && text.length > 0) {
    text = text.slice(0, -1);
    bytes = Buffer.byteLength(text);
  }
  state.text += text;
  state.bytes += bytes;
  if (buffer.length > room) state.truncated = true;
};

export const runCommandCheck = ({ directory, run, expectExit = 0, timeoutMs = 600_000 }) => new Promise((resolve) => {
  const startedAt = Date.now();
  const stdout = { text: '', bytes: 0, truncated: false };
  const stderr = { text: '', bytes: 0, truncated: false };
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
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
      timedOut,
      durationMs: Date.now() - startedAt,
      ok: !timedOut && exitCode === expectExit,
    });
  };

  child.stdout?.on('data', (chunk) => { appendChunk(stdout, chunk); });
  child.stderr?.on('data', (chunk) => { appendChunk(stderr, chunk); });
  child.on('error', (error) => {
    appendChunk(stderr, `${stderr.text ? '\n' : ''}${error.message}`);
    finish(null);
  });
  child.on('close', (code) => finish(code));
});
