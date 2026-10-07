import express from 'express';
import {
  createWorktree as createWorktreeDefault,
  getWorktreeBootstrapStatus as getWorktreeBootstrapStatusDefault,
  resolvePrimaryWorktreeRoot,
} from '../git/index.js';
import { expandSnippets } from '../openchamber/snippets.js';
import { AUTO_MODEL_REF, isAutoModel } from '../routing/defaults.js';
import { parseScheduledCommandPrompt } from '../scheduled-tasks/runtime.js';
import { createSessionGoal } from '../session-goal/create.js';
import { OpenChamberControlError, asControlError } from '../openchamber-control/error.js';
import { readObjective, writeObjective } from '../session-goal/objectives.js';
import { createArchiveStore } from './archive-store.js';
import { applyForkInheritance } from './fork-inheritance.js';
import {
  getOmpRuntimeHost,
  promptSession,
  readSessionMessages,
  setSessionModel,
} from '../agents/omp-host-access.js';
import { createSessionMetadataStore } from './session-metadata-store.js';

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const asList = (value) => (Array.isArray(value) ? value : []);

/**
 * A surface the OpenCode runtime had and OMP does not. Answered as unsupported
 * rather than ignored or guessed: the caller gets one clear failure, and the
 * route's error handler answers it with its own status instead of turning a
 * missing method into a 500 somewhere deeper in the dispatch.
 */
const unsupportedOnOmp = (what) => {
  throw new OpenChamberControlError(`${what} is not supported on the OMP runtime`, 501);
};

/** The raw OMP host, or a clear failure when the runtime is not mounted. */
const requireOmpHost = async () => {
  const host = await getOmpRuntimeHost();
  if (!host) throw new OpenChamberControlError('The OMP runtime is not available', 503);
  return host;
};

/**
 * The runtime's model catalogue in the shape the selection logic reads: OMP
 * names a model as `{ provider, id }` while every lookup here is by
 * `providerID`/`modelID`. An entry naming neither is unusable and dropped; an
 * unreadable catalogue is empty, which callers read as "unknown" rather than as
 * a rejection.
 */
const listModelCatalog = async () => {
  const host = await getOmpRuntimeHost();
  if (!host) return [];
  const catalog = [];
  for (const model of asList(await host.listModels())) {
    const providerID = asNonEmptyString(model?.provider ?? model?.providerID);
    const modelID = asNonEmptyString(model?.id ?? model?.modelID);
    if (providerID && modelID) catalog.push({ providerID, modelID });
  }
  return catalog;
};

/** The runtime's slash commands, or none when the runtime is not mounted. */
const listRuntimeCommands = async () => {
  const host = await getOmpRuntimeHost();
  if (!host) return [];
  return asList(await host.listCommands());
};

/**
 * OMP serves no agent catalogue, so no agent is resolved by id or by name and
 * no agent informs a default. Kept as a narrow failure where the OpenCode call
 * used to be, so the gap stays visible.
 */
const listAgents = async () => unsupportedOnOmp('Listing agents');

/**
 * OMP serves no OpenCode-level config, so it cannot supply a default agent or a
 * default model any more. Kept as a narrow failure for the same reason.
 */
const listRuntimeConfig = async () => unsupportedOnOmp('Reading the runtime config');

/**
 * OMP switches a session's model in one RPC and exposes no agent switch, so a
 * session cannot be moved onto an agent. Answered as unsupported rather than
 * ignored: a dispatch that must run on a named agent must not silently run on
 * whichever one the session already has.
 */
const switchSessionAgent = (agent) => {
  unsupportedOnOmp(`Switching the session to the '${agent}' agent`);
};

/**
 * `setModel(provider, modelId)` is the whole model switch: OMP has no reasoning
 * variant to apply, so a session asked for one would silently run without it.
 */
const applyModelVariant = (variant) => {
  unsupportedOnOmp(`The '${variant}' model variant`);
};

/**
 * Rejects what OMP cannot apply, before any session, worktree or goal side
 * effect happens, rather than dropping it from a request that would otherwise
 * look like it succeeded.
 */
const rejectUnsupportedSelection = ({ agent, variant }) => {
  if (agent) switchSessionAgent(agent);
  if (variant) applyModelVariant(variant);
};

const splitModel = (value) => {
  const model = asNonEmptyString(value);
  if (!model) return null;
  const slashIndex = model.indexOf('/');
  if (slashIndex <= 0 || slashIndex === model.length - 1) return null;
  return {
    providerID: model.slice(0, slashIndex),
    modelID: model.slice(slashIndex + 1),
  };
};

const resolveRequestedModel = (payload) => {
  const model = splitModel(payload?.model);
  if (model) return model;

  const providerID = asNonEmptyString(payload?.providerID);
  const modelID = asNonEmptyString(payload?.modelID);
  return providerID && modelID ? { providerID, modelID } : null;
};

