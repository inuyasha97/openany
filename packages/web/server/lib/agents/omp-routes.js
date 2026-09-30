/**
 * OMP agent routes.
 *
 * Explicit OpenChamber routes registered before the generic OpenCode proxy, so
 * `/api/agents/omp/*` never falls through to OpenCode. Every body parser is
 * attached per route: the generic proxy needs an unread request stream, so
 * parsing globally would break it.
 *
 * The routes are always registered; each request checks `isEnabled` first
 * (env flag or OpenChamber setting) and answers 404 when the runtime is off,
 * so a settings toggle takes effect without a restart.
 */

import express from 'express';
import { z } from 'zod';

const parseJsonBody = express.json({ limit: '1mb' });

const createBodySchema = z.object({ cwd: z.string().min(1).optional() }).optional();
const promptBodySchema = z.object({ text: z.string().min(1), messageId: z.string().min(1).optional() });

const isUnknownSession = (error) => {
  const message = error instanceof Error ? error.message : '';
  return message.startsWith('unknown omp session');
};

const respondWithError = (res, error, fallbackMessage) => {
  if (isUnknownSession(error)) {
    return res.status(404).json({ error: 'Unknown OMP session' });
  }
  const message = error instanceof Error ? error.message : fallbackMessage;
  return res.status(500).json({ error: message || fallbackMessage });
};

const serializeSession = (session) => ({
  id: session.id,
  sessionPath: session.sessionPath,
  cwd: session.cwd,
  title: session.title,
});

export const registerOmpRoutes = (app, { getHost, isEnabled }) => {
  const rejectIfDisabled = async (res) => {
    if (await isEnabled()) return false;
    res.status(404).json({ error: 'OMP runtime is disabled', disabled: true });
    return true;
  };

  app.get('/api/agents/omp/status', async (_req, res) => res.json({ enabled: await isEnabled() }));

  app.get('/api/agents/omp/sessions', async (_req, res) => {
    if (await rejectIfDisabled(res)) return;
    try {
      const sessions = await (await getHost()).listSessions();
      return res.json({ sessions: sessions.map(serializeSession) });
    } catch (error) {
      return respondWithError(res, error, 'Failed to list OMP sessions');
    }
  });

  app.post('/api/agents/omp/sessions', parseJsonBody, async (req, res) => {
    if (await rejectIfDisabled(res)) return;
    const parsed = createBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'cwd must be a non-empty string' });
    }
    const cwd = parsed.data?.cwd;
    try {
      const handle = await (await getHost()).createSession(cwd !== undefined ? { cwd } : {});
      return res.status(201).json({ session: { id: handle.id, sessionFile: handle.sessionFile ?? null } });
    } catch (error) {
      return respondWithError(res, error, 'Failed to create OMP session');
    }
  });

  app.get('/api/agents/omp/sessions/:id/messages', async (req, res) => {
    if (await rejectIfDisabled(res)) return;
    try {
      return res.json(await (await getHost()).getMessages(req.params.id));
    } catch (error) {
      return respondWithError(res, error, 'Failed to read OMP messages');
    }
  });

  app.post('/api/agents/omp/sessions/:id/prompt', parseJsonBody, async (req, res) => {
    if (await rejectIfDisabled(res)) return;
    const parsed = promptBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'text must be a non-empty string' });
    }
    try {
      const accepted = await (await getHost()).prompt(req.params.id, parsed.data.text, parsed.data.messageId);
      return res.json({ ok: accepted === true });
    } catch (error) {
      return respondWithError(res, error, 'Failed to prompt OMP session');
    }
  });

  app.post('/api/agents/omp/sessions/:id/abort', async (req, res) => {
    if (await rejectIfDisabled(res)) return;
    try {
      await (await getHost()).abort(req.params.id);
      return res.json({ ok: true });
    } catch (error) {
      return respondWithError(res, error, 'Failed to abort OMP session');
    }
  });
};
