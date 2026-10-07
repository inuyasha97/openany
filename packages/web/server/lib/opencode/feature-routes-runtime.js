import { registerFsRoutes } from '../fs/routes.js';
import { registerQuotaRoutes } from '../quota/routes.js';
import { registerSmallModelRoutes } from '../small-model/routes.js';
import { registerWalkthroughRoutes } from '../walkthrough/routes.js';
import { registerSessionGoalRoutes } from '../session-goal/routes.js';
import { registerGitHubRoutes } from '../github/routes.js';
import { registerLinearRoutes } from '../linear/routes.js';
import { registerGuestRoutes } from '../guests/routes.js';
import { registerBuiltInGuests } from '../guests/catalog.js';
import { extensionsPersistPath } from '../guests/persist.js';
import { registerGitRoutes } from '../git/routes.js';
import { registerDevServerRoutes } from '../dev-servers/routes.js';
import { registerMagicPromptRoutes } from '../magic-prompts/routes.js';
import { registerSessionFoldersRoutes } from '../session-folders/routes.js';
import { registerProjectContextRoutes } from '../project-context/routes.js';
import { registerProjectSetupRoutes } from '../projects/routes.js';
import { registerAgentMemoryRoutes } from '../agent-memory/routes.js';
import { registerSessionKnowledgeRoutes } from '../session-knowledge/routes.js';
import { registerPermissionAutoAcceptRoutes } from '../permission-auto-accept/runtime.js';
import { registerMessageQueueRoutes } from '../message-queue/runtime.js';
import { registerRoutingPromptRewrite, registerRoutingRoutes } from '../routing/routes.js';
import { registerSettingsUtilityRoutes } from '../openchamber/core-routes.js';
import { registerProjectIconRoutes } from '../openchamber/project-icon-routes.js';
import { registerScheduledTaskRoutes } from '../scheduled-tasks/routes.js';
import { registerOpenChamberSessionRoutes } from '../openchamber-sessions/routes.js';
import { registerOpenChamberControlRoutes } from '../openchamber-control/routes.js';
import { registerMarkdownImageGrantRoutes } from '../markdown-image-grants/routes.js';

/**
 * The worktree-removal hook: releases every session process the agent runtime
 * holds in that directory, so the folder is not locked while it is removed.
 * `undefined` when no runtime is mounted, which makes `removeWorktree` skip
 * disposal.
 */
const createWorktreeInstanceDisposer = (getOmpRuntime) => {
  if (typeof getOmpRuntime !== 'function') return undefined;
  return async (worktreeDirectory) => {
    const host = await Promise.resolve(getOmpRuntime()).catch(() => null);
    await host?.disposeSessionsInDirectory?.(worktreeDirectory);
  };
};

/**
 * Registers every OpenChamber-owned feature route. The OpenCode config-entity
 * routes (agents, commands, MCP, snippets, providers, plugins, skills) that
 * used to be registered here are gone with the OpenCode server: those config
 * files and their routes no longer exist.
 */
