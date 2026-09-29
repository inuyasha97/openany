import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { registerOmpRoutes } from './omp-routes.js';

const createHost = (overrides = {}) => {
  const sessions = [
    { id: 'ses_a', sessionPath: '/s/a.json', cwd: '/repo', title: 'A' },
  ];
  return {
    listSessions: vi.fn(async () => sessions),
    createSession: vi.fn(async (input) => ({ id: 'ses_new', sessionFile: '/s/new.json', cwd: input.cwd ?? '' })),
    getMessages: vi.fn(async () => ({ items: [], cursor: {} })),
    prompt: vi.fn(async () => true),
    abort: vi.fn(async () => {}),
    ...overrides,
  };
};

const createApp = (host) => {
  const app = express();
  registerOmpRoutes(app, { host });
  return app;
};

describe('OMP routes', () => {
  it('announces the runtime on the status route', async () => {
    const response = await request(createApp(createHost())).get('/api/agents/omp/status');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ enabled: true });
  });

  it('lists sessions in the wire shape', async () => {
    const host = createHost();
    const response = await request(createApp(host)).get('/api/agents/omp/sessions');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ sessions: [{ id: 'ses_a', sessionPath: '/s/a.json', cwd: '/repo', title: 'A' }] });
  });

  it('creates a session with a cwd', async () => {
    const host = createHost();
    const response = await request(createApp(host)).post('/api/agents/omp/sessions').send({ cwd: '/repo' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ session: { id: 'ses_new', sessionFile: '/s/new.json' } });
    expect(host.createSession).toHaveBeenCalledWith({ cwd: '/repo' });
  });

  it('rejects a non-string cwd', async () => {
    const host = createHost();
    const response = await request(createApp(host)).post('/api/agents/omp/sessions').send({ cwd: 5 });

    expect(response.status).toBe(400);
    expect(host.createSession).not.toHaveBeenCalled();
  });

  it('prompts a session and requires text', async () => {
    const host = createHost();
    const app = createApp(host);

    expect((await request(app).post('/api/agents/omp/sessions/ses_a/prompt').send({ text: 'hi' })).body).toEqual({ ok: true });
    expect(host.prompt).toHaveBeenCalledWith('ses_a', 'hi', undefined);

    expect((await request(app).post('/api/agents/omp/sessions/ses_a/prompt').send({ text: '' })).status).toBe(400);
  });

  it('passes a client message id through to the prompt', async () => {
    const host = createHost();
    const response = await request(createApp(host)).post('/api/agents/omp/sessions/ses_a/prompt').send({ text: 'hi', messageId: 'client-1' });

    expect(response.status).toBe(200);
    expect(host.prompt).toHaveBeenCalledWith('ses_a', 'hi', 'client-1');
  });

  it('reads session messages', async () => {
    const host = createHost({
      getMessages: vi.fn(async () => ({ items: [{ info: { id: 'm1', role: 'user' }, parts: [] }], cursor: {} })),
    });
    const response = await request(createApp(host)).get('/api/agents/omp/sessions/ses_a/messages');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [{ info: { id: 'm1', role: 'user' }, parts: [] }], cursor: {} });
    expect(host.getMessages).toHaveBeenCalledWith('ses_a');
  });

  it('aborts a session', async () => {
    const host = createHost();
    const response = await request(createApp(host)).post('/api/agents/omp/sessions/ses_a/abort');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(host.abort).toHaveBeenCalledWith('ses_a');
  });

  it('maps an unknown session to 404', async () => {
    const host = createHost({
      prompt: vi.fn(async () => {
        throw new Error('unknown omp session: missing');
      }),
    });
    const response = await request(createApp(host)).post('/api/agents/omp/sessions/missing/prompt').send({ text: 'hi' });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Unknown OMP session' });
  });

  it('maps any other host failure to 500', async () => {
    const host = createHost({
      listSessions: vi.fn(async () => {
        throw new Error('store unavailable');
      }),
    });
    const response = await request(createApp(host)).get('/api/agents/omp/sessions');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'store unavailable' });
  });
});