import React from 'react';
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import type { I18nKey } from '@/lib/i18n';

/**
 * OMP's `tools.approvalMode` — one wire contract, one vocabulary.
 *
 * `always-ask` auto-approves read-only tools and prompts for write and exec
 * ones, `write` auto-approves read and write, `yolo` auto-approves every tier.
 * OMP's default is `yolo`, so until this is set a session runs commands without
 * asking. `GET|PUT /api/config/tool-approval` answers OMP's own default when the
 * key is absent, which is why the route — not the config file — is the source.
 *
 * The per-tool half (`tools.approval`) is OMP's, and is not surfaced yet.
 */
export const TOOL_APPROVAL_MODES = ['always-ask', 'write', 'yolo'] as const;

export type ToolApprovalMode = (typeof TOOL_APPROVAL_MODES)[number];

/** The route answers one of the three modes; anything else is not a mode. */
export const toolApprovalModeSchema = z.enum(TOOL_APPROVAL_MODES);

const toolApprovalSchema = z.object({ mode: toolApprovalModeSchema });

export const TOOL_APPROVAL_MODE_LABEL_KEYS = {
  'always-ask': 'settings.openchamber.defaults.toolApproval.option.alwaysAsk',
  write: 'settings.openchamber.defaults.toolApproval.option.write',
  yolo: 'settings.openchamber.defaults.toolApproval.option.yolo',
} satisfies Record<ToolApprovalMode, I18nKey>;

/** The mode, or null when the route could not be read or answered something else. */
export const readToolApprovalMode = async (): Promise<ToolApprovalMode | null> => {
  const response = await runtimeFetch('/api/config/tool-approval', { headers: { Accept: 'application/json' } });
  if (!response.ok) return null;
  const parsed = toolApprovalSchema.safeParse(await response.json());
  return parsed.success ? parsed.data.mode : null;
};

/** The mode for a read-only surface, fetched once. */
export const useToolApprovalMode = (): ToolApprovalMode | null => {
  const [mode, setMode] = React.useState<ToolApprovalMode | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    readToolApprovalMode()
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
