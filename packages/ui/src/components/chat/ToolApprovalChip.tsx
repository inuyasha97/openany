import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { TOOL_APPROVAL_MODE_LABEL_KEYS, useToolApprovalMode, type ToolApprovalMode } from '@/lib/toolApproval';

/**
 * OMP's tool approval mode, next to the model and effort the call is made with.
 *
 * The picker used to render per-tool allow/ask/deny rows read from the agent's
 * config — OpenCode's rule vocabulary, which OMP applies none of (§I.10). This
 * is the policy that actually decides whether a tool call reaches the user, so
 * the composer describes the runtime instead of a wish.
 */
const MODE_ICONS = {
  'always-ask': 'shield-check',
  write: 'shield',
  yolo: 'lock-unlock',
} as const satisfies Record<ToolApprovalMode, string>;

/** Only `yolo` runs every tier without asking, so only it is coloured. */
const MODE_TEXT_CLASS: Record<ToolApprovalMode, string> = {
  'always-ask': 'text-muted-foreground',
  write: 'text-muted-foreground',
  yolo: 'text-[color:var(--status-warning)]',
};

export const ToolApprovalChip: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useI18n();
  const mode = useToolApprovalMode();
  if (mode === null) return null;

  return (
    <Tooltip delayDuration={600}>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'model-controls__approval-chip flex items-center gap-1.5 min-w-0 select-none',
            MODE_TEXT_CLASS[mode],
            className,
          )}
        >
          <Icon name={MODE_ICONS[mode]} className="size-3.5 flex-shrink-0" />
          <span className="model-controls__approval-label font-medium min-w-0 truncate">
            {t(TOOL_APPROVAL_MODE_LABEL_KEYS[mode])}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="typography-meta">{t('settings.openchamber.defaults.field.toolApprovalInfo')}</p>
      </TooltipContent>
    </Tooltip>
  );
};
