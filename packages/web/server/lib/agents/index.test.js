import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { installOmpAgentRuntime, isOmpRuntimeForced } from './index.js';

const createAdapter = () => {
  let subscriber = null;
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
    async dispose() {},
    subscribe(listener) {
      subscriber = listener;
      return () => {
        subscriber = null;
      };
    },
  };
  return {
    OmpRuntime: class {
      constructor() {
        return runtime;
      }
    },
    createOmpHost: () => ({}),
    createOmpEventProjector: vi.fn(() => ({ project: () => [] })),
  };
};

describe('installOmpAgentRuntime', () => {
  it('is off unless the env flag forces it', () => {
    expect(isOmpRuntimeForced({})).toBe(false);
    expect(isOmpRuntimeForced({ OPENCHAMBER_OMP_RUNTIME: '1' })).toBe(true);
  });

  it('registers routes but answers 404 while disabled, without loading the adapter', async () => {
    const app = express();
    const adapter = createAdapter();
    await installOmpAgentRuntime({ app, broadcast: () => {}, env: {}, adapter });

    const response = await request(app).get('/api/agents/omp/sessions');
    expect(response.status).toBe(404);
    expect(response.body.disabled).toBe(true);
    expect(adapter.createOmpEventProjector).not.toHaveBeenCalled();
  });

  it('serves when the env flag forces it on', async () => {
    const app = express();
    await installOmpAgentRuntime({ app, broadcast: () => {}, env: { OPENCHAMBER_OMP_RUNTIME: '1' }, adaptersRunnable: () => true, adapter: createAdapter() });

    const response = await request(app).get('/api/agents/omp/sessions');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ sessions: [] });
    expect((await request(app).get('/api/agents/omp/status')).body).toEqual({ enabled: true });
  });

  it('serves when the setting enables it', async () => {
    const app = express();
    await installOmpAgentRuntime({ app, broadcast: () => {}, env: {}, adaptersRunnable: () => true, isSettingEnabled: async () => true, adapter: createAdapter() });

    expect((await request(app).get('/api/agents/omp/status')).body).toEqual({ enabled: true });
  });

  it('stays disabled when the adapters cannot run (Node desktop), even forced', async () => {
    const app = express();
    await installOmpAgentRuntime({
      app,
      broadcast: () => {},
      env: { OPENCHAMBER_OMP_RUNTIME: '1' },
      adaptersRunnable: () => false,
      adapter: createAdapter(),
    });

    expect((await request(app).get('/api/agents/omp/status')).body).toEqual({ enabled: false });
  });
});
