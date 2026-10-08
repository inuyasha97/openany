import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsFieldRow, SETTINGS_SELECT_SIZE, SETTINGS_SELECT_ROW_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { reportSettingsSaveState } from '@/lib/persistence';
import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * OMP's `providers.cacheRetention`. OMP keeps a provider's prompt cache alive
 * itself, so there is no warm-up loop to switch on — only how long an entry is
 * kept, which OMP forwards to providers that support it. The value is read from
 * and written to `GET|PUT /api/config/cache-retention`; the route answers OMP's
 * own default (`auto`) when the key is absent, so the row always shows a value.
 */
const CACHE_RETENTION_VALUES = ['auto', 'short', 'long', 'none'] as const;
type CacheRetention = (typeof CACHE_RETENTION_VALUES)[number];

const RETENTION_LABEL_KEYS: Record<CacheRetention, I18nKey> = {
  auto: 'settings.openchamber.defaults.cacheRetention.option.auto',
  short: 'settings.openchamber.defaults.cacheRetention.option.short',
  long: 'settings.openchamber.defaults.cacheRetention.option.long',
  none: 'settings.openchamber.defaults.cacheRetention.option.none',
};

const isCacheRetention = (value: unknown): value is CacheRetention =>
  typeof value === 'string' && (CACHE_RETENTION_VALUES as readonly string[]).includes(value);

export const CacheRetentionRow: React.FC = () => {
  const { t } = useI18n();
  const [retention, setRetention] = React.useState<CacheRetention | null>(null);
  // The value the user last saw, so a failed write can go back to it. The
  // generation guards against an in-flight read overwriting a later write.
  const latestWrite = React.useRef(0);

  React.useEffect(() => {
    let cancelled = false;
    runtimeFetch('/api/config/cache-retention', { headers: { Accept: 'application/json' } })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { retention?: unknown } | null) => {
        if (cancelled || latestWrite.current !== 0) return;
        if (isCacheRetention(body?.retention)) setRetention(body.retention);
      })
      .catch((error) => console.warn('[cache-retention] failed to read', error));
    return () => {
      cancelled = true;
    };
  }, []);

  const handleChange = React.useCallback(async (next: string) => {
    if (!isCacheRetention(next)) return;
    const previous = retention;
    const write = ++latestWrite.current;
    setRetention(next);
    reportSettingsSaveState('saving');
    try {
      const response = await runtimeFetch('/api/config/cache-retention', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ retention: next }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      reportSettingsSaveState('saved');
    } catch (error) {
      console.warn('[cache-retention] failed to save', error);
      reportSettingsSaveState('error');
      if (write === latestWrite.current) setRetention(previous);
    }
  }, [retention]);

  const selected = retention ?? 'auto';

  return (
    <SettingsFieldRow
      settingsItem="sessions.cache-retention"
      label={t('settings.openchamber.defaults.field.cacheRetention')}
      info={t('settings.openchamber.defaults.field.cacheRetentionInfo')}
    >
      <Select value={selected} onValueChange={handleChange} disabled={retention === null}>
        <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
          <SelectValue placeholder={t(RETENTION_LABEL_KEYS.auto)}>
            {t(RETENTION_LABEL_KEYS[selected])}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {CACHE_RETENTION_VALUES.map((value) => (
            <SelectItem key={value} value={value}>
              {t(RETENTION_LABEL_KEYS[value])}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsFieldRow>
  );
};