const MIN_GOAL_TOKEN_BUDGET = 1_000;
const MAX_GOAL_TOKEN_BUDGET = 100_000_000;

const resolveGoalInput = (payload, prompt) => {
  const enabled = payload?.goal === true;
  if (payload?.goalTokenBudget !== undefined && !enabled) {
    return { ok: false, error: 'goalTokenBudget requires goal' };
  }
  if (enabled && !prompt) {
    return { ok: false, error: 'prompt is required when goal is enabled' };
  }
  if (payload?.goalTokenBudget === undefined) {
    return { ok: true, enabled, tokenBudget: null };
  }
  const tokenBudget = payload.goalTokenBudget;
  if (!Number.isSafeInteger(tokenBudget)
    || tokenBudget < MIN_GOAL_TOKEN_BUDGET
    || tokenBudget > MAX_GOAL_TOKEN_BUDGET) {
    return { ok: false, error: `goalTokenBudget must be an integer from ${MIN_GOAL_TOKEN_BUDGET} to ${MAX_GOAL_TOKEN_BUDGET}` };
  }
  return { ok: true, enabled, tokenBudget };
};

// OMP serves one flat model catalogue: every entry names its provider.
const hasCatalogModel = (models, providerID, modelID) => models.some(
  (model) => model?.providerID === providerID && model?.modelID === modelID,
);

// Config `model` is either "providerID/modelID" or the expanded object form.
const parseConfigModel = (value) => {
  if (typeof value === 'string') return splitModel(value);
  const providerID = asNonEmptyString(value?.providerID);
  const modelID = asNonEmptyString(value?.model);
  return providerID && modelID ? { providerID, modelID } : null;
};

const resolveProjectDefaults = (settings, directory, projectId) => {
  const projects = Array.isArray(settings?.projects) ? settings.projects : [];
  const matchedProject = projectId
    ? projects.find((entry) => entry?.id === projectId) || null
    : projects.find((entry) => entry?.path === directory) || null;
  return {
    defaultModel: asNonEmptyString(matchedProject?.defaultModel),
  };
};

/**
 * The default-selection inputs the routes still read: the saved settings and
 * the runtime's model catalogue. A failed lookup answers empty on purpose — an
 * empty catalogue means "unknown", and callers must never turn that into a
 * rejection.
 *
 * Two inputs the OpenCode runtime supplied are gone with it: an agent catalogue
 * (a default agent) and its own config (the runtime's default model). Both
 * lookups are still attempted so the gap stays a visible, narrow failure rather
 * than a call that quietly disappeared, and their empty answer is read as
 * "unknown" — never as "the runtime says there are none".
 */
const fetchSelectionInputs = async ({ readSettingsFromDiskMigrated }) => {
  const settings = await readSettingsFromDiskMigrated();
  const models = await listModelCatalog().catch(() => []);
  await Promise.all([listAgents().catch(() => []), listRuntimeConfig().catch(() => [])]);
  return { settings, models };
};

/**
 * The model a dispatch with no explicit choice runs on: the project's default,
 * then the global one, then the catalogue's first entry. The steps the OpenCode
 * runtime supplied are gone (see `fetchSelectionInputs`), and OMP resolves no
 * default agent at all — an explicit one is rejected instead (see
 * `switchSessionAgent`).
 */
const resolveDefaultModel = ({ models, settings, projectDefaults }) => {
  const projectDefaultModel = parseConfigModel(projectDefaults?.defaultModel);
  if (projectDefaultModel) return projectDefaultModel;

  const settingsDefaultModel = parseConfigModel(settings?.defaultModel);
  if (settingsDefaultModel) return settingsDefaultModel;

  const first = models[0];
  if (asNonEmptyString(first?.providerID) && asNonEmptyString(first?.modelID)) {
    return { providerID: first.providerID, modelID: first.modelID };
  }
  return null;
};

/**
 * A dispatch sets the session's model before its prompt. OMP switches it in one
 * RPC; the agent and the variant do not travel with the model and cannot be
 * applied by it, so they are answered before it is reached (see
 * `rejectUnsupportedSelection`).
 */
const applySessionSelection = async ({ sessionID, model }) => {
  if (!model) return;
  const switched = await setSessionModel(sessionID, model.providerID, model.modelID);
  if (switched === null) throw new OpenChamberControlError('The OMP runtime is not available', 503);
};

const createSession = async ({ directory, title }) => {
  const host = await requireOmpHost();
  const session = await host.createSession({ cwd: directory });
  const sessionID = asNonEmptyString(session?.id);
  if (!sessionID) throw new Error('failed to create session');
  // OMP opens a session on a directory and names it afterwards; there is no
  // create-with-title call.
  if (title) await host.renameSession(sessionID, title);
  return sessionID;
};

