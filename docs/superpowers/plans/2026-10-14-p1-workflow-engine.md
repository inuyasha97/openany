# Workflow engine (P1 + P2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a declared sequence of SDLC steps against a project from the server, with verifiable checkpoints, a person confirming each step, and a resume that rebuilds from evidence after a restart.

**Architecture:** One new server module tree, `packages/web/server/lib/workflows/`, exposes routes under `/api/workflows/*`. The engine drives one OMP session per step attempt, waits for the turn to end, runs artifact and command verifiers, and persists run state to one JSON file per run. Sessions, prompts, git and the clock are all injected, so the whole loop runs in tests with no model. Nothing in `packages/ui` changes in this plan.

**Tech Stack:** Node >= 22 ESM JavaScript, Express 5, vitest, supertest, `simple-git`, `node:crypto`.

**Spec:** `docs/superpowers/specs/2026-10-14-sdlc-workflow-design.md`

## Global Constraints

- No new dependencies. `simple-git`, `express` and `yaml` are already dependencies of `packages/web`.
- Server modules are ESM JavaScript. Routes follow `registerXxxRoutes(app, dependencies)` (`packages/web/server/lib/project-context/routes.js:53`). There is no global JSON body parser, so a route that reads a body attaches `express.json({ limit: '1mb' })` itself.
- Run state dir: `<projectsDirPath>/<projectId>/workflow-runs/<runId>.json`, with `projectsDirPath` = `OPENCHAMBER_PROJECTS_CONFIG_DIR`, the value project context already uses (`packages/web/server/index.js:573-578`).
- Definitions: `<projectDirectory>/.openchamber/workflows/<id>.yaml`.
- Tests are vitest files next to the module (`*.test.js`), route tests end in `*.http.test.js` and mount the routes on a bare express app with supertest.
- Focused test command: `bun run --cwd packages/web test -- server/lib/workflows/<file>.test.js`. Syntax check for a new or rewritten JS module: `node --check <file>`.
- Run `bunx oxlint <changed-paths>` once at the end, not per task.
- Do not modify `../opencode`. Do not add, log, or store secrets.
- User-facing text goes into all 13 locales under `packages/ui/src/lib/i18n/messages/`: de, en, es, fr, ja, ko, nl, pl, pt-BR, tr, uk, zh-CN, zh-TW. (No UI text in this plan; it applies to P3.)
- Never delete runtime data: no route deletes a session, and `DELETE /api/workflows/runs/:runId` removes exactly one run file whose id the caller named.
- `AGENTS.md` forbids git commands unless the maintainer asked. The maintainer asked for this plan to be executed, so the commit steps below are the only git commands an executor runs.

## Review Focus

Input classes and failure modes the spec implies but no single task's tests otherwise pin. Each line names the behavior a reasonable person expects, and the task that owns the test:

1. A glob that matches nothing must read as a failed check, never as a passed step. A person who typed the pattern wrong needs to see "no files matched", not a green step. Owner: Task 3, Task 5.
2. A prompt the runtime refused must not be recorded as sent. A step must not read as running when nothing was dispatched. Owner: Task 9.
3. Two "run step" clicks while a turn is in flight must produce one attempt, not two. The second click has to answer "already running". Owner: Task 9, Task 11.
4. A server restart mid-turn must leave the step `interrupted`, never `done`. Owner: Task 13.
5. A confirmed artifact that changed under the checkpoint must block that step on resume instead of advancing the run. Owner: Task 13.
6. Paths with spaces and non-ASCII characters inside a project directory must work in artifact globs and in the git checkpoint. Owner: Task 3, Task 8.

---

## File Structure

```
packages/web/server/lib/workflows/
  definitions.js        parse, validate, list definition files         Task 1
  definitions.test.js
  prompts.js            input substitution, prompt block assembly      Task 2
  prompts.test.js
  artifacts.js          glob matching, hashing                         Task 3
  artifacts.test.js
  commands.js           command check with timeout                     Task 4
  commands.test.js
  verifiers.js          assemble artifact + command results            Task 5
  verifiers.test.js
  turn.js               wait for one turn to end                       Task 6
  turn.test.js
  store.js              run files on disk, serialized writes           Task 7
  store.test.js
  git-checkpoint.js     commit the step's changes, or read HEAD        Task 8
  git-checkpoint.test.js
  engine.js             the run loop and its decisions                 Task 9, 10
  engine.test.js
  resume.js             boot reconciliation                            Task 13
  resume.test.js
  routes.js             HTTP routes                                    Task 11
  routes.http.test.js
  runtime.js            factory that wires the modules                 Task 12
  index.js              export of the factory                          Task 12
```

Modified:

- `packages/web/server/lib/scheduled-tasks/runtime.js` (Task 2: use the shared prompt assembly)
- `packages/web/server/index.js` (Task 12: build the runtime and pass it to the feature routes)
- `packages/web/server/lib/openchamber/feature-routes-runtime.js` (Task 12: call `registerWorkflowRoutes`)

---

### Task 1: Definition parsing and listing

**Files:**
- Create: `packages/web/server/lib/workflows/definitions.js`
- Test: `packages/web/server/lib/workflows/definitions.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `parseDefinition(rawText, { file }) -> { ok: true, definition } | { ok: false, errors: Array<{ field, message }> }`
  - `createWorkflowDefinitions({ fsPromises, path, projectPathFromId }) -> { list(projectId), read(projectId, workflowId), directoryFor(projectId) }`
  - `WorkflowDefinition = { id, name, version, inputs, steps }`, `WorkflowStep = { id, title, prompt, session, permissions, verify, confirm }`

- [ ] **Step 1: Write the failing test**

```js
// packages/web/server/lib/workflows/definitions.test.js
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorkflowDefinitions, parseDefinition } from './definitions.js';

const valid = `
id: sdlc-feature
name: SDLC, feature work
version: 3
inputs:
  - name: request
    description: What to build
    required: true
steps:
  - id: spec
    title: Design the change
    prompt: "Design {{request}}."
    session: new
    permissions: ask
    verify:
      artifacts:
        - glob: "docs/superpowers/specs/*-design.md"
          hash: true
      commands:
        - run: "bun run type-check:web"
          expectExit: 0
    confirm: human
  - id: verify
    title: Verify
    prompt: "Run the checks."
    session: reuse
    verify:
      commands:
        - run: "bun run type-check:web"
    confirm: auto
`;

describe('parseDefinition', () => {
  it('fills defaults and normalizes verify entries', () => {
    const result = parseDefinition(valid, { file: 'sdlc-feature.yaml' });
    expect(result.ok).toBe(true);
    const [spec, verify] = result.definition.steps;
    expect(spec.session).toBe('new');
    expect(spec.permissions).toBe('ask');
    expect(spec.confirm).toBe('human');
    expect(spec.verify.commands[0]).toEqual({ run: 'bun run type-check:web', expectExit: 0, timeoutMs: 600000 });
    expect(spec.verify.artifacts).toEqual([{ glob: 'docs/superpowers/specs/*-design.md', hash: true }]);
    expect(verify.verify.artifacts).toEqual([]);
    expect(verify.verify.commands[0].expectExit).toBe(0);
  });

  it('reports a placeholder with no declared input', () => {
    const result = parseDefinition(valid.replace('{{request}}', '{{nope}}'), { file: 'a.yaml' });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([{ field: 'steps[0].prompt', message: 'unknown input "nope"' }]);
  });

  it('rejects confirm: auto with nothing to verify', () => {
    const result = parseDefinition(valid.replace('confirm: auto', 'confirm: auto').replace('      commands:\n        - run: "bun run type-check:web"\n', ''), { file: 'a.yaml' });
    expect(result.ok).toBe(false);
    expect(result.errors[0].field).toBe('steps[1]');
    expect(result.errors[0].message).toMatch(/confirm: auto needs a verifier/);
  });

  it('rejects a duplicate step id', () => {
    const result = parseDefinition(valid.replace('id: verify', 'id: spec'), { file: 'a.yaml' });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([{ field: 'steps[1].id', message: 'duplicate step id "spec"' }]);
  });

  it('rejects an unknown step field instead of ignoring it', () => {
    const result = parseDefinition(valid.replace('    session: new', '    session: new\n    sandbox: worktree'), { file: 'a.yaml' });
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toMatch(/unknown field "sandbox"/);
  });

  it('rejects a file that is not an object', () => {
    const result = parseDefinition('- one\n- two\n', { file: 'a.yaml' });
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toMatch(/must be a mapping/);
  });
});

describe('createWorkflowDefinitions', () => {
  it('lists every yaml file with its errors, and reads a valid one by id', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-defs-'));
    await fs.mkdir(path.join(root, '.openchamber/workflows'), { recursive: true });
    await fs.writeFile(path.join(root, '.openchamber/workflows/two-step.yaml'), valid);
    await fs.writeFile(path.join(root, '.openchamber/workflows/broken.yaml'), 'id: Broken\nsteps: []\n');
    const local = createWorkflowDefinitions({ fsPromises: fs, path, projectPathFromId: () => root });

    const listed = await local.list('proj-1');
    expect(listed.map((entry) => entry.file)).toEqual(['broken.yaml', 'two-step.yaml']);
    expect(listed[0].errors[0].field).toBe('id');
    expect(listed[1].id).toBe('sdlc-feature');
    expect((await local.read('proj-1', 'sdlc-feature')).steps.map((step) => step.id)).toEqual(['spec', 'verify']);
    expect(await local.read('proj-1', 'broken')).toBeNull();
  });

  it('answers an empty list for a project with no workflows directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-defs-empty-'));
    const local = createWorkflowDefinitions({ fsPromises: fs, path, projectPathFromId: () => root });
    expect(await local.list('proj-1')).toEqual([]);
    expect(await local.list('unknown-project')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd packages/web test -- server/lib/workflows/definitions.test.js`
Expected: FAIL, `Failed to resolve import "./definitions.js"`.

- [ ] **Step 3: Write the implementation**

```js
// packages/web/server/lib/workflows/definitions.js
/**
 * Workflow definitions read from `<projectDirectory>/.openchamber/workflows/*.yaml`.
 *
 * A definition is validated the same way in the engine and in the UI: every
 * failure is reported as `{ field, message }` rather than thrown, so a broken
 * file shows up in the screens instead of disappearing from the list.
 */
import { parse as parseYaml } from 'yaml';

const WORKFLOW_DIR = '.openchamber/workflows';
const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;
const STEP_FIELDS = new Set(['id', 'title', 'prompt', 'session', 'permissions', 'verify', 'confirm']);
const DEFINITION_FIELDS = new Set(['id', 'name', 'version', 'inputs', 'steps']);
const INPUT_FIELDS = new Set(['name', 'description', 'required']);
const VERIFY_FIELDS = new Set(['artifacts', 'commands']);

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isName = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const isWorkflowId = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;

const findPlaceholders = (text) => [...text.matchAll(/\{\{([^}]+)\}\}/g)].map((match) => match[1].trim());

const normalizeArtifacts = (value, field, errors) => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({ field, message: 'must be a list' });
    return [];
  }
  return value.map((entry, index) => {
    if (typeof entry === 'string') {
      return isText(entry)
        ? { glob: entry, hash: false }
        : (errors.push({ field: `${field}[${index}]`, message: 'must be a non-empty string' }), null);
    }
    if (isRecord(entry)) {
      const extra = Object.keys(entry).filter((key) => key !== 'glob' && key !== 'hash');
      if (extra.length > 0) errors.push({ field: `${field}[${index}]`, message: `unknown field "${extra[0]}"` });
      if (!isText(entry.glob)) errors.push({ field: `${field}[${index}].glob`, message: 'must be a non-empty string' });
      if (entry.hash !== undefined && typeof entry.hash !== 'boolean') errors.push({ field: `${field}[${index}].hash`, message: 'must be a boolean' });
      return isText(entry.glob) ? { glob: entry.glob, hash: entry.hash === true } : null;
    }
    errors.push({ field: `${field}[${index}]`, message: 'must be a string or a mapping' });
    return null;
  }).filter(Boolean);
};

const normalizeCommands = (value, field, errors) => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({ field, message: 'must be a list' });
    return [];
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      errors.push({ field: `${field}[${index}]`, message: 'must be a mapping' });
      return null;
    }
    const extra = Object.keys(entry).filter((key) => !['run', 'expectExit', 'timeoutMs'].includes(key));
    if (extra.length > 0) errors.push({ field: `${field}[${index}]`, message: `unknown field "${extra[0]}"` });
    if (!isText(entry.run)) errors.push({ field: `${field}[${index}].run`, message: 'must be a non-empty string' });
    if (entry.expectExit !== undefined && !Number.isInteger(entry.expectExit)) {
      errors.push({ field: `${field}[${index}].expectExit`, message: 'must be an integer' });
    }
    if (entry.timeoutMs !== undefined && !(Number.isInteger(entry.timeoutMs) && entry.timeoutMs > 0)) {
      errors.push({ field: `${field}[${index}].timeoutMs`, message: 'must be a positive integer' });
    }
    if (!isText(entry.run)) return null;
    return {
      run: entry.run,
      expectExit: Number.isInteger(entry.expectExit) ? entry.expectExit : 0,
      timeoutMs: Number.isInteger(entry.timeoutMs) ? entry.timeoutMs : DEFAULT_COMMAND_TIMEOUT_MS,
    };
  }).filter(Boolean);
};

export const parseDefinition = (rawText, { file = 'unknown.yaml' } = {}) => {
  const errors = [];
  let raw;
  try {
    raw = parseYaml(rawText);
  } catch (error) {
    return { ok: false, errors: [{ field: '$', message: error?.message ?? 'invalid YAML' }] };
  }
  if (!isRecord(raw)) return { ok: false, errors: [{ field: '$', message: 'must be a mapping' }] };

  for (const key of Object.keys(raw)) {
    if (!DEFINITION_FIELDS.has(key)) errors.push({ field: key, message: `unknown field "${key}"` });
  }
  if (!isWorkflowId(raw.id)) errors.push({ field: 'id', message: 'must be lowercase words, dots or dashes' });
  if (!isText(raw.name)) errors.push({ field: 'name', message: 'is required' });
  if (!Number.isInteger(raw.version) || raw.version < 1) errors.push({ field: 'version', message: 'must be a positive integer' });

  const inputs = Array.isArray(raw.inputs) ? raw.inputs : [];
  if (raw.inputs !== undefined && !Array.isArray(raw.inputs)) errors.push({ field: 'inputs', message: 'must be a list' });
  const inputNames = new Set();
  const normalizedInputs = inputs.map((input, index) => {
    if (!isRecord(input)) {
      errors.push({ field: `inputs[${index}]`, message: 'must be a mapping' });
      return null;
    }
    for (const key of Object.keys(input)) {
      if (!INPUT_FIELDS.has(key)) errors.push({ field: `inputs[${index}]`, message: `unknown field "${key}"` });
    }
    if (!isName(input.name)) errors.push({ field: `inputs[${index}].name`, message: 'must be lowercase words or dashes' });
    if (inputNames.has(input.name)) errors.push({ field: `inputs[${index}].name`, message: `duplicate input "${input.name}"` });
    inputNames.add(input.name);
    if (input.description !== undefined && typeof input.description !== 'string') {
      errors.push({ field: `inputs[${index}].description`, message: 'must be a string' });
    }
    return isName(input.name) ? { name: input.name, description: input.description ?? '', required: input.required === true } : null;
  }).filter(Boolean);

  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    errors.push({ field: 'steps', message: 'must be a non-empty list' });
    return { ok: false, errors };
  }

  const stepIds = new Set();
  const steps = raw.steps.map((step, index) => {
    const field = `steps[${index}]`;
    if (!isRecord(step)) {
      errors.push({ field, message: 'must be a mapping' });
      return null;
    }
    for (const key of Object.keys(step)) {
      if (!STEP_FIELDS.has(key)) errors.push({ field, message: `unknown field "${key}"` });
    }
    if (!isName(step.id)) errors.push({ field: `${field}.id`, message: 'must be lowercase words or dashes' });
    if (stepIds.has(step.id)) errors.push({ field: `${field}.id`, message: `duplicate step id "${step.id}"` });
    stepIds.add(step.id);
    if (step.title !== undefined && typeof step.title !== 'string') errors.push({ field: `${field}.title`, message: 'must be a string' });
    if (!isText(step.prompt)) errors.push({ field: `${field}.prompt`, message: 'is required' });
    if (step.session !== undefined && !['new', 'reuse'].includes(step.session)) {
      errors.push({ field: `${field}.session`, message: 'must be "new" or "reuse"' });
    }
    if (step.permissions !== undefined && !['ask', 'auto'].includes(step.permissions)) {
      errors.push({ field: `${field}.permissions`, message: 'must be "ask" or "auto"' });
    }
    if (step.confirm !== undefined && !['human', 'auto'].includes(step.confirm)) {
      errors.push({ field: `${field}.confirm`, message: 'must be "human" or "auto"' });
    }
    if (isText(step.prompt)) {
      for (const placeholder of findPlaceholders(step.prompt)) {
        if (!inputNames.has(placeholder)) errors.push({ field: `${field}.prompt`, message: `unknown input "${placeholder}"` });
      }
    }
    const verify = isRecord(step.verify) ? step.verify : {};
    if (step.verify !== undefined && !isRecord(step.verify)) errors.push({ field: `${field}.verify`, message: 'must be a mapping' });
    for (const key of Object.keys(verify)) {
      if (!VERIFY_FIELDS.has(key)) errors.push({ field: `${field}.verify`, message: `unknown field "${key}"` });
    }
    const artifacts = normalizeArtifacts(verify.artifacts, `${field}.verify.artifacts`, errors);
    const commands = normalizeCommands(verify.commands, `${field}.verify.commands`, errors);
    const confirm = step.confirm === 'auto' ? 'auto' : 'human';
    if (confirm === 'auto' && artifacts.length === 0 && commands.length === 0) {
      errors.push({ field, message: 'confirm: auto needs a verifier, or the step advances on a guess' });
    }
    if (!isName(step.id) || !isText(step.prompt)) return null;
    return {
      id: step.id,
      title: typeof step.title === 'string' && step.title.trim() ? step.title : step.id,
      prompt: step.prompt,
      session: step.session === 'reuse' ? 'reuse' : 'new',
      permissions: step.permissions === 'auto' ? 'auto' : 'ask',
      verify: { artifacts, commands },
      confirm,
    };
  }).filter(Boolean);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    definition: { id: raw.id, name: raw.name, version: raw.version, inputs: normalizedInputs, steps, file },
  };
};

