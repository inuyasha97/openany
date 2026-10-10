import React from 'react';
import { z } from 'zod';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * OMP's tool approval policy, as `GET|PUT /api/config/tool-approval` reports it.
 *
 * The picker used to render per-tool allow/ask/deny rows read from the agent's
 * config, which is OpenCode's rule vocabulary — OMP applies none of it (§I.10).
 * This shows the mode that actually decides whether a tool call reaches the
 * user, so the panel describes the runtime instead of a wish.
 */
const TOOL_APPROVAL_MODES = ['always-ask', 'write', 'yolo'] as const;

type ToolApprovalMode = (typeof TOOL_APPROVAL_MODES)[number];

const toolApprovalSchema = z.object({ mode: z.enum(TOOL_APPROVAL_MODES) });

export const TOOL_APPROVAL_LABEL_KEYS = {
  'always-ask': 'settings.openchamber.defaults.toolApproval.option.alwaysAsk',
  write: 'settings.openchamber.defaults.toolApproval.option.write',
  yolo: 'settings.openchamber.defaults.toolApproval.option.yolo',
} satisfies Record<ToolApprovalMode, I18nKey>;

/** The mode, shared by every picker that renders it. */
export const useToolApprovalMode = (): ToolApprovalMode | null => {
  const [mode, setMode] = React.useState<ToolApprovalMode | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const read = async () => {
      const response = await runtimeFetch('/api/config/tool-approval', { headers: { Accept: 'application/json' } });
      if (!response.ok) return null;
      const parsed = toolApprovalSchema.safeParse(await response.json());
      return parsed.success ? parsed.data.mode : null;
    };
    read()
      .then((value) => {
        if (!cancelled && value !== null) setMode(value);
      })
      .catch((error) => console.warn('[tool-approval] failed to read', error));
    return () => {
      cancelled = true;
    };
  }, []);

  return mode;
};

export const ToolApprovalSummary: React.FC<{ variant?: 'card' | 'inline' }> = ({ variant = 'card' }) => {
  const { t } = useI18n();
  const mode = useToolApprovalMode();
  if (mode === null) return null;

  if (variant === 'inline') {
    return (
      <div className="flex flex-col gap-1">
        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">
          {t('settings.openchamber.defaults.field.toolApproval')}
        </span>
        <span className="typography-meta text-foreground">{t(TOOL_APPROVAL_LABEL_KEYS[mode])}</span>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
      <div className="flex items-center justify-between">
        <span className="typography-meta text-muted-foreground/80">
          {t('settings.openchamber.defaults.field.toolApproval')}
        </span>
        <span className="typography-meta font-medium text-foreground">{t(TOOL_APPROVAL_LABEL_KEYS[mode])}</span>
      </div>
    </div>
  );
};