/**
 * OpenCode forked a session at a message boundary; OMP's RPC surface has none
 * (a session is its own transcript, and the fork request carries no OMP
 * counterpart). Kept in the dispatch as a narrow failure so a caller asking for
 * a fork is told instead of receiving a session that is not one.
 */
const forkSession = async () => unsupportedOnOmp('Forking a session');

/**
 * OpenCode admitted a message without starting a run — goal reminders and the
 * session's standing project context travelled that way. OMP's only way in is a
 * prompt, which does start the agent, so the call is answered as unsupported
 * rather than the message being folded into something the caller kept it apart
 * from.
 */
const sendSyntheticMessage = (what) => unsupportedOnOmp(`Recording the ${what} without starting a run`);

/**
 * OpenCode ran a catalogue command through its own route, with the typed
 * arguments as the message. OMP has no such route — its commands travel inside
 * a prompt — so an explicit command call is answered as unsupported rather than
 * turned into a prompt the caller did not ask to send.
 */
const runSessionCommand = async (name) => unsupportedOnOmp(`Running the '${name}' session command`);

/**
 * The newest completed assistant message, from the runtime's canonical page.
 * A page the runtime does not have (`null`: not mounted) leaves the id unknown;
 * a page it could not answer throws, because "could not read" must not be
 * reported as "there is no completed answer".
 */
const latestCompletedAssistantMessageID = async ({ sessionID }) => {
  const page = await readSessionMessages(sessionID);
  let latest = null;
  for (const item of asList(page?.items)) {
    const info = item?.info;
    if (info?.role !== 'assistant' || !Number.isFinite(info?.time?.completed)) continue;
    if (!latest || (info.time.created || 0) >= (latest.time?.created || 0)) latest = info;
  }
  return asNonEmptyString(latest?.id);
};


/**
 * Upper bound on one archive batch.
 *
 * The batch is a bounded amount of work on one request, and callers with more
 * sessions than this send several batches and keep their own partial results.
 */
const MAX_ARCHIVE_BATCH = 500;

const parseIdBatch = (payload) => {
  const rawIds = payload?.ids;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return { ok: false, error: 'ids must be a non-empty array of session ids' };
  }
  if (rawIds.length > MAX_ARCHIVE_BATCH) {
    return { ok: false, error: `ids must contain at most ${MAX_ARCHIVE_BATCH} session ids` };
  }

  const ids = [];
  for (const value of rawIds) {
    const id = asNonEmptyString(value);
    if (!id) return { ok: false, error: 'ids must contain non-empty session ids' };
    ids.push(id);
  }
  return { ok: true, ids };
};

const parseArchiveRequest = (payload) => {
  const parsed = parseIdBatch(payload);
  if (!parsed.ok) return parsed;

  const archivedAt = payload?.archivedAt;
  if (archivedAt !== undefined && (!Number.isSafeInteger(archivedAt) || archivedAt <= 0)) {
    return { ok: false, error: 'archivedAt must be a positive integer timestamp' };
  }

  return { ok: true, ids: parsed.ids, archivedAt: archivedAt ?? Date.now() };
};

const resolveRequestedDirectory = async ({ payload, readSettingsFromDiskMigrated, sanitizeProjects, validateDirectoryPath }) => {
  const projectID = asNonEmptyString(payload?.projectId) || asNonEmptyString(payload?.projectID);
  if (projectID) {
    const settings = await readSettingsFromDiskMigrated();
    const projects = sanitizeProjects(settings?.projects || []);
    const project = projects.find((entry) => entry.id === projectID) || null;
    if (!project?.path) {
      return { ok: false, status: 404, error: 'Project not found' };
    }
    const validated = await validateDirectoryPath(project.path);
    return validated.ok
      ? { ok: true, directory: validated.directory, projectId: projectID }
      : { ok: false, status: 400, error: validated.error || 'Invalid project directory' };
  }

  const directory = asNonEmptyString(payload?.directory);
  const validated = await validateDirectoryPath(directory);
  if (!validated.ok) return { ok: false, status: 400, error: validated.error || 'Invalid directory' };
  const settings = await readSettingsFromDiskMigrated();
  const projects = sanitizeProjects(settings?.projects || []);
  let project = projects.find((entry) => entry.path === validated.directory);
  if (!project && projects.length > 0) {
    const { root } = await resolvePrimaryWorktreeRoot(validated.directory);
    project = projects.find((entry) => entry.path === root);
  }
  return { ok: true, directory: validated.directory, ...(project ? { projectId: project.id } : {}) };
};

