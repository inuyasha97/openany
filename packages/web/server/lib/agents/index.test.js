import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { installOmpAgentRuntime } from './index.js';

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
  it('registers routes and serves them with no flag', async () => {
    const app = express();
    await installOmpAgentRuntime({ app, broadcast: () => {}, adapter: createAdapter() });

    const response = await request(app).get('/api/agents/omp/sessions');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ sessions: [] });
  });
});
