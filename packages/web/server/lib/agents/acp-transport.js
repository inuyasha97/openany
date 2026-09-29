/**
 * The ACP stdio process transport.
 *
 * The agent is a subprocess that speaks newline-delimited JSON-RPC on stdio
 * (ACP transports). This is the only Node-specific piece of the ACP path; the
 * adapter's client is transport-agnostic and tested with a fake.
 */

import { spawn } from 'node:child_process';

export const createProcessTransport = ({ command, args = [], cwd, env }) => {
  const child = spawn(command, args, {
    cwd,
    env: env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  const listeners = new Set();

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const raw = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (raw.length === 0) continue;
      for (const listener of listeners) {
        try {
          listener(raw);
        } catch (error) {
          console.warn('[acp] line handler failed:', error instanceof Error ? error.message : error);
        }
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    // ACP reserves stderr for agent logging; forward it so a crash is visible.
    const text = String(chunk).trim();
    if (text.length > 0) console.warn('[acp] agent:', text);
  });
  child.on('error', (error) => {
    console.error('[acp] agent process error:', error instanceof Error ? error.message : error);
  });

  return {
    write: (line) => {
      if (child.stdin.writable) child.stdin.write(`${line}\n`);
    },
    onLine: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      try {
        child.stdin.end();
        child.kill();
      } catch {
        /* best effort */
      }
    },
  };
};