// createWorktree returns while the worktree is still being populated in the
// background (git reset --hard after a --no-checkout add). Dispatching a
// prompt into a half-populated directory makes the run die with UnknownError
// (agent and config files are not there yet), so wait until the bootstrap
// reaches git-ready (population done) or fails before creating the session and
// dispatching.
const WORKTREE_BOOTSTRAP_TIMEOUT_MS = 60_000;
const WORKTREE_BOOTSTRAP_POLL_MS = 150;

const resolveWorktreeInput = (payload) => {
  if (!payload?.worktree || typeof payload.worktree !== 'object') return null;
  const name = asNonEmptyString(payload.worktree.name);
  if (!name) return null;
  const branchName = asNonEmptyString(payload.worktree.branchName);
  const startRef = asNonEmptyString(payload.worktree.startRef);
  return {
    mode: 'new',
    name,
    ...(branchName ? { branchName } : {}),
    ...(startRef ? { startRef } : {}),
    ...(typeof payload.setUpstream === 'boolean' ? { setUpstream: payload.setUpstream } : {}),
  };
};

export const createOpenChamberSessionService = (dependencies) => {
  const {
    readSettingsFromDiskMigrated,
    sanitizeProjects,
    validateDirectoryPath,
    emitSessionCreatedEvent,
    broadcastGlobalUiEvent,
    createSessionGoal: createSessionGoalOverride,
    sessionKnowledgeRuntime = null,
    dataDir = null,
    archiveStore: injectedArchiveStore = null,
    sessionMetadataStore: injectedSessionMetadataStore = null,
    // Injected by the server so every metadata write takes the same path:
    // store, broadcast, and tell the goal loop. Falls back to store+broadcast
    // when it is absent, which is what module tests use.
    persistSessionMetadata = null,
    createWorktree = createWorktreeDefault,
    getWorktreeBootstrapStatus = getWorktreeBootstrapStatusDefault,
    // Auto routing. Sessions dispatched here reach the runtime through the OMP
    // host, not through the proxy that intercepts the Auto sentinel, so a
    // default of `openchamber/auto` (Session Defaults) is resolved here before
    // the session is switched onto it. Null when routing is not wired in.
    resolveAutoSelection = null,
  } = dependencies;

  if ((!injectedArchiveStore || !injectedSessionMetadataStore) && !dataDir) {
    throw new Error('openchamber session routes need either both stores or a dataDir');
  }
  const archiveStore = injectedArchiveStore || createArchiveStore({ dataDir });
  const sessionMetadataStore = injectedSessionMetadataStore || createSessionMetadataStore({ dataDir });

  const waitForWorktreeBootstrapReady = async ({ directory }) => {
    const deadline = Date.now() + WORKTREE_BOOTSTRAP_TIMEOUT_MS;
    for (;;) {
      const status = await getWorktreeBootstrapStatus(directory);
      if (status?.status === 'failed') {
        throw new OpenChamberControlError(`Worktree bootstrap failed: ${status.error || 'unknown error'}`, 500);
      }
      const phase = status?.phase;
      if (status?.status === 'ready' || phase === 'git-ready' || phase === 'setup-ready') return;
      if (Date.now() >= deadline) {
        throw new OpenChamberControlError('Timed out waiting for the worktree bootstrap', 500);
      }
      await new Promise((resolve) => setTimeout(resolve, WORKTREE_BOOTSTRAP_POLL_MS));
    }
  };

  /**
   * The model an existing session already runs on. OMP keeps the live selection
   * in the session's process, which the host does not expose, so the newest
   * message that names a provider and a model stands in for it: the session
   * keeps running on that model, and a dispatch that must not move it onto a
   * global default reads it here first. OMP has no session agent or model
   * variant to carry over.
   *
   * A page the runtime could not answer throws — a failed read must not be
   * taken for "this session has no model", which would move the session onto
   * the default behind the caller's back.
   */
  const fetchSessionSelection = async ({ sessionID }) => {
    const page = await readSessionMessages(sessionID);
    const items = asList(page?.items);
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const info = items[index]?.info;
      const providerID = asNonEmptyString(info?.providerID);
      const modelID = asNonEmptyString(info?.modelID);
      if (providerID && modelID) return { model: { providerID, modelID } };
    }
    return null;
  };

  // An unknown model makes the run fail after the prompt is accepted, leaving a
  // session with no answer. Reject it before any session, worktree, or goal side
  // effect happens. An agent is not validated here: OMP serves no agent
  // catalogue to validate against, and a requested agent is rejected outright
  // (see `rejectUnsupportedSelection`).
  const validateRequestedModel = async ({ directory, requestedModel }) => {
    if (!requestedModel) return;
    const { models } = await fetchSelectionInputs({ readSettingsFromDiskMigrated });

    // An empty catalogue means the lookup failed or returned nothing
    // authoritative; it must not turn a valid selection into a rejection.
    if (models.length === 0) return;
    if (!hasCatalogModel(models, requestedModel.providerID, requestedModel.modelID)) {
      throw new OpenChamberControlError(
        `Unknown model '${requestedModel.providerID}/${requestedModel.modelID}' for ${directory}`,
        400,
      );
    }
  };

  const dispatchPrompt = async ({
    sessionID,
    directory,
    projectId,
    prompt,
    goalInput,
    requestedModel,
    reuseSessionSelection = false,
  }) => {
    let model = requestedModel;
    if (reuseSessionSelection && !model) {
      const previous = await fetchSessionSelection({ sessionID });
      if (previous?.model) model = previous.model;
    }
    if (!model) {
      const inputs = await fetchSelectionInputs({ readSettingsFromDiskMigrated });
      model = resolveDefaultModel({
        ...inputs,
        projectDefaults: resolveProjectDefaults(inputs.settings, directory, projectId),
      });
    }
    if (!model) {
      const error = new Error('No model is configured or available for the requested directory');
      error.statusCode = 400;
      throw error;
    }

    const expandedPrompt = expandSnippets(prompt, directory);
    if (isAutoModel(model)) {
      // The sentinel must never reach the runtime: neither the goal record nor
      // the session switch below may carry it.
      if (!resolveAutoSelection) {
        throw new OpenChamberControlError('Auto routing is not available on this server. Choose a model.', 400);
      }
      const routed = await resolveAutoSelection({
        sessionId: sessionID,
        directory,
        model: AUTO_MODEL_REF,
        agent: null,
        requestText: expandedPrompt,
      });
      // A category can name an agent; OMP cannot switch a session onto one, so
      // a routed agent is answered rather than run on the wrong one.
      if (routed.agent) switchSessionAgent(routed.agent);
      model = { providerID: routed.model.providerID, modelID: routed.model.id };
    }
    const parsedCommand = parseScheduledCommandPrompt(prompt);
    let resolvedCommand = null;
    if (parsedCommand) {
      try {
        const commands = await listRuntimeCommands();
        if (commands.some((candidate) => candidate?.name === parsedCommand.command)) {
          resolvedCommand = parsedCommand;
        }
      } catch {
      }
    }
    if (goalInput.enabled) {
      // The runtime publishes no command template, so a slash command's goal
      // objective is the prompt the user typed rather than the expanded body.
      await (createSessionGoalOverride || createSessionGoal)({
        sessionID,
        directory,
        objective: expandedPrompt,
        tokenBudget: goalInput.tokenBudget,
        providerID: model.providerID,
        modelID: model.modelID,
        onWarning: (message, error) => console.warn(`[OpenChamberSessions] ${message}:`, error?.message || error),
        // The goal record goes to OpenChamber's own store — the same one the
        // proxy overlays back onto the sessions it serves.
        persistSessionGoal: async (goalSessionID, goalDirectory, goal) => {
          await writeMetadata(goalSessionID, { openchamber: { goal } }, goalDirectory);
        },
      });
    }

    const markGoalPartial = (error) => {
      if (goalInput.enabled && error && typeof error === 'object') error.goalConfigured = true;
      return error;
    };

    try {
      await applySessionSelection({ sessionID, model });
    } catch (error) {
      throw markGoalPartial(error);
    }

    // A session the agent dispatched has no UI to attach the project's
    // standing context, so it is asked for here. The context is injected only
    // if the runtime offers a way to record a message without starting a run;
    // on OMP it does not, so a dispatch with context pending is answered
    // instead of the context being dropped behind the caller's back.
    const knowledge = sessionKnowledgeRuntime
      ? await sessionKnowledgeRuntime.resolvePendingForSession(sessionID, directory)
        .catch(() => ({ text: '', signature: '' }))
      : { text: '', signature: '' };
    // After the send is accepted, so a rejected dispatch carries it again.
    const recordKnowledge = async () => {
      if (knowledge.text && sessionKnowledgeRuntime) {
        await sessionKnowledgeRuntime.recordDelivered(sessionID, directory, knowledge.signature)
          .catch(() => undefined);
      }
    };

    if (resolvedCommand) {
      try {
        // The standing context goes in first, as a message that does not start
        // a run on its own; OMP has no such call, so both it and the command
        // route below fail narrowly instead of being dropped.
        if (knowledge.text) sendSyntheticMessage('session context');
        await runSessionCommand(resolvedCommand.command);
      } catch (error) {
        throw markGoalPartial(error);
      }
      await recordKnowledge();
    } else {
      let accepted;
      try {
        if (knowledge.text) sendSyntheticMessage('session context');
        accepted = await promptSession(sessionID, expandedPrompt);
        if (accepted === null) {
          throw new OpenChamberControlError('The OMP runtime is not available', 503);
        }
        if (goalInput.enabled) {
          // Goal mode's reminder refers to "the user message above", so it is
          // admitted after the prompt, as its own message.
          sendSyntheticMessage('goal reminder');
        }
      } catch (error) {
        throw markGoalPartial(error);
      }
      await recordKnowledge();
      if (!accepted) {
        // The runtime recorded the prompt without starting the agent, so the
        // dispatch must not be claimed as done.
        return {
          model,
          promptDispatched: false,
          dispatchedAsCommand: false,
          promptError: 'OMP accepted the prompt but did not start the agent',
        };
      }
    }

    return { model, promptDispatched: true, dispatchedAsCommand: Boolean(resolvedCommand) };
  };

  const broadcastMetadata = (sessionID, metadata) => {
    broadcastGlobalUiEvent?.({
      type: 'openchamber:session-metadata',
      properties: { sessionID, metadata },
    });
  };

  /**
   * Merge-patch a session's OpenChamber metadata: the per-session state of goal
   * mode, session assist, obligatory context and pinned notes. The broadcast
   * carries the full merged object, because a client that missed an earlier
   * patch must not have to reconstruct it.
   */
  const writeMetadata = async (sessionID, patch, directory = '') => {
    if (typeof persistSessionMetadata === 'function') {
      return persistSessionMetadata(sessionID, patch, { directory });
    }
    const metadata = await sessionMetadataStore.setSessionMetadata(sessionID, patch, { directory });
    broadcastMetadata(sessionID, metadata);
    return metadata;
  };

  const setMetadata = async (sessionID, payload = {}) => {
    const id = asNonEmptyString(sessionID);
    if (!id) throw new OpenChamberControlError('a session id is required', 400);
    const patch = payload?.patch;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new OpenChamberControlError('patch must be an object', 400);
    }

    return { metadata: await writeMetadata(id, patch, asNonEmptyString(payload?.directory) || '') };
  };

  const getMetadata = async (sessionID, directory = '') => {
    const id = asNonEmptyString(sessionID);
    if (!id) throw new OpenChamberControlError('a session id is required', 400);
    return { metadata: await sessionMetadataStore.get(id, { directory }) };
  };

  const broadcastArchived = (sessionID, archivedAt) => {
    broadcastGlobalUiEvent?.({
      type: 'openchamber:session-archived',
      properties: { sessionID, archivedAt },
    });
  };

  /**
   * Archive a batch of sessions in one request.
   *
   * OpenCode 2.x has no route that sets `time.archived`, so the state is
   * OpenChamber's own: a JSON file beside the OpenCode instance, folded back
   * onto the session records the proxy serves. Batching matters for the same
   * reason it did before — the UI archives every session linked to a worktree
   * before removing it, and doing that one request at a time is what made
   * removing a busy worktree take tens of seconds.
   *
   * No directory is needed: archive state is keyed by session id per data dir.
   */
  const archive = async (payload = {}) => {
    const parsed = parseArchiveRequest(payload);
    if (!parsed.ok) {
      throw new OpenChamberControlError(parsed.error, 400);
    }

    const { archived, failedIds } = await archiveStore.archive(parsed.ids, parsed.archivedAt);
    for (const entry of archived) broadcastArchived(entry.id, entry.archivedAt);
    return { archived, failedIds };
  };

  /** Clears the archive flag for a batch. Mirrors `archive`. */
  const unarchive = async (payload = {}) => {
    const parsed = parseIdBatch(payload);
    if (!parsed.ok) {
      throw new OpenChamberControlError(parsed.error, 400);
    }

    const { restored, failedIds } = await archiveStore.unarchive(parsed.ids);
    for (const entry of restored) broadcastArchived(entry.id, null);
    return { restored, failedIds };
  };

  const create = async (payload = {}) => {
    const title = asNonEmptyString(payload.title);
    const prompt = asNonEmptyString(payload.prompt);
    const goalInput = resolveGoalInput(payload, prompt);
    if (!goalInput.ok) {
      throw new OpenChamberControlError(goalInput.error, 400);
    }
    const model = resolveRequestedModel(payload);
    const agent = asNonEmptyString(payload.agent);
    const variant = asNonEmptyString(payload.variant);
    // An agent or a variant OMP cannot apply is answered before any side effect.
    rejectUnsupportedSelection({ agent, variant });

    const resolvedDirectory = await resolveRequestedDirectory({
      payload,
      readSettingsFromDiskMigrated,
      sanitizeProjects,
      validateDirectoryPath,
    });
    if (!resolvedDirectory.ok) {
      throw new OpenChamberControlError(resolvedDirectory.error, resolvedDirectory.status || 400);
    }

    const worktreeInput = resolveWorktreeInput(payload);
    let worktree = null;
    let sessionDirectory = resolvedDirectory.directory;
    if (payload?.worktree && !worktreeInput) {
      throw new OpenChamberControlError('worktree.name is required when worktree is provided', 400);
    }

    if (prompt) {
      await validateRequestedModel({
        directory: resolvedDirectory.directory,
        requestedModel: model,
      });
    }

    if (worktreeInput) {
      worktree = await createWorktree(resolvedDirectory.directory, worktreeInput);
      sessionDirectory = worktree.path;
      await waitForWorktreeBootstrapReady({ directory: sessionDirectory });
    }

    const sessionID = await createSession({
      directory: sessionDirectory,
      ...(title ? { title } : {}),
    });

    let dispatch = { model, promptDispatched: false, dispatchedAsCommand: false };
    if (prompt) {
      dispatch = await dispatchPrompt({
        sessionID,
        directory: sessionDirectory,
        projectId: resolvedDirectory.projectId,
        prompt,
        goalInput,
        requestedModel: model,
      });
    }

    const result = {
      sessionId: sessionID,
      directory: sessionDirectory,
      ...(resolvedDirectory.projectId ? { projectId: resolvedDirectory.projectId } : {}),
      ...(title ? { title } : {}),
      ...(worktree ? { worktree } : {}),
      ...(prompt && dispatch.model ? { model: dispatch.model } : {}),
      promptDispatched: dispatch.promptDispatched,
      ...(dispatch.promptError ? { promptError: dispatch.promptError } : {}),
      dispatchedAsCommand: dispatch.dispatchedAsCommand,
      ...(goalInput.enabled ? { goalEnabled: true } : {}),
      ...(goalInput.tokenBudget ? { goalTokenBudget: goalInput.tokenBudget } : {}),
    };

    try {
      emitSessionCreatedEvent?.({
        sessionID,
        directory: sessionDirectory,
        ...(resolvedDirectory.projectId ? { projectID: resolvedDirectory.projectId } : {}),
        ...(title ? { title } : {}),
        ...(worktree ? { worktree } : {}),
        ...(prompt && dispatch.model ? { model: dispatch.model } : {}),
        promptDispatched: dispatch.promptDispatched,
        dispatchedAsCommand: dispatch.dispatchedAsCommand,
        ...(goalInput.enabled ? { goalEnabled: true } : {}),
        ...(goalInput.tokenBudget ? { goalTokenBudget: goalInput.tokenBudget } : {}),
        createdAt: Date.now(),
      });
    } catch {
    }

    return result;
  };

  const runExisting = async (action, sourceSessionId, payload = {}) => {
    const sourceSessionID = asNonEmptyString(sourceSessionId);
    const prompt = asNonEmptyString(payload.prompt);
    if (!sourceSessionID) throw new OpenChamberControlError('sessionId is required', 400);
    if (!prompt) throw new OpenChamberControlError('prompt is required', 400);
    const goalInput = resolveGoalInput(payload, prompt);
    if (!goalInput.ok) throw new OpenChamberControlError(goalInput.error, 400);
    const requestedModel = resolveRequestedModel(payload);
    // An agent or a variant OMP cannot apply is answered before any side effect.
    rejectUnsupportedSelection({
      agent: asNonEmptyString(payload.agent),
      variant: asNonEmptyString(payload.variant),
    });

    let targetSessionID = sourceSessionID;
    let targetSession = null;
    let directory = null;
    try {
      const resolvedDirectory = await resolveRequestedDirectory({
        payload,
        readSettingsFromDiskMigrated,
        sanitizeProjects,
        validateDirectoryPath,
      });
      if (!resolvedDirectory.ok) {
        throw new OpenChamberControlError(resolvedDirectory.error, resolvedDirectory.status || 400);
      }
      directory = resolvedDirectory.directory;

      await validateRequestedModel({
        directory,
        requestedModel,
      });

      if (action === 'fork') {
        targetSession = await forkSession();
        targetSessionID = targetSession.id;
        // Before the prompt goes out, so a goal armed by this dispatch writes
        // over the copied objective rather than the other way round.
        await applyForkInheritance({
          sourceSessionID,
          fork: targetSession,
          readObjective,
          writeObjective,
          writeMetadata: (sessionID, patch) => writeMetadata(sessionID, patch, directory),
        });
      }

      const baselineAssistantMessageId = await latestCompletedAssistantMessageID({
        sessionID: targetSessionID,
      });

      const dispatch = await dispatchPrompt({
        sessionID: targetSessionID,
        directory,
        projectId: resolvedDirectory.projectId,
        prompt,
        goalInput,
        requestedModel,
        reuseSessionSelection: true,
      });
      const result = {
        action,
        sessionId: targetSessionID,
        directory,
        ...(action === 'fork' ? { sourceSessionId: sourceSessionID } : {}),
        ...(targetSession?.title ? { title: targetSession.title } : {}),
        ...(baselineAssistantMessageId ? { baselineAssistantMessageId } : {}),
        model: dispatch.model,
        promptDispatched: dispatch.promptDispatched,
        ...(dispatch.promptError ? { promptError: dispatch.promptError } : {}),
        dispatchedAsCommand: dispatch.dispatchedAsCommand,
        ...(goalInput.enabled ? { goalEnabled: true } : {}),
        ...(goalInput.tokenBudget ? { goalTokenBudget: goalInput.tokenBudget } : {}),
      };

      if (action === 'fork') {
        try {
          emitSessionCreatedEvent?.({
            sessionID: targetSessionID,
            directory,
            sourceSessionID,
            ...(targetSession?.title ? { title: targetSession.title } : {}),
            model: dispatch.model,
            promptDispatched: dispatch.promptDispatched,
            dispatchedAsCommand: dispatch.dispatchedAsCommand,
            ...(goalInput.enabled ? { goalEnabled: true } : {}),
            ...(goalInput.tokenBudget ? { goalTokenBudget: goalInput.tokenBudget } : {}),
            createdAt: Date.now(),
          });
        } catch {
        }
      }
      return result;
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 500;
      const forkCreated = action === 'fork' && targetSessionID !== sourceSessionID;
      const goalConfigured = error?.goalConfigured === true;
      throw new OpenChamberControlError(
        error instanceof Error ? error.message : `Failed to ${action} session`,
        statusCode,
        {
        ...(forkCreated || goalConfigured
          ? {
            partial: true,
            partialAction: forkCreated ? 'fork-created' : 'goal-configured',
            sessionId: targetSessionID,
            directory,
          }
          : {}),
        },
      );
    }
  };

  return {
    create,
    archive,
    unarchive,
    archiveStore,
    sessionMetadataStore,
    setMetadata,
    getMetadata,
    send: (sessionID, payload) => runExisting('send', sessionID, payload),
    fork: (sessionID, payload) => runExisting('fork', sessionID, payload),
  };
};