const readDirectory = async (fsPromises, directory) => {
  try {
    return await fsPromises.readdir(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
};

export const createWorkflowDefinitions = ({ fsPromises, path, projectPathFromId }) => {
  const directoryFor = (projectId) => {
    const projectDirectory = projectPathFromId(projectId);
    if (!projectDirectory) return null;
    return path.join(projectDirectory, WORKFLOW_DIR);
  };

  const list = async (projectId) => {
    const directory = directoryFor(projectId);
    if (!directory) return [];
    const entries = (await readDirectory(fsPromises, directory))
      .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
      .sort();
    const results = [];
    for (const name of entries) {
      const raw = await fsPromises.readFile(path.join(directory, name), 'utf8');
      const parsed = parseDefinition(raw, { file: name });
      results.push(parsed.ok
        ? { file: name, id: parsed.definition.id, name: parsed.definition.name, version: parsed.definition.version, errors: [], definition: parsed.definition }
        : { file: name, id: null, name: null, version: null, errors: parsed.errors, definition: null });
    }
    return results;
  };

  const read = async (projectId, workflowId) => {
    const found = (await list(projectId)).find((entry) => entry.id === workflowId && entry.definition);
    return found ? found.definition : null;
  };

  return { list, read, directoryFor };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run --cwd packages/web test -- server/lib/workflows/definitions.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Syntax check and commit**

```bash
node --check packages/web/server/lib/workflows/definitions.js
git add packages/web/server/lib/workflows/definitions.js packages/web/server/lib/workflows/definitions.test.js
git commit -m "feat(workflows): parse and validate workflow definitions"
```

---

### Task 2: Prompt assembly shared with scheduled tasks

**Files:**
- Create: `packages/web/server/lib/workflows/prompts.js`
- Test: `packages/web/server/lib/workflows/prompts.test.js`
- Modify: `packages/web/server/lib/scheduled-tasks/runtime.js:499-521` (the `blocks` assembly in `runPrompt`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `substituteInputs(template, values) -> { text, missing: string[] }`
  - `assemblePromptBlocks({ prompt, context }) -> string`

- [ ] **Step 1: Write the failing test**

```js
// packages/web/server/lib/workflows/prompts.test.js
import { describe, expect, it } from 'vitest';
import { assemblePromptBlocks, substituteInputs } from './prompts.js';

describe('substituteInputs', () => {
  it('replaces every declared placeholder', () => {
    expect(substituteInputs('Design {{request}} for {{audience}}.', { request: 'a cache', audience: 'ops' }))
      .toEqual({ text: 'Design a cache for ops.', missing: [] });
  });

  it('reports a placeholder with no value instead of blanking it', () => {
    expect(substituteInputs('Design {{request}}.', {}))
      .toEqual({ text: 'Design {{request}}.', missing: ['request'] });
  });
});

describe('assemblePromptBlocks', () => {
  it('leads with a slash prompt so OMP still expands the command', () => {
    expect(assemblePromptBlocks({ prompt: '/plan-feature add caching', context: ['PROJECT NOTES'] }))
      .toBe('/plan-feature add caching\n\nPROJECT NOTES');
  });

  it('puts context in front of a plain prompt', () => {
    expect(assemblePromptBlocks({ prompt: 'Do the work', context: ['PROJECT NOTES'] }))
      .toBe('PROJECT NOTES\n\nDo the work');
  });

  it('drops empty context blocks', () => {
    expect(assemblePromptBlocks({ prompt: 'Do the work', context: ['', '   ', null] })).toBe('Do the work');
  });

  it('treats a leading space before the slash as leading', () => {
    expect(assemblePromptBlocks({ prompt: '   /plan-feature x', context: ['CTX'] })).toBe('   /plan-feature x\n\nCTX');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd packages/web test -- server/lib/workflows/prompts.test.js`
Expected: FAIL, `Failed to resolve import "./prompts.js"`.

- [ ] **Step 3: Write the implementation**

```js
// packages/web/server/lib/workflows/prompts.js
/**
 * Prompt text assembly for a step.
 *
 * OMP expands a prompt that starts with `/name args`, so such a prompt has to
 * lead the text: context placed in front of it would hide the slash and the
 * command would be sent as literal text. Every other prompt reads better with
 * its context first.
 */

export const substituteInputs = (template, values) => {
  const missing = [];
  const text = String(template).replace(/\{\{([^}]+)\}\}/g, (match, rawName) => {
    const name = rawName.trim();
    const value = values?.[name];
    if (typeof value !== 'string' || value.length === 0) {
      if (!missing.includes(name)) missing.push(name);
      return match;
    }
    return value;
  });
  return { text, missing };
};

export const assemblePromptBlocks = ({ prompt, context = [] }) => {
  const text = String(prompt ?? '');
  const blocks = (Array.isArray(context) ? context : [])
    .filter((block) => typeof block === 'string' && block.trim().length > 0);
  if (blocks.length === 0) return text;
  return text.trimStart().startsWith('/')
    ? [text.trimEnd(), ...blocks].join('\n\n')
    : [...blocks, text.trimStart()].join('\n\n');
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run --cwd packages/web test -- server/lib/workflows/prompts.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Repoint scheduled tasks at the shared assembly**

In `packages/web/server/lib/scheduled-tasks/runtime.js`, `runPrompt` currently builds `blocks` and joins them inline (the `leads` branch around line 499 to 521). Replace that assembly with a call to the shared function, keeping the knowledge and goal text as `context`:

```js
import { assemblePromptBlocks } from '../workflows/prompts.js';
...
const taskPrompt = expandSnippets(task.execution.prompt, projectPath);
const context = [];
if (knowledge.text) context.push(knowledge.text);
if (task.execution.goalEnabled) context.push(buildGoalIntroText(task.execution.goalTokenBudget));
const accepted = await promptSession(sessionID, assemblePromptBlocks({ prompt: taskPrompt, context }));
```

- [ ] **Step 6: Run the scheduled-task tests to verify nothing moved**

Run: `bun run --cwd packages/web test -- server/lib/scheduled-tasks`
Expected: PASS, same count as before the change.

- [ ] **Step 7: Syntax check and commit**

```bash
node --check packages/web/server/lib/workflows/prompts.js
node --check packages/web/server/lib/scheduled-tasks/runtime.js
git add packages/web/server/lib/workflows/prompts.js packages/web/server/lib/workflows/prompts.test.js packages/web/server/lib/scheduled-tasks/runtime.js
git commit -m "feat(workflows): share prompt block assembly with scheduled tasks"
```

---

### Task 3: Artifact matching and hashing

**Files:**
- Create: `packages/web/server/lib/workflows/artifacts.js`
- Test: `packages/web/server/lib/workflows/artifacts.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `matchArtifacts({ directory, pattern }) -> Promise<string[]>` (relative paths, sorted)
  - `hashFile(absolutePath) -> Promise<{ size, sha256 }>`
  - `inspectArtifacts({ directory, patterns, hash }) -> Promise<Array<{ glob, path, exists, size, sha256 }>>`

- [ ] **Step 1: Write the failing test**

```js
// packages/web/server/lib/workflows/artifacts.test.js
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectArtifacts, matchArtifacts } from './artifacts.js';

let root;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf artifacts '));
  await fs.mkdir(path.join(root, 'docs/specs'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/specs/a-design.md'), 'a');
  await fs.writeFile(path.join(root, 'docs/specs/b-design.md'), 'bb');
  await fs.writeFile(path.join(root, 'docs/specs/notes.txt'), 'c');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('matchArtifacts', () => {
  it('matches a single star inside one segment', async () => {
    expect(await matchArtifacts({ directory: root, pattern: 'docs/specs/*-design.md' }))
      .toEqual(['docs/specs/a-design.md', 'docs/specs/b-design.md']);
  });

  it('matches a double star across segments', async () => {
    expect(await matchArtifacts({ directory: root, pattern: 'docs/**/*.md' }))
      .toEqual(['docs/specs/a-design.md', 'docs/specs/b-design.md']);
  });

  it('returns nothing for a pattern with no match, and does not throw on a missing root', async () => {
    expect(await matchArtifacts({ directory: root, pattern: 'nope/*.md' })).toEqual([]);
    expect(await matchArtifacts({ directory: path.join(root, 'gone'), pattern: '*.md' })).toEqual([]);
  });

  it('handles spaces and non-ASCII names', async () => {
    await fs.writeFile(path.join(root, 'docs/specs/đặc tả.md'), 'x');
    expect(await matchArtifacts({ directory: root, pattern: 'docs/specs/*.md' }))
      .toEqual(['docs/specs/a-design.md', 'docs/specs/b-design.md', 'docs/specs/đặc tả.md']);
  });

  it('does not escape the directory', async () => {
    expect(await matchArtifacts({ directory: root, pattern: '../*.md' })).toEqual([]);
    expect(await matchArtifacts({ directory: root, pattern: 'docs/../*.md' })).toEqual([]);
  });

  it('refuses an absolute pattern instead of reading it as relative', async () => {
    expect(await matchArtifacts({ directory: root, pattern: '/etc/hosts' })).toEqual([]);
    expect(await matchArtifacts({ directory: root, pattern: path.join(root, 'docs/specs/a-design.md') })).toEqual([]);
  });

  it('treats a double star as zero or more segments', async () => {
    await fs.writeFile(path.join(root, 'docs/top.md'), 't');
    await fs.mkdir(path.join(root, 'docs/specs/deep'), { recursive: true });
    await fs.writeFile(path.join(root, 'docs/specs/deep/nested.md'), 'n');
    expect(await matchArtifacts({ directory: root, pattern: 'docs/**/*.md' }))
      .toEqual(['docs/specs/a-design.md', 'docs/specs/b-design.md', 'docs/specs/deep/nested.md', 'docs/top.md']);
    expect(await matchArtifacts({ directory: root, pattern: 'docs/**' }))
      .toEqual(['docs/specs/a-design.md', 'docs/specs/b-design.md', 'docs/specs/deep/nested.md', 'docs/specs/notes.txt', 'docs/top.md']);
    expect(await matchArtifacts({ directory: root, pattern: '**/*.md' }))
      .toEqual(['docs/specs/a-design.md', 'docs/specs/b-design.md', 'docs/specs/deep/nested.md', 'docs/top.md']);
  });
});

describe('inspectArtifacts', () => {
  it('hashes only when asked, and reports a pattern with no match', async () => {
    const [hashed, plain, missing] = await inspectArtifacts({
      directory: root,
      patterns: [
        { glob: 'docs/specs/a-design.md', hash: true },
        { glob: 'docs/specs/b-design.md', hash: false },
        { glob: 'docs/specs/zzz.md', hash: true },
      ],
    });
    expect(hashed).toMatchObject({ glob: 'docs/specs/a-design.md', path: 'docs/specs/a-design.md', exists: true, size: 1 });
    expect(hashed.sha256).toHaveLength(64);
    expect(plain).toMatchObject({ exists: true, sha256: null });
    expect(missing).toEqual({ glob: 'docs/specs/zzz.md', path: null, exists: false, size: null, sha256: null });
  });

  it('reports one entry per match of a multi-match pattern', async () => {
    const results = await inspectArtifacts({ directory: root, patterns: [{ glob: 'docs/specs/*.md', hash: false }] });
    expect(results.map((entry) => entry.path)).toEqual(['docs/specs/a-design.md', 'docs/specs/b-design.md']);
  });

  it('hashes the bytes, so the digest is the file and not a placeholder', async () => {
    const [entry] = await inspectArtifacts({ directory: root, patterns: [{ glob: 'docs/specs/a-design.md', hash: true }] });
    expect(entry.size).toBe(1);
    // sha256 of the single byte "a"
    expect(entry.sha256).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd packages/web test -- server/lib/workflows/artifacts.test.js`
Expected: FAIL, `Failed to resolve import "./artifacts.js"`.

- [ ] **Step 3: Write the implementation**

```js
// packages/web/server/lib/workflows/artifacts.js
/**
 * Artifact checks for a step: which files a glob matches, and their hashes.
 *
 * The matcher is local rather than a dependency: `packages/web` has no glob
 * package, and the patterns a definition uses are path segments with `*` and
 * `**`. Patterns are relative to the run's directory and can never escape it.
 */
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const toSegments = (pattern) => String(pattern)
  .replace(/\\/g, '/')
  .split('/')
  .filter((segment) => segment.length > 0 && segment !== '.');

const segmentMatches = (segment, name) => {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}$`).test(name);
};

const walk = async (directory, segments) => {
  const [head, ...rest] = segments;
  if (head === undefined) return [];
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'EACCES') return [];
    throw error;
  }

  const matches = [];
  if (head === '**') {
    // `**` is zero or more segments. A trailing `**` means every file at or
    // below this directory; otherwise the rest of the pattern is tried in this
    // same directory (the zero case) and once more per directory below it. The
    // zero case is the one that is easy to lose: without it `docs/**/*.md`
    // misses a file sitting directly in `docs/`, and `docs/**` matches nothing,
    // so a pattern a person wrote correctly reads as a failed check.
    if (rest.length === 0) {
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        if (entry.isFile()) matches.push(absolute);
        else if (entry.isDirectory()) matches.push(...await walk(absolute, segments));
      }
      return matches;
    }
    matches.push(...await walk(directory, rest));
    for (const entry of entries) {
      if (entry.isDirectory()) matches.push(...await walk(path.join(directory, entry.name), segments));
    }
    return matches;
  }

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (!segmentMatches(head, entry.name)) continue;
    if (rest.length === 0) {
      if (entry.isFile()) matches.push(absolute);
      continue;
    }
    if (entry.isDirectory()) matches.push(...await walk(absolute, rest));
  }
  return matches;
};

export const matchArtifacts = async ({ directory, pattern }) => {
  const raw = String(pattern);
  // An absolute pattern is a mistake in a definition, and silently treating it
  // as relative would look at the wrong tree.
  if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) return [];
  const segments = toSegments(raw);
  if (segments.length === 0 || segments.includes('..')) return [];
  const matched = await walk(directory, segments);
  return [...new Set(matched)]
    .map((absolute) => path.relative(directory, absolute).split(path.sep).join('/'))
    .sort();
};

export const hashFile = async (absolutePath) => {
  // Size and digest come from the same read, so the pair always describes the
  // same bytes. Comparing them later is what tells a checkpoint whether the file
  // still holds what it held when a person confirmed it.
  const digest = crypto.createHash('sha256');
  let size = 0;
  const source = createReadStream(absolutePath);
  source.on('data', (chunk) => { size += chunk.length; });
  await pipeline(source, digest);
  return { size, sha256: digest.digest('hex') };
};

