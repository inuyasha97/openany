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
// A prompt may carry base64 images (`ImageContent[]`), which overshoot the 1mb
// the other routes need by far. Only this route gets the larger budget.
const parsePromptBody = express.json({ limit: '64mb' });

const createBodySchema = z.object({ cwd: z.string().min(1).optional() }).optional();
const promptImageSchema = z.object({
  type: z.literal('image'),
  data: z.string().min(1),
  mimeType: z.string().min(1),
});
const promptBodySchema = z.object({
  text: z.string(),
  messageId: z.string().min(1).optional(),
  images: z.array(promptImageSchema).optional(),
}).refine((body) => body.text.trim().length > 0 || (body.images?.length ?? 0) > 0);
const renameBodySchema = z.object({ title: z.string().min(1) });
const moveBodySchema = z.object({ directory: z.string().min(1) });
const modelBodySchema = z.object({ provider: z.string().min(1), modelId: z.string().min(1) });
const permissionReplySchema = z.object({ reply: z.enum(['once', 'always', 'reject']), value: z.string().optional() });
const mcpEnabledSchema = z.object({ enabled: z.boolean() });
const loginBodySchema = z.object({ providerId: z.string().min(1) });

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

  app.post('/api/agents/omp/sessions/:id/prompt', parsePromptBody, async (req, res) => {
    if (await rejectIfDisabled(res)) return;
    const parsed = promptBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'text must be a non-empty string unless the prompt carries images' });
    }
    try {
      const { text, messageId, images } = parsed.data;
      const accepted = await (await getHost()).prompt(req.params.id, text, messageId, images);
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

  app.patch('/api/agents/omp/sessions/:id', parseJsonBody, async (req, res) => {
    if (await rejectIfDisabled(res)) return;
    const parsed = renameBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'title must be a non-empty string' });
    }
    try {
      await (await getHost()).renameSession(req.params.id, parsed.data.title);
      return res.json({ ok: true });
    } catch (error) {
      return respondWithError(res, error, 'Failed to rename OMP session');
    }
  });

  app.delete('/api/agents/omp/sessions/:id', async (req, res) => {
    if (await rejectIfDisabled(res)) return;
    try {
      const deleted = await (await getHost()).deleteSession(req.params.id);
      if (!deleted) return res.status(404).json({ error: 'Unknown OMP session' });
      return res.json({ ok: true });
    } catch (error) {
      return respondWithError(res, error, 'Failed to delete OMP session');
    }
  });

  app.post('/api/agents/omp/sessions/:id/move', parseJsonBody, async (req, res) => {
    if (await rejectIfDisabled(res)) return;
    const parsed = moveBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'directory must be a non-empty string' });
    }
    try {
      await (await getHost()).moveSession(req.params.id, parsed.data.directory);
      return res.json({ ok: true });
    } catch (error) {
      return respondWithError(res, error, 'Failed to move OMP session');
    }
  });

  app.post('/api/agents/omp/sessions/:id/model', parseJsonBody, async (req, res) => {
    if (await rejectIfDisabled(res)) return;
    const parsed = modelBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'provider and modelId must be non-empty strings' });
    }
    try {
      await (await getHost()).setModel(req.params.id, parsed.data.provider, parsed.data.modelId);
      return res.json({ ok: true });
    } catch (error) {
      return respondWithError(res, error, 'Failed to set OMP session model');
    }
  });

  app.get('/api/agents/omp/sessions/:id/status', async (req, res) => {
    if (await rejectIfDisabled(res)) return;
    try {
      return res.json(await (await getHost()).getSessionStatus(req.params.id));
    } catch (error) {
      return respondWithError(res, error, 'Failed to read OMP session status');
    }
  });

  app.get('/api/agents/omp/models', async (_req, res) => {
    if (await rejectIfDisabled(res)) return;
    try {
      return res.json({ models: await (await getHost()).listModels() });
    } catch (error) {
      return respondWithError(res, error, 'Failed to list OMP models');
    }
  });

  app.get('/api/agents/omp/commands', async (_req, res) => {
    if (await rejectIfDisabled(res)) return;
    try {
      return res.json({ commands: await (await getHost()).listCommands() });
    } catch (error) {
      return respondWithError(res, error, 'Failed to list OMP commands');
    }
  });

  app.get('/api/agents/omp/login/providers', async (_req, res) => {
    if (await rejectIfDisabled(res)) return;
    try {
      return res.json({ providers: await (await getHost()).listLoginProviders() });
    } catch (error) {
      return respondWithError(res, error, 'Failed to list OMP login providers');
    }
  });

  /**
   * Starts a login and answers as soon as OMP has something for the user: the
   * browser URL, or (with the `loginId`) completion. The login keeps running
   * after this response, so the UI confirms it through `login/providers`.
   */
  app.post('/api/agents/omp/login', parseJsonBody, async (req, res) => {
    if (await rejectIfDisabled(res)) return;
    const parsed = loginBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'providerId must be a non-empty string' });
    }
    try {
      return res.json(await (await getHost()).login(parsed.data.providerId));
    } catch (error) {
      return respondWithError(res, error, 'Failed to start OMP login');
    }
  });

  app.get('/api/agents/omp/mcp', async (req, res) => {
    if (await rejectIfDisabled(res)) return;
    try {
      const directory = typeof req.query.directory === 'string' && req.query.directory ? req.query.directory : undefined;
      return res.json({ servers: await (await getHost()).listMcpServers(directory) });
    } catch (error) {
      return respondWithError(res, error, 'Failed to list OMP MCP servers');
    }
  });

  app.post('/api/agents/omp/mcp/:name/enabled', parseJsonBody, async (req, res) => {
    if (await rejectIfDisabled(res)) return;
    const parsed = mcpEnabledSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    try {
      await (await getHost()).setMcpEnabled(req.params.name, parsed.data.enabled);
      return res.json({ ok: true });
    } catch (error) {
      return respondWithError(res, error, 'Failed to toggle OMP MCP server');
    }
  });

  app.delete('/api/agents/omp/mcp/:name', async (req, res) => {
    if (await rejectIfDisabled(res)) return;
    const scope = req.query.scope === 'project' ? 'project' : 'user';
    const directory = typeof req.query.directory === 'string' && req.query.directory ? req.query.directory : undefined;
    try {
      const removed = await (await getHost()).removeMcpServer(req.params.name, scope, directory);
      if (!removed) return res.status(404).json({ error: 'Unknown OMP MCP server' });
      return res.json({ ok: true });
    } catch (error) {
      return respondWithError(res, error, 'Failed to remove OMP MCP server');
    }
  });

  app.get('/api/agents/omp/sessions/:id/permissions', async (req, res) => {
    if (await rejectIfDisabled(res)) return;
    try {
      return res.json({ permissions: await (await getHost()).listPermissions(req.params.id) });
    } catch (error) {
      return respondWithError(res, error, 'Failed to list OMP permissions');
    }
  });

  app.post('/api/agents/omp/sessions/:id/permissions/:requestId', parseJsonBody, async (req, res) => {
    if (await rejectIfDisabled(res)) return;
    const parsed = permissionReplySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'reply must be once, always or reject' });
    }
    try {
      const ok = await (await getHost()).replyPermission(req.params.id, req.params.requestId, parsed.data.reply, parsed.data.value);
      if (!ok) return res.status(404).json({ error: 'Unknown OMP permission' });
      return res.json({ ok: true });
    } catch (error) {
      return respondWithError(res, error, 'Failed to answer OMP permission');
    }
  });
};