const sendServiceError = (res, error, fallback) => {
  const controlError = asControlError(error, fallback);
  return res.status(controlError.statusCode).json({
    error: controlError.message,
    ...(controlError.partial === true ? {
      partial: true,
      partialAction: controlError.partialAction,
      sessionId: controlError.sessionId,
      directory: controlError.directory,
    } : {}),
  });
};

export const registerOpenChamberSessionRoutes = (app, dependencies) => {
  const service = dependencies.sessionService || createOpenChamberSessionService(dependencies);

  app.post('/api/openchamber/sessions', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      return res.json(await service.create(req.body && typeof req.body === 'object' ? req.body : {}));
    } catch (error) {
      console.error('[OpenChamberSessions] failed to create session:', error);
      return sendServiceError(res, error, 'Failed to create session');
    }
  });

  app.post('/api/openchamber/sessions/archive', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      return res.json(await service.archive(req.body && typeof req.body === 'object' ? req.body : {}));
    } catch (error) {
      console.error('[OpenChamberSessions] failed to archive sessions:', error);
      return sendServiceError(res, error, 'Failed to archive sessions');
    }
  });

  app.get('/api/openchamber/sessions/:sessionId/metadata', async (req, res) => {
    try {
      return res.json(await service.getMetadata(
        req.params.sessionId,
        asNonEmptyString(req.query?.directory) || '',
      ));
    } catch (error) {
      console.error('[OpenChamberSessions] failed to read session metadata:', error);
      return sendServiceError(res, error, 'Failed to read session metadata');
    }
  });

  app.post('/api/openchamber/sessions/:sessionId/metadata', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      return res.json(await service.setMetadata(
        req.params.sessionId,
        req.body && typeof req.body === 'object' ? req.body : {},
      ));
    } catch (error) {
      console.error('[OpenChamberSessions] failed to store session metadata:', error);
      return sendServiceError(res, error, 'Failed to store session metadata');
    }
  });

  app.post('/api/openchamber/sessions/unarchive', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      return res.json(await service.unarchive(req.body && typeof req.body === 'object' ? req.body : {}));
    } catch (error) {
      console.error('[OpenChamberSessions] failed to unarchive sessions:', error);
      return sendServiceError(res, error, 'Failed to unarchive sessions');
    }
  });

  app.post(
    '/api/openchamber/sessions/:sessionId/send',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      try {
        return res.json(await service.send(req.params.sessionId, req.body));
      } catch (error) {
        console.error('[OpenChamberSessions] failed to send session:', error);
        return sendServiceError(res, error, 'Failed to send session');
      }
    },
  );
  app.post(
    '/api/openchamber/sessions/:sessionId/fork',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      try {
        return res.json(await service.fork(req.params.sessionId, req.body));
      } catch (error) {
        console.error('[OpenChamberSessions] failed to fork session:', error);
        return sendServiceError(res, error, 'Failed to fork session');
      }
    },
  );
};
