import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsFieldRow, SETTINGS_SELECT_SIZE, SETTINGS_SELECT_ROW_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { reportSettingsSaveState } from '@/lib/persistence';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  readToolApprovalMode,
  TOOL_APPROVAL_MODE_LABEL_KEYS,
  TOOL_APPROVAL_MODES,
  toolApprovalModeSchema,
  type ToolApprovalMode,
} from '@/lib/toolApproval';

/**
 * OMP's `tools.approvalMode` — the policy behind a tool call reaching the user.
 *
 * Read from and written to `GET|PUT /api/config/tool-approval`, which answers
 * OMP's own default when the key is absent. The vocabulary and the read live in
 * `@/lib/toolApproval`, shared with the composer's chip; this is the half that
 * writes. The per-tool half (`tools.approval`) is not exposed yet, and is
 * preserved by the write.
 */
export const ToolApprovalRow: React.FC = () => {
  const { t } = useI18n();
  const [mode, setMode] = React.useState<ToolApprovalMode | null>(null);
  // The value the user last saw, so a failed write can go back to it. The
  // generation guards against an in-flight read overwriting a later write.
  const latestWrite = React.useRef(0);

  React.useEffect(() => {
    let cancelled = false;
    readToolApprovalMode()
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
          <SelectValue placeholder={t(TOOL_APPROVAL_MODE_LABEL_KEYS.yolo)}>
            {t(TOOL_APPROVAL_MODE_LABEL_KEYS[selected])}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {TOOL_APPROVAL_MODES.map((value) => (
            <SelectItem key={value} value={value}>
              {t(TOOL_APPROVAL_MODE_LABEL_KEYS[value])}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsFieldRow>
  );
};
