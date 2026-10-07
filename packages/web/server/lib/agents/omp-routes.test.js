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
    renameSession: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => true),
    moveSession: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    getSessionStatus: vi.fn(async () => ({ busy: false })),
    listModels: vi.fn(async () => []),
    listCommands: vi.fn(async () => []),
    listLoginProviders: vi.fn(async () => []),
    login: vi.fn(async (providerId) => ({ providerId })),
    listPermissions: vi.fn(async () => []),
    replyPermission: vi.fn(async () => true),
    listMcpServers: vi.fn(async () => []),
    setMcpEnabled: vi.fn(async () => true),
    removeMcpServer: vi.fn(async () => true),
    ...overrides,
  };
};

const createApp = (host, enabled = true) => {
  const app = express();
  registerOmpRoutes(app, { getHost: async () => host, isEnabled: async () => enabled });
  return app;
};

describe('OMP routes', () => {
  it('answers 404 with a disabled flag when the runtime is off', async () => {
    const response = await request(createApp(createHost(), false)).get('/api/agents/omp/sessions');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'OMP runtime is disabled', disabled: true });
    expect((await request(createApp(createHost(), false)).get('/api/agents/omp/status')).body).toEqual({ enabled: false });
  });

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
    expect(host.prompt).toHaveBeenCalledWith('ses_a', 'hi', undefined, undefined);

    expect((await request(app).post('/api/agents/omp/sessions/ses_a/prompt').send({ text: '' })).status).toBe(400);
  });

  it('passes a client message id through to the prompt', async () => {
    const host = createHost();
    const response = await request(createApp(host)).post('/api/agents/omp/sessions/ses_a/prompt').send({ text: 'hi', messageId: 'client-1' });

    expect(response.status).toBe(200);
    expect(host.prompt).toHaveBeenCalledWith('ses_a', 'hi', 'client-1', undefined);
  });

  it('passes a prompt\'s images through to the host', async () => {
    const host = createHost();
    const images = [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }];
    const response = await request(createApp(host)).post('/api/agents/omp/sessions/ses_a/prompt').send({ text: 'look', images });

    expect(response.status).toBe(200);
    expect(host.prompt).toHaveBeenCalledWith('ses_a', 'look', undefined, images);
  });

  it('accepts an image-only prompt but not an empty one', async () => {
    const host = createHost();
    const app = createApp(host);
    const images = [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }];

    expect((await request(app).post('/api/agents/omp/sessions/ses_a/prompt').send({ text: '', images })).status).toBe(200);
    expect((await request(app).post('/api/agents/omp/sessions/ses_a/prompt').send({ text: '   ' })).status).toBe(400);
  });

  it('rejects an image that is not one', async () => {
    const host = createHost();
    const response = await request(createApp(host))
      .post('/api/agents/omp/sessions/ses_a/prompt')
      .send({ text: 'look', images: [{ type: 'file', data: 'QUJD', mimeType: 'image/png' }] });

    expect(response.status).toBe(400);
    expect(host.prompt).not.toHaveBeenCalled();
  });

  it('accepts an image larger than the other routes\' body limit', async () => {
    const host = createHost();
    // A plain screenshot base64-encodes past the 1mb the shared parser allows.
    const data = 'A'.repeat(1_500_000);
    const response = await request(createApp(host))
      .post('/api/agents/omp/sessions/ses_a/prompt')
      .send({ text: 'look', images: [{ type: 'image', data, mimeType: 'image/png' }] });

    expect(response.status).toBe(200);
    expect(host.prompt).toHaveBeenCalledWith('ses_a', 'look', undefined, [{ type: 'image', data, mimeType: 'image/png' }]);
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

  it('serves session mutations', async () => {
    const app = createApp(createHost());

    expect((await request(app).patch('/api/agents/omp/sessions/ses_1').send({ title: 'Renamed' })).body).toEqual({ ok: true });
    expect((await request(app).delete('/api/agents/omp/sessions/ses_1')).body).toEqual({ ok: true });
    expect((await request(app).post('/api/agents/omp/sessions/ses_1/move').send({ directory: '/repo/b' })).body).toEqual({ ok: true });
    expect((await request(app).post('/api/agents/omp/sessions/ses_1/model').send({ provider: 'anthropic', modelId: 'claude' })).body).toEqual({ ok: true });
  });

  it('rejects a mutation body that fails validation', async () => {
    const app = createApp(createHost());

    expect((await request(app).patch('/api/agents/omp/sessions/ses_1').send({ title: '' })).status).toBe(400);
    expect((await request(app).post('/api/agents/omp/sessions/ses_1/move').send({})).status).toBe(400);
    expect((await request(app).post('/api/agents/omp/sessions/ses_1/model').send({ provider: 'anthropic' })).status).toBe(400);
  });

  it('answers 404 when deleting an unknown session', async () => {
    const host = createHost({ deleteSession: vi.fn(async () => false) });
    const response = await request(createApp(host)).delete('/api/agents/omp/sessions/missing');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Unknown OMP session' });
  });

  it('serves status, models and commands', async () => {
    const app = createApp(createHost());

    expect((await request(app).get('/api/agents/omp/sessions/ses_1/status')).body).toEqual({ busy: false });
    expect((await request(app).get('/api/agents/omp/models')).body).toEqual({ models: [] });
    expect((await request(app).get('/api/agents/omp/commands')).body).toEqual({ commands: [] });
  });

  it('lists and answers permissions', async () => {
    const host = createHost({ listPermissions: vi.fn(async () => [{ id: 'ui_1', sessionID: 'ses_1', action: 'tool', resources: ['m'] }]) });
    const app = createApp(host);

    expect((await request(app).get('/api/agents/omp/sessions/ses_1/permissions')).body).toEqual({
      permissions: [{ id: 'ui_1', sessionID: 'ses_1', action: 'tool', resources: ['m'] }],
    });

    const answered = await request(app).post('/api/agents/omp/sessions/ses_1/permissions/ui_1').send({ reply: 'once' });
    expect(answered.body).toEqual({ ok: true });
    expect(host.replyPermission).toHaveBeenCalledWith('ses_1', 'ui_1', 'once', undefined);

    expect((await request(app).post('/api/agents/omp/sessions/ses_1/permissions/ui_1').send({ reply: 'maybe' })).status).toBe(400);
  });

  it('answers 404 when the permission was never asked', async () => {
    const host = createHost({ replyPermission: vi.fn(async () => false) });
    const response = await request(createApp(host)).post('/api/agents/omp/sessions/ses_1/permissions/ui_9').send({ reply: 'reject' });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Unknown OMP permission' });
  });

  it('lists and toggles MCP servers', async () => {
    const host = createHost({ listMcpServers: vi.fn(async () => [{ name: 'files', scope: 'user', enabled: true, type: 'stdio' }]) });
    const app = createApp(host);

    expect((await request(app).get('/api/agents/omp/mcp?directory=/repo')).body).toEqual({
      servers: [{ name: 'files', scope: 'user', enabled: true, type: 'stdio' }],
    });
    expect(host.listMcpServers).toHaveBeenCalledWith('/repo');

    expect((await request(app).post('/api/agents/omp/mcp/files/enabled').send({ enabled: false })).body).toEqual({ ok: true });
    expect(host.setMcpEnabled).toHaveBeenCalledWith('files', false);

    expect((await request(app).post('/api/agents/omp/mcp/files/enabled').send({ enabled: 'yes' })).status).toBe(400);
    expect((await request(app).delete('/api/agents/omp/mcp/files?scope=project&directory=/repo')).body).toEqual({ ok: true });
    expect(host.removeMcpServer).toHaveBeenCalledWith('files', 'project', '/repo');
  });

  it('answers 404 when removing an unknown MCP server', async () => {
    const host = createHost({ removeMcpServer: vi.fn(async () => false) });
    const response = await request(createApp(host)).delete('/api/agents/omp/mcp/missing');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Unknown OMP MCP server' });
  });

  it('lists the login providers OMP offers', async () => {
    const providers = [{ id: 'anthropic', name: 'Anthropic', available: true, authenticated: false }];
    const host = createHost({ listLoginProviders: vi.fn(async () => providers) });
    const response = await request(createApp(host)).get('/api/agents/omp/login/providers');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ providers });
  });

  it('starts a login and answers with the URL and its login id', async () => {
    const host = createHost({
      login: vi.fn(async (providerId) => ({ providerId, loginId: 'omp-login-1', url: 'https://auth.example/start', launchUrl: 'http://127.0.0.1:1/launch' })),
    });
    const response = await request(createApp(host)).post('/api/agents/omp/login').send({ providerId: 'anthropic' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ providerId: 'anthropic', loginId: 'omp-login-1', url: 'https://auth.example/start', launchUrl: 'http://127.0.0.1:1/launch' });
    expect(host.login).toHaveBeenCalledWith('anthropic');
  });

  it('rejects a missing provider and maps a refused login to 500', async () => {
    const host = createHost({
      login: vi.fn(async (providerId) => {
        throw new Error(`Unknown OAuth provider: ${providerId}`);
      }),
    });
    const app = createApp(host);

    expect((await request(app).post('/api/agents/omp/login').send({ providerId: '' })).status).toBe(400);
    const refused = await request(app).post('/api/agents/omp/login').send({ providerId: 'nope' });
    expect(refused.status).toBe(500);
    expect(refused.body).toEqual({ error: 'Unknown OAuth provider: nope' });
  });
});