export const inspectArtifacts = async ({ directory, patterns }) => {
  const results = [];
  for (const pattern of patterns) {
    const matches = await matchArtifacts({ directory, pattern: pattern.glob });
    if (matches.length === 0) {
      results.push({ glob: pattern.glob, path: null, exists: false, size: null, sha256: null });
      continue;
    }
    for (const relative of matches) {
      if (pattern.hash === true) {
        const { size, sha256 } = await hashFile(path.join(directory, relative));
        results.push({ glob: pattern.glob, path: relative, exists: true, size, sha256 });
      } else {
        const stats = await fs.stat(path.join(directory, relative));
        results.push({ glob: pattern.glob, path: relative, exists: true, size: stats.size, sha256: null });
      }
    }
  }
  return results;
};
```

`createReadStream` and `pipeline` are additional imports (`node:fs`, `node:stream/promises`). A file that vanishes between the walk and the read makes this throw; the rule that a thrown verification is a failed check, not a crashed run, is owned by `verifiers.js` (Task 5), which catches it and records the pattern as unmatched.

Note the matcher's `*` matches dotfiles, unlike minimatch's default. That is stated here on purpose: an artifact glob is written by the person who wants the file, so matching more is the safer direction.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run --cwd packages/web test -- server/lib/workflows/artifacts.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Syntax check and commit**

```bash
node --check packages/web/server/lib/workflows/artifacts.js
git add packages/web/server/lib/workflows/artifacts.js packages/web/server/lib/workflows/artifacts.test.js
git commit -m "feat(workflows): match and hash step artifacts"
```

---

### Task 4: Command check with timeout

**Files:**
- Create: `packages/web/server/lib/workflows/commands.js`
- Test: `packages/web/server/lib/workflows/commands.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `runCommandCheck({ directory, run, expectExit, timeoutMs }) -> Promise<{ run, expectExit, exitCode, stdout, stderr, timedOut, durationMs, ok }>`

- [ ] **Step 1: Write the failing test**

```js
// packages/web/server/lib/workflows/commands.test.js
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { runCommandCheck } from './commands.js';

let root;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-cmd-'));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('runCommandCheck', () => {
  it('passes on the expected exit code and keeps the output', async () => {
    const result = await runCommandCheck({ directory: root, run: 'node -e "console.log(\'hello\')"', expectExit: 0, timeoutMs: 20000 });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, ok: true });
    expect(result.stdout).toContain('hello');
  });

  it('fails when the exit code is not the expected one', async () => {
    const result = await runCommandCheck({ directory: root, run: 'node -e "process.exit(3)"', expectExit: 0, timeoutMs: 20000 });
    expect(result).toMatchObject({ exitCode: 3, ok: false, timedOut: false });
  });

  it('accepts a non-zero expected exit code', async () => {
    const result = await runCommandCheck({ directory: root, run: 'node -e "process.exit(4)"', expectExit: 4, timeoutMs: 20000 });
    expect(result.ok).toBe(true);
  });

  it('kills a command that runs past its timeout', async () => {
    const result = await runCommandCheck({ directory: root, run: 'node -e "setTimeout(() => {}, 30000)"', expectExit: 0, timeoutMs: 500 });
    expect(result).toMatchObject({ timedOut: true, ok: false });
  });

  it('runs in the given directory', async () => {
    const result = await runCommandCheck({ directory: root, run: 'node -e "console.log(process.cwd())"', expectExit: 0, timeoutMs: 20000 });
    expect(result.stdout.trim()).toBe(await fs.realpath(root));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd packages/web test -- server/lib/workflows/commands.test.js`
Expected: FAIL, `Failed to resolve import "./commands.js"`.

- [ ] **Step 3: Write the implementation**

```js
// packages/web/server/lib/workflows/commands.js
/**
 * One verifier command, run in the run's directory.
 *
 * `shell: true` so a definition can write `bun run type-check:web` the way a
 * person would type it in the project. The child is killed at the timeout and
 * the result says `timedOut`, so a hung check never reads as a passed one.
 */
import { spawn } from 'node:child_process';

export const runCommandCheck = ({ directory, run, expectExit = 0, timeoutMs = 600_000 }) => new Promise((resolve) => {
  const startedAt = Date.now();
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let settled = false;
  const child = spawn(run, { cwd: directory, shell: true });

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);

  const finish = (exitCode) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({
      run,
      expectExit,
      exitCode,
      stdout,
      stderr,
      timedOut,
      durationMs: Date.now() - startedAt,
      ok: !timedOut && exitCode === expectExit,
    });
  };

  child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', (error) => {
    stderr += `${stderr ? '\n' : ''}${error.message}`;
    finish(null);
  });
  child.on('close', (code) => finish(code));
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run --cwd packages/web test -- server/lib/workflows/commands.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Syntax check and commit**

```bash
node --check packages/web/server/lib/workflows/commands.js
git add packages/web/server/lib/workflows/commands.js packages/web/server/lib/workflows/commands.test.js
git commit -m "feat(workflows): run verifier commands with a timeout"
```

---

### Task 5: Verifier assembly

**Files:**
- Create: `packages/web/server/lib/workflows/verifiers.js`
- Test: `packages/web/server/lib/workflows/verifiers.test.js`

**Interfaces:**
- Consumes: `inspectArtifacts` (Task 3), `runCommandCheck` (Task 4).
- Produces:
  - `runVerifiers({ step, directory, deps }) -> Promise<{ ok, artifacts, commands }>`
  - `verifyCheckpoint({ checkpoint, directory, deps }) -> Promise<{ ok, mismatches }>`
  - `WorkflowVerifyResult = { ok, artifacts: Array<{ glob, path, exists, size, sha256 }>, commands: Array<{ run, expectExit, exitCode, stdout, stderr, timedOut, durationMs, ok }> }`

- [ ] **Step 1: Write the failing test**

```js
// packages/web/server/lib/workflows/verifiers.test.js
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runVerifiers, verifyCheckpoint } from './verifiers.js';

let root;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-ver-'));
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/design.md'), 'one');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const step = (verify) => ({ id: 'spec', verify });

