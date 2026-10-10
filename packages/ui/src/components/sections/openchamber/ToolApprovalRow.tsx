import React from 'react';
import { z } from 'zod';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsFieldRow, SETTINGS_SELECT_SIZE, SETTINGS_SELECT_ROW_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { reportSettingsSaveState } from '@/lib/persistence';
import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * OMP's `tools.approvalMode` — the policy behind a tool call reaching the user.
 *
 * `always-ask` auto-approves read-only tools and prompts for write and exec
 * ones, `write` auto-approves read and write, `yolo` auto-approves every tier.
 * OMP's default is `yolo`, so until this is set a session runs commands without
 * asking; the approval dock the UI already renders appears once OMP is told to
 * ask. The value is read from and written to `GET|PUT /api/config/tool-approval`,
 * which answers OMP's own default when the key is absent.
 *
 * This is the session-facing half of OMP's policy. The per-tool half
 * (`tools.approval`) is not exposed here yet, and is preserved by the write.
 */
const TOOL_APPROVAL_MODES = ['always-ask', 'write', 'yolo'] as const;

type ToolApprovalMode = (typeof TOOL_APPROVAL_MODES)[number];

/** The route answers one of the three modes; anything else is not a mode. */
const toolApprovalModeSchema = z.enum(TOOL_APPROVAL_MODES);
const toolApprovalSchema = z.object({ mode: toolApprovalModeSchema });

const MODE_LABEL_KEYS = {
  'always-ask': 'settings.openchamber.defaults.toolApproval.option.alwaysAsk',
  write: 'settings.openchamber.defaults.toolApproval.option.write',
  yolo: 'settings.openchamber.defaults.toolApproval.option.yolo',
} satisfies Record<ToolApprovalMode, I18nKey>;

export const ToolApprovalRow: React.FC = () => {
  const { t } = useI18n();
  const [mode, setMode] = React.useState<ToolApprovalMode | null>(null);
  // The value the user last saw, so a failed write can go back to it. The
  // generation guards against an in-flight read overwriting a later write.
  const latestWrite = React.useRef(0);

  React.useEffect(() => {
    let cancelled = false;
    /** Reads OMP's mode, or null when the route refused or answered something else. */
    const readMode = async (): Promise<ToolApprovalMode | null> => {
      const response = await runtimeFetch('/api/config/tool-approval', { headers: { Accept: 'application/json' } });
      if (!response.ok) return null;
      const parsed = toolApprovalSchema.safeParse(await response.json());
      return parsed.success ? parsed.data.mode : null;
    };
    readMode()
      .then((value) => {
        if (cancelled || latestWrite.current !== 0 || value === null) return;
        setMode(value);
      })
      .catch((error) => console.warn('[tool-approval] failed to read', error));
    return () => {
      cancelled = true;
    };
  }, []);

  const handleChange = React.useCallback(async (next: string) => {
    const parsed = toolApprovalModeSchema.safeParse(next);
    if (!parsed.success) return;
    const value = parsed.data;
    const previous = mode;
    const write = ++latestWrite.current;
    setMode(value);
    reportSettingsSaveState('saving');
    try {
      const response = await runtimeFetch('/api/config/tool-approval', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ mode: value }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      reportSettingsSaveState('saved');
    } catch (error) {
      console.warn('[tool-approval] failed to save', error);
      reportSettingsSaveState('error');
      if (write === latestWrite.current) setMode(previous);
    }
  }, [mode]);

  const selected = mode ?? 'yolo';

  return (
    <SettingsFieldRow
      settingsItem="sessions.tool-approval"
      label={t('settings.openchamber.defaults.field.toolApproval')}
      info={t('settings.openchamber.defaults.field.toolApprovalInfo')}
    >
      <Select value={selected} onValueChange={handleChange} disabled={mode === null}>
        <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
          <SelectValue placeholder={t(MODE_LABEL_KEYS.yolo)}>
            {t(MODE_LABEL_KEYS[selected])}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {TOOL_APPROVAL_MODES.map((value) => (
            <SelectItem key={value} value={value}>
              {t(MODE_LABEL_KEYS[value])}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsFieldRow>
  );
};
