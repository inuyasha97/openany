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
import { parseDefinition } from './definitions.js';
import { TERMINAL_RUN_STATUSES } from './engine.js';
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
  const { definitions, store, engine, resolveProjectId, projectPathFromId, normalizeDirectoryPath } = workflowsRuntime;

  // The browser smoke caught this as a real staleness: without a `Cache-Control`,
  // a reload revalidated a run read and the browser drew the `304` body it had
  // cached, so a run that had reached `done` on disk still showed `waiting_confirm`.
  // Every answer under this prefix describes a state that changes while steps
  // execute, so none of it may be cached.
  app.use('/api/workflows', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  /**
   * The project a request acts on: the `x-opencode-directory` header, turned
   * into the same path-derived id the projects directory names its files by
   * (`createProjectIdFromPath`), and back into the checkout path that id
   * encodes. A request naming a directory that is not an open project gets no
   * scope rather than a guessed one.
   *
   * The header is normalized first, because the projects list stores a
   * realpathed path: without it a directory that is a symlink names two ids —
   * `/tmp/x` and its realpath `/private/tmp/x` — and the same run id ends up in
   * two files, one advanced by one caller and one read by another. The browser
   * smoke saw exactly that: the page read `/private/tmp/...` while a scripted
   * client had advanced the run under `/tmp/...`.
   */
  const scopeOf = (req) => {
    const directory = directoryOf(req);
    if (!directory) return null;
    const projectId = resolveProjectId(normalizeDirectoryPath(directory));
    if (!projectId) return null;
    const projectPath = projectPathFromId(projectId);
    return projectPath ? { projectId, projectPath } : null;
  };

  const summary = (entry) => ({
    file: entry.file,
    // The hash of the bytes on disk, so a screen can hand it back on a save and
    // be told when another window changed the file in between.
    hash: entry.hash,
    id: entry.id,
    name: entry.name,
    version: entry.version,
    errors: entry.errors,
    // The diagram needs the declared steps; a summary without them would force the
    // screen to re-read every file separately.
    steps: entry.definition ? entry.definition.steps : [],
    // The create route rejects a missing required input, so a screen that offers
    // to start a run has to know what to ask for.
    inputs: entry.definition ? entry.definition.inputs : [],
    // The mode a run started from this file will use, so the screen can say it
    // before the run exists. `null` reads the way the other fields of an
    // unparsed row do: there is no mode to report.
    sandbox: entry.definition?.sandbox ?? null,
  });

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

  /**
   * One definition, as the file it is: the summary a screen already has stops at
   * the parsed definition, and the editor needs the text a person edits plus the
   * hash that text was read at.
   *
   * A file that no longer parses still opens — `definition: null` with the text
   * beside it is what a person repairs it from — and a definition that has not
   * been written yet answers 404, which is how the editor learns it may offer a
   * template instead of an empty buffer.
   */
  app.get('/api/workflows/definitions/:workflowId', async (req, res) => {
    try {
      const scope = scopeOf(req);
      if (!scope) return res.status(400).json({ error: 'x-opencode-directory is required' });
      const workflowId = req.params.workflowId;
      const source = await definitions.readSource(scope.projectId, workflowId);
      if (!source) return res.status(404).json({ error: `workflow "${workflowId}" was not found` });
      const parsed = parseDefinition(source.raw, { file: source.file });
      return res.json({ definition: parsed.ok ? parsed.definition : null, raw: source.raw, hash: source.hash });
    } catch (error) {
      return respondWithError(res, error, 'Failed to read the workflow definition');
    }
  });

  /**
   * Write one definition. The parser and the id check live in the definitions
   * module and refuse with their own reason, which is what the person reads.
   */
  app.put('/api/workflows/definitions/:workflowId', parseJsonBody, async (req, res) => {
    try {
      const scope = scopeOf(req);
      if (!scope) return res.status(400).json({ error: 'x-opencode-directory is required' });
      // `null` is not an absent field: it is the create case, and it has to reach
      // the writer as itself rather than collapse into "no expectation". An empty
      // string is no expectation, the way it is for a hash nobody read.
      const expectedHash = req.body?.expectedHash === null
        ? null
        : (typeof req.body?.expectedHash === 'string' && req.body.expectedHash ? req.body.expectedHash : undefined);
      const written = await definitions.write(scope.projectId, req.params.workflowId, req.body?.raw, { expectedHash });
      return res.json({ written });
    } catch (error) {
      return respondWithError(res, error, 'Failed to write the workflow definition');
    }
  });

  /**
   * Delete one definition.
   *
   * The engine reads the definition from disk again on every advance
   * (`loadStepDefinition`), so a run that has not stopped for good cannot move
   * once its file is gone. That delete is therefore refused, naming the run that
   * holds it, rather than stranding the run in silence.
   */
  app.delete('/api/workflows/definitions/:workflowId', async (req, res) => {
    try {
      const scope = scopeOf(req);
      if (!scope) return res.status(400).json({ error: 'x-opencode-directory is required' });
      const workflowId = req.params.workflowId;
      const runs = await store.list(scope.projectId);
      const live = runs.find((candidate) => candidate.workflowId === workflowId && !TERMINAL_RUN_STATUSES.has(candidate.status));
      if (live) {
        return res.status(409).json({
          error: `run ${live.runId} has not finished, so ${workflowId}.yaml cannot be deleted: finish or delete that run first`,
        });
      }
      const removed = await definitions.remove(scope.projectId, workflowId);
      if (!removed) return res.status(404).json({ error: `workflow "${workflowId}" was not found` });
      return res.json({ removed: true });
    } catch (error) {
      return respondWithError(res, error, 'Failed to delete the workflow definition');
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
        sandbox: definition.sandbox,
        steps: definition.steps.map((step) => ({ id: step.id, status: 'pending', attempts: [], note: null })),
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

  app.post('/api/workflows/runs/:runId/sandbox/release', parseJsonBody, withProject(({ projectId, projectPath, req }, res) => {
    const runId = runIdOf(req, res);
    return runId ? engine.releaseSandbox({ projectId, projectPath, runId }) : undefined;
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