export const createFeatureRoutesRuntime = (dependencies) => {
  const {
    clientReloadDelayMs,
  } = dependencies;

  let quotaProviders = null;
  const getQuotaProviders = async () => {
    if (!quotaProviders) {
      quotaProviders = await import('../quota/index.js');
    }
    return quotaProviders;
  };

  let smallModelService = null;
  const getSmallModelService = async () => {
    if (!smallModelService) {
      smallModelService = await import('../small-model/index.js');
    }
    return smallModelService;
  };

  let walkthroughService = null;
  const getWalkthroughService = async () => {
    if (!walkthroughService) {
      const [service, pullRequest] = await Promise.all([
        import('../walkthrough/index.js'),
        import('../walkthrough/pull-request.js'),
      ]);
      walkthroughService = { ...service, getPullRequestDiff: pullRequest.getPullRequestDiff, getPullRequestFileContents: pullRequest.getPullRequestFileContents };
    }
    return walkthroughService;
  };

  const registerRoutes = async (app, routeDependencies) => {
    const {
      crypto,
      fs,
      os,
      path,
      fsPromises,
      spawn,
      resolveGitBinaryForSpawn,
      createFsSearchRuntime,
      openchamberDataDir,
      onGuestDeactivated,
      surfaceViewerHeaders,
      openchamberUserConfigRoot,
      managedChatsRoot,
      normalizeDirectoryPath,
      resolveProjectDirectory,
      resolveOptionalProjectDirectory,
      validateDirectoryPath,
      readCustomThemesFromDisk,
      saveImportedTheme,
      deleteImportedTheme,
      readSettingsFromDiskMigrated,
      persistSettings,
      sanitizeProjects,
      getOwnPorts,
      devServerScanner,
      buildAugmentedPath,
      projectConfigRuntime,
      projectContextRuntime,
      agentMemoryRuntime,
      isAgentMemoryEnabled,
      sessionKnowledgeRuntime,
      scheduledTasksRuntime,
      scheduledTaskService,
      openChamberSessionService,
      openChamberControlService,
      emitSessionCreatedEvent,
      getOpenChamberEventClients,
      writeSseEvent,
      permissionAutoAcceptRuntime,
      messageQueueRuntime,
      routingRuntime,
      openchamberVersion,
    } = routeDependencies;

    registerSettingsUtilityRoutes(app, {
      readCustomThemesFromDisk,
      saveImportedTheme,
      deleteImportedTheme,
      clientReloadDelayMs,
    });

    registerPermissionAutoAcceptRoutes(app, permissionAutoAcceptRuntime);
    registerMessageQueueRoutes(app, messageQueueRuntime);
    registerRoutingRoutes(app, routingRuntime);
    // Before the generic runtime proxy: swallows the `openchamber/auto` model
    // switch and routes the sends that follow it.
    registerRoutingPromptRewrite(app, routingRuntime);

    registerProjectIconRoutes(app, {
      fsPromises,
      path,
      crypto,
      openchamberDataDir,
      sanitizeProjects,
      readSettingsFromDiskMigrated,
      persistSettings,
      createFsSearchRuntime,
      spawn,
      resolveGitBinaryForSpawn,
    });

    registerScheduledTaskRoutes(app, {
      readSettingsFromDiskMigrated,
      sanitizeProjects,
      projectConfigRuntime,
      scheduledTasksRuntime,
      scheduledTaskService,
      getOpenChamberEventClients,
      writeSseEvent,
    });

    registerOpenChamberSessionRoutes(app, {
      readSettingsFromDiskMigrated,
      sanitizeProjects,
      validateDirectoryPath,
      emitSessionCreatedEvent,
      sessionService: openChamberSessionService,
    });

    registerOpenChamberControlRoutes(app, { controlService: openChamberControlService });

    registerMarkdownImageGrantRoutes(app, {
      fsPromises,
      path,
      os,
      crypto,
      validateDirectoryPath,
    });

    registerQuotaRoutes(app, { getQuotaProviders });
    registerSmallModelRoutes(app, { getSmallModelService });
    registerWalkthroughRoutes(app, { getWalkthroughService });
    registerSessionGoalRoutes(app);
    registerGitHubRoutes(app);
    registerLinearRoutes(app);
    await registerBuiltInGuests({ persistPath: extensionsPersistPath(openchamberDataDir), root: routeDependencies.builtInExtensionsDir });
    registerGuestRoutes(app, { openchamberDataDir, openchamberVersion, resolveGitBinaryForSpawn, resolveOptionalProjectDirectory, getSmallModelService, onGuestDeactivated, surfaceViewerHeaders });
    registerGitRoutes(app, {
      disposeWorktreeInstance: createWorktreeInstanceDisposer(routeDependencies.getOmpRuntime),
      emitWorktreeChanged: ({ directories, at }) => {
        const clients = getOpenChamberEventClients();
        for (const client of clients) {
          try {
            writeSseEvent(client, {
              type: 'openchamber:worktree-changed',
              properties: { directories, at },
            });
          } catch {
            clients.delete(client);
          }
        }
      },
    });
    registerDevServerRoutes(app, { scanner: devServerScanner, getOwnPorts });
    registerMagicPromptRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir,
    });
    registerProjectContextRoutes(app, { projectContextRuntime });
    registerProjectSetupRoutes(app, { projectConfigRuntime });
    registerAgentMemoryRoutes(app, { agentMemoryRuntime, isAgentMemoryEnabled });
    registerSessionKnowledgeRoutes(app, { sessionKnowledgeRuntime });

    registerSessionFoldersRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir,
    });
    registerFsRoutes(app, {
      os,
      path,
      fsPromises,
      spawn,
      crypto,
      normalizeDirectoryPath,
      resolveProjectDirectory,
      buildAugmentedPath,
      resolveGitBinaryForSpawn,
      openchamberUserConfigRoot,
      managedChatsRoot,
    });
  };

  return {
    registerRoutes,
  };
};
