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
 * Closing is not the only way out: the list's `+` and pencils stay live while
 * this pane is mounted, so switching to another definition would unmount it over
 * whatever was typed. The parent hands that switch down (`pendingSwitch`) instead
 * of applying it, and this pane answers it with the same question the close asks,
 * because the buffer it would take is the same one.
 *
 * Deleting is refused while a run of the project has not finished with this
 * definition: the engine re-reads the file on every advance, so the run could
 * never move again.
 *
 * A definition that does not exist yet is the same pane with no file: it asks for
 * the id that names the file and offers the shipped template to start from. The
 * template is only ever copied onto a name that has no file — the first save of a
 * new definition says so with `expectedHash: null`, which the route answers with
 * an existence check, not a hash comparison — and once the file exists the id is
 * fixed and the template is no longer offered, because renaming a definition is
 * refused and copying over one that is there is not a thing this screen should
 * make easy.
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
import { sdlcTemplateFor, sdlcTemplateSummary } from '@/lib/workflows/templates';
import { Input } from '@/components/ui/input';
import {
  deleteWorkflowDefinition,
  fetchWorkflowDefinitionSource,
  saveWorkflowDefinition,
  WorkflowRequestError,
  type WorkflowDefinitionSummary,
} from '@/lib/workflowsApi';

export interface DefinitionEditorProps {
  project: { id: string; path: string };
  /**
   * The definition to open, or `null` for one that does not exist yet. A
   * definition that has no file has nothing to read; the pane asks for the id
   * that will name it and offers the shipped template to start from.
   */
  summary: WorkflowDefinitionSummary | null;
  /** Hands the pane back to the run detail. */
  onClose: () => void;
  /**
   * True while a switch to another definition is waiting on this pane's answer.
   * The parent lists the definitions and owns what is being edited, so it cannot
   * know whether the buffer here holds unsaved text; it hands the switch down and
   * this pane resolves it, over the buffer that would go with it.
   */
  pendingSwitch: boolean;
  /** Answers that switch: `true` discards this buffer and lets it through. */
  onSwitchResolved: (discard: boolean) => void;
}

/**
 * The id shape `definitions.js` names a file by (`isWorkflowId`), so the pane can
 * refuse an unusable id before the route does. The route stays the authority: a
 * value that passes here is still parsed and checked there.
 */
const isWorkflowId = (value: string): boolean => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);

/**
 * The first line a refusal names. A YAML syntax failure names one ("… at line
 * 4, column 2"), a schema failure names a field instead, so most refusals have
 * no line to mark.
 */
const namedLine = (message: string): number | null => {
  const match = /\bline (\d+)\b/.exec(message);
  return match ? Number(match[1]) : null;
};

