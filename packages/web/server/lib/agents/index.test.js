import express from 'express';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { installOmpAgentRuntime } from './index.js';

const require = createRequire(import.meta.url);

const createAdapter = () => {
  const runtime = {
    async listSessions() {
      return [];
    },
    async createSession() {
      return { id: 'ses_new', sessionFile: '/s/new.json' };
    },
    async prompt() {
      return true;
    },
    async abort() {},
    async getMessages() {
      return [];
    },
    async dispose() {},
    subscribe() {
      return () => {};
    },
  };
  return {
    OmpRuntime: class {
      constructor() {
        return runtime;
      }
    },
    createOmpHost: vi.fn(() => ({})),
    createOmpEventProjector: vi.fn(() => ({ project: () => [] })),
  };
};

describe('installOmpAgentRuntime', () => {
  it('resolves the adapter to its compiled entry point', () => {
    // The regression this guards: the server imported `omp-adapter/src/index.ts`
    // by relative path, which Bun loads and Node does not, so every OMP route
    // answered 500 inside Electron and in the Docker image.
    const entry = require.resolve('@openchamber/omp-adapter');
    expect(entry.endsWith(path.join('omp-adapter', 'dist', 'index.js'))).toBe(true);
    expect(fs.existsSync(entry)).toBe(true);
  });

  it('serves a route in a fresh Node process, the runtime Electron embeds', () => {
    // The regression this guards: the server imported `omp-adapter/src/index.ts`
    // by relative path, which Bun resolves and Node does not, so every OMP route
    // answered 500 inside Electron and in the Docker image. Vitest resolves
    // TypeScript itself, so only a real Node child can see the difference.
    const moduleUrl = new URL('./index.js', import.meta.url).href;
    const result = spawnSync('node', ['--input-type=module', '--eval', `
      import express from 'express';
      const { installOmpAgentRuntime } = await import(${JSON.stringify(moduleUrl)});
      const app = express();
      await installOmpAgentRuntime({ app, broadcast: () => {} });
      const server = app.listen(0);
      await new Promise((resolve) => server.once('listening', resolve));
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/agents/omp/sessions');
      console.log('STATUS ' + response.status);
      server.close();
    `], { encoding: 'utf8', timeout: 30_000, windowsHide: true });

    expect(result.status, result.stderr).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('STATUS 200');
  });

  it('registers routes and serves them with no flag', async () => {
    const app = express();
    await installOmpAgentRuntime({ app, broadcast: () => {}, adapter: createAdapter() });

    const response = await request(app).get('/api/agents/omp/sessions');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ sessions: [] });
  });
});
