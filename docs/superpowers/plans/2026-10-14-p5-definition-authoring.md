# Workflow definition authoring (P5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person create and edit a workflow definition from the app, and start from a shipped SDLC template instead of a blank file.

**Architecture:** One write route that validates before it writes, one screen that edits the YAML with the editor the app already has, and one template constant the screen can copy into the project. The definition stays a file in the project; nothing about it moves into a database.

**Tech Stack:** Node ESM, Express 5, vitest, supertest, React, `components/ui/CodeMirrorEditor.tsx` (CodeMirror with the YAML language already a dependency).

**Spec:** `docs/superpowers/specs/2026-10-14-sdlc-workflow-design.md` (P5, deferred)

## Global Constraints

- Load these project skills before editing: `openchamber-change-discipline`, `locale-ui-patterns`, `settings-ui-patterns` (the editing surface follows the settings-dialog conventions), `theme-system`.
- No new dependencies. The YAML editor uses `CodeMirrorEditor` with the language the app already ships (`@codemirror/lang-yaml` is in `packages/ui/package.json`).
- A definition is written only after it parses and validates. An invalid definition is never written to disk, so a person cannot lose a working file to a typo.
- The written file is `<projectDirectory>/.openchamber/workflows/<id>.yaml`, written atomically. Renaming the `id` inside the file is refused: it would orphan the runs that reference it.
- Every user-facing string goes through `useI18n()` and lands in all 13 locales.
- `AGENTS.md` forbids git commands unless the maintainer asked. The maintainer asked for this plan to be executed, so the commit steps below are the only git commands an executor runs.

## Review Focus

1. Writing a definition must not overwrite a file whose `id` differs from the requested one, and must not write outside `.openchamber/workflows/`. Owner: Task 1.
2. A person editing a definition that another window changed must see the conflict instead of silently winning. Owner: Task 1, Task 2.
3. A template copied into a project whose workflow directory already has the file must not clobber it. Owner: Task 3.
4. The editor must not lose unsaved text when validation fails. Owner: Task 2.

---

### Task 1: The write route

**Files:**
- Modify: `packages/web/server/lib/workflows/definitions.js` + `definitions.test.js` (a `write` and a `remove` that go through the parser)
- Modify: `packages/web/server/lib/workflows/routes.js` + `routes.http.test.js`
- Modify: `packages/ui/src/lib/workflowsApi.ts`

**Interfaces:**
- Consumes: `parseDefinition` (engine plan Task 1).
- Produces:
  - `definitions.write(projectId, workflowId, rawText, { expectedHash }) -> Promise<{ file, id, hash }>` and `definitions.remove(projectId, workflowId)`
  - `PUT /api/workflows/definitions/:workflowId` with `{ raw: string, expectedHash?: string }` and `DELETE /api/workflows/definitions/:workflowId`
  - `saveWorkflowDefinition(directory, workflowId, raw, expectedHash?)` and `deleteWorkflowDefinition(directory, workflowId)` in the UI client.

- [ ] **Step 1: Write the failing tests**

```js
// add to definitions.test.js
describe('write', () => {
  it('refuses text that does not parse, and writes nothing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-write-'));
    const local = createWorkflowDefinitions({ fsPromises: fs, path, projectPathFromId: () => root });
    await expect(local.write('proj-1', 'two-step', 'id: Broken\nsteps: []\n')).rejects.toThrow(/id/);
    await expect(fs.stat(path.join(root, '.openchamber/workflows/two-step.yaml'))).rejects.toThrow();
  });

  it('refuses a body whose id is not the id being written', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-write-'));
    const local = createWorkflowDefinitions({ fsPromises: fs, path, projectPathFromId: () => root });
    await expect(local.write('proj-1', 'two-step', valid.replace('id: sdlc-feature', 'id: other')))
      .rejects.toThrow(/id "other" does not match/);
  });

  it('writes atomically and answers the new hash', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-write-'));
    const local = createWorkflowDefinitions({ fsPromises: fs, path, projectPathFromId: () => root });
    const written = await local.write('proj-1', 'sdlc-feature', valid);
    expect(written.id).toBe('sdlc-feature');
    expect(written.hash).toHaveLength(64);
    expect((await local.read('proj-1', 'sdlc-feature')).steps.map((step) => step.id)).toEqual(['spec', 'verify']);
  });

  it('refuses to overwrite a file that changed since the person read it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-write-'));
    const local = createWorkflowDefinitions({ fsPromises: fs, path, projectPathFromId: () => root });
    const first = await local.write('proj-1', 'sdlc-feature', valid);
    await expect(local.write('proj-1', 'sdlc-feature', valid.replace('version: 3', 'version: 4'), { expectedHash: 'a'.repeat(64) }))
      .rejects.toThrow(/changed on disk/);
    await local.write('proj-1', 'sdlc-feature', valid.replace('version: 3', 'version: 4'), { expectedHash: first.hash });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/web test -- server/lib/workflows/definitions.test.js`
