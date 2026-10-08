import { z } from 'zod';

import {
  getUserConfigPath,
  readConfigFile as defaultReadConfigFile,
  isPlainObject,
  writeConfig as defaultWriteConfig,
} from './agent-config-files.js';

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

export const registerOmpSettingsRoutes = (app, dependencies = {}) => {
  const {
    readConfigFile = defaultReadConfigFile,
    writeConfig = defaultWriteConfig,
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

  app.put('/api/config/cache-retention', async (req, res) => {
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

      const providers = config.providers ?? {};
      const previous = readRetention();
      writeConfig({ ...config, providers: { ...providers, cacheRetention: parsed.data } }, configFile);

      res.json({ retention: parsed.data, changed: previous !== parsed.data });
    } catch (error) {
      console.error('[API:PUT /api/config/cache-retention] Failed to save cache retention:', error);
      res.status(500).json({ error: 'Failed to save cache retention' });
    }
  });
};
