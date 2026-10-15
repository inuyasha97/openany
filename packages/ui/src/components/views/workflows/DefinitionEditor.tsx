/**
 * The YAML of one definition.
 *
 * The editor never throws a person's text away. A refused save keeps the buffer
 * and shows what the server said, because reloading the file from disk instead
 * would discard the edit the refusal was about.
 *
 * The save carries the hash of the text this editor read. If another window
 * changed the file in between, the server refuses on that hash and the person
 * gets to choose, rather than one window silently winning.
 *
 * The text is not in the summary a screen already has, so it is read when the
 * editor opens. Until that read answers the pane shows its loading state, and a
 * read that fails shows the failure beside the file name: an empty buffer a
 * person then saves is how a working definition gets erased.
 *
 * The read follows the file this editor was opened from, not the `id` the body
 * declares: the two may differ, and the route resolves the path from the name it
 * is handed. A body whose id differs is refused by the save, which is the message
 * the person needs rather than a read failure that names nothing on screen.
 *
 * Closing with unsaved text asks first, because a buffer the server refused is
 * exactly the text a person is still reconciling, and the close is the only exit
 * from that state.
 *
 * Deleting is refused while a run of the project has not finished with this
 * definition: the engine re-reads the file on every advance, so the run could
 * never move again.
 */
import { useEffect, useMemo, useState } from 'react';

import { useI18n } from '@/lib/i18n';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useUIStore } from '@/stores/useUIStore';
import { useWorkflowStore } from '@/stores/useWorkflowStore';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { CodeMirrorEditor } from '@/components/ui/CodeMirrorEditor';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { createFlexokiCodeMirrorTheme } from '@/lib/codemirror/flexokiTheme';
import { languageByExtension } from '@/lib/codemirror/languageByExtension';
import { liveRunForDefinition } from '@/lib/workflows/liveRun';
import {
  deleteWorkflowDefinition,
  fetchWorkflowDefinitionSource,
  saveWorkflowDefinition,
  type WorkflowDefinitionSummary,
} from '@/lib/workflowsApi';

export interface DefinitionEditorProps {
  project: { id: string; path: string };
  summary: WorkflowDefinitionSummary;
  /** Hands the pane back to the run detail. */
  onClose: () => void;
}

/**
 * The first line a refusal names. A YAML syntax failure names one ("… at line
 * 4, column 2"), a schema failure names a field instead, so most refusals have
 * no line to mark.
 */
const namedLine = (message: string): number | null => {
  const match = /\bline (\d+)\b/.exec(message);
  return match ? Number(match[1]) : null;
};