Expected: FAIL, `local.write is not a function`.

- [ ] **Step 3: Implement**

```js
// in createWorkflowDefinitions, beside list/read
  const fileFor = (projectId, workflowId) => {
    const directory = directoryFor(projectId);
    if (!directory || !isWorkflowId(workflowId)) throw new Error(`invalid workflow id "${workflowId}"`);
    return { directory, file: path.join(directory, `${workflowId}.yaml`) };
  };

  const hashOf = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

  const write = async (projectId, workflowId, rawText, options = {}) => {
    const parsed = parseDefinition(rawText, { file: `${workflowId}.yaml` });
    if (!parsed.ok) {
      const first = parsed.errors[0];
      throw new Error(`${first.field}: ${first.message}`);
    }
    if (parsed.definition.id !== workflowId) {
      throw new Error(`the definition's id "${parsed.definition.id}" does not match ${workflowId}.yaml`);
    }
    const { directory, file } = fileFor(projectId, workflowId);
    if (options.expectedHash) {
      const current = await fsPromises.readFile(file, 'utf8').catch(() => null);
      if (current !== null && hashOf(current) !== options.expectedHash) {
        throw new Error(`${workflowId}.yaml changed on disk since it was read`);
      }
    }
    await fsPromises.mkdir(directory, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await fsPromises.writeFile(temporary, rawText, 'utf8');
    await fsPromises.rename(temporary, file);
    return { file: `${workflowId}.yaml`, id: workflowId, hash: hashOf(rawText) };
  };

  const remove = async (projectId, workflowId) => {
    const { file } = fileFor(projectId, workflowId);
    try {
      await fsPromises.unlink(file);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  };
```

`list` and `read` gain `hash` alongside `file` in their summaries so the UI can pass `expectedHash` back; add the same field to `WorkflowDefinitionSummary` in `workflowsApi.ts`.

- [ ] **Step 4: Add the routes and their tests**

`PUT /api/workflows/definitions/:workflowId` takes `{ raw, expectedHash }`, `DELETE` takes the id; both scope by `x-opencode-directory` like the read routes, and a validation failure answers 400 with the parser's own message. Add two cases to `routes.http.test.js` in the shape of the existing ones.

- [ ] **Step 5: Run the suites**

```bash
bun run --cwd packages/web test -- server/lib/workflows/definitions.test.js server/lib/workflows/routes.http.test.js
bun run type-check:ui
```

- [ ] **Step 6: Commit**

```bash
git add packages/web/server/lib/workflows packages/ui/src/lib/workflowsApi.ts
git commit -m "feat(workflows): write a definition through a validating route"
```

---

### Task 2: The editing screen

**Files:**
- Create: `packages/ui/src/components/views/workflows/DefinitionEditor.tsx`
- Modify: `packages/ui/src/components/views/workflows/WorkflowsView.tsx` (an action to open it), `packages/ui/src/components/views/workflows/WorkflowDiagram.tsx` (switch between diagram and editor)
- Modify: the 13 locale files

**Interfaces:**
- Consumes: `CodeMirrorEditor` (`packages/ui/src/components/ui/CodeMirrorEditor.tsx`), Task 1's client functions.
- Produces: `<DefinitionEditor summary project />`, which edits the raw YAML, validates on the server, shows the first error against the line it names, and keeps the text in place when the save is refused.

- [ ] **Step 1: Write the editor**

```tsx
// packages/ui/src/components/views/workflows/DefinitionEditor.tsx
/**
 * The YAML of one definition.
 *
 * The editor never throws a person's text away. A refused save keeps the buffer
 * and shows what the server said, because the alternative (reload the file from
 * disk) loses the edit that was being made when the refusal arrived.
 *
 * The save carries the hash of the text the editor opened. If another window
 * changed the file, the server refuses and the person gets to choose, rather
 * than one window silently winning.
 */
import { useState } from 'react';

import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { CodeMirrorEditor } from '@/components/ui/CodeMirrorEditor';
import { saveWorkflowDefinition, type WorkflowDefinitionSummary } from '@/lib/workflowsApi';

export interface DefinitionEditorProps {
  project: { id: string; path: string };
  summary: WorkflowDefinitionSummary;
  raw: string;
  onSaved: (raw: string) => void;
}

export const DefinitionEditor = ({ project, summary, raw, onSaved }: DefinitionEditorProps) => {
  const { t } = useI18n();
  const [text, setText] = useState(raw);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = text !== raw;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveWorkflowDefinition(project.path, summary.id as string, text, summary.hash);
      onSaved(text);
    } catch (failure) {
      // Keep the buffer exactly as typed.
      setError(failure instanceof Error ? failure.message : t('workflows.error.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="font-mono text-xs">{summary.file}</span>
        {dirty ? <span className="text-[11px] text-muted-foreground">{t('workflows.editor.unsaved')}</span> : null}
        <Button size="xs" className="ml-auto" disabled={busy || !dirty} onClick={() => void save()}>
          {t('workflows.editor.save')}
        </Button>
      </div>
      {error ? <p role="status" className="px-3 py-2 text-xs text-destructive">{error}</p> : null}
      <div className="min-h-0 flex-1">
        <CodeMirrorEditor value={text} language="yaml" onChange={setText} />
      </div>
    </div>
  );
};
```

Check `CodeMirrorEditor`'s actual props (`value`, `onChange`, and how it selects a language) in `packages/ui/src/components/ui/CodeMirrorEditor.tsx` and use those names; do not add a prop the component does not have.

- [ ] **Step 2: Add the strings**

`workflows.editor.{save,unsaved,open,newDefinition,idPlaceholder,template,fromTemplate,delete,deleteConfirm}` in `en.ts` and the other 12 locales, then:

Run: `bun run --cwd packages/ui test -- src/lib/i18n/messages.test.ts`

- [ ] **Step 3: Type check and commit**

```bash
bun run type-check:ui
git add packages/ui/src/components/views/workflows packages/ui/src/lib/i18n/messages
git commit -m "feat(workflows): edit a definition in the app"
```

---

### Task 3: A shipped SDLC template

**Files:**
- Create: `packages/ui/src/lib/workflows/templates.ts`
- Test: `packages/ui/src/lib/workflows/templates.test.ts`
- Modify: `DefinitionEditor` (a "start from the SDLC template" action)

**Interfaces:**
- Consumes: the engine's definition parser rules (the template has to be a valid definition).
- Produces: `SDLC_FEATURE_TEMPLATE: string` and `sdlcTemplateSummary()`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/lib/workflows/templates.test.ts
import { describe, expect, it } from 'vitest';
import { SDLC_FEATURE_TEMPLATE } from './templates';

describe('SDLC template', () => {
  it('declares the five SDLC steps in order, each with a stop for a person', () => {
    const ids = [...SDLC_FEATURE_TEMPLATE.matchAll(/^  - id: (.+)$/gm)].map((match) => match[1]);
    expect(ids).toEqual(['spec', 'plan', 'implement', 'verify', 'bring-back']);
  });

  it('declares no confirm field, which the schema refuses', () => {
    // A step is done only when a person confirms it, so the field is gone from
    // the schema and a template carrying it would not load at all.
    expect(SDLC_FEATURE_TEMPLATE).not.toMatch(/confirm:/);
  });

  it('gives every step that produces something a verifier', () => {
    const verifyBlocks = [...SDLC_FEATURE_TEMPLATE.matchAll(/verify:/g)].length;
    expect(verifyBlocks).toBeGreaterThanOrEqual(3);   // spec, plan and verify
  });

  it('names the inputs it asks for', () => {
    expect(SDLC_FEATURE_TEMPLATE).toContain('{{request}}');
    expect(SDLC_FEATURE_TEMPLATE).toMatch(/inputs:/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/ui test -- src/lib/workflows/templates.test.ts`
Expected: FAIL, `Failed to resolve import "./templates"`.

- [ ] **Step 3: Write the template**

```ts
// packages/ui/src/lib/workflows/templates.ts
/**
 * The SDLC workflow the app can start a person from.
 *
 * Every step stops for a person, because a step is done only when a person
 * confirms it; the steps that produce a file carry a verifier so the stop has
 * evidence beside it. The last step brings the work back, because a run in
 * worktree mode leaves a branch behind on purpose.
 */
export const SDLC_FEATURE_TEMPLATE = `id: sdlc-feature
name: SDLC, feature work
version: 1
inputs:
  - name: request
    description: What to build, in the requester's words
    required: true
sandbox: worktree
steps:
  - id: spec
    title: Design the change
    prompt: "Design {{request}} and write the design to docs/superpowers/specs/."
    session: new
    verify:
      artifacts:
        - glob: "docs/superpowers/specs/*-design.md"
          hash: true

  - id: plan
    title: Write the implementation plan
    prompt: "Read the approved design in this session and write the implementation plan to docs/superpowers/plans/."
    session: reuse
    verify:
      artifacts: ["docs/superpowers/plans/*.md"]

  - id: implement
    title: Implement the plan
    prompt: "Execute the plan you just wrote, one task at a time, committing as it says."
    session: reuse

  - id: verify
    title: Verify the branch
    prompt: "Run the checks the plan names and report what failed."
    session: reuse
    verify:
      commands:
        - run: "bun run type-check:web"
          expectExit: 0

  - id: bring-back
    title: Bring the work back
    prompt: "Summarize what changed, list the commits, and say what a reviewer should look at first."
    session: reuse
`;
```

The template ships `sandbox: worktree`, the default the design approved. If P4's measurement says a worktree costs too much to set up, the parser default changes to `working-tree` and this template changes in the same commit.

- [ ] **Step 4: Run the test**

Run: `bun run --cwd packages/ui test -- src/lib/workflows/templates.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Offer it in the editor**

In `DefinitionEditor`, when the definition does not exist yet, offer a "start from the SDLC template" action that seeds the buffer with `SDLC_FEATURE_TEMPLATE` and asks for the id before saving. The save goes through the same validating route, so a template that does not parse is refused in front of the person rather than written.

- [ ] **Step 6: Confirm the written file is a valid definition**

Run the engine's parser over the template in a throwaway script rather than only in the UI test:

```bash
node --input-type=module -e "
import fs from 'node:fs/promises';
import { parseDefinition } from './packages/web/server/lib/workflows/definitions.js';
const text = (await fs.readFile('./packages/ui/src/lib/workflows/templates.ts','utf8')).split('export const SDLC_FEATURE_TEMPLATE = \`')[1].split('\`;')[0];
const parsed = parseDefinition(text, { file: 'sdlc-feature.yaml' });
console.log(parsed.ok ? 'valid' : parsed.errors);
"
```

Expected: `valid`. If it prints errors, fix the template, not the parser.

- [ ] **Step 7: Type check and commit**

```bash
bun run type-check:ui
git add packages/ui/src/lib/workflows/templates.ts packages/ui/src/lib/workflows/templates.test.ts packages/ui/src/components/views/workflows/DefinitionEditor.tsx
git commit -m "feat(workflows): ship an SDLC template"
```
