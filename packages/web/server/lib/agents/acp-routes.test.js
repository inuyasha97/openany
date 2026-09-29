import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { registerAcpRoutes } from './acp-routes.js';

const createHost = (overrides = {}) => ({
  listSessions: vi.fn(async () => [{ id: 'ses_a', cwd: '/repo', title: 'A' }]),
  createSession: vi.fn(async (input) => ({ id: 'ses_new', cwd: input.cwd ?? '' })),
  prompt: vi.fn(async () => true),
  abort: vi.fn(async () => {}),
  replyPermission: vi.fn(async () => true),
  ...overrides,
});

const createApp = (host) => {
  const app = express();
  registerAcpRoutes(app, { host });
  return app;
};

describe('ACP routes', () => {
  it('announces the runtime on the status route', async () => {
    const response = await request(createApp(createHost())).get('/api/agents/acp/status');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ enabled: true });
  });

  it('lists sessions in the wire shape', async () => {
    const response = await request(createApp(createHost())).get('/api/agents/acp/sessions');
    expect(response.body).toEqual({ sessions: [{ id: 'ses_a', cwd: '/repo', title: 'A' }] });
  });

  it('creates a session with a cwd', async () => {
    const host = createHost();
    const response = await request(createApp(host)).post('/api/agents/acp/sessions').send({ cwd: '/repo' });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ session: { id: 'ses_new' } });
    expect(host.createSession).toHaveBeenCalledWith({ cwd: '/repo' });
  });

  it('prompts, aborts and replies to a permission', async () => {
    const host = createHost();
    const app = createApp(host);

    expect((await request(app).post('/api/agents/acp/sessions/ses_a/prompt').send({ text: 'hi' })).status).toBe(200);
    expect(host.prompt).toHaveBeenCalledWith('ses_a', 'hi');
    expect((await request(app).post('/api/agents/acp/sessions/ses_a/abort')).status).toBe(200);
    expect(host.abort).toHaveBeenCalledWith('ses_a');

    const reply = await request(app).post('/api/agents/acp/sessions/ses_a/permission').send({ requestId: 'req_1', reply: 'always' });
    expect(reply.status).toBe(200);
    expect(host.replyPermission).toHaveBeenCalledWith('ses_a', 'req_1', 'always');
  });

  it('rejects a malformed permission reply and an unknown session', async () => {
    const host = createHost({
      prompt: vi.fn(async () => {
        throw new Error('unknown acp session: missing');
      }),
    });
    const app = createApp(host);
    expect((await request(app).post('/api/agents/acp/sessions/ses_a/permission').send({ reply: 'always' })).status).toBe(400);
    expect((await request(app).post('/api/agents/acp/sessions/missing/prompt').send({ text: 'hi' })).status).toBe(404);
  });
});
