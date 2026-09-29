/**
 * ACP agent routes.
 *
 * Explicit OpenChamber routes registered before the generic OpenCode proxy.
 * Bodies are parsed per route so the proxy still sees an unread stream. The
 * permission route carries the user's reply (once/always/reject); the host maps
 * it to the ACP option the agent offered.
 */

import express from 'express';
import { z } from 'zod';

const parseJsonBody = express.json({ limit: '1mb' });

const createBodySchema = z.object({ cwd: z.string().min(1).optional() }).optional();
const promptBodySchema = z.object({ text: z.string().min(1) });
const permissionBodySchema = z.object({ requestId: z.string().min(1), reply: z.enum(['once', 'always', 'reject']) });

const isUnknownSession = (error) => {
  const message = error instanceof Error ? error.message : '';
  return message.startsWith('unknown acp session');
};

const respondWithError = (res, error, fallbackMessage) => {
  if (isUnknownSession(error)) {
    return res.status(404).json({ error: 'Unknown ACP session' });
  }
  const message = error instanceof Error ? error.message : fallbackMessage;
  return res.status(500).json({ error: message || fallbackMessage });
};

const serializeSession = (session) => ({
  id: session.id,
  cwd: session.cwd,
  title: session.title ?? '',
});

export const registerAcpRoutes = (app, { host }) => {
  app.get('/api/agents/acp/status', (_req, res) => res.json({ enabled: true }));

  app.get('/api/agents/acp/sessions', async (_req, res) => {
    try {
      const sessions = await host.listSessions();
      return res.json({ sessions: sessions.map(serializeSession) });
    } catch (error) {
      return respondWithError(res, error, 'Failed to list ACP sessions');
    }
  });

  app.post('/api/agents/acp/sessions', parseJsonBody, async (req, res) => {
    const parsed = createBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'cwd must be a non-empty string' });
    }
    const cwd = parsed.data?.cwd;
    try {
      const handle = await host.createSession(cwd !== undefined ? { cwd } : {});
      return res.status(201).json({ session: { id: handle.id } });
    } catch (error) {
      return respondWithError(res, error, 'Failed to create ACP session');
    }
  });

  app.post('/api/agents/acp/sessions/:id/prompt', parseJsonBody, async (req, res) => {
    const parsed = promptBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'text must be a non-empty string' });
    }
    try {
      const accepted = await host.prompt(req.params.id, parsed.data.text);
      return res.json({ ok: accepted === true });
    } catch (error) {
      return respondWithError(res, error, 'Failed to prompt ACP session');
    }
  });

  app.post('/api/agents/acp/sessions/:id/abort', async (req, res) => {
    try {
      await host.abort(req.params.id);
      return res.json({ ok: true });
    } catch (error) {
      return respondWithError(res, error, 'Failed to abort ACP session');
    }
  });

  app.post('/api/agents/acp/sessions/:id/permission', parseJsonBody, async (req, res) => {
    const parsed = permissionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'requestId and reply are required' });
    }
    try {
      const accepted = await host.replyPermission(req.params.id, parsed.data.requestId, parsed.data.reply);
      return res.json({ ok: accepted === true });
    } catch (error) {
      return respondWithError(res, error, 'Failed to reply to ACP permission');
    }
  });
};
