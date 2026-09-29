/**
 * OMP agent routes.
 *
 * Explicit OpenChamber routes registered before the generic OpenCode proxy, so
 * `/api/agents/omp/*` never falls through to OpenCode. Every body parser is
 * attached per route: the generic proxy needs an unread request stream, so
 * parsing globally would break it.
 *
 * The routes are a thin shell over the injected host: validation, status codes
 * and serialization only. Domain behavior belongs to the adapter.
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

export const registerOmpRoutes = (app, { host }) => {
  // Registered only when the runtime is enabled, so a 404 tells the UI the
  // feature is off without it needing the server's env.
  app.get('/api/agents/omp/status', (_req, res) => res.json({ enabled: true }));

  app.get('/api/agents/omp/sessions', async (_req, res) => {
    try {
      const sessions = await host.listSessions();
      return res.json({ sessions: sessions.map(serializeSession) });
    } catch (error) {
      return respondWithError(res, error, 'Failed to list OMP sessions');
    }
  });

  app.post('/api/agents/omp/sessions', parseJsonBody, async (req, res) => {
    const parsed = createBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'cwd must be a non-empty string' });
    }
    const cwd = parsed.data?.cwd;
    try {
      const handle = await host.createSession(cwd !== undefined ? { cwd } : {});
      return res.status(201).json({ session: { id: handle.id, sessionFile: handle.sessionFile ?? null } });
    } catch (error) {
      return respondWithError(res, error, 'Failed to create OMP session');
    }
  });

  app.get('/api/agents/omp/sessions/:id/messages', async (req, res) => {
    try {
      return res.json(await host.getMessages(req.params.id));
    } catch (error) {
      return respondWithError(res, error, 'Failed to read OMP messages');
    }
  });

  app.post('/api/agents/omp/sessions/:id/prompt', parseJsonBody, async (req, res) => {
    const parsed = promptBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'text must be a non-empty string' });
    }
    try {
      const accepted = await host.prompt(req.params.id, parsed.data.text, parsed.data.messageId);
      return res.json({ ok: accepted === true });
    } catch (error) {
      return respondWithError(res, error, 'Failed to prompt OMP session');
    }
  });

  app.post('/api/agents/omp/sessions/:id/abort', async (req, res) => {
    try {
      await host.abort(req.params.id);
      return res.json({ ok: true });
    } catch (error) {
      return respondWithError(res, error, 'Failed to abort OMP session');
    }
  });
};