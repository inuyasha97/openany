/**
 * The declared workflow as a diagram.
 *
 * The source is a mermaid fence handed to the app's markdown renderer, so the
 * diagram follows the theme, the user's mermaid mode and the render cache the
 * chat already uses. It shows the definition, which does not change, and never
 * the live status: that is the timeline's job.
 */
import { useMemo } from 'react';

import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useI18n } from '@/lib/i18n';
import type { WorkflowDefinitionSummary, WorkflowStepDefinition } from '@/lib/workflowsApi';

export interface WorkflowDiagramProps {
  summary: WorkflowDefinitionSummary;
}

const mermaidSource = (steps: WorkflowStepDefinition[]) => {
  const lines = ['flowchart TD'];
  steps.forEach((step, index) => {
    const label = `${step.id}${step.confirm === 'auto' ? ' (auto)' : ''}`;
    lines.push(`  s${index}["${label}"]`);
    if (index > 0) lines.push(`  s${index - 1} --> s${index}`);
  });
  return lines.join('\n');
};

export const WorkflowDiagram = ({ summary }: WorkflowDiagramProps) => {
  const { t } = useI18n();
  const content = useMemo(
    () => (summary.steps.length > 0 ? `\`\`\`mermaid\n${mermaidSource(summary.steps)}\n\`\`\`` : ''),
    [summary.steps],
  );

  if (summary.errors.length > 0) {
    return (
      <div className="p-3 text-xs">
        <p className="text-destructive">{t('workflows.definition.invalid')}</p>
        <ul className="mt-1 flex flex-col gap-0.5">
          {summary.errors.map((error) => (
            <li key={`${error.field}:${error.message}`} className="font-mono text-[11px] text-muted-foreground">
              {error.field}: {error.message}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (!content) {
    return <div className="p-3 text-xs text-muted-foreground">{t('workflows.definition.diagram')}</div>;
  }

  return <SimpleMarkdownRenderer content={content} className="typography-markdown-body" enableFileReferences={false} />;
};
