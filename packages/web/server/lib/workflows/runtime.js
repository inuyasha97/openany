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
  // Canonicalizes a directory before its project id is derived, so a symlinked
  // path and its realpath name one project rather than two. Defaults to the
  // identity for tests; the server passes the same normalizer the projects list
  // uses to store its paths.
  normalizeDirectoryPath = (value) => value,
  getOmpRuntimeHost,
  setSessionAutoAccept,
  // The projects the restart sweep walks, supplied by the server from the same
  // settings it reads everywhere else. No default: guessing would read every
  // directory under the projects root.
  listProjectIds,
  reconcileRuns,
  broadcast = () => {},
  logger = console,
  git = createGitDriver(),
  now = Date.now,
}) => {
  const definitions = createWorkflowDefinitions({ fsPromises: fs, path, projectPathFromId });
  const store = createWorkflowRunStore({ fsPromises: fs, path, projectsDirPath, now });
  const checkpoints = createCheckpointWriter({ git, now });

  // The 6000-line git service must not be pulled in at server boot, so the
  // worktree functions are loaded on the worktree path only, the way the git
  // routes do it (`packages/web/server/lib/git/routes.js:11-19`). Tests inject a
  // fake instead of this loader.
  const worktrees = {
    createWorktree: async (...args) => (await import('../git/index.js')).createWorktree(...args),
    removeWorktree: async (...args) => (await import('../git/index.js')).removeWorktree(...args),
    getWorktreeBootstrapStatus: async (...args) => (await import('../git/index.js')).getWorktreeBootstrapStatus(...args),
  };

  const requireHost = async () => {
    const mounted = await getOmpRuntimeHost();
    if (!mounted) throw new WorkflowError('unavailable', 'the OMP runtime is not available', 503);
    return mounted;
  };

  const host = {
    createSession: async (params) => (await requireHost()).createSession(params),
    prompt: async (sessionId, text) => (await requireHost()).prompt(sessionId, text),
    getSessionStatus: async (sessionId) => (await requireHost()).getSessionStatus(sessionId),
    listSessions: async () => (await requireHost()).listSessions(),
    renameSession: async (sessionId, title) => (await requireHost()).renameSession(sessionId, title),
    setModel: async (sessionId, provider, modelId) => (await requireHost()).setModel(sessionId, provider, modelId),
    // `async` and an `await` on purpose: the toggle may not be wired, and a call
    // that returns `undefined` breaks every caller that chains `.catch` onto it.
    setAutoAccept: async (sessionId, enabled, directory) => {
      await setSessionAutoAccept?.(sessionId, enabled, directory);
    },
  };

  const engine = createWorkflowEngine({
    store,
    definitions,
    host,
    checkpoints,
    listProjectIds,
    reconcileRuns,
    worktrees,
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
    normalizeDirectoryPath,
    routes: registerWorkflowRoutes,
  };
};
