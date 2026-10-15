/**
 * The declared workflow of one definition: what it parses to, and the way into
 * its YAML.
 *
 * The source is a mermaid fence handed to the app's markdown renderer, so the
 * diagram follows the theme, the user's mermaid mode and the render cache the
 * chat already uses. It shows the definition, which does not change, and never
 * the live status: that is the timeline's job.
 *
 * A definition that does not load is shown as its errors rather than as no
 * diagram, and the edit action stays beside them: repairing the file is what a
 * person does next.
 */
import { useMemo } from 'react';

import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import type { WorkflowDefinitionSummary, WorkflowStepDefinition } from '@/lib/workflowsApi';

export interface WorkflowDiagramProps {
  summary: WorkflowDefinitionSummary;
  /** Opens this definition's YAML in the editing surface. */
  onEdit: () => void;
}

const mermaidSource = (steps: WorkflowStepDefinition[]) => {
  const lines = ['flowchart TD'];
  steps.forEach((step, index) => {
    const label = step.id;
    lines.push(`  s${index}["${label}"]`);
    if (index > 0) lines.push(`  s${index - 1} --> s${index}`);
  });
  return lines.join('\n');
};

export const WorkflowDiagram = ({ summary, onEdit }: WorkflowDiagramProps) => {
  const { t } = useI18n();
  const content = useMemo(
    () => (summary.steps.length > 0 ? `\`\`\`mermaid\n${mermaidSource(summary.steps)}\n\`\`\`` : ''),
    [summary.steps],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 truncate font-mono text-xs">{summary.file}</span>
        <Button size="xs" variant="ghost" className="ml-auto" onClick={onEdit}>
          <Icon name="edit" className="size-3.5" aria-hidden />
          {t('workflows.editor.open')}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {summary.errors.length > 0 ? (
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
        ) : content ? (
          <SimpleMarkdownRenderer content={content} className="typography-markdown-body" enableFileReferences={false} />
        ) : (
          <div className="p-3 text-xs text-muted-foreground">{t('workflows.definition.diagram')}</div>
        )}
      </div>
    </div>
  );
};
