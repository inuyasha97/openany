/**
 * One place that turns a workflow status into what a screen shows.
 *
 * Every status carries a label and an icon, not only a color: a person who
 * cannot separate the hues still reads the same state. The colors come from
 * theme tokens, so light and dark are both legible.
 */
import type { IconName } from '@/components/icon/icons';
import type { I18nKey, I18nParams } from '@/lib/i18n';
import type { WorkflowRunStatus, WorkflowStepStatus } from '@/lib/workflowsApi';

export type StatusTone = 'neutral' | 'active' | 'attention' | 'danger' | 'done';

export interface DescribedStatus {
  label: string;
  tone: StatusTone;
  className: string;
  /** A sprite name; the caller renders `<Icon name={status.icon} />`. */
  icon: IconName;
}

// The `useI18n()` translator. Typed by its own key contract rather than
// `(key: string) => string`: the narrower signature cannot accept it, and the
// keys below are the `workflows.*` literals the dictionary already carries.
type Translate = (key: I18nKey, params?: I18nParams) => string;

// Only tokens the design system defines: this theme has no `success` or
// `warning` colour, and a raw Tailwind palette class would silently do nothing.
// `chart-2` is the theme's green and `chart-3` its amber, in both light and dark.
const TONE_CLASS: Record<StatusTone, string> = {
  neutral: 'text-muted-foreground',
  active: 'text-primary',
  attention: 'text-chart-3',
  danger: 'text-destructive',
  done: 'text-chart-2',
};

const STEP_TONE: Record<WorkflowStepStatus, StatusTone> = {
  pending: 'neutral',
  running: 'active',
  waiting_confirm: 'attention',
  needs_work: 'attention',
  blocked: 'attention',
  done: 'done',
  failed: 'danger',
  interrupted: 'danger',
  skipped: 'neutral',
};

// Every status carries a distinct sprite icon, so the state reads without colour.
const STEP_ICON: Record<WorkflowStepStatus, DescribedStatus['icon']> = {
  pending: 'checkbox-blank',
  running: 'loader',
  waiting_confirm: 'time',
  needs_work: 'tools',
  blocked: 'pause',
  done: 'checkbox-circle',
  failed: 'error-warning',
  interrupted: 'alert',
  skipped: 'stop',
};

export const describeStepStatus = (status: WorkflowStepStatus, t: Translate): DescribedStatus => ({
  label: t(`workflows.step.status.${status}`),
  tone: STEP_TONE[status],
  className: TONE_CLASS[STEP_TONE[status]],
  icon: STEP_ICON[status],
});

const RUN_TONE: Record<WorkflowRunStatus, StatusTone> = {
  idle: 'neutral',
  running: 'active',
  waiting: 'attention',
  done: 'done',
  failed: 'danger',
  cancelled: 'neutral',
};

const RUN_ICON: Record<WorkflowRunStatus, DescribedStatus['icon']> = {
  idle: 'checkbox-blank',
  running: 'loader',
  waiting: 'time',
  done: 'checkbox-circle',
  failed: 'error-warning',
  cancelled: 'stop',
};

export const describeRunStatus = (status: WorkflowRunStatus, t: Translate): DescribedStatus => ({
  label: t(`workflows.run.status.${status}`),
  tone: RUN_TONE[status],
  className: TONE_CLASS[RUN_TONE[status]],
  icon: RUN_ICON[status],
});
