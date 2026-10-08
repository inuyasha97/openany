import {
  listSnippets,
  getSnippet,
  createSnippet,
  updateSnippet,
  deleteSnippet,
  expandSnippets,
} from './snippets.js';

/**
 * `GET|POST|PATCH|DELETE /api/config/snippets*`.
 *
 * Snippets live in `~/.omp/agent/snippets` and `<project>/.omp/snippets` (with
 * the legacy OpenCode trees still read for compatibility); the store in
 * `packages/ui/src/stores/useSnippetsStore.ts` is the client for every route
 * here, so the paths and payloads match what it sends.
 *
 * Directory resolution is optional: user-scoped snippets are listable without a
 * project, and a `?directory=`/`x-opencode-directory` that cannot be validated
 * is a 400 rather than a silent fallback to some other tree.
 */
export const registerConfigSnippetRoutes = (app, dependencies) => {
  const { resolveOptionalProjectDirectory } = dependencies;

  app.get('/api/config/snippets', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      res.json(listSnippets(directory));
    } catch (error) {
      console.error('[API:GET /api/config/snippets] Failed:', error);
      res.status(500).json({ error: error.message || 'Failed to list snippets' });
    }
  });

  app.post('/api/config/snippets/expand', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      res.json({ text: expandSnippets(req.body?.text ?? '', directory) });
    } catch (error) {
      console.error('[API:POST /api/config/snippets/expand] Failed:', error);
      res.status(500).json({ error: error.message || 'Failed to expand snippets' });
    }
  });

  app.get('/api/config/snippets/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const snippet = getSnippet(name, directory);
      if (!snippet) {
        return res.status(404).json({ error: `Snippet "${name}" not found` });
      }
      res.json(snippet);
    } catch (error) {
      console.error('[API:GET /api/config/snippets/:name] Failed:', error);
      if (error.message?.includes('Snippet name')) {
        return res.status(400).json({ error: error.message });
      }
      res.status(500).json({ error: error.message || 'Failed to get snippet' });
    }
  });

  app.post('/api/config/snippets/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const body = req.body || {};
      const snippet = createSnippet(name, body, directory, body.scope || 'global');
      res.json({ success: true, snippet });
    } catch (error) {
      console.error('[API:POST /api/config/snippets/:name] Failed:', error);
      if (error.message?.includes('already exists')) {
        return res.status(409).json({ error: error.message });
      }
      if (error.message?.includes('Snippet name') || error.message?.includes('Project directory')) {
        return res.status(400).json({ error: error.message });
      }
      res.status(500).json({ error: error.message || 'Failed to create snippet' });
    }
  });

  app.patch('/api/config/snippets/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      res.json({ success: true, snippet: updateSnippet(name, req.body || {}, directory) });
    } catch (error) {
      console.error('[API:PATCH /api/config/snippets/:name] Failed:', error);
      if (error.message?.includes('not found')) {
        return res.status(404).json({ error: error.message });
      }
      if (error.message?.includes('Snippet name')) {
        return res.status(400).json({ error: error.message });
      }
      res.status(500).json({ error: error.message || 'Failed to update snippet' });
    }
  });

  app.delete('/api/config/snippets/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      deleteSnippet(name, directory);
      res.json({ success: true });
    } catch (error) {
      console.error('[API:DELETE /api/config/snippets/:name] Failed:', error);
      if (error.message?.includes('not found')) {
        return res.status(404).json({ error: error.message });
      }
      if (error.message?.includes('Snippet name')) {
        return res.status(400).json({ error: error.message });
      }
      res.status(500).json({ error: error.message || 'Failed to delete snippet' });
    }
  });
};
