import { settingsSurfaceOf } from './settings-files.js';

/**
 * `GET|PUT /api/config/settings`.
 *
 * The write path is entirely `persistSettings`: it gates the body through the
 * settings registry (`isPersistableSettingsKey`), drops device-owned and secret
 * keys, merges the change into the stored document and answers in the read
 * shape. Computed flags (`hasDesktopUiPassword`, `agentMemoryFeatureAvailable`,
 * the LAN-access flags, …) are therefore never persistable and never echo a
 * client value back.
 *
 * Reads take the surface kind from `?surface=` or `x-openchamber-surface` and
 * resolve the per-surface profile keys against it.
 */
export const registerConfigSettingsRoutes = (app, dependencies) => {
  const {
    readSettingsFromDiskMigrated,
    persistSettings,
    formatSettingsResponse,
  } = dependencies;

  app.get('/api/config/settings', async (req, res) => {
    try {
      const settings = await readSettingsFromDiskMigrated({ surface: settingsSurfaceOf(req) });
      res.json(formatSettingsResponse(settings));
    } catch (error) {
      console.error('Failed to read settings:', error);
      res.status(500).json({ error: 'Failed to read settings' });
    }
  });

  app.put('/api/config/settings', async (req, res) => {
    try {
      const updated = await persistSettings(req.body ?? {}, { surface: settingsSurfaceOf(req) });
      res.json(updated);
    } catch (error) {
      console.error('[API:PUT /api/config/settings] Failed to save settings:', error);
      res.status(500).json({ error: 'Failed to save settings' });
    }
  });
};
