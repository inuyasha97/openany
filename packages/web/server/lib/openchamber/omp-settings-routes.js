import express from 'express';
import { z } from 'zod';

import {
  getUserConfigPath,
  readConfigFile as defaultReadConfigFile,
  isPlainObject,
  writeConfigKey as defaultWriteConfigKey,
} from './agent-config-files.js';

/**
 * The body parser is attached per route: this family is registered without a
 * global JSON parser (the generic proxy needs an unread request stream), so a
 * PUT without one sees `req.body === undefined` and answers 400 for a valid
 * body.
 */
const parseJsonBody = express.json({ limit: '64kb' });

/**
 * `GET|PUT /api/config/cache-retention`.
 *
 * OMP keeps Anthropic's prompt cache warm itself; the knob is
 * `providers.cacheRetention` in the agent directory's user config file
 * (`auto|short|long|none`, OMP's `default` is `auto`). This replaced the old
 * session-warming row: there is no warm-up loop left to configure, only this
 * retention value, which OMP forwards to providers that support it.
 *
 * The write touches that single key. Every other key — and every other
 * `providers` entry — is read back and written unchanged, and the response
 * reports whether the value actually moved so the UI does not claim a change
 * OMP will not make.
 *
 * Reads answer OMP's own default when the key is absent rather than `null`, so
 * the settings row always shows the value OMP would use.
 */
export const CACHE_RETENTION_VALUES = ['auto', 'short', 'long', 'none'];

const cacheRetentionSchema = z.enum(CACHE_RETENTION_VALUES);

const CACHE_RETENTION_DEFAULT = 'auto';

const ACCEPTED_VALUES = cacheRetentionSchema.options.join(', ');

/** OMP's `tools.approvalMode` values, most cautious first. OMP's default is `yolo`. */
export const TOOL_APPROVAL_MODES = ['always-ask', 'write', 'yolo'];

const toolApprovalSchema = z.enum(TOOL_APPROVAL_MODES);

const TOOL_APPROVAL_DEFAULT = 'yolo';

export const registerOmpSettingsRoutes = (app, dependencies = {}) => {
  const {
    readConfigFile = defaultReadConfigFile,
    writeConfigKey = defaultWriteConfigKey,
  } = dependencies;

  /**
   * The file OMP actually loads is the first existing of `config.yml` and the
   * legacy `config.yaml` (falling back to the canonical `config.yml`). Resolve
   * at call time so a machine whose settings live in `config.yaml` is read and
   * updated in place — writing a fresh `config.yml` would shadow the file OMP
   * loads and silently drop every setting it holds.
   */
  const resolveConfigFile = () => getUserConfigPath();

  const readRetention = () => {
    const config = readConfigFile(resolveConfigFile()) ?? {};
    const stored = isPlainObject(config.providers) ? config.providers.cacheRetention : undefined;
    return cacheRetentionSchema.safeParse(stored).success ? stored : CACHE_RETENTION_DEFAULT;
  };

  app.get('/api/config/cache-retention', async (_req, res) => {
    try {
      res.json({ retention: readRetention() });
    } catch (error) {
      console.error('[API:GET /api/config/cache-retention] Failed to read cache retention:', error);
      res.status(500).json({ error: 'Failed to read cache retention' });
    }
  });

  app.put('/api/config/cache-retention', parseJsonBody, async (req, res) => {
    const parsed = cacheRetentionSchema.safeParse(req.body?.retention);
    if (!parsed.success) {
      res.status(400).json({ error: `retention must be one of: ${ACCEPTED_VALUES}` });
      return;
    }

    try {
      const configFile = resolveConfigFile();
      const config = readConfigFile(configFile) ?? {};
      if (config.providers !== undefined && !isPlainObject(config.providers)) {
        throw new Error('the providers section is not a mapping');
      }

      const previous = readRetention();
      writeConfigKey(configFile, ['providers', 'cacheRetention'], parsed.data);

      res.json({ retention: parsed.data, changed: previous !== parsed.data });
    } catch (error) {
      console.error('[API:PUT /api/config/cache-retention] Failed to save cache retention:', error);
      res.status(500).json({ error: 'Failed to save cache retention' });
    }
  });

  /**
   * `GET|PUT /api/config/tool-approval`.
   *
   * OMP's own policy for tool calls, `tools.approvalMode`: `always-ask`
   * auto-approves read-only tools and prompts for write and exec ones, `write`
   * auto-approves read and write, `yolo` auto-approves everything. OMP's
   * default is `yolo`, which is why a session runs commands without asking
   * until this is set.
   *
   * The other half of OMP's policy, `tools.approval` (per-tool
   * allow/prompt/deny), is deliberately not touched here: this route reads and
   * writes only the mode, and everything else under `tools` — and the rest of
   * the document — is read back and written unchanged.
   */
  const readToolApproval = () => {
    const config = readConfigFile(resolveConfigFile()) ?? {};
    const stored = isPlainObject(config.tools) ? config.tools.approvalMode : undefined;
    return toolApprovalSchema.safeParse(stored).success ? stored : TOOL_APPROVAL_DEFAULT;
  };

  app.get('/api/config/tool-approval', async (_req, res) => {
    try {
      res.json({ mode: readToolApproval() });
    } catch (error) {
      console.error('[API:GET /api/config/tool-approval] Failed to read tool approval:', error);
      res.status(500).json({ error: 'Failed to read tool approval' });
    }
  });

  app.put('/api/config/tool-approval', parseJsonBody, async (req, res) => {
    const parsed = toolApprovalSchema.safeParse(req.body?.mode);
    if (!parsed.success) {
      res.status(400).json({ error: `mode must be one of: ${TOOL_APPROVAL_MODES.join(', ')}` });
      return;
    }

    try {
      const configFile = resolveConfigFile();
      const config = readConfigFile(configFile) ?? {};
      if (config.tools !== undefined && !isPlainObject(config.tools)) {
        throw new Error('the tools section is not a mapping');
      }

      const previous = readToolApproval();
      writeConfigKey(configFile, ['tools', 'approvalMode'], parsed.data);

      res.json({ mode: parsed.data, changed: previous !== parsed.data });
    } catch (error) {
      console.error('[API:PUT /api/config/tool-approval] Failed to save tool approval:', error);
      res.status(500).json({ error: 'Failed to save tool approval' });
    }
  });
};
