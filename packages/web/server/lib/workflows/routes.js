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

const parseJsonBody = express.json({ limit: '1mb' });

const respondWithError = (res, error, fallback) => {
  const status = Number.isInteger(error?.status) ? error.status : error?.code === 'ENOENT' ? 404 : 500;
  return res.status(status).json({ error: error?.message ?? fallback });
};

const directoryOf = (req) => (typeof req.get('x-opencode-directory') === 'string' ? req.get('x-opencode-directory') : null);

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
      const run = await store.read(scope.projectId, req.params.runId);
      if (!run) return res.status(404).json({ error: `run ${req.params.runId} was not found` });
      return res.json({ run });
    } catch (error) {
      return respondWithError(res, error, 'Failed to read the workflow run');
    }
  });

  const withProject = (handler) => async (req, res) => {
    try {
      const scope = scopeOf(req);
      if (!scope) return res.status(400).json({ error: 'x-opencode-directory is required' });
      return res.json({ run: await handler({ ...scope, req }) });
    } catch (error) {
      return respondWithError(res, error, 'The workflow run could not be advanced');
    }
  };

  app.post('/api/workflows/runs/:runId/run', parseJsonBody, withProject(({ projectId, projectPath, req }) => (
    engine.runUntilStop({ projectId, projectPath, runId: req.params.runId })
  )));

  app.post('/api/workflows/runs/:runId/cancel', parseJsonBody, withProject(({ projectId, req }) => (
    engine.cancelRun({ projectId, runId: req.params.runId })
  )));

  app.post('/api/workflows/runs/:runId/steps/:stepId/run', parseJsonBody, withProject(({ projectId, projectPath, req }) => (
    engine.startStep({ projectId, projectPath, runId: req.params.runId, stepId: req.params.stepId })
  )));

  app.post('/api/workflows/runs/:runId/steps/:stepId/verify', parseJsonBody, withProject(({ projectId, projectPath, req }) => (
    engine.verifyStep({ projectId, projectPath, runId: req.params.runId, stepId: req.params.stepId })
  )));

  app.post('/api/workflows/runs/:runId/steps/:stepId/prompt', parseJsonBody, withProject(({ projectId, projectPath, req }) => {
    const text = req.body?.text;
    if (typeof text !== 'string' || !text.trim()) {
      const error = new Error('prompt text is required');
      error.status = 400;
      throw error;
    }
    return engine.continueStep({ projectId, projectPath, runId: req.params.runId, stepId: req.params.stepId, text });
  }));

  app.post('/api/workflows/runs/:runId/steps/:stepId/confirm', parseJsonBody, withProject(({ projectId, req }) => {
    const decision = req.body?.decision;
    if (!['done', 'not_done', 'skip'].includes(decision)) {
      const error = new Error('decision must be done, not_done or skip');
      error.status = 400;
      throw error;
    }
    return engine.confirmStep({ projectId, runId: req.params.runId, stepId: req.params.stepId, decision, reason: req.body?.reason ?? null });
  }));

  app.delete('/api/workflows/runs/:runId', async (req, res) => {
    try {
      const scope = scopeOf(req);
      if (!scope) return res.status(400).json({ error: 'x-opencode-directory is required' });
      const removed = await store.remove(scope.projectId, req.params.runId);
      if (!removed) return res.status(404).json({ error: `run ${req.params.runId} was not found` });
      return res.json({ removed: true });
    } catch (error) {
      return respondWithError(res, error, 'Failed to delete the workflow run');
    }
  });
};