describe('runVerifiers', () => {
  it('passes when every check passed, and records each one', async () => {
    const result = await runVerifiers({
      step: step({ artifacts: [{ glob: 'docs/*.md', hash: true }], commands: [{ run: 'node -e ""', expectExit: 0, timeoutMs: 20000 }] }),
      directory: root,
    });
    expect(result.ok).toBe(true);
    expect(result.artifacts[0]).toMatchObject({ path: 'docs/design.md', exists: true });
    expect(result.commands[0].ok).toBe(true);
  });

  it('fails when an artifact pattern matched nothing', async () => {
    const result = await runVerifiers({ step: step({ artifacts: [{ glob: 'docs/zzz.md', hash: false }], commands: [] }), directory: root });
    expect(result.ok).toBe(false);
    expect(result.artifacts[0]).toMatchObject({ exists: false, path: null });
  });

  it('fails when a command failed, and keeps the output', async () => {
    const result = await runVerifiers({
      step: step({ artifacts: [], commands: [{ run: 'node -e "console.error(\'bad\'); process.exit(2)"', expectExit: 0, timeoutMs: 20000 }] }),
      directory: root,
    });
    expect(result.ok).toBe(false);
    expect(result.commands[0].stderr).toContain('bad');
  });

  it('fails when a toggle command throws instead of answering', async () => {
    const runCommand = vi.fn(async () => { throw new Error('spawn failed'); });
    const result = await runVerifiers({
      step: step({ artifacts: [], commands: [{ run: 'x', expectExit: 0, timeoutMs: 1000 }] }),
      directory: root,
      deps: { runCommand },
    });
    expect(result.ok).toBe(false);
    expect(result.commands[0]).toMatchObject({ exitCode: null, ok: false });
    expect(result.commands[0].stderr).toContain('spawn failed');
  });

  it('fails when the artifact inspection throws, instead of letting it escape', async () => {
    const inspectArtifacts = vi.fn(async () => { throw new Error('EACCES: permission denied'); });
    const result = await runVerifiers({
      step: step({ artifacts: [{ glob: 'docs/*.md', hash: true }], commands: [] }),
      directory: root,
      deps: { inspectArtifacts },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('EACCES');
    expect(result.artifacts).toEqual([{ glob: 'docs/*.md', path: null, exists: false, size: null, sha256: null }]);
  });
});

describe('verifyCheckpoint', () => {
  it('passes while the hashed artifact is unchanged', async () => {
    const hashed = await runVerifiers({ step: step({ artifacts: [{ glob: 'docs/design.md', hash: true }], commands: [] }), directory: root });
    const checkpoint = { artifacts: hashed.artifacts.map(({ path: file, size, sha256 }) => ({ path: file, size, sha256 })) };
    expect(await verifyCheckpoint({ checkpoint, directory: root })).toEqual({ ok: true, mismatches: [] });
  });

  it('reports a changed artifact and a missing one', async () => {
    const checkpoint = { artifacts: [{ path: 'docs/design.md', size: 3, sha256: 'a'.repeat(64) }, { path: 'docs/gone.md', size: 1, sha256: 'b'.repeat(64) }] };
    const result = await verifyCheckpoint({ checkpoint, directory: root });
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([
      { path: 'docs/design.md', reason: 'changed' },
      { path: 'docs/gone.md', reason: 'missing' },
    ]);
  });

  it('checks existence only for an artifact the checkpoint recorded without a digest', async () => {
    // A plain-string pattern in the definition means `hash: false`, so the
    // checkpoint holds `sha256: null`. Comparing a real digest against that
    // null would report the step broken on every restart.
    const checkpoint = { artifacts: [{ path: 'docs/design.md', size: 1, sha256: null }] };
    expect(await verifyCheckpoint({ checkpoint, directory: root })).toEqual({ ok: true, mismatches: [] });

    await fs.writeFile(path.join(root, 'docs/design.md'), 'a much longer body');
    expect(await verifyCheckpoint({ checkpoint, directory: root })).toEqual({ ok: true, mismatches: [] });

    await fs.rm(path.join(root, 'docs/design.md'));
    expect(await verifyCheckpoint({ checkpoint, directory: root })).toEqual({ ok: false, mismatches: [{ path: 'docs/design.md', reason: 'missing' }] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd packages/web test -- server/lib/workflows/verifiers.test.js`
Expected: FAIL, `Failed to resolve import "./verifiers.js"`.

- [ ] **Step 3: Write the implementation**

```js
// packages/web/server/lib/workflows/verifiers.js
/**
 * A step's checks: artifacts on disk and commands that must exit as declared.
 *
 * A failure is a result, not an exception: the screen shows which check failed
 * and what it printed. `ok` is true only when every check passed, and a pattern
 * that matched nothing is a failed check, never a quiet pass.
 */
import path from 'node:path';
import { inspectArtifacts, hashFile } from './artifacts.js';
import { runCommandCheck } from './commands.js';

export const runVerifiers = async ({ step, directory, deps = {} }) => {
  const inspect = deps.inspectArtifacts ?? inspectArtifacts;
  const runCommand = deps.runCommand ?? runCommandCheck;
  const patterns = step?.verify?.artifacts ?? [];
  const commands = step?.verify?.commands ?? [];

  let artifacts = [];
  let inspectionError = null;
  if (patterns.length > 0) {
    try {
      artifacts = await inspect({ directory, patterns });
    } catch (error) {
      // A verification that could not run is a failed check, never a crashed
      // run: the person sees which pattern could not be read, and why.
      inspectionError = error?.message ?? 'the artifacts could not be inspected';
      artifacts = patterns.map((pattern) => ({ glob: pattern.glob, path: null, exists: false, size: null, sha256: null }));
    }
  }
  const commandResults = [];
  for (const command of commands) {
    try {
      commandResults.push(await runCommand({
        directory,
        run: command.run,
        expectExit: command.expectExit,
        timeoutMs: command.timeoutMs,
      }));
    } catch (error) {
      commandResults.push({
        run: command.run,
        expectExit: command.expectExit,
        exitCode: null,
        stdout: '',
        stderr: error?.message ?? 'the command could not be started',
        timedOut: false,
        durationMs: 0,
        ok: false,
      });
    }
  }

  const ok = artifacts.every((entry) => entry.exists) && commandResults.every((entry) => entry.ok) && inspectionError === null;
  return inspectionError === null
    ? { ok, artifacts, commands: commandResults }
    : { ok, artifacts, commands: commandResults, error: inspectionError };
};

export const verifyCheckpoint = async ({ checkpoint, directory, deps = {} }) => {
  const hash = deps.hashFile ?? hashFile;
  const mismatches = [];
  for (const artifact of checkpoint?.artifacts ?? []) {
    const absolute = path.join(directory, artifact.path);
    let current;
    try {
      current = await hash(absolute);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        mismatches.push({ path: artifact.path, reason: 'missing' });
        continue;
      }
      throw error;
    }
    // A checkpoint carries a digest only for an artifact the definition marks
    // `hash: true`. For every other artifact the contract is that the file is
    // still there, so a file that changed is not a mismatch: comparing a real
    // digest against the recorded `null` would report every unhashed step as
    // broken the first time the server restarted.
    if (artifact.sha256 !== null && artifact.sha256 !== undefined) {
      if (current.size !== artifact.size || current.sha256 !== artifact.sha256) {
        mismatches.push({ path: artifact.path, reason: 'changed' });
      }
    }
  }
  return { ok: mismatches.length === 0, mismatches };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run --cwd packages/web test -- server/lib/workflows/verifiers.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Syntax check and commit**

```bash
node --check packages/web/server/lib/workflows/verifiers.js
git add packages/web/server/lib/workflows/verifiers.js packages/web/server/lib/workflows/verifiers.test.js
git commit -m "feat(workflows): assemble artifact and command verifier results"
```

---

### Task 6: Waiting for a turn to end

**Files:**
- Create: `packages/web/server/lib/workflows/turn.js`
- Test: `packages/web/server/lib/workflows/turn.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `waitForTurnEnd({ host, sessionId, pollMs, graceMs, timeoutMs, now, sleep }) -> Promise<'completed'|'timeout'|'never_started'|'unavailable'>`

- [ ] **Step 1: Write the failing test**

```js
// packages/web/server/lib/workflows/turn.test.js
import { describe, expect, it } from 'vitest';
import { waitForTurnEnd } from './turn.js';

const harness = (statuses) => {
  let index = 0;
  let clock = 0;
  const seen = [];
  return {
    seen,
    deps: {
      host: { getSessionStatus: async () => { seen.push(index); return statuses[Math.min(index++, statuses.length - 1)]; } },
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      pollMs: 1000,
    },
  };
};

describe('waitForTurnEnd', () => {
  it('answers completed after busy then idle', async () => {
    const { deps } = harness([{ busy: true }, { busy: true }, { busy: false }]);
    expect(await waitForTurnEnd({ ...deps, sessionId: 's1' })).toBe('completed');
  });

  it('answers never_started when the runtime never reports busy', async () => {
    const { deps } = harness([{ busy: false }]);
    expect(await waitForTurnEnd({ ...deps, sessionId: 's1', graceMs: 5000 })).toBe('never_started');
  });

  it('answers unavailable when the runtime went away', async () => {
    const { deps } = harness([null]);
    expect(await waitForTurnEnd({ ...deps, sessionId: 's1' })).toBe('unavailable');
  });

  it('answers timeout when a turn never ends', async () => {
    const { deps } = harness([{ busy: true }]);
    expect(await waitForTurnEnd({ ...deps, sessionId: 's1', timeoutMs: 4000 })).toBe('timeout');
  });

  it('never reads an idle session as a finished turn', async () => {
    const { deps } = harness([{ busy: false }]);
    expect(await waitForTurnEnd({ ...deps, sessionId: 's1', graceMs: 0 })).toBe('never_started');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd packages/web test -- server/lib/workflows/turn.test.js`
Expected: FAIL, `Failed to resolve import "./turn.js"`.

- [ ] **Step 3: Write the implementation**

```js
// packages/web/server/lib/workflows/turn.js
/**
 * Waits for one turn to finish, watching the session's busy state.
 *
 * OMP reports a session as idle both before a turn starts and after it ends, so
 * a single idle reading proves nothing. The wait only accepts idle after having
 * seen busy once. A runtime that never reports busy within the grace window
 * answers `never_started`, which the engine records as a blocked step rather
 * than a finished one: "the turn never ran" and "the turn finished" are
 * different facts, and only one of them means the step may advance.
 */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const waitForTurnEnd = async ({
  host,
  sessionId,
  pollMs = 1000,
  graceMs = 15_000,
  timeoutMs = 30 * 60_000,
  now = Date.now,
  sleep = defaultSleep,
}) => {
  const startedAt = now();
  let sawBusy = false;
  for (;;) {
    const status = await host.getSessionStatus(sessionId);
    if (!status) return 'unavailable';
    if (status.busy === true) sawBusy = true;
    if (sawBusy && status.busy !== true) return 'completed';
    const elapsed = now() - startedAt;
    if (!sawBusy && elapsed >= graceMs) return 'never_started';
    if (elapsed >= timeoutMs) return 'timeout';
    await sleep(pollMs);
  }
};
```

Only a busy reading followed by an idle one is a finished turn. An idle session we never saw busy is `never_started`, which the engine records as a blocked step: the runtime may have refused the prompt, or the process may have died, and neither of those is a step that ran. Do not soften this to `completed` to make a fast turn look finished. A fast turn still reports busy once, and the person's confirmation is what decides the step either way. If a turn genuinely completes so quickly that the poll never sees it, the step lands in `blocked` with that message, which the person can see and act on, rather than advancing the run on a guess.

Note the branch order: the grace check comes before the timeout check, and the grace window is measured from the first poll rather than from the prompt. Both are pinned by the tests, including the `graceMs: 0` case, which shows an idle session is never read as a finished turn even with no grace at all.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run --cwd packages/web test -- server/lib/workflows/turn.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Syntax check and commit**

```bash
node --check packages/web/server/lib/workflows/turn.js
git add packages/web/server/lib/workflows/turn.js packages/web/server/lib/workflows/turn.test.js
git commit -m "feat(workflows): wait for a turn to end without guessing"
```

---

### Task 7: Run state on disk

**Files:**
- Create: `packages/web/server/lib/workflows/store.js`
- Test: `packages/web/server/lib/workflows/store.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `createWorkflowRunStore({ fsPromises, path, projectsDirPath, now }) -> { create(run), read(projectId, runId), list(projectId), write(run), remove(projectId, runId), pathFor(projectId, runId) }`
  - `WorkflowRun` shape (see the spec): `{ runId, projectId, directory, workflowId, workflowVersion, workflowHash, inputs, status, cursor, createdAt, updatedAt, sandbox, steps }`

- [ ] **Step 1: Write the failing test**

```js
// packages/web/server/lib/workflows/store.test.js
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkflowRunStore, isValidRunId, isValidProjectId } from './store.js';

let root;
let store;

const run = (overrides = {}) => ({
  runId: '11111111-2222-4333-8444-555555555555',
  projectId: 'proj-1',
  directory: '/tmp/proj',
  workflowId: 'sdlc-feature',
  workflowVersion: 1,
  workflowHash: 'hash',
  inputs: { request: 'x' },
  status: 'idle',
  cursor: 'spec',
  createdAt: 1,
  updatedAt: 1,
  sandbox: 'working-tree',
  steps: [],
  ...overrides,
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-store-'));
  store = createWorkflowRunStore({ fsPromises: fs, path, projectsDirPath: root, now: () => 42 });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('identifiers', () => {
  it('rejects a path escape in a project id or a run id', () => {
    expect(isValidProjectId('../etc')).toBe(false);
    expect(isValidProjectId('proj-1')).toBe(true);
    expect(isValidRunId('..')).toBe(false);
    expect(isValidRunId('11111111-2222-4333-8444-555555555555')).toBe(true);
  });
});

describe('run store', () => {
  it('creates a run file under the project directory', async () => {
    const created = await store.create(run());
    expect(created.updatedAt).toBe(42);
    expect(await store.read('proj-1', run().runId)).toMatchObject({ runId: run().runId, status: 'idle' });
  });

  it('lists runs newest first and skips an unreadable file', async () => {
    await store.create(run({ runId: 'aaaaaaaa-2222-4333-8444-555555555555', createdAt: 2 }));
    await store.create(run({ runId: 'bbbbbbbb-2222-4333-8444-555555555555', createdAt: 5 }));
    await fs.writeFile(store.pathFor('proj-1', 'cccccccc-2222-4333-8444-555555555555'), '{not json');
    const listed = await store.list('proj-1');
    expect(listed.map((entry) => entry.runId)).toEqual(['bbbbbbbb-2222-4333-8444-555555555555', 'aaaaaaaa-2222-4333-8444-555555555555']);
  });

  it('reads null for a run that is not there, rather than an empty run', async () => {
    expect(await store.read('proj-1', 'dddddddd-2222-4333-8444-555555555555')).toBeNull();
    expect(await store.list('missing-project')).toEqual([]);
  });

  it('serializes concurrent writes to one run', async () => {
    const created = await store.create(run());
    await Promise.all([
      store.write({ ...created, status: 'running' }),
      store.write({ ...created, status: 'done' }),
      store.write({ ...created, status: 'waiting' }),
    ]);
    const read = await store.read('proj-1', created.runId);
    expect(['running', 'done', 'waiting']).toContain(read.status);
    expect(JSON.parse(await fs.readFile(store.pathFor('proj-1', created.runId), 'utf8')).updatedAt).toBe(42);
  });

  it('removes exactly one run file', async () => {
    const created = await store.create(run());
    expect(await store.remove('proj-1', created.runId)).toBe(true);
    expect(await store.read('proj-1', created.runId)).toBeNull();
    expect(await store.remove('proj-1', created.runId)).toBe(false);
  });

  it('refuses to write outside the projects directory', async () => {
    await expect(store.create(run({ projectId: '../escape' }))).rejects.toThrow(/invalid project id/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd packages/web test -- server/lib/workflows/store.test.js`
Expected: FAIL, `Failed to resolve import "./store.js"`.

- [ ] **Step 3: Write the implementation**

```js
// packages/web/server/lib/workflows/store.js
/**
 * Run state on disk: one JSON file per run, under
 * `<projectsDirPath>/<projectId>/workflow-runs/<runId>.json`.
 *
 * Run state is an index, not the record. Artifacts and commits live in the
 * project; this file only says which step a run reached and which session each
 * attempt used, all of which is local to the machine. Writes to one run are
 * serialized and go through a temporary file and a rename, so a crash leaves
 * either the old file or the new one.
 */
const PROJECT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

export const isValidProjectId = (value) => typeof value === 'string' && PROJECT_ID_PATTERN.test(value) && !value.includes('..');
export const isValidRunId = (value) => typeof value === 'string' && RUN_ID_PATTERN.test(value) && !value.includes('..');

export const createWorkflowRunStore = ({ fsPromises, path, projectsDirPath, now = Date.now }) => {
  const directoryFor = (projectId) => path.join(projectsDirPath, projectId, 'workflow-runs');
  const pathFor = (projectId, runId) => path.join(directoryFor(projectId), `${runId}.json`);

  const assertIds = (projectId, runId) => {
    if (!isValidProjectId(projectId)) throw new Error(`invalid project id "${projectId}"`);
    if (runId !== undefined && !isValidRunId(runId)) throw new Error(`invalid run id "${runId}"`);
  };

  // One promise chain per run file keeps two writers from interleaving a read
  // and a rename on the same path.
  const chains = new Map();
  const serialize = (key, task) => {
    const previous = chains.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    chains.set(key, next.catch(() => undefined));
    return next;
  };

  const writeAtomic = async (filePath, value) => {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await fsPromises.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fsPromises.rename(temporary, filePath);
  };

  const read = async (projectId, runId) => {
    assertIds(projectId, runId);
    try {
      return JSON.parse(await fsPromises.readFile(pathFor(projectId, runId), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  };

  const list = async (projectId) => {
    assertIds(projectId);
    let names = [];
    try {
      names = await fsPromises.readdir(directoryFor(projectId));
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const runs = [];
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      const parsed = await read(projectId, name.slice(0, -'.json'.length));
      if (parsed) runs.push(parsed);
    }
    return runs.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
  };

  const write = (run) => serialize(`${run.projectId}/${run.runId}`, async () => {
    assertIds(run.projectId, run.runId);
    const next = { ...run, updatedAt: now() };
    await writeAtomic(pathFor(run.projectId, run.runId), next);
    return next;
  });

  const create = (run) => write({ createdAt: now(), ...run });

  const remove = (projectId, runId) => serialize(`${projectId}/${runId}`, async () => {
    assertIds(projectId, runId);
    try {
      await fsPromises.unlink(pathFor(projectId, runId));
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  });

  return { create, read, list, write, remove, pathFor, directoryFor };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run --cwd packages/web test -- server/lib/workflows/store.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Syntax check and commit**

```bash
node --check packages/web/server/lib/workflows/store.js
git add packages/web/server/lib/workflows/store.js packages/web/server/lib/workflows/store.test.js
git commit -m "feat(workflows): store run state as one file per run"
```

---

### Task 8: Git checkpoint

**Files:**
- Create: `packages/web/server/lib/workflows/git-checkpoint.js`
- Test: `packages/web/server/lib/workflows/git-checkpoint.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `createCheckpointWriter({ git, now }) -> { write({ directory, runId, stepId, attemptIndex }) }`
  - Default `git` driver built from `simple-git`, exported as `createGitDriver()`
  - `WorkflowCheckpoint = { at, commit, clean, artifacts }`

- [ ] **Step 1: Write the failing test**

```js
// packages/web/server/lib/workflows/git-checkpoint.test.js
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCheckpointWriter, createGitDriver } from './git-checkpoint.js';

let root;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf checkpoint '));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(root, 'seed.txt'), 'seed');
  git('add', '.');
  git('commit', '-q', '-m', 'seed');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const writer = () => createCheckpointWriter({ git: createGitDriver(), now: () => 7 });

describe('write', () => {
  it('commits the step changes and records the commit', async () => {
    await fs.writeFile(path.join(root, 'new file.txt'), 'content');
    const checkpoint = await writer().write({ directory: root, runId: 'run-1', stepId: 'spec', attemptIndex: 0 });
    expect(checkpoint.clean).toBe(false);
    expect(checkpoint.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(checkpoint.at).toBe(7);
    const message = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: root }).toString().trim();
    expect(message).toBe('step spec [run=run-1 step=spec attempt=0]');
  });

  it('records HEAD instead of an empty commit on a clean tree', async () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
    const checkpoint = await writer().write({ directory: root, runId: 'run-1', stepId: 'verify', attemptIndex: 1 });
    expect(checkpoint).toEqual({ at: 7, commit: head, clean: true, artifacts: checkpoint.artifacts });
    expect(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root }).toString().trim()).toBe('1');
  });

  it('attaches the verified artifacts', async () => {
    const checkpoint = await writer().write({
      directory: root,
      runId: 'run-1',
      stepId: 'spec',
      attemptIndex: 0,
      artifacts: [{ path: 'seed.txt', size: 4, sha256: 'c'.repeat(64) }],
    });
    expect(checkpoint.artifacts).toEqual([{ path: 'seed.txt', size: 4, sha256: 'c'.repeat(64) }]);
  });

  it('surfaces a git failure instead of reporting a checkpoint', async () => {
    const failing = createCheckpointWriter({ git: { status: async () => { throw new Error('not a git repository'); } }, now: () => 7 });
    await expect(failing.write({ directory: root, runId: 'run-1', stepId: 'spec', attemptIndex: 0 }))
      .rejects.toThrow(/not a git repository/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd packages/web test -- server/lib/workflows/git-checkpoint.test.js`
Expected: FAIL, `Failed to resolve import "./git-checkpoint.js"`.

- [ ] **Step 3: Write the implementation**

```js
// packages/web/server/lib/workflows/git-checkpoint.js
/**
 * A checkpoint as git sees it: a commit holding the step's changes, or the
 * commit that is already HEAD when the step changed nothing.
 *
 * OMP keeps no file snapshots and no per-turn diff, so this commit is the only
 * thing that makes a confirmed step undoable. The message carries the run and
 * the step, which makes git history the checkpoint chain. A repository that
 * cannot answer is an error, never a checkpoint.
 */
import simpleGit from 'simple-git';

export const createGitDriver = () => ({
  status: (directory) => simpleGit(directory).status(),
  revparseHead: (directory) => simpleGit(directory).revparse(['HEAD']),
  add: (directory, files) => simpleGit(directory).add(files),
  commit: (directory, message) => simpleGit(directory).commit(message),
});

const changesOf = (status) => [
  ...(status?.files ?? []).map((file) => file.path),
  ...(status?.not_added ?? []),
].filter((file) => typeof file === 'string' && file.length > 0);

export const createCheckpointWriter = ({ git, now = Date.now }) => ({
  write: async ({ directory, runId, stepId, attemptIndex, artifacts = [] }) => {
    const status = await git.status(directory);
    const changed = [...new Set(changesOf(status))];
    const message = `step ${stepId} [run=${runId} step=${stepId} attempt=${attemptIndex}]`;
    if (changed.length === 0) {
      const commit = (await git.revparseHead(directory)).trim();
      return { at: now(), commit, clean: true, artifacts };
    }
    await git.add(directory, changed);
    const result = await git.commit(directory, message);
    const commit = result?.commit ?? (await git.revparseHead(directory)).trim();
    return { at: now(), commit, clean: false, artifacts };
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run --cwd packages/web test -- server/lib/workflows/git-checkpoint.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Syntax check and commit**

```bash
node --check packages/web/server/lib/workflows/git-checkpoint.js
git add packages/web/server/lib/workflows/git-checkpoint.js packages/web/server/lib/workflows/git-checkpoint.test.js
git commit -m "feat(workflows): write a git checkpoint per confirmed step"
```

---

### Task 9: Engine, running one step

**Files:**
- Create: `packages/web/server/lib/workflows/engine.js`
- Test: `packages/web/server/lib/workflows/engine.test.js`

**Interfaces:**
- Consumes: `createWorkflowRunStore` (Task 7), `createWorkflowDefinitions` (Task 1), `runVerifiers` (Task 5), `createCheckpointWriter` (Task 8), `waitForTurnEnd` (Task 6), `substituteInputs` + `assemblePromptBlocks` (Task 2).
- Produces:
  - `createWorkflowEngine({ store, definitions, host, checkpoints, runChecks, turn, now, broadcast, logger }) -> { startStep, runUntilStop }` (Tasks 10 and 13 add the rest)
  - `WorkflowError` with `code` in `unavailable | invalid | not-found | busy | conflict`
  - `host` shape: `{ createSession({ cwd }), prompt(sessionId, text), getSessionStatus(sessionId), listSessions(), renameSession(sessionId, title), setModel(sessionId, provider, modelId), setAutoAccept(sessionId, enabled, directory) }`
  - Step statuses written by this task: `running`, `waiting_confirm`, `needs_work`, `done`, `blocked`

- [ ] **Step 1: Write the failing test**

```js
// packages/web/server/lib/workflows/engine.test.js
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkflowEngine } from './engine.js';
import { createWorkflowRunStore } from './store.js';
import { parseDefinition } from './definitions.js';

const definitionText = `
id: two-step
name: Two step
version: 1
inputs:
  - name: request
    required: true
steps:
  - id: first
    prompt: "Do {{request}}"
    confirm: human
    verify:
      artifacts: ["out/*.md"]
  - id: second
    prompt: "Check it"
    session: reuse
    confirm: human
`;

const definition = parseDefinition(definitionText, { file: 'two-step.yaml' }).definition;

// One engine per test, each with its own project directory; the suite removes
// them afterwards so a run never leaves `wf-engine-*` directories behind.
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const buildEngine = async ({ overrides = {} } = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-engine-'));
  roots.push(root);
  const run = {
    runId: '11111111-2222-4333-8444-555555555555',
    projectId: 'proj-1',
    directory: root,
    workflowId: 'two-step',
    workflowVersion: 1,
    workflowHash: 'hash',
    inputs: { request: 'the thing' },
    status: 'idle',
    cursor: 'first',
    createdAt: 1,
    sandbox: 'working-tree',
    steps: (overrides.stepIds ?? ['first', 'second']).map((id) => ({ id, status: 'pending', attempts: [], checkpoint: null, note: null })),
  };
  await fs.mkdir(path.join(root, 'out'), { recursive: true });
  const store = createWorkflowRunStore({ fsPromises: fs, path, projectsDirPath: root, now: () => 42 });
  await store.create(run);

  const prompts = [];
  let created = 0;
  const host = {
    createSession: async () => ({ id: `session-${created += 1}` }),
    prompt: async (sessionId, text) => { prompts.push({ sessionId, text }); return true; },
    getSessionStatus: async () => ({ busy: false }),
    listSessions: async () => [{ id: 'session-1', cwd: root }],
    renameSession: async () => {},
    setModel: async () => {},
    setAutoAccept: async () => {},
  };
  const engine = createWorkflowEngine({
    store,
    definitions: { read: async () => definition },
    host,
    checkpoints: { write: async ({ artifacts }) => ({ at: 42, commit: 'c'.repeat(40), clean: false, artifacts }) },
    turn: async () => 'completed',
    now: () => 42,
    broadcast: () => {},
    logger: { warn: () => {}, error: () => {} },
    ...overrides,
  });
  return { engine, store, host, prompts, root, runId: run.runId, run };
};

const refusingHost = () => ({
  createSession: async () => ({ id: 'session-1' }),
  prompt: async () => null,
  getSessionStatus: async () => ({ busy: false }),
  listSessions: async () => [],
  renameSession: async () => {},
  setModel: async () => {},
  setAutoAccept: async () => {},
});

const autoDefinition = parseDefinition(`
id: two-step
name: Two step
version: 1
steps:
  - id: first
    prompt: "Write out/one.md"
    confirm: auto
    verify:
      artifacts: ["out/*.md"]
  - id: second
    prompt: "Check it"
    session: reuse
    confirm: human
`, { file: 'two-step.yaml' }).definition;

describe('startStep', () => {
  it('prompts with the substituted input, verifies, and stops for a person', async () => {
    const { engine, prompts, root, runId } = await buildEngine();
    const run = await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    expect(prompts).toEqual([{ sessionId: 'session-1', text: 'Do the thing' }]);
    const step = run.steps[0];
    expect(step.status).toBe('needs_work');
    expect(step.attempts[0]).toMatchObject({ sessionId: 'session-1', status: 'completed' });
    expect(step.attempts[0].verify.ok).toBe(false);
    expect(run.status).toBe('waiting');
    expect(run.cursor).toBe('first');
  });

  it('waits for confirmation when the verifier passed', async () => {
    const { engine, root, runId } = await buildEngine();
    await fs.writeFile(path.join(root, 'out/a.md'), 'x');
    const run = await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    expect(run.steps[0].status).toBe('waiting_confirm');
    expect(run.steps[0].attempts[0].verify.ok).toBe(true);
  });

  it('advances on its own, with a checkpoint, when confirm is auto and the verifier passed', async () => {
    const { engine, root, runId } = await buildEngine({ overrides: { definitions: { read: async () => autoDefinition } } });
    await fs.writeFile(path.join(root, 'out/a.md'), 'x');
    const run = await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    expect(run.steps[0].status).toBe('done');
    expect(run.steps[0].checkpoint).toMatchObject({ commit: 'c'.repeat(40) });
    expect(run.cursor).toBe('second');
    expect(run.status).toBe('running');
  });

  it('records a refused prompt as blocked and never as a sent one', async () => {
    const { engine, root, runId } = await buildEngine({ overrides: { host: refusingHost() } });
    const run = await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    expect(run.steps[0].status).toBe('blocked');
    expect(run.steps[0].attempts[0]).toMatchObject({ status: 'blocked' });
    expect(run.steps[0].attempts[0].error.code).toBe('unavailable');
    expect(run.status).toBe('waiting');
  });

  it('blocks a step whose declared input has no value', async () => {
    const { engine, root, runId, store, run } = await buildEngine();
    await store.write({ ...run, inputs: {} });
    const result = await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    expect(result.steps[0].status).toBe('blocked');
    expect(result.steps[0].note).toBe('missing input: request');
  });

  it('reuses the session of the previous attempt when the step says reuse', async () => {
    const { engine, root, runId, prompts } = await buildEngine();
    await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'second' });
    expect(prompts.map((entry) => entry.sessionId)).toEqual(['session-1', 'session-1']);
  });

  it('refuses a second start while the first is still running', async () => {
    // The turn waits on a gate the test opens at the end, so nothing outlives the
    // test and the temp directory is not removed under a live attempt.
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const { engine, root, runId } = await buildEngine({ overrides: { turn: async () => { await gate; return 'completed'; } } });
    const first = engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    await expect(engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' }))
      .rejects.toMatchObject({ code: 'busy' });
    release();
    await first;
  });

  it('broadcasts the running step, because the request answers only after the turn', async () => {
    const frames = [];
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    let sawFrame = () => {};
    const anyFrame = new Promise((resolve) => { sawFrame = resolve; });
    const { engine, root, runId } = await buildEngine({
      overrides: {
        broadcast: (frame) => { frames.push(frame); sawFrame(); },
        turn: async () => { await gate; return 'completed'; },
      },
    });
    const first = engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    // The turn stays gated until `release`, so a frame showing the step running
    // can only exist if the engine broadcast it before waiting on the turn. The
    // wait is a race rather than one macrotask because `store.write` is async.
    await Promise.race([anyFrame, new Promise((resolve) => setTimeout(resolve, 1000))]);
    expect(frames.some((frame) => frame.properties.steps.some((step) => step.id === 'first' && step.status === 'running'))).toBe(true);
    release();
    await first;
  });

  it('refuses to cancel a run while a step is executing', async () => {
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const { engine, root, runId } = await buildEngine({ overrides: { turn: async () => { await gate; return 'completed'; } } });
    const first = engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    await expect(engine.cancelRun({ projectId: 'proj-1', runId }))
      .rejects.toMatchObject({ code: 'busy' });
    release();
    await first;
  });

  it('refuses to confirm a step whose attempt never finished', async () => {
    const { engine, store, run, runId } = await buildEngine();
    await store.write({
      ...run,
      steps: run.steps.map((step) => (step.id === 'first'
        ? { ...step, status: 'blocked', attempts: [{ index: 0, sessionId: 'session-1', prompt: 'x', startedAt: 1, endedAt: null, status: 'blocked', turn: null, verify: { ok: true, artifacts: [], commands: [] }, error: { code: 'unavailable', message: 'no' } }] }
        : step)),
    });
    // The verdict is deliberately a pass, so a passing verifier cannot be the
    // reason the answer is refused: the unfinished attempt itself must be.
    await expect(engine.confirmStep({ projectId: 'proj-1', runId, stepId: 'first', decision: 'done' }))
      .rejects.toMatchObject({ code: 'conflict' });
  });

  it('answers not-found for a step the definition does not declare', async () => {
    const { engine, root, runId } = await buildEngine();
    await expect(engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'nope' }))
      .rejects.toMatchObject({ code: 'not-found' });
  });

  it('answers not-found for a run that is not on disk', async () => {
    const { engine, root } = await buildEngine();
    await expect(engine.startStep({ projectId: 'proj-1', projectPath: root, runId: '99999999-2222-4333-8444-555555555555', stepId: 'first' }))
      .rejects.toMatchObject({ code: 'not-found' });
  });

  it('continues the nearest preceding session, not the first one the run opened', async () => {
    const threeSteps = parseDefinition(`
id: two-step
name: Two step
version: 1
steps:
  - id: first
    prompt: "one"
    confirm: human
  - id: second
    prompt: "two"
    session: new
    confirm: human
  - id: third
    prompt: "three"
    session: reuse
    confirm: human
`, { file: 'two-step.yaml' }).definition;
    const { engine, root, runId, prompts } = await buildEngine({
      overrides: { definitions: { read: async () => threeSteps }, stepIds: ['first', 'second', 'third'] },
    });
    await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'second' });
    await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'third' });
    expect(prompts.map((entry) => entry.sessionId)).toEqual(['session-1', 'session-2', 'session-2']);
  });

  it('does not call a run done while a step behind the cursor still owes work', async () => {
    const autoLast = parseDefinition(`
id: two-step
name: Two step
version: 1
steps:
  - id: first
    prompt: "one"
    confirm: human
  - id: second
    prompt: "two"
    confirm: auto
    verify:
      artifacts: ["out/*.md"]
`, { file: 'two-step.yaml' }).definition;
    const { engine, root, runId } = await buildEngine({ overrides: { definitions: { read: async () => autoLast } } });
    await fs.writeFile(path.join(root, 'out/a.md'), 'x');
    const run = await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'second' });
    expect(run.steps[1].status).toBe('done');
    expect(run.cursor).toBeNull();
    // `first` never ran, so the run is waiting on it, not finished.
    expect(run.status).toBe('waiting');
  });

  it('returns a run that is already stopped instead of prompting its step again', async () => {
    const { engine, root, runId, prompts } = await buildEngine();
    await fs.writeFile(path.join(root, 'out/a.md'), 'x');
    await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    const before = prompts.length;
    const run = await engine.runUntilStop({ projectId: 'proj-1', projectPath: root, runId });
    expect(prompts.length).toBe(before);
    expect(run.steps[0].status).toBe('waiting_confirm');
    expect(run.steps[0].attempts).toHaveLength(1);
    expect(run.status).toBe('waiting');
  });
});
```

`buildEngine` returns `{ engine, store, host, prompts, root, runId, run }` so the missing-input test can write a run with no input values.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd packages/web test -- server/lib/workflows/engine.test.js`
Expected: FAIL, `Failed to resolve import "./engine.js"`.

- [ ] **Step 3: Write the implementation**

```js
// packages/web/server/lib/workflows/engine.js
/**
 * The run loop.
 *
 * One attempt is: create or adopt a session, send the prompt, wait for the turn
 * to end, run the verifiers, then stop for a person or advance. Every fact the
 * engine records comes from the runtime, from disk, or from git; a step never
 * advances because a model said it was done.
 *
 * Two writers are impossible by construction: an in-flight map holds the project
 * ids currently executing, and `runUntilStop` stops at the first stop, so a
 * second click answers `busy` instead of starting a second attempt.
 */
import { substituteInputs } from './prompts.js';
import { runVerifiers } from './verifiers.js';

export class WorkflowError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
    this.status = status ?? (code === 'not-found' ? 404 : code === 'busy' || code === 'conflict' ? 409 : code === 'unavailable' ? 503 : 400);
  }
}

const TERMINAL_RUN_STATUSES = new Set(['done', 'failed', 'cancelled']);
const STOPS = new Set(['waiting_confirm', 'needs_work', 'blocked', 'failed', 'interrupted']);

/**
 * The session a `session: reuse` step continues: the nearest preceding attempt
 * that has one, starting from this step's own last attempt. Walking the steps
 * from the front would hand a later step the first session the run ever opened,
 * which is not "the previous attempt".
 */
const previousSessionId = (run, stepId) => {
  const index = run.steps.findIndex((step) => step.id === stepId);
  if (index < 0) return null;
  for (let position = index; position >= 0; position -= 1) {
    const attempts = run.steps[position].attempts;
    for (let attempt = attempts.length - 1; attempt >= 0; attempt -= 1) {
      if (attempts[attempt].sessionId) return attempts[attempt].sessionId;
    }
  }
  return null;
};

/** Step statuses that still owe the run something before it can be called done. */
const OPEN_STEP_STATUSES = new Set(['pending', 'running', 'waiting_confirm', 'needs_work', 'blocked', 'interrupted']);

const hasOpenWork = (run) => run.steps.some((step) => OPEN_STEP_STATUSES.has(step.status));

export const createWorkflowEngine = ({
  store,
  definitions,
  host,
  checkpoints,
  runChecks = runVerifiers,
  turn,
  now = Date.now,
  broadcast = () => {},
  logger = console,
}) => {
  const requireHost = () => {
    if (!host) throw new WorkflowError('unavailable', 'the OMP runtime is not available');
    return host;
  };

  const emit = (run) => {
    try {
      broadcast({ type: 'openchamber:workflow', properties: { runId: run.runId, projectId: run.projectId, status: run.status, cursor: run.cursor, steps: run.steps.map((step) => ({ id: step.id, status: step.status })) } });
    } catch (error) {
      logger.warn?.('[workflows] broadcast failed', error?.message ?? error);
    }
  };

  const inFlight = new Set();

  const loadRun = async (projectId, runId) => {
    const run = await store.read(projectId, runId);
    if (!run) throw new WorkflowError('not-found', `run ${runId} was not found`, 404);
    return run;
  };

  const loadStepDefinition = async (projectId, run) => {
    const definition = await definitions.read(projectId, run.workflowId);
    if (!definition) throw new WorkflowError('not-found', `workflow ${run.workflowId} is missing or invalid`, 404);
    return definition;
  };

  const findStep = (run, stepId) => {
    const step = run.steps.find((entry) => entry.id === stepId);
    if (!step) throw new WorkflowError('not-found', `step ${stepId} is not part of the run`, 404);
    return step;
  };

  const attemptStep = async ({ projectId, projectPath, runId, stepId }) => {
    const run = await loadRun(projectId, runId);
    const definition = await loadStepDefinition(projectId, run);
    const declared = definition.steps.find((entry) => entry.id === stepId);
    if (!declared) throw new WorkflowError('not-found', `step ${stepId} is not declared by ${run.workflowId}`, 404);
    const step = findStep(run, stepId);

    const { text, missing } = substituteInputs(declared.prompt, run.inputs ?? {});
    if (missing.length > 0) {
      step.status = 'blocked';
      step.note = `missing input: ${missing.join(', ')}`;
      // A blocked step waits on a person, so the run is waiting, never running:
      // the screens and the resume path both read that status.
      run.status = 'waiting';
      const saved = await store.write(run);
      emit(saved);
      return saved;
    }

    const bus = requireHost();
    let sessionId = declared.session === 'reuse' ? previousSessionId(run, stepId) : null;
    if (!sessionId) {
      const created = await bus.createSession({ cwd: projectPath });
      sessionId = created?.id;
      if (!sessionId) throw new WorkflowError('unavailable', 'the runtime created no session');
      try {
        await bus.renameSession(sessionId, `${run.workflowId} ${stepId}`);
      } catch (error) {
        logger.warn?.('[workflows] could not rename the step session', error?.message ?? error);
      }
    }
    if (declared.permissions === 'auto') {
      try {
        await bus.setAutoAccept(sessionId, true, projectPath);
      } catch (error) {
        logger.warn?.('[workflows] could not enable permission auto-accept', error?.message ?? error);
      }
    }

    const attempt = { index: step.attempts.length, sessionId, prompt: text, startedAt: now(), endedAt: null, status: 'running', turn: null, verify: null, error: null };
    step.attempts.push(attempt);
    step.status = 'running';
    run.status = 'running';
    run.cursor = stepId;
    await store.write(run);
    emit(run);

    const accepted = await bus.prompt(sessionId, text);
    if (accepted !== true) {
      attempt.status = 'blocked';
      attempt.endedAt = now();
      attempt.error = {
        code: 'unavailable',
        message: accepted === null ? 'the OMP runtime went away before it could take the prompt' : 'the OMP runtime did not take the prompt',
      };
      step.status = 'blocked';
      step.note = attempt.error.message;
      run.status = 'waiting';
      const saved = await store.write(run);
      emit(saved);
      return saved;
    }

    const outcome = await turn({ host: bus, sessionId });
    attempt.turn = outcome;
    attempt.endedAt = now();
    if (outcome !== 'completed') {
      attempt.status = 'blocked';
      attempt.error = { code: 'unavailable', message: outcome === 'timeout' ? 'the turn did not finish before the timeout' : 'the runtime never reported the turn as running' };
      step.status = 'blocked';
      step.note = attempt.error.message;
      run.status = 'waiting';
      const saved = await store.write(run);
      emit(saved);
      return saved;
    }

    const verify = await runChecks({ step: declared, directory: run.directory });
    attempt.verify = verify;
    attempt.status = 'completed';
    step.note = verify.ok ? null : 'a verifier failed';

    if (declared.confirm === 'auto' && verify.ok) {
      step.status = 'done';
      step.checkpoint = await writeCheckpointFor({ run, step, attempt, verify });
      advance(run, stepId);
      // `done` means the run owes nobody anything, not merely that the cursor
      // reached the end: a step left blocked or waiting behind the cursor keeps
      // the run waiting.
      run.status = run.cursor ? 'running' : hasOpenWork(run) ? 'waiting' : 'done';
    } else if (verify.ok) {
      step.status = 'waiting_confirm';
      run.status = 'waiting';
    } else {
      step.status = 'needs_work';
      run.status = 'waiting';
    }
    const saved = await store.write(run);
    emit(saved);
    return saved;
  };

  const writeCheckpointFor = async ({ run, step, attempt, verify }) => {
    const artifacts = verify.artifacts.filter((entry) => entry.exists).map(({ path: file, size, sha256 }) => ({ path: file, size, sha256 }));
    return checkpoints.write({ directory: run.directory, runId: run.runId, stepId: step.id, attemptIndex: attempt.index, artifacts });
  };

  const advance = (run, stepId) => {
    const index = run.steps.findIndex((step) => step.id === stepId);
    const next = run.steps.slice(index + 1).find((step) => step.status === 'pending');
    run.cursor = next ? next.id : null;
  };

  /**
   * One run per project executes at a time, so the key is the project: two runs
   * of the same project would otherwise share the working tree, or two
   * worktrees' worth of steps would race on the same checkout.
   */
  const withLock = async (projectId, task) => {
    if (inFlight.has(projectId)) throw new WorkflowError('busy', 'this project already has a run executing a step', 409);
    inFlight.add(projectId);
    try {
      return await task();
    } finally {
      inFlight.delete(projectId);
    }
  };

  return {
    startStep: ({ projectId, projectPath, runId, stepId }) => withLock(projectId, () => attemptStep({ projectId, projectPath, runId, stepId })),
    runUntilStop: async ({ projectId, projectPath, runId }) => {
      const start = await loadRun(projectId, runId);
      if (TERMINAL_RUN_STATUSES.has(start.status)) throw new WorkflowError('conflict', `run ${runId} is ${start.status}`, 409);
      const firstStepId = start.cursor ?? start.steps.find((step) => step.status === 'pending')?.id;
      if (!firstStepId) throw new WorkflowError('conflict', `run ${runId} has no step left to run`, 409);
      // A run already stopped for a person is returned as it stands: running
      // until the next stop must not start a fresh turn on a step nobody has
      // answered yet.
      const cursorStep = start.steps.find((step) => step.id === firstStepId);
      if (cursorStep && STOPS.has(cursorStep.status)) return start;
      let run = await withLock(projectId, () => attemptStep({ projectId, projectPath, runId, stepId: firstStepId }));
      while (run.cursor && !STOPS.has(run.steps.find((step) => step.id === run.cursor)?.status ?? 'pending')) {
        const next = run.cursor;
        run = await withLock(projectId, () => attemptStep({ projectId, projectPath, runId, stepId: next }));
      }
      return run;
    },
  };
};
```

Task 10 adds the four decision methods to this object, and Task 13 adds `reconcile`. Nothing in this task is a stub.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run --cwd packages/web test -- server/lib/workflows/engine.test.js`
Expected: PASS, 12 tests.

- [ ] **Step 5: Syntax check and commit**

```bash
node --check packages/web/server/lib/workflows/engine.js
git add packages/web/server/lib/workflows/engine.js packages/web/server/lib/workflows/engine.test.js
git commit -m "feat(workflows): run one step, verify it, and stop for a person"
```

---

### Task 10: Engine decisions (continue, confirm, verify, cancel)

**Files:**
- Modify: `packages/web/server/lib/workflows/engine.js`
- Test: `packages/web/server/lib/workflows/engine.test.js` (add cases)

**Interfaces:**
- Consumes: Task 9's engine.
- Produces: `continueStep({ projectId, projectPath, runId, stepId, text })`, `confirmStep({ projectId, runId, stepId, decision, reason })` with `decision` in `done | not_done | skip`, `verifyStep({ projectId, projectPath, runId, stepId })`, `cancelRun({ projectId, runId })`.

- [ ] **Step 1: Write the failing test**

Add to `packages/web/server/lib/workflows/engine.test.js`:

```js
describe('confirmStep', () => {
  it('writes the checkpoint and advances on done', async () => {
    const { engine, root, runId } = await buildEngine();
    await fs.writeFile(path.join(root, 'out/a.md'), 'x');
    await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    const run = await engine.confirmStep({ projectId: 'proj-1', runId, stepId: 'first', decision: 'done' });
    expect(run.steps[0].status).toBe('done');
    expect(run.steps[0].checkpoint).toMatchObject({ commit: 'c'.repeat(40) });
    expect(run.cursor).toBe('second');
    expect(run.status).toBe('running');
  });

  it('keeps the step waiting when the answer is not_done', async () => {
    const { engine, root, runId } = await buildEngine();
    await fs.writeFile(path.join(root, 'out/a.md'), 'x');
    await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    const run = await engine.confirmStep({ projectId: 'proj-1', runId, stepId: 'first', decision: 'not_done', reason: 'the spec is thin' });
    expect(run.steps[0].status).toBe('needs_work');
    expect(run.steps[0].note).toBe('the spec is thin');
    expect(run.cursor).toBe('first');
  });

  it('skips a step and moves the cursor past it', async () => {
    const { engine, root, runId } = await buildEngine();
    const run = await engine.confirmStep({ projectId: 'proj-1', runId, stepId: 'first', decision: 'skip', reason: 'not needed' });
    expect(run.steps[0].status).toBe('skipped');
    expect(run.cursor).toBe('second');
  });

  it('refuses to confirm a step that never ran', async () => {
    const { engine, runId } = await buildEngine();
    await expect(engine.confirmStep({ projectId: 'proj-1', runId, stepId: 'second', decision: 'done' }))
      .rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('continueStep', () => {
  it('sends another prompt in the same session and counts a new attempt', async () => {
    const { engine, root, runId, prompts } = await buildEngine();
    await fs.writeFile(path.join(root, 'out/a.md'), 'x');
    await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    const run = await engine.continueStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first', text: 'tighten it' });
    expect(prompts.at(-1)).toEqual({ sessionId: 'session-1', text: 'tighten it' });
    expect(run.steps[0].attempts).toHaveLength(2);
    expect(run.steps[0].status).toBe('waiting_confirm');
  });

  it('refuses an empty prompt', async () => {
    const { engine, root, runId } = await buildEngine();
    await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    await expect(engine.continueStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first', text: '   ' }))
      .rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('cancelRun', () => {
  it('marks the run cancelled and keeps the steps as they were', async () => {
    const { engine, root, runId } = await buildEngine();
    await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    const run = await engine.cancelRun({ projectId: 'proj-1', runId });
    expect(run.status).toBe('cancelled');
    expect(run.steps[0].status).toBe('needs_work');
  });
});

describe('verifyStep', () => {
  it('re-runs the verifiers without prompting', async () => {
    const { engine, root, runId, prompts } = await buildEngine();
    await engine.startStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    const before = prompts.length;
    const run = await engine.verifyStep({ projectId: 'proj-1', projectPath: root, runId, stepId: 'first' });
    expect(prompts.length).toBe(before);
    expect(run.steps[0].attempts[0].verify.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run --cwd packages/web test -- server/lib/workflows/engine.test.js`
Expected: FAIL on the new cases with `engine.confirmStep is not a function`.

- [ ] **Step 3: Write the implementation**

Add the four decision methods to the object `engine.js` already returns, and use the injected `runChecks` and `checkpoints` directly (they are already the engine's parameters; there is no indirection to remove).

```js
    confirmStep: async ({ projectId, runId, stepId, decision, reason = null }) => {
      if (inFlight.has(projectId)) throw new WorkflowError('busy', 'this project already has a run executing a step', 409);
      const run = await loadRun(projectId, runId);
      const step = findStep(run, stepId);
      if (!['done', 'not_done', 'skip'].includes(decision)) throw new WorkflowError('invalid', `unknown decision "${decision}"`);
      if (decision === 'done') {
        const attempt = step.attempts.at(-1);
        // Only a turn that finished can be confirmed: confirming an attempt that
        // is still in flight would write a checkpoint for a half-written artifact
        // set and then be overwritten when that turn settles.
        if (!attempt || attempt.status !== 'completed') throw new WorkflowError('conflict', `step ${stepId} has no finished attempt to confirm`, 409);
        const verify = attempt.verify ?? { ok: false, artifacts: [], commands: [] };
        if (!verify.ok) throw new WorkflowError('conflict', 'a verifier is failing; answer not_done and prompt again, or skip the step', 409);
        step.checkpoint = await writeCheckpointFor({ run, step, attempt, verify });
        step.status = 'done';
        step.note = null;
        advance(run, stepId);
        run.status = run.cursor ? 'running' : hasOpenWork(run) ? 'waiting' : 'done';
      } else if (decision === 'skip') {
        step.status = 'skipped';
        step.note = reason;
        advance(run, stepId);
      } else {
        step.status = 'needs_work';
        step.note = reason ?? 'the person answered that the step is not done';
        run.status = 'waiting';
      }
      const saved = await store.write(run);
      emit(saved);
      return saved;
    },

    continueStep: async ({ projectId, projectPath, runId, stepId, text }) => {
      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (!trimmed) throw new WorkflowError('invalid', 'a continue prompt needs text');
      return withLock(projectId, async () => {
        const run = await loadRun(projectId, runId);
        const definition = await loadStepDefinition(projectId, run);
        const declared = definition.steps.find((entry) => entry.id === stepId);
        const step = findStep(run, stepId);
        const sessionId = step.attempts.at(-1)?.sessionId;
        if (!declared || !sessionId) throw new WorkflowError('conflict', `step ${stepId} has no session to continue`, 409);
        return runPromptInSession({ run, step, declared, sessionId, text: trimmed, projectPath });
      });
    },

    verifyStep: async ({ projectId, runId, stepId }) => {
      if (inFlight.has(projectId)) throw new WorkflowError('busy', 'this project already has a run executing a step', 409);
      const run = await loadRun(projectId, runId);
      const definition = await loadStepDefinition(projectId, run);
      const declared = definition.steps.find((entry) => entry.id === stepId);
      const step = findStep(run, stepId);
      const attempt = step.attempts.at(-1);
      if (!declared || !attempt) throw new WorkflowError('conflict', `step ${stepId} has not run yet`, 409);
      attempt.verify = await runChecks({ step: declared, directory: run.directory });
      step.note = attempt.verify.ok ? null : 'a verifier failed';
      const saved = await store.write(run);
      emit(saved);
      return saved;
    },

    cancelRun: async ({ projectId, runId }) => {
      // Cancelling writes the whole run, so it cannot run beside an attempt: that
      // attempt holds an older snapshot and would write it back over `cancelled`.
      // Stopping a turn that is in flight is the session's abort, not the run's.
      if (inFlight.has(projectId)) throw new WorkflowError('busy', 'a step is executing; stop its turn instead of the run', 409);
      const run = await loadRun(projectId, runId);
      run.status = 'cancelled';
      const saved = await store.write(run);
      emit(saved);
      return saved;
    },
```

Factor the shared "prompt, wait, verify, decide" body out of `attemptStep` so `runPromptInSession` can be reused for the continue prompt. In `attemptStep`, delete everything from `const verify = await runChecks(...)` to the end of the function and replace it with `return settleAttempt({ run, step, declared, attempt });`.

```js
  const settleAttempt = async ({ run, step, declared, attempt }) => {
    const verify = await runChecks({ step: declared, directory: run.directory });
    attempt.verify = verify;
    attempt.status = 'completed';
    step.note = verify.ok ? null : 'a verifier failed';
    if (declared.confirm === 'auto' && verify.ok) {
      step.status = 'done';
      step.checkpoint = await writeCheckpointFor({ run, step, attempt, verify });
      advance(run, step.id);
      run.status = run.cursor ? 'running' : hasOpenWork(run) ? 'waiting' : 'done';
    } else {
      step.status = verify.ok ? 'waiting_confirm' : 'needs_work';
      run.status = 'waiting';
    }
    const saved = await store.write(run);
    emit(saved);
    return saved;
  };
```

`runPromptInSession` sends the text into the recorded session and then calls `settleAttempt`:

```js
  const runPromptInSession = async ({ run, step, declared, sessionId, text, projectPath }) => {
    const bus = requireHost();
    if (declared.permissions === 'auto') {
      await bus.setAutoAccept?.(sessionId, true, projectPath).catch(() => undefined);
    }
    const attempt = { index: step.attempts.length, sessionId, prompt: text, startedAt: now(), endedAt: null, status: 'running', turn: null, verify: null, error: null };
    step.attempts.push(attempt);
    step.status = 'running';
    run.status = 'running';
    const started = await store.write(run);
    // The request that starts the attempt answers only when the turn is over, so
    // this frame is the only way a screen learns the step is running.
    emit(started);
    const accepted = await bus.prompt(sessionId, text);
    if (accepted !== true) {
      attempt.status = 'blocked';
      attempt.endedAt = now();
      attempt.error = { code: 'unavailable', message: 'the OMP runtime did not take the prompt' };
      step.status = 'blocked';
      step.note = attempt.error.message;
      run.status = 'waiting';
      const saved = await store.write(run);
      emit(saved);
      return saved;
    }
    const outcome = await turn({ host: bus, sessionId });
    attempt.turn = outcome;
    attempt.endedAt = now();
    if (outcome !== 'completed') {
      attempt.status = 'blocked';
      attempt.error = { code: 'unavailable', message: outcome === 'timeout' ? 'the turn did not finish before the timeout' : 'the runtime never reported the turn as running' };
      step.status = 'blocked';
      step.note = attempt.error.message;
      run.status = 'waiting';
      const saved = await store.write(run);
      emit(saved);
      return saved;
    }
    return settleAttempt({ run, step, declared, attempt });
  };
```

Use `runPromptInSession` from `attemptStep` too, so the refused-prompt and never-started paths exist in one place.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run --cwd packages/web test -- server/lib/workflows/engine.test.js`
Expected: PASS, 23 tests.

- [ ] **Step 5: Syntax check and commit**

```bash
node --check packages/web/server/lib/workflows/engine.js
git add packages/web/server/lib/workflows/engine.js packages/web/server/lib/workflows/engine.test.js
git commit -m "feat(workflows): confirm, continue, re-verify and cancel a step"
```

---

### Task 11: HTTP routes

**Files:**
- Create: `packages/web/server/lib/workflows/routes.js`
- Test: `packages/web/server/lib/workflows/routes.http.test.js`

**Interfaces:**
- Consumes: the engine (Tasks 9, 10), the store (Task 7), the definitions (Task 1).
- Produces: `registerWorkflowRoutes(app, { workflowsRuntime })`, where `workflowsRuntime` is `{ definitions, store, engine, resolveProjectId, projectPathFromId }`.

- [ ] **Step 1: Write the failing test**

```js
// packages/web/server/lib/workflows/routes.http.test.js
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { registerWorkflowRoutes } from './routes.js';

const run = { runId: '11111111-2222-4333-8444-555555555555', projectId: 'proj-1', status: 'idle', cursor: 'first', steps: [] };
const SCOPE = { 'x-opencode-directory': '/tmp/proj' };

const createApp = (overrides = {}) => {
  const calls = [];
  const runtime = {
    definitions: {
      list: async () => [{ file: 'a.yaml', id: 'a', name: 'A', version: 1, errors: [], definition: null }],
      read: async () => null,
    },
    store: {
      list: async () => [run],
      read: async () => run,
      create: async (value) => { calls.push(['create', value]); return value; },
      remove: async () => true,
    },
    engine: {
      startStep: async (value) => { calls.push(['startStep', value]); return run; },
      runUntilStop: async () => run,
      continueStep: async () => run,
      confirmStep: async (value) => { calls.push(['confirmStep', value]); return run; },
      verifyStep: async () => run,
      cancelRun: async () => run,
    },
    resolveProjectId: () => 'proj-1',
    projectPathFromId: () => '/tmp/proj',
    ...overrides,
  };
  const app = express();
  registerWorkflowRoutes(app, { workflowsRuntime: runtime });
  return { app, calls, runtime };
};

describe('workflow routes', () => {
  it('lists definitions for a project directory', async () => {
    const { app } = createApp();
    const response = await request(app).get('/api/workflows/definitions').set(SCOPE);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ definitions: [{ file: 'a.yaml', id: 'a', name: 'A', version: 1, errors: [] }] });
  });

  it('answers 400 when the project header is missing', async () => {
    const { app } = createApp();
    const response = await request(app).get('/api/workflows/definitions');
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('x-opencode-directory is required');
  });

  it('creates a run from a definition with its inputs', async () => {
    const { app, calls } = createApp({
      definitions: { list: async () => [], read: async () => ({ id: 'a', version: 3, inputs: [{ name: 'request', required: true }], steps: [{ id: 'first' }, { id: 'second' }] }) },
    });
    const response = await request(app).post('/api/workflows/runs').set(SCOPE).send({ workflowId: 'a', inputs: { request: 'x' } });
    expect(response.status).toBe(201);
    expect(calls[0][0]).toBe('create');
    expect(calls[0][1]).toMatchObject({ projectId: 'proj-1', directory: '/tmp/proj', workflowId: 'a', workflowVersion: 3, inputs: { request: 'x' }, status: 'idle', sandbox: 'working-tree' });
    expect(calls[0][1].steps.map((step) => [step.id, step.status])).toEqual([['first', 'pending'], ['second', 'pending']]);
  });

  it('refuses a run whose required input has no value', async () => {
    const { app } = createApp({
      definitions: { list: async () => [], read: async () => ({ id: 'a', version: 1, inputs: [{ name: 'request', required: true }], steps: [{ id: 'first' }] }) },
    });
    const response = await request(app).post('/api/workflows/runs').set(SCOPE).send({ workflowId: 'a' });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('input "request" is required');
  });

  it('parses a body, because there is no global json parser', async () => {
    const { app, calls } = createApp();
    const response = await request(app)
      .post('/api/workflows/runs/11111111-2222-4333-8444-555555555555/steps/first/confirm')
      .set(SCOPE)
      .send({ decision: 'done' });
    expect(response.status).toBe(200);
    expect(calls[0][1]).toMatchObject({ decision: 'done', stepId: 'first' });
  });

  it('rejects an unknown decision with 400', async () => {
    const { app } = createApp();
    const response = await request(app)
      .post('/api/workflows/runs/11111111-2222-4333-8444-555555555555/steps/first/confirm')
      .set(SCOPE)
      .send({ decision: 'maybe' });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/decision/);
  });

  it('maps an engine WorkflowError to its status and its message', async () => {
    const { app } = createApp({
      engine: {
        // This request goes to `/run`, which the routes map to `runUntilStop`.
        runUntilStop: async () => {
          const error = new Error('this run is already executing a step');
          error.code = 'busy';
          error.status = 409;
          throw error;
        },
      },
    });
    const response = await request(app).post('/api/workflows/runs/11111111-2222-4333-8444-555555555555/run').set(SCOPE).send({});
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('this run is already executing a step');
  });

  it('decodes a marked directory header, so an encoded path names the same project', async () => {
    const seen = [];
    const { app } = createApp({ resolveProjectId: (directory) => { seen.push(directory); return directory === '/tmp/proj' ? 'proj-1' : ''; } });
    const response = await request(app)
      .get('/api/workflows/definitions')
      .set({ 'x-opencode-directory': encodeURIComponent('/tmp/proj'), 'x-opencode-directory-encoding': 'uri' });
    expect(response.status).toBe(200);
    expect(seen).toEqual(['/tmp/proj']);
  });

  it('answers 400 for a run id the store would refuse', async () => {
    const { app } = createApp();
    const response = await request(app).get('/api/workflows/runs/abc').set(SCOPE);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('the run id is not valid');
  });

  it('deletes one run and answers 404 when there is none', async () => {
    const { app } = createApp();
    expect((await request(app).delete('/api/workflows/runs/11111111-2222-4333-8444-555555555555').set(SCOPE)).status).toBe(200);
    const missing = createApp({ store: { read: async () => null, remove: async () => false, list: async () => [] } });
    expect((await request(missing.app).delete('/api/workflows/runs/11111111-2222-4333-8444-555555555555').set(SCOPE)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd packages/web test -- server/lib/workflows/routes.http.test.js`
Expected: FAIL, `Failed to resolve import "./routes.js"`.

- [ ] **Step 3: Write the implementation**

```js
// packages/web/server/lib/workflows/routes.js
/**
 * Workflow routes.
 *
 * Body parsing is attached per route: the server has no global JSON parser, so a
 * handler that reads `req.body` and forgets to attach one sees `undefined` and
 * rejects every write as malformed.
 *
 * The project comes from the `x-opencode-directory` header, the same header the
 * rest of the server scopes a request by, turned into the path-derived id the
 * projects directory names its files by (`createProjectIdFromPath`) and back
 * into the checkout path that id encodes (`projectPathFromId`). A directory that
 * decodes to no path is refused, so a request cannot aim the routes at a place
 * that is not a project.
 */
import crypto from 'node:crypto';
import express from 'express';
import { isValidRunId } from './store.js';

const parseJsonBody = express.json({ limit: '1mb' });

const respondWithError = (res, error, fallback) => {
  const status = Number.isInteger(error?.status) ? error.status : error?.code === 'ENOENT' ? 404 : 500;
  return res.status(status).json({ error: error?.message ?? fallback });
};

// The browser transport percent-encodes a directory hint and marks it with
// `x-opencode-directory-encoding: uri`; only a marked value is decoded, so a
// literal percent sequence from a direct client survives untouched. Every other
// route family decodes it the same way (`lib/openchamber/project-directory-runtime.js`),
// and skipping it here resolves a different project id than the caller named.
const DIRECTORY_ENCODING_HEADER = 'x-opencode-directory-encoding';

const safeDecodeMarkedURIComponent = (value, encoding) => {
  if (encoding !== 'uri') return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const directoryOf = (req) => {
  const raw = typeof req.get('x-opencode-directory') === 'string' ? req.get('x-opencode-directory') : null;
  if (!raw) return null;
  return safeDecodeMarkedURIComponent(raw, req.get(DIRECTORY_ENCODING_HEADER));
};

export const registerWorkflowRoutes = (app, { workflowsRuntime }) => {
  const { definitions, store, engine, resolveProjectId, projectPathFromId } = workflowsRuntime;

  /**
   * The project a request acts on: the `x-opencode-directory` header, turned
   * into the same path-derived id the projects directory names its files by
   * (`createProjectIdFromPath`), and back into the checkout path that id
   * encodes. A request naming a directory that is not an open project gets no
   * scope rather than a guessed one.
   */
  const scopeOf = (req) => {
    const directory = directoryOf(req);
    if (!directory) return null;
    const projectId = resolveProjectId(directory);
    if (!projectId) return null;
    const projectPath = projectPathFromId(projectId);
    return projectPath ? { projectId, projectPath } : null;
  };

  const summary = (entry) => ({ file: entry.file, id: entry.id, name: entry.name, version: entry.version, errors: entry.errors });

  /**
   * A run id the store would refuse is the caller's mistake, so it answers 400
   * with that reason instead of letting the store's own throw become a 500.
   */
  const runIdOf = (req, res) => {
    const runId = req.params.runId;
    if (isValidRunId(runId)) return runId;
    res.status(400).json({ error: 'the run id is not valid' });
    return null;
  };

  app.get('/api/workflows/definitions', async (req, res) => {
    try {
      const scope = scopeOf(req);
      if (!scope) return res.status(400).json({ error: 'x-opencode-directory is required' });
      const list = await definitions.list(scope.projectId);
      return res.json({ definitions: list.map(summary) });
    } catch (error) {
      return respondWithError(res, error, 'Failed to list workflow definitions');
    }
  });

  app.get('/api/workflows/runs', async (req, res) => {
    try {
      const scope = scopeOf(req);
      if (!scope) return res.status(400).json({ error: 'x-opencode-directory is required' });
      return res.json({ runs: await store.list(scope.projectId) });
    } catch (error) {
      return respondWithError(res, error, 'Failed to list workflow runs');
    }
  });

  app.post('/api/workflows/runs', parseJsonBody, async (req, res) => {
    try {
      const scope = scopeOf(req);
      if (!scope) return res.status(400).json({ error: 'x-opencode-directory is required' });
      const workflowId = req.body?.workflowId;
      const definition = await definitions.read(scope.projectId, workflowId);
      if (!definition) return res.status(404).json({ error: `workflow "${workflowId}" is missing or invalid` });

      const inputs = {};
      for (const input of definition.inputs) {
        const value = req.body?.inputs?.[input.name];
        if (typeof value === 'string' && value.trim()) inputs[input.name] = value;
        else if (input.required) return res.status(400).json({ error: `input "${input.name}" is required` });
      }

      const run = {
        runId: crypto.randomUUID(),
        projectId: scope.projectId,
        directory: scope.projectPath,
        workflowId: definition.id,
        workflowVersion: definition.version,
        workflowHash: crypto.createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
        inputs,
        status: 'idle',
        cursor: definition.steps[0].id,
        sandbox: 'working-tree',
        steps: definition.steps.map((step) => ({ id: step.id, status: 'pending', attempts: [], checkpoint: null, note: null })),
      };
      return res.status(201).json({ run: await store.create(run) });
    } catch (error) {
      return respondWithError(res, error, 'Failed to create the workflow run');
    }
  });

  app.get('/api/workflows/runs/:runId', async (req, res) => {
    try {
      const scope = scopeOf(req);
      if (!scope) return res.status(400).json({ error: 'x-opencode-directory is required' });
      const runId = runIdOf(req, res);
      if (!runId) return undefined;
      const run = await store.read(scope.projectId, runId);
      if (!run) return res.status(404).json({ error: `run ${runId} was not found` });
      return res.json({ run });
    } catch (error) {
      return respondWithError(res, error, 'Failed to read the workflow run');
    }
  });

  const withProject = (handler) => async (req, res) => {
    try {
      const scope = scopeOf(req);
      if (!scope) return res.status(400).json({ error: 'x-opencode-directory is required' });
      const run = await handler({ ...scope, req }, res);
      // A handler that already answered (a bad run id) must not answer twice.
      if (run === undefined) return undefined;
      return res.json({ run });
    } catch (error) {
      return respondWithError(res, error, 'The workflow run could not be advanced');
    }
  };

  app.post('/api/workflows/runs/:runId/run', parseJsonBody, withProject(({ projectId, projectPath, req }, res) => {
    const runId = runIdOf(req, res);
    return runId ? engine.runUntilStop({ projectId, projectPath, runId }) : undefined;
  }));

  app.post('/api/workflows/runs/:runId/cancel', parseJsonBody, withProject(({ projectId, req }, res) => {
    const runId = runIdOf(req, res);
    return runId ? engine.cancelRun({ projectId, runId }) : undefined;
  }));

  app.post('/api/workflows/runs/:runId/steps/:stepId/run', parseJsonBody, withProject(({ projectId, projectPath, req }, res) => {
    const runId = runIdOf(req, res);
    return runId ? engine.startStep({ projectId, projectPath, runId, stepId: req.params.stepId }) : undefined;
  }));

  app.post('/api/workflows/runs/:runId/steps/:stepId/verify', parseJsonBody, withProject(({ projectId, projectPath, req }, res) => {
    const runId = runIdOf(req, res);
    return runId ? engine.verifyStep({ projectId, projectPath, runId, stepId: req.params.stepId }) : undefined;
  }));

  app.post('/api/workflows/runs/:runId/steps/:stepId/prompt', parseJsonBody, withProject(({ projectId, projectPath, req }, res) => {
    const runId = runIdOf(req, res);
    if (!runId) return undefined;
    const text = req.body?.text;
    if (typeof text !== 'string' || !text.trim()) {
      const error = new Error('prompt text is required');
      error.status = 400;
      throw error;
    }
    return engine.continueStep({ projectId, projectPath, runId, stepId: req.params.stepId, text });
  }));

  app.post('/api/workflows/runs/:runId/steps/:stepId/confirm', parseJsonBody, withProject(({ projectId, req }, res) => {
    const runId = runIdOf(req, res);
    if (!runId) return undefined;
    const decision = req.body?.decision;
    if (!['done', 'not_done', 'skip'].includes(decision)) {
      const error = new Error('decision must be done, not_done or skip');
      error.status = 400;
      throw error;
    }
    return engine.confirmStep({ projectId, runId, stepId: req.params.stepId, decision, reason: req.body?.reason ?? null });
  }));

  app.delete('/api/workflows/runs/:runId', async (req, res) => {
    try {
      const scope = scopeOf(req);
      if (!scope) return res.status(400).json({ error: 'x-opencode-directory is required' });
      const runId = runIdOf(req, res);
      if (!runId) return undefined;
      const removed = await store.remove(scope.projectId, runId);
      if (!removed) return res.status(404).json({ error: `run ${runId} was not found` });
      return res.json({ removed: true });
    } catch (error) {
      return respondWithError(res, error, 'Failed to delete the workflow run');
    }
  });
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run --cwd packages/web test -- server/lib/workflows/routes.http.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Syntax check and commit**

```bash
node --check packages/web/server/lib/workflows/routes.js
git add packages/web/server/lib/workflows/routes.js packages/web/server/lib/workflows/routes.http.test.js
git commit -m "feat(workflows): serve the workflow routes"
```

---

### Task 12: Wiring, and a real run against the OMP binary

**Files:**
- Create: `packages/web/server/lib/workflows/runtime.js`
- Modify: `packages/web/server/index.js` (build the runtime before `createFeatureRoutesRuntime`, pass it in the `registerRoutes` deps)
- Modify: `packages/web/server/lib/openchamber/feature-routes-runtime.js` (call `registerWorkflowRoutes`)

**Interfaces:**
- Consumes: every module from Tasks 1 to 11.
- Produces: `createWorkflowRuntime({ projectsDirPath, projectPathFromId, resolveProjectId, getOmpRuntimeHost, setSessionAutoAccept, git, broadcast, logger })` returning `{ definitions, store, checkpoints, engine, resolveProjectId, projectPathFromId, routes: registerWorkflowRoutes }`.

- [ ] **Step 1: Write the failing test**

```js
// packages/web/server/lib/workflows/runtime.test.js
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorkflowRuntime } from './runtime.js';

const createRuntime = async (overrides = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-runtime-'));
  return createWorkflowRuntime({
    projectsDirPath: root,
    projectPathFromId: () => root,
    resolveProjectId: () => 'proj-1',
    getOmpRuntimeHost: async () => null,
    setSessionAutoAccept: async () => {},
    broadcast: () => {},
    logger: { warn: () => {} },
    ...overrides,
  });
};

describe('createWorkflowRuntime', () => {
  it('exposes the modules the routes need', async () => {
    const runtime = await createRuntime();
    expect(typeof runtime.definitions.list).toBe('function');
    expect(typeof runtime.store.read).toBe('function');
    expect(typeof runtime.engine.startStep).toBe('function');
    expect(runtime.resolveProjectId('/tmp/proj')).toBe('proj-1');
  });

  it('answers unavailable when the runtime is not mounted, instead of prompting nothing', async () => {
    const runtime = await createRuntime();
    const projectPath = runtime.projectPathFromId('proj-1');
    await runtime.store.create({
      runId: '11111111-2222-4333-8444-555555555555',
      projectId: 'proj-1',
      directory: projectPath,
      workflowId: 'a',
      workflowVersion: 1,
      workflowHash: 'h',
      inputs: {},
      status: 'idle',
      cursor: 'first',
      sandbox: 'working-tree',
      createdAt: 1,
      steps: [{ id: 'first', status: 'pending', attempts: [], checkpoint: null, note: null }],
    });
    await expect(runtime.engine.startStep({
      projectId: 'proj-1',
      projectPath,
      runId: '11111111-2222-4333-8444-555555555555',
      stepId: 'first',
    })).rejects.toThrow(/not available/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd packages/web test -- server/lib/workflows/runtime.test.js`
Expected: FAIL, `Failed to resolve import "./runtime.js"`.

- [ ] **Step 3: Write the implementation**

```js
// packages/web/server/lib/workflows/runtime.js
/**
 * Wires the workflow modules for the server.
 *
 * The host and the auto-accept toggle are read per call, because the OMP
 * runtime is mounted after the routes register. A call that arrives before the
 * runtime exists answers `unavailable`; it never falls back to a no-op prompt.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createWorkflowDefinitions } from './definitions.js';
import { createWorkflowRunStore } from './store.js';
import { createWorkflowEngine, WorkflowError } from './engine.js';
import { createCheckpointWriter, createGitDriver } from './git-checkpoint.js';
import { runVerifiers } from './verifiers.js';
import { waitForTurnEnd } from './turn.js';
import { registerWorkflowRoutes } from './routes.js';

export const createWorkflowRuntime = ({
  projectsDirPath,
  projectPathFromId,
  resolveProjectId,
  getOmpRuntimeHost,
  setSessionAutoAccept,
  broadcast = () => {},
  logger = console,
  git = createGitDriver(),
  now = Date.now,
}) => {
  const definitions = createWorkflowDefinitions({ fsPromises: fs, path, projectPathFromId });
  const store = createWorkflowRunStore({ fsPromises: fs, path, projectsDirPath, now });
  const checkpoints = createCheckpointWriter({ git, now });

  const host = {
    createSession: async (params) => (await requireHost()).createSession(params),
    prompt: async (sessionId, text) => (await requireHost()).prompt(sessionId, text),
    getSessionStatus: async (sessionId) => (await requireHost()).getSessionStatus(sessionId),
    listSessions: async () => (await requireHost()).listSessions(),
    renameSession: async (sessionId, title) => (await requireHost()).renameSession(sessionId, title),
    setModel: async (sessionId, provider, modelId) => (await requireHost()).setModel(sessionId, provider, modelId),
    setAutoAccept: async (sessionId, enabled, directory) => setSessionAutoAccept?.(sessionId, enabled, directory),
  };

  const requireHost = async () => {
    const mounted = await getOmpRuntimeHost();
    if (!mounted) throw new WorkflowError('unavailable', 'the OMP runtime is not available', 503);
    return mounted;
  };

  const engine = createWorkflowEngine({
    store,
    definitions,
    host,
    checkpoints,
    runChecks: ({ step, directory }) => runVerifiers({ step, directory }),
    turn: ({ host: sessionHost, sessionId }) => waitForTurnEnd({ host: sessionHost, sessionId }),
    now,
    broadcast,
    logger,
  });

  return {
    definitions,
    store,
    checkpoints,
    engine,
    resolveProjectId,
    projectPathFromId,
    routes: registerWorkflowRoutes,
  };
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run --cwd packages/web test -- server/lib/workflows/runtime.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 5: Wire it into the server**

In `packages/web/server/index.js`, before `createFeatureRoutesRuntime({...})`:

```js
const workflowRuntime = createWorkflowRuntime({
  projectsDirPath: OPENCHAMBER_PROJECTS_CONFIG_DIR,
  projectPathFromId,
  resolveProjectId: createProjectIdFromPath,
  getOmpRuntimeHost: async () => {
    const host = ompAgentRuntime?.getHost?.();
    return host ? await host : null;
  },
  setSessionAutoAccept: (sessionId, enabled, directory) => permissionAutoAcceptRuntime.setSessionPolicy(sessionId, enabled, directory),
  broadcast: broadcastOpenChamberUiEvent,
  logger: console,
});
```

with these imports at the top of `index.js`, next to the existing ones:

```js
import { createWorkflowRuntime } from './lib/workflows/runtime.js';
import { createProjectIdFromPath, projectPathFromId } from './lib/projects/project-id.js';
```

Then pass `workflowRuntime,` into the `featureRoutesRuntime.registerRoutes(app, {...})` dependency object, next to `scheduledTasksRuntime`.

In `packages/web/server/lib/openchamber/feature-routes-runtime.js`, add the import and the install next to the scheduled-task routes. Destructure `workflowRuntime` in the `routeDependencies` list at `feature-routes-runtime.js:94-137` (next to `scheduledTasksRuntime`), and register:

```js
import { registerWorkflowRoutes } from '../workflows/routes.js';
...
    registerScheduledTaskRoutes(app, { ... });
    registerWorkflowRoutes(app, { workflowsRuntime: workflowRuntime });
```

- [ ] **Step 6: Syntax check the wire**

```bash
node --check packages/web/server/index.js
node --check packages/web/server/lib/openchamber/feature-routes-runtime.js
bun run --cwd packages/web test -- server/lib/workflows
```

Expected: every workflow test file PASS.

- [ ] **Step 7: Smoke it against the real OMP binary**

Create a throwaway project and definition (do not commit either):

```bash
sh -c '
set -e
SMOKE="$(mktemp -d /tmp/wf-smoke-XXXXXX)"
cd "$SMOKE"
git init -q -b main
git config user.email smoke@example.com && git config user.name Smoke
mkdir -p .openchamber/workflows out
cat > .openchamber/workflows/two-step.yaml <<YAML
id: two-step
name: Two step smoke
version: 1
steps:
  - id: write
    title: Write a file
    prompt: "Create out/one.md containing the single word one. Do nothing else."
    confirm: human
    verify:
      artifacts:
        - glob: "out/*.md"
          hash: true
  - id: check
    title: Check the file
    prompt: "Read out/one.md and reply with its contents."
    session: reuse
    confirm: human
YAML
git add -A && git commit -q -m "smoke setup"
echo "$SMOKE"
'
```

Then, in another shell, start the server against that directory (`bun packages/web/server/index.js --port 4199`) and drive the routes with the real runtime:

```bash
DIR="$SMOKE"
H="x-opencode-directory: $DIR"
curl -s -X POST localhost:4199/api/workflows/runs -H "$H" -H 'content-type: application/json' \
  -d '{"workflowId":"two-step"}' | tee /tmp/wf-run.json
RUN=$(python3 -c "import json;print(json.load(open('/tmp/wf-run.json'))['run']['runId'])")
curl -s -X POST "localhost:4199/api/workflows/runs/$RUN/steps/write/run" -H "$H" -H 'content-type: application/json' -d '{}' \
  | python3 -m json.tool | head -60
```

Observed result, in the run file and in the response: step `write` is `waiting_confirm`, `attempts[0].verify.ok` is `true` with the hash of the file the model wrote, and the session id is recorded. Then:

```bash
curl -s -X POST "localhost:4199/api/workflows/runs/$RUN/steps/write/confirm" -H "$H" -H 'content-type: application/json' -d '{"decision":"done"}'
curl -s -X POST "localhost:4199/api/workflows/runs/$RUN/run" -H "$H" -H 'content-type: application/json' -d '{}'
git -C "$DIR" log --oneline
```

Observed result: the confirm response shows `steps[0].status` `done` with a `checkpoint.commit`, the run cursor moved to `check`, that step reached `waiting_confirm` on the same session id, and `git log` shows the checkpoint commit whose subject carries `[run=... step=write attempt=0]`.

If the model refuses to write the file, that is a step that lands in `needs_work` with the verifier output recorded. Do not edit the run file by hand to make the smoke pass; report what happened instead.

- [ ] **Step 8: Commit**

```bash
git add packages/web/server/lib/workflows/runtime.js packages/web/server/lib/workflows/runtime.test.js \
  packages/web/server/index.js packages/web/server/lib/openchamber/feature-routes-runtime.js
git commit -m "feat(workflows): wire the workflow runtime into the server"
```

---

### Task 13: Resume from evidence

**Files:**
- Create: `packages/web/server/lib/workflows/resume.js`
- Modify: `packages/web/server/lib/workflows/engine.js` (`reconcile`)
- Test: `packages/web/server/lib/workflows/resume.test.js`

**Interfaces:**
- Consumes: store (Task 7), verifiers (Task 5), the host from Task 12.
- Produces:
  - `reconcileRuns({ store, definitions, host, verifyCheckpoint, projectsDirPath, listProjectIds, logger }) -> Promise<{ runs, interrupted, blocked, waiting }>`
  - `engine.reconcile()` delegates to it.

- [ ] **Step 1: Write the failing test**

```js
// packages/web/server/lib/workflows/resume.test.js
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { reconcileRuns } from './resume.js';
import { createWorkflowRunStore } from './store.js';

let root;
let store;

const baseRun = (overrides = {}) => ({
  runId: '11111111-2222-4333-8444-555555555555',
  projectId: 'proj-1',
  directory: '/tmp/proj',
  workflowId: 'two-step',
  workflowVersion: 1,
  workflowHash: 'hash',
  inputs: {},
  status: 'running',
  cursor: 'second',
  createdAt: 1,
  sandbox: 'working-tree',
  steps: [
    { id: 'first', status: 'done', attempts: [{ index: 0, sessionId: 'session-1', status: 'completed' }], checkpoint: { at: 1, commit: 'a'.repeat(40), clean: false, artifacts: [] }, note: null },
    { id: 'second', status: 'running', attempts: [{ index: 0, sessionId: 'session-9', status: 'running' }], checkpoint: null, note: null },
  ],
  ...overrides,
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-resume-'));
  store = createWorkflowRunStore({ fsPromises: fs, path, projectsDirPath: root, now: () => 42 });
});

const deps = (overrides = {}) => ({
  store,
  definitions: { read: async () => ({ id: 'two-step', steps: [{ id: 'first' }, { id: 'second' }] }) },
  host: { getSessionStatus: async () => ({ busy: false }), listSessions: async () => [{ id: 'session-9' }] },
  verifyCheckpoint: async () => ({ ok: true, mismatches: [] }),
  listProjectIds: async () => ['proj-1'],
  logger: { warn: () => {} },
  ...overrides,
});

describe('reconcileRuns', () => {
  it('marks a step that was running when the server stopped as interrupted', async () => {
    await store.create(baseRun());
    const summary = await reconcileRuns(deps());
    const run = await store.read('proj-1', baseRun().runId);
    expect(summary.interrupted).toBe(1);
    expect(run.steps[1].status).toBe('interrupted');
    expect(run.status).toBe('waiting');
  });

  it('blocks the run when a checkpoint no longer matches', async () => {
    await store.create(baseRun());
    const summary = await reconcileRuns(deps({ verifyCheckpoint: async () => ({ ok: false, mismatches: [{ path: 'a.md', reason: 'changed' }] }) }));
    const run = await store.read('proj-1', baseRun().runId);
    expect(summary.blocked).toBe(1);
    expect(run.status).toBe('waiting');
    expect(run.steps[0].status).toBe('done');
    expect(run.steps[0].note).toMatch(/a\.md \(changed\)/);
    expect(run.cursor).toBe('first');
  });

  it('leaves a run alone when its session is gone', async () => {
    await store.create(baseRun());
    const summary = await reconcileRuns(deps({ host: { getSessionStatus: async () => ({ busy: false }), listSessions: async () => [] } }));
    const run = await store.read('proj-1', baseRun().runId);
    expect(summary.blocked).toBe(1);
    expect(run.steps[1].status).toBe('interrupted');
    expect(run.steps[1].note).toMatch(/session .* is no longer known/);
  });

  it('leaves a finished run untouched', async () => {
    await store.create(baseRun({ status: 'done', steps: [{ id: 'first', status: 'done', attempts: [], checkpoint: null, note: null }, { id: 'second', status: 'done', attempts: [], checkpoint: null, note: null }] }));
    const summary = await reconcileRuns(deps());
    expect(summary).toMatchObject({ runs: 0, interrupted: 0, blocked: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd packages/web test -- server/lib/workflows/resume.test.js`
Expected: FAIL, `Failed to resolve import "./resume.js"`.

- [ ] **Step 3: Write the implementation**

```js
// packages/web/server/lib/workflows/resume.js
/**
 * What a restart means for the runs on disk.
 *
 * The run file is an index, not the record: sessions belong to OMP, artifacts
 * belong to the project, and commits belong to git. Every one of them is
 * re-checked here, and anything uncertain is reported instead of assumed. A
 * step that was running when the server stopped becomes `interrupted`, because
 * the engine cannot tell a finished turn from a turn that never returned.
 */
const ACTIVE = new Set(['running', 'waiting']);

export const reconcileRuns = async ({ store, host, verifyCheckpoint, listProjectIds, logger = console }) => {
  const summary = { runs: 0, interrupted: 0, blocked: 0, waiting: 0 };
  const projectIds = await listProjectIds();
  const sessions = await host.listSessions().catch(() => null);

  for (const projectId of projectIds) {
    const runs = await store.list(projectId);
    for (const run of runs) {
      if (!ACTIVE.has(run.status)) continue;
      summary.runs += 1;
      let changed = false;
      const knownSessions = sessions === null ? null : new Set(sessions.map((entry) => entry.id));

      for (const step of run.steps) {
        if (step.status === 'running') {
          step.status = 'interrupted';
          step.note = 'the server stopped while this step was running';
          summary.interrupted += 1;
          changed = true;
        }
        if (step.checkpoint) {
          const check = await verifyCheckpoint({ checkpoint: step.checkpoint, directory: run.directory });
          if (!check.ok) {
            const details = check.mismatches.map((entry) => `${entry.path} (${entry.reason})`).join(', ');
            step.note = `checkpoint no longer matches: ${details}`;
            run.status = 'waiting';
            run.cursor = step.id;
            summary.blocked += 1;
            changed = true;
            logger.warn?.(`[workflows] run ${run.runId}: ${step.note}`);
          }
        }
        const attempt = step.attempts.at(-1);
        if (attempt?.sessionId && knownSessions && !knownSessions.has(attempt.sessionId)) {
          attempt.status = 'blocked';
          attempt.error = { code: 'unavailable', message: `session ${attempt.sessionId} is no longer known` };
          if (step.status === 'running' || step.status === 'interrupted') step.status = 'interrupted';
          step.note = `session ${attempt.sessionId} is no longer known`;
          run.status = 'waiting';
          run.cursor = step.id;
          summary.blocked += 1;
          changed = true;
        }
      }

      if (changed) {
        if (run.status === 'running') {
          run.status = 'waiting';
          run.cursor = run.cursor ?? run.steps.find((step) => step.status !== 'done' && step.status !== 'skipped')?.id ?? null;
          summary.waiting += 1;
        }
        await store.write(run);
      }
    }
  }
  return summary;
};
```

Then in `engine.js`, add `reconcileRuns = defaultReconcile`, `listProjectIds`, and `verifyCheckpoint = defaultVerifyCheckpoint` to the engine's parameters (imported from `./resume.js` and `./verifiers.js`), and add the method to the returned object:

```js
import { reconcileRuns as defaultReconcile } from './resume.js';
import { runVerifiers as defaultRunChecks, verifyCheckpoint as defaultVerifyCheckpoint } from './verifiers.js';
...
  return {
    startStep: ...,
    runUntilStop: ...,
    continueStep: ...,
    confirmStep: ...,
    verifyStep: ...,
    cancelRun: ...,
    reconcile: () => reconcileRuns({
      store,
      host: requireHost(),
      verifyCheckpoint,
      listProjectIds,
      logger,
    }),
  };
```

`listProjectIds` has no default: it is what tells the engine which projects to sweep, and a default that guessed would read every directory under the projects root.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run --cwd packages/web test -- server/lib/workflows/resume.test.js server/lib/workflows/engine.test.js`
Expected: PASS.

- [ ] **Step 5: Wire the reconciliation and run it at boot**

Add `listProjectIds` to `createWorkflowRuntime` and pass it to the engine, then call `reconcile()` once the server is up:

```js
// runtime.js: the projects the sweep walks, from the same settings the rest of
// the server reads
const engine = createWorkflowEngine({
  ...,
  listProjectIds,
  reconcileRuns,
  ...
});
```

```js
// index.js, next to the workflow runtime construction
const workflowRuntime = createWorkflowRuntime({
  ...,
  listProjectIds: async () => {
    const settings = await readSettingsFromDiskMigrated();
    return sanitizeProjects(settings?.projects || []).map((project) => project.projectId).filter(Boolean);
  },
});

// after the runtime is mounted, so sessions exist to look up
void workflowRuntime.engine.reconcile()
  .then((summary) => { if (summary.runs > 0) console.log('[workflows] reconciled runs', summary); })
  .catch((error) => console.warn('[workflows] reconciliation failed:', error?.message ?? error));
```

Check the exact field names of a project entry in `sanitizeProjects` output before writing the `map`; if there is no id field, use `createProjectIdFromPath(project.path)`. The reconciliation is not allowed to keep the server from starting: it runs after listen and logs its failure.

- [ ] **Step 6: Syntax check and commit**

```bash
node --check packages/web/server/lib/workflows/resume.js
node --check packages/web/server/lib/workflows/engine.js
node --check packages/web/server/lib/workflows/runtime.js
git add packages/web/server/lib/workflows/resume.js packages/web/server/lib/workflows/resume.test.js \
  packages/web/server/lib/workflows/engine.js packages/web/server/lib/workflows/runtime.js packages/web/server/index.js
git commit -m "feat(workflows): rebuild run state from evidence after a restart"
```

---

### Task 14: Restart smoke, then the whole-branch checks

**Files:**
- Modify: nothing, unless the smoke finds a defect.

**Interfaces:**
- Consumes: everything above.
- Produces: the observed evidence that resume works on a real server.

- [ ] **Step 1: Reproduce an interrupted step on the real runtime**

Against the smoke project from Task 12 (same server, same `$DIR`), start a step whose prompt takes a while:

```bash
curl -s -X POST "localhost:4199/api/workflows/runs/$RUN/steps/check/run" -H "$H" \
  -H 'content-type: application/json' -d '{}' &
sleep 3
kill %1 2>/dev/null || true
# stop the server while the turn is in flight
kill "$(pgrep -f 'server/index.js --port 4199' | head -1)"
```

Expected: the run file on disk has step `check` as `running` with an attempt whose `status` is `running`.

- [ ] **Step 2: Start the server again and read the run**

Restart the server on the same port and read the run through the route. Expected: step `check` is `interrupted` with the note `the server stopped while this step was running`, run status is `waiting`, and the run did not claim the step finished. Then send a continue prompt for that step and confirm the same session id is used.

- [ ] **Step 3: Report the observed output**

Paste the run JSON before and after the restart into the task's own report. If the run advanced to `done` without a prompt, that is a defect in Task 13 and it must be fixed before this task closes.

- [ ] **Step 4: Run the workspace checks once**

```bash
bun run --cwd packages/web test -- server/lib/workflows
bun run type-check:web
bunx oxlint packages/web/server/lib/workflows
bun run dead-code
```

Expected: workflow tests pass; type-check and oxlint report nothing for the new files; `dead-code` may report pre-existing entries, but nothing under `packages/web/server/lib/workflows/` beyond what the wiring uses. `bun run type-check` at the root stays red for the known `packages/vscode` reason recorded in `docs/agent-host/FUNCTION-STATUS.md`; do not "fix" it here.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/workflows
git commit -m "chore(workflows): whole-branch checks for the engine"
```

---

## Notes for the executor

- `docs/agent-host/FUNCTION-STATUS.md` records what is proven on a real runtime and what is not. When this plan lands, add rows for the workflow routes there: the smoke in Task 12 is the evidence for "run a step", and the smoke in Task 14 is the evidence for "resume". Windows and Linux were never run for anything in this repo, so an unrun platform stays `UNTESTED`.
- The screens (spec P3) are a separate plan. Nothing in this plan adds UI text, so no locale file changes here.
- The `sandbox` field is not part of this plan, on purpose: `working-tree` is the only mode the engine implements, and a definition cannot ask for a mode the code lacks. Worktree mode is spec P4.
