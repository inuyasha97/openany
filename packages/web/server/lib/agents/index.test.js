import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { installOmpAgentRuntime, isOmpRuntimeEnabled } from './index.js';

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
  it('is off by default', () => {
    expect(isOmpRuntimeEnabled({})).toBe(false);
    expect(isOmpRuntimeEnabled({ OPENCHAMBER_OMP_RUNTIME: '1' })).toBe(true);
  });

  it('does nothing and never loads the adapter when the flag is off', async () => {
    const app = express();
    const loadAdapter = vi.fn();
    const result = await installOmpAgentRuntime({ app, broadcast: () => {}, env: {}, adapter: loadAdapter });

    expect(result).toBeNull();
    expect(loadAdapter).not.toHaveBeenCalled();
  });

  it('mounts the routes when enabled', async () => {
    const app = express();
    const host = await installOmpAgentRuntime({
      app,
      broadcast: () => {},
      env: { OPENCHAMBER_OMP_RUNTIME: '1' },
      adapter: createAdapter(),
    });

    expect(host).not.toBeNull();
    const response = await request(app).get('/api/agents/omp/sessions');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ sessions: [] });
  });

  it('reports a mount failure without throwing', async () => {
    const app = express();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await installOmpAgentRuntime({
      app,
      broadcast: () => {},
      env: { OPENCHAMBER_OMP_RUNTIME: '1' },
      adapter: {
        OmpRuntime: class {
          constructor() {
            throw new Error('boom');
          }
        },
        createOmpHost: () => ({}),
        createOmpEventProjector: () => ({ project: () => [] }),
      },
    });

    expect(result).toBeNull();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});