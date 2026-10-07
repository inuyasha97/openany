import React from 'react';
import { SettingsCheckboxRow } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { reportSettingsSaveState } from '@/lib/persistence';
import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * The `warming` setting: keeps an idle session's prompt cache alive with small
 * keep-alive requests. The effective value is read from the OpenChamber
 * settings and written through `PUT /api/config/warming`.
 */
export const SessionWarmingCheckbox: React.FC = () => {
  const { t } = useI18n();
  const [enabled, setEnabled] = React.useState<boolean | null>(null);
  const latestWrite = React.useRef(0);

  React.useEffect(() => {
    let cancelled = false;
    runtimeFetch('/api/config/settings', { headers: { Accept: 'application/json' } })
      .then((response) => (response.ok ? response.json() : null))
      .then((settings: { warming?: unknown } | null) => {
        if (!cancelled && latestWrite.current === 0) setEnabled(settings?.warming === true);
      })
      .catch((error) => console.warn('[session-warming] failed to read settings', error));
    return () => {
      cancelled = true;
    };
  }, []);

  const handleChange = React.useCallback(async (next: boolean) => {
    const previous = enabled;
    const write = ++latestWrite.current;
    setEnabled(next);
    reportSettingsSaveState('saving');
    try {
      const response = await runtimeFetch('/api/config/warming', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      reportSettingsSaveState('saved');
    } catch (error) {
      console.warn('[session-warming] failed to save', error);
      reportSettingsSaveState('error');
      if (write === latestWrite.current) setEnabled(previous);
    }
  }, [enabled]);

  return (
    <SettingsCheckboxRow
      settingsItem="sessions.warming"
      checked={enabled ?? false}
      disabled={enabled === null}
      onChange={(checked) => {
        void handleChange(checked);
      }}
      label={t('settings.openchamber.defaults.field.sessionWarming')}
      info={t('settings.openchamber.defaults.field.sessionWarmingInfo')}
    />
  );
};
