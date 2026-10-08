import type { I18nKey } from '@/lib/i18n';

// Known backend failures that the user can act on from here. Everything else
// falls back to the raw detail plus the logs button.
export type ErrorRemedy = 'uiPassword' | 'localPort' | 'noRuntime' | 'noOpencode' | 'externalPort' | null;

export const errorRemedy = (detail?: string): ErrorRemedy => {
  const text = (detail || '').toLowerCase();
  if (!text) return null;
  if (text.includes('ui authentication') || text.includes('ui password')) return 'uiPassword';
  if (text.includes('already in use') || text.includes('eaddrinuse')) return 'localPort';
  if (text.includes('neither bun nor npm')) return 'noRuntime';
  if (text.includes('cli is not installed')) return 'noOpencode';
  if (text.includes('requires a ui password')) return 'uiPassword';
  if (text.includes('preferred remote openchamber port')) return 'externalPort';
  return null;
};

// Remedies the user resolves on the remote machine: explain, do not offer a button.
const REMEDY_HINT_KEYS = {
  noRuntime: 'settings.remoteInstances.page.error.hint.noRuntime',
  noOpencode: 'settings.remoteInstances.page.error.hint.noOpencode',
} satisfies Record<string, I18nKey>;

export const remedyHintKey = (remedy: ErrorRemedy): I18nKey | null => {
  if (remedy === 'noRuntime') return REMEDY_HINT_KEYS.noRuntime;
  if (remedy === 'noOpencode') return REMEDY_HINT_KEYS.noOpencode;
  return null;
};