export const DefinitionEditor = ({ project, summary, onClose, pendingSwitch, onSwitchResolved }: DefinitionEditorProps) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const editorFontSize = useUIStore((state) => state.editorFontSize);
  const reload = useWorkflowStore((state) => state.load);
  const runs = useWorkflowStore((state) => state.getEntry({ id: project.id }).runs);
  // A definition that does not exist yet is the create state: no file to read, an
  // id to ask for, and the template to start from. It is entered by opening this
  // pane with no definition, and by the read below answering 404 — a file removed
  // since the list was read is that same state, not a failure to show.
  const [creating, setCreating] = useState(summary === null);
  /** The id a person typed: it names the file the save writes. */
  const [createId, setCreateId] = useState('');
  /** The text the template action seeded, and the id it was seeded for. */
  const [seed, setSeed] = useState<{ id: string; text: string } | null>(null);
  /** The name the first save wrote. The id is fixed once the file exists. */
  const [writtenFile, setWrittenFile] = useState<string | null>(null);
  // The file this editor was opened from, without its extension. The read
  // resolves the path from the name it is handed and the route writes back to the
  // same name, so a body that declares another id is still refused truthfully
  // rather than being read from a path the person did not point at.
  const workflowId = summary !== null && !creating ? summary.file.replace(/\.ya?ml$/i, '') : createId;
  // The id the definition declares — what a run of this definition holds, because
  // the engine resolves a run through `definitions.read`, which matches the id in
  // the body and never the file name (`lib/workflows/liveRun.ts`). A name this
  // pane has written declares its own name (the route refuses any other); before
  // that, the summary carries the id the file was listed with.
  const declaredId = writtenFile !== null ? workflowId : summary?.id ?? null;
  // The engine re-reads this file on every advance, so a run that has not
  // finished needs it on disk. The delete waits for that run, and says why.
  const liveRun = liveRunForDefinition(runs, declaredId);

  const [text, setText] = useState('');
  /** The text as it is on disk: what "unsaved" is measured against. */
  const [baseline, setBaseline] = useState<string | null>(summary === null ? '' : null);
  /** The hash the buffer was read or written at, passed back as `expectedHash`. */
  const [hash, setHash] = useState<string | null>(summary?.hash ?? null);
  const [reading, setReading] = useState(summary !== null);
  // `null` means the read succeeded; an empty string means it failed without a
  // message of its own, which falls back to the shared failure wording.
  const [readFailure, setReadFailure] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  useEffect(() => {
    // A pane opened for no definition has no file to read: the buffer starts empty
    // and the template action is what gives it text. Nothing is read, so nothing
    // can be reported as a read failure.
    if (summary === null || creating) return;
    // A file whose name is not a workflow id cannot be read, saved or deleted
    // through the routes at all: they name a file by the id, and refuse that name
    // before they read the body. It exists, so it is not the create state either —
    // a pane that offered an id field and a template over it could never write
    // them. The name is the problem, and the person fixes it on disk.
    if (!isWorkflowId(workflowId)) {
      setReading(false);
      setReadFailure(t('workflows.editor.nameInvalid', { file: summary.file }));
      return;
    }
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
        // 404 is "there is no file for this id (yet)", which is the create state
        // rather than a failure: the list can name a definition whose file was
        // removed after it was read, and a new one starts from an id with no file
        // at all. A pane that answered this with an error over an empty buffer is
        // the one outcome that must not happen, so it becomes the new-definition
        // pane with the id it was opened for already filled in.
        if (failure instanceof WorkflowRequestError && failure.status === 404) {
          setCreating(true);
          setCreateId(workflowId);
          setText('');
          setBaseline('');
          setHash(null);
          setReading(false);
          return;
        }
        setReadFailure(failure instanceof Error && failure.message ? failure.message : '');
        setReading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [creating, summary, project.path, workflowId, t]);

  const editorExtensions = useMemo(() => {
    const extensions = [createFlexokiCodeMirrorTheme(currentTheme, { fontSize: editorFontSize })];
    const language = languageByExtension(`${workflowId}.yaml`);
    if (language) extensions.push(language);
    return extensions;
  }, [currentTheme, editorFontSize, workflowId]);

  const dirty = baseline !== null && text !== baseline;
  /**
   * Everything an exit would take with it: the buffer, and in the create pane the
   * id a person has typed, which names the file this pane would write. Only the
   * exits use it — the save keys on `dirty` alone, because an empty buffer with an
   * id is not a definition and Save must not write one.
   */
  const unsaved = dirty || (creating && createId.trim() !== '');
  const failedLine = error === null ? null : namedLine(error);
  const idUsable = isWorkflowId(createId);
  /** The name the write uses: the file being edited, the id a person typed, or what the save wrote. */
  const fileLabel = writtenFile ?? (summary !== null && !creating ? summary.file : idUsable ? sdlcTemplateSummary(createId).file : null);
  /** The buffer is still exactly the template this pane seeded. */
  const seeded = seed !== null && text === seed.text;
  // A new definition needs the id that names its file before anything is written,
  // and something to write; an edited one needs a change.
  const canSave = dirty && (!creating || idUsable);
  /**
   * Why the save and the template action are closed, when the reason is the id
   * itself. A disabled `Button` is `pointer-events-none`
   * (`components/ui/button.tsx`), so its own `title` never appears: the span
   * around it is the hit target that carries the reason, as the delete button's
   * does. An edited definition never reads the typed id, so the reason is only
   * about the create pane.
   */
  const idReason = creating && !idUsable ? t('workflows.editor.idInvalid') : undefined;

  /** Puts the template in the buffer, named by the id it is given. */
  const seedTemplate = (targetId: string) => {
    const next = { id: targetId, text: sdlcTemplateFor(targetId) };
    setText(next.text);
    setSeed(next);
    setError(null);
  };

  /**
   * The id names the file the save writes and the id inside the body has to match
   * it, so the seed follows the field. Text a person edited is theirs and is never
   * rewritten; a body whose id no longer matches the field is refused by the route,
   * with the message that names both.
   */
  const applyCreateId = (value: string) => {
    setCreateId(value);
    if (seed === null || text !== seed.text || !isWorkflowId(value)) return;
    seedTemplate(value);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // A definition with no file yet says so with `null`: the route checks that
      // no file exists rather than comparing hashes, so a name that is already
      // taken — by a file this pane could not even read — is refused instead of
      // replaced. An edited definition carries the hash it was read at.
      const expectedHash = hash ?? (creating ? null : undefined);
      const written = await saveWorkflowDefinition(project.path, workflowId, text, expectedHash);
      setBaseline(text);
      // The next save compares against the text that is now on disk.
      setHash(written.hash);
      // The name comes from the route, and the id is fixed now that the file
      // exists: renaming would orphan the runs that reference it, so the route
      // refuses it and the pane stops offering it.
      if (creating) setWrittenFile(written.file);
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
  /** There is a file to delete only once one has been read or written. */
  const hasFile = writtenFile !== null || (summary !== null && !creating);

  /**
   * Closing asks when the pane holds something a person typed. The close stays
   * available either way: after a refused save the buffer's hash is deliberately
   * not advanced, so the close is the only exit, and it must not be the one that
   * throws the edit away without asking.
   */
  const requestClose = () => {
    if (!unsaved) {
      onClose();
      return;
    }
    setError(null);
    setConfirmClose(true);
  };

  /**
   * The parent's switch is this pane's other exit, and it asks the same question
   * the close does: the buffer is a person's text, and unmounting this pane over
   * it is exactly what the guard exists to prevent. A clean buffer has nothing to
   * lose, so the switch goes through.
   */
  useEffect(() => {
    if (!pendingSwitch) return;
    if (unsaved) {
      setConfirmClose(true);
      return;
    }
    onSwitchResolved(true);
  }, [pendingSwitch, unsaved, onSwitchResolved]);

  /** Discards the buffer: the close the person confirmed, or the switch it was asked for. */
  const discardEdits = () => {
    setConfirmClose(false);
    if (pendingSwitch) {
      onSwitchResolved(true);
      return;
    }
    onClose();
  };

  /** Keeps the buffer: the dialog is dismissed and a switch waiting on it is answered with "no". */
  const keepEditing = () => {
    setConfirmClose(false);
    if (pendingSwitch) onSwitchResolved(false);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 truncate font-mono text-xs">{fileLabel ?? t('workflows.editor.newDefinition')}</span>
        {seeded ? <span className="text-[11px] text-muted-foreground">{t('workflows.editor.template')}</span> : null}
        {editable && dirty ? <span className="text-[11px] text-muted-foreground">{t('workflows.editor.unsaved')}</span> : null}
        <span className="ml-auto flex items-center gap-1">
          {editable && hasFile ? (
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
            /* The reason a closed save carries is the unusable id, on the same
               hit-target span the delete button uses. */
            <span title={idReason}>
              <Button size="xs" disabled={busy || !canSave} onClick={() => void save()}>
                {t('workflows.editor.save')}
              </Button>
            </span>
          ) : null}
        </span>
      </div>
      {editable && creating && writtenFile === null ? (
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          {/* The id is what names the file, so it is asked for before the buffer
              has anything to save — the header already shows the name it will
              write. Nothing is offered for an id the route would refuse, and the
              reason travels on the span because a disabled `Button` is
              `pointer-events-none` and never shows its own `title`. */}
          <Input
            value={createId}
            onChange={(event) => applyCreateId(event.target.value)}
            placeholder={t('workflows.editor.idPlaceholder')}
            aria-label={t('workflows.editor.newDefinition')}
            className="h-7 w-44 font-mono text-xs"
            autoFocus
            disabled={busy}
          />
          <span title={idReason}>
            <Button size="xs" variant="outline" disabled={busy || !idUsable} onClick={() => seedTemplate(createId)}>
              {t('workflows.editor.fromTemplate')}
            </Button>
          </span>
        </div>
      ) : null}
      {/* The delete this explains is only offered for a definition with a file, so
          the banner waits for one: a create pane has no Delete to be blocked. */}
      {editable && hasFile && liveRun ? (
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
              <span className="block font-mono text-[11px] text-muted-foreground">{fileLabel}</span>
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
      <Dialog open={confirmClose} onOpenChange={(open) => { if (!open) keepEditing(); }}>
        <DialogContent showCloseButton={false} className="max-w-sm gap-5">
          <DialogHeader>
            <DialogTitle>{t('workflows.editor.discard')}</DialogTitle>
            <DialogDescription>
              <span className="block font-mono text-[11px] text-muted-foreground">{fileLabel}</span>
              {t('workflows.editor.discardConfirm')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={keepEditing}>
              {t('workflows.editor.discardCancel')}
            </Button>
            {/* Not disabled by `busy`: a save in flight is exactly when a person
                changes their mind, and the close must be able to answer a
                refusal, so the way out stays open. */}
            <Button variant="destructive" size="sm" onClick={discardEdits}>
              {t(pendingSwitch ? 'workflows.editor.discardSwitch' : 'workflows.editor.discardClose')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
