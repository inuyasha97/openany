/**
 * ACP agent routes.
 *
 * Explicit OpenChamber routes registered before the generic OpenCode proxy.
 * Bodies are parsed per route so the proxy still sees an unread stream.
 *
 * The routes are always registered; each request checks `isEnabled` first
 * (env flag or OpenChamber setting) and answers 404 when the runtime is off, so
 * a settings toggle takes effect without a restart. The permission route
 * carries the user's reply (once/always/reject); the host maps it to the ACP
 * option the agent offered.
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

export const registerAcpRoutes = (app, { getHost, isEnabled }) => {
  const rejectIfDisabled = async (res) => {
    if (await isEnabled()) return false;
    res.status(404).json({ error: 'ACP runtime is disabled', disabled: true });
    return true;
  };

  app.get('/api/agents/acp/status', async (_req, res) => res.json({ enabled: await isEnabled() }));

  app.get('/api/agents/acp/sessions', async (_req, res) => {
    if (await rejectIfDisabled(res)) return;
    try {
      const sessions = await (await getHost()).listSessions();
      return res.json({ sessions: sessions.map(serializeSession) });
    } catch (error) {
      return respondWithError(res, error, 'Failed to list ACP sessions');
    }
  });

  app.post('/api/agents/acp/sessions', parseJsonBody, async (req, res) => {
    if (await rejectIfDisabled(res)) return;
    const parsed = createBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'cwd must be a non-empty string' });
    }
    const cwd = parsed.data?.cwd;
    try {
      const handle = await (await getHost()).createSession(cwd !== undefined ? { cwd } : {});
      return res.status(201).json({ session: { id: handle.id } });
    } catch (error) {
      return respondWithError(res, error, 'Failed to create ACP session');
    }
  });

  app.post('/api/agents/acp/sessions/:id/prompt', parseJsonBody, async (req, res) => {
    if (await rejectIfDisabled(res)) return;
    const parsed = promptBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'text must be a non-empty string' });
    }
    try {
      const accepted = await (await getHost()).prompt(req.params.id, parsed.data.text);
      return res.json({ ok: accepted === true });
    } catch (error) {
      return respondWithError(res, error, 'Failed to prompt ACP session');
    }
  });

  app.post('/api/agents/acp/sessions/:id/abort', async (req, res) => {
    if (await rejectIfDisabled(res)) return;
    try {
      await (await getHost()).abort(req.params.id);
      return res.json({ ok: true });
    } catch (error) {
      return respondWithError(res, error, 'Failed to abort ACP session');
    }
  });

  app.post('/api/agents/acp/sessions/:id/permission', parseJsonBody, async (req, res) => {
    if (await rejectIfDisabled(res)) return;
    const parsed = permissionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'requestId and reply are required' });
    }
    try {
      const accepted = await (await getHost()).replyPermission(req.params.id, parsed.data.requestId, parsed.data.reply);
      return res.json({ ok: accepted === true });
    } catch (error) {
      return respondWithError(res, error, 'Failed to reply to ACP permission');
    }
  });
};