export const DefinitionEditor = ({ project, summary, onClose }: DefinitionEditorProps) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const editorFontSize = useUIStore((state) => state.editorFontSize);
  const reload = useWorkflowStore((state) => state.load);
  const runs = useWorkflowStore((state) => state.getEntry({ id: project.id }).runs);
  // The file this editor was opened from, without its extension. The read
  // resolves the path from the name it is handed and the route writes back to the
  // same name, so a body that declares another id is still refused truthfully
  // rather than being read from a path the person did not point at.
  const workflowId = summary.file.replace(/\.ya?ml$/i, '');
  // The engine re-reads this file on every advance, so a run that has not
  // finished needs it on disk. The delete waits for that run, and says why.
  const liveRun = liveRunForDefinition(runs, workflowId);

  const [text, setText] = useState('');
  /** The text as it is on disk: what "unsaved" is measured against. */
  const [baseline, setBaseline] = useState<string | null>(null);
  /** The hash the buffer was read or written at, passed back as `expectedHash`. */
  const [hash, setHash] = useState<string | null>(summary.hash);
  const [reading, setReading] = useState(true);
  // `null` means the read succeeded; an empty string means it failed without a
  // message of its own, which falls back to the shared failure wording.
  const [readFailure, setReadFailure] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReading(true);
    setReadFailure(null);
    void (async () => {
      try {
        const source = await fetchWorkflowDefinitionSource(project.path, workflowId);
        if (cancelled) return;
        setText(source.raw);
        setBaseline(source.raw);
        setHash(source.hash);
        setReading(false);
      } catch (failure) {
        if (cancelled) return;
        setReadFailure(failure instanceof Error && failure.message ? failure.message : '');
        setReading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project.path, workflowId]);

  const editorExtensions = useMemo(() => {
    const extensions = [createFlexokiCodeMirrorTheme(currentTheme, { fontSize: editorFontSize })];
    const language = languageByExtension(`${workflowId}.yaml`);
    if (language) extensions.push(language);
    return extensions;
  }, [currentTheme, editorFontSize, workflowId]);

  const dirty = baseline !== null && text !== baseline;
  const failedLine = error === null ? null : namedLine(error);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const written = await saveWorkflowDefinition(project.path, workflowId, text, hash ?? undefined);
      setBaseline(text);
      // The next save compares against the text that is now on disk.
      setHash(written.hash);
      // The surface's definitions are stale the moment the file changes, and the
      // list and the diagram are both read from them.
      await reload(project, { force: true });
    } catch (failure) {
      // The buffer stays exactly as typed.
      setError(failure instanceof Error ? failure.message : t('workflows.error.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteWorkflowDefinition(project.path, workflowId);
      setConfirmDelete(false);
      await reload(project, { force: true });
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('workflows.error.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const editable = !reading && readFailure === null;

  /**
   * Closing asks when the buffer holds text the file does not. The close stays
   * available either way: after a refused save the buffer's hash is deliberately
   * not advanced, so the close is the only exit, and it must not be the one that
   * throws the edit away without asking.
   */
  const requestClose = () => {
    if (!dirty) {
      onClose();
      return;
    }
    setError(null);
    setConfirmClose(true);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 truncate font-mono text-xs">{summary.file}</span>
        {editable && dirty ? <span className="text-[11px] text-muted-foreground">{t('workflows.editor.unsaved')}</span> : null}
        <span className="ml-auto flex items-center gap-1">
          {editable ? (
            /* A disabled `Button` is `pointer-events-none`
               (`components/ui/button.tsx`), so its own `title` never appears;
               the span is the hit target that can carry the reason, as the
               step bar does (`StepPane.tsx`). */
            <span title={liveRun ? t('workflows.editor.deleteBlocked') : undefined}>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy || liveRun !== null}
                title={t('workflows.editor.delete')}
                aria-label={t('workflows.editor.delete')}
                onClick={() => {
                  setError(null);
                  setConfirmDelete(true);
                }}
              >
                <Icon name="delete-bin" className="size-3.5" aria-hidden />
              </Button>
            </span>
          ) : null}
          <Button size="xs" variant="ghost" disabled={busy} onClick={requestClose}>
            {t('workflows.editor.close')}
          </Button>
          {editable ? (
            <Button size="xs" disabled={busy || !dirty} onClick={() => void save()}>
              {t('workflows.editor.save')}
            </Button>
          ) : null}
        </span>
      </div>
      {editable && liveRun ? (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
          {t('workflows.editor.deleteBlocked')}
        </p>
      ) : null}
      {reading ? <div className="p-3 text-xs text-muted-foreground">{t('workflows.editor.loading')}</div> : null}
      {readFailure !== null ? (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {readFailure || t('workflows.error.actionFailed')}
        </p>
      ) : null}
      {editable ? (
        <>
          {error && !confirmDelete ? (
            <p role="status" className="px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <div className="min-h-0 flex-1">
            <CodeMirrorEditor
              value={text}
              onChange={setText}
              className="h-full"
              extensions={editorExtensions}
              highlightLines={failedLine === null ? undefined : { start: failedLine, end: failedLine }}
            />
          </div>
        </>
      ) : null}
      <Dialog
        open={confirmDelete}
        onOpenChange={(open) => {
          if (open) return;
          setConfirmDelete(false);
          setError(null);
        }}
      >
        <DialogContent showCloseButton={false} className="max-w-sm gap-5">
          <DialogHeader>
            <DialogTitle>{t('workflows.editor.delete')}</DialogTitle>
            <DialogDescription>
              <span className="block font-mono text-[11px] text-muted-foreground">{summary.file}</span>
              {t('workflows.editor.deleteConfirm')}
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <div role="alert" className="text-xs text-destructive">
              {error}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setConfirmDelete(false);
                setError(null);
              }}
            >
              {t('workflows.editor.deleteCancel')}
            </Button>
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => void remove()}>
              {t('workflows.editor.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmClose} onOpenChange={(open) => { if (!open) setConfirmClose(false); }}>
        <DialogContent showCloseButton={false} className="max-w-sm gap-5">
          <DialogHeader>
            <DialogTitle>{t('workflows.editor.discard')}</DialogTitle>
            <DialogDescription>
              <span className="block font-mono text-[11px] text-muted-foreground">{summary.file}</span>
              {t('workflows.editor.discardConfirm')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmClose(false)}>
              {t('workflows.editor.discardCancel')}
            </Button>
            {/* Not disabled by `busy`: a save in flight is exactly when a person
                changes their mind, and the close must be able to answer a
                refusal, so the way out stays open. */}
            <Button variant="destructive" size="sm" onClick={onClose}>
              {t('workflows.editor.discardClose')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
