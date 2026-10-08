import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { devtools, persist } from "zustand/middleware";
import { openChamberClient } from "@/lib/openchamber/client";
import { getAgentRuntime } from "@/lib/agent/registry";
import {
  startConfigUpdate,
  finishConfigUpdate,
  updateConfigUpdateMessage,
} from "@/lib/configUpdate";
import { emitConfigChange, scopeMatches, subscribeToConfigChanges } from "@/lib/configSync";
import { createDeferredSafeJSONStorage } from "./utils/safeStorage";
import { useProjectsStore } from "@/stores/useProjectsStore";
import { runtimeFetch } from "@/lib/runtime-fetch";
import { runBackgroundNetworkTask } from '@/lib/background-network';


export type CommandScope = 'user' | 'project';

/**
 * The command entity as OpenChamber persists it, i.e. the OpenCode 2 shape the
 * config routes read and write. `template` is the markdown body of a `.md`
 * command; `model` is the joined `provider/model#variant` string; `subagent`
 * runs the command in a child session instead of the current one.
 */
export interface CommandConfig {
  name: string;
  description?: string;
  agent?: string | null;
  model?: string | null;
  source?: string;
  template?: string;
  subagent?: boolean;
  scope?: CommandScope;
}

export interface Command extends CommandConfig {
  isBuiltIn?: boolean;
  /** The file OpenChamber would rewrite on the next save. */
  path?: string | null;
  /** The file still uses v1 spellings; the next save rewrites it in v2. */
  legacy?: boolean;
}

// Built-in commands provided by OpenCode (not defined in user config directories)
const BUILTIN_COMMAND_NAMES = new Set(['init', 'review']);

/** What `GET /api/config/commands/:name/config` answers. */
export interface CommandEntityEnvelope {
  source: 'md' | 'json' | 'none';
  scope: CommandScope | null;
  path: string | null;
  legacy: boolean;
  config: Omit<CommandConfig, 'name' | 'scope' | 'source'>;
}

/**
 * How much of a command's editable half is known. The list carries only a
 * name and description, so the rest is fetched when the command is opened.
 * `none` is the server's typed 501 (`OMP_UNSUPPORTED_CONFIG_SECTION`) for a
 * command OMP has no editable config for, e.g. every built-in.
 */
export type CommandConfigStatus = 'unknown' | 'loading' | 'loaded' | 'none' | 'error';

interface CommandConfigEntry {
  status: Exclude<CommandConfigStatus, 'unknown'>;
  config?: Partial<Command>;
}

export const isCommandBuiltIn = (command: Command): boolean => {
  return BUILTIN_COMMAND_NAMES.has(command.name);
};

const CONFIG_EVENT_SOURCE = "useCommandsStore";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const COMMANDS_LOAD_CACHE_TTL_MS = 5000;
const DEFAULT_COMMANDS_CACHE_KEY = '__default__';
const commandsLastLoadedAt = new Map<string, number>();
const commandsLoadInFlight = new Map<string, Promise<boolean>>();
let commandsGeneration = 0;
const commandReadControllers = new Set<AbortController>();

const readCommandMetadata = <T>(generation: number, read: (signal: AbortSignal) => Promise<T>): Promise<T> => (
  runBackgroundNetworkTask(async () => {
    if (generation !== commandsGeneration) throw new Error('Command discovery superseded');
    const controller = new AbortController();
    commandReadControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(new Error('Command discovery timed out')), 30_000);
    try {
      return await read(controller.signal);
    } finally {
      clearTimeout(timeout);
      commandReadControllers.delete(controller);
    }
  })
);

const getCommandsCacheKey = (directory: string | null): string => {
  return directory?.trim() || DEFAULT_COMMANDS_CACHE_KEY;
};

export const invalidateCommandsLoadCache = (directory: string | null = getRequestDirectory()) => {
  commandsLastLoadedAt.delete(getCommandsCacheKey(directory));
};

const buildCommandsSignature = (commands: Command[]): string => {
  return commands
    .map((command) => [
      command.name,
      command.scope ?? '',
      command.description ?? '',
      command.agent ?? '',
      command.model ?? '',
      command.template ?? '',
      String(command.subagent === true),
      String(command.legacy === true),
      String(command.isBuiltIn === true),
    ].join('|'))
    .join('||');
};

/** Fold every already-loaded config into the fresh list entries. */
const mergeKnownConfig = (
  commands: Command[],
  entries: Record<string, CommandConfigEntry> | undefined,
): Command[] => {
  if (!entries) return commands;
  return commands.map((command) => {
    const entry = entries[command.name];
    if (!entry || entry.status !== 'loaded' || !entry.config) return command;
    return {
      ...command,
      ...entry.config,
      name: command.name,
      description: entry.config.description ?? command.description,
    };
  });
};

type CommandsStoreSet = (updater: (state: CommandsStore) => Partial<CommandsStore>) => void;

/** Record a command's config state, publishing its editable fields when loaded. */
const writeCommandConfig = (
  set: CommandsStoreSet,
  get: () => CommandsStore,
  cacheKey: string,
  name: string,
  entry: CommandConfigEntry,
) => {
  set((state) => {
    const previous = state.commandConfigsByDirectory[cacheKey]?.[name];
    const resolved: CommandConfigEntry = entry.status === 'loaded'
      ? { status: 'loaded', config: { ...(previous?.config ?? {}), ...(entry.config ?? {}) } }
      : entry;
    const entries = { ...(state.commandConfigsByDirectory[cacheKey] ?? {}), [name]: resolved };
    const next: Partial<CommandsStore> = {
      commandConfigsByDirectory: { ...state.commandConfigsByDirectory, [cacheKey]: entries },
    };
    const list = state.commandsByDirectory[cacheKey];
    if (resolved.status === 'loaded' && list) {
      const nextList = mergeKnownConfig(list, entries);
      next.commandsByDirectory = { ...state.commandsByDirectory, [cacheKey]: nextList };
      if (cacheKey === getCommandsCacheKey(getRequestDirectory())) next.commands = nextList;
    }
    return next;
  });
};

/** Drop every trace of a command's config, so a same-named command starts fresh. */
const clearCommandConfig = (set: CommandsStoreSet, cacheKey: string, name: string) => {
  set((state) => {
    const entries = { ...(state.commandConfigsByDirectory[cacheKey] ?? {}) };
    delete entries[name];
    return { commandConfigsByDirectory: { ...state.commandConfigsByDirectory, [cacheKey]: entries } };
  });
};

const upsertCommandLocal = (
  set: (updater: (state: CommandsStore) => Partial<CommandsStore>) => void,
  get: () => CommandsStore,
  name: string,
  config: Partial<CommandConfig>,
  directory: string | null,
) => {
  const cacheKey = getCommandsCacheKey(directory);
  const isAmbient = cacheKey === getCommandsCacheKey(getRequestDirectory());
  const current = get().commandsByDirectory[cacheKey] ?? [];
  const existing = current.find((command) => command.name === name);
  const nextCommand: Command = {
    ...existing,
    name,
    ...config,
    source: config.source ?? existing?.source,
    scope: config.scope ?? existing?.scope,
    isBuiltIn: existing?.isBuiltIn,
  };
  const nextCommands = current.some((command) => command.name === name)
    ? current.map((command) => (command.name === name ? nextCommand : command))
    : [...current, nextCommand];
  set((state) => {
    const next: Partial<CommandsStore> = {
      commandsByDirectory: { ...state.commandsByDirectory, [cacheKey]: nextCommands },
      commandConfigsByDirectory: {
        ...state.commandConfigsByDirectory,
        [cacheKey]: { ...(state.commandConfigsByDirectory[cacheKey] ?? {}), [name]: { status: 'loaded', config } },
      },
    };
    if (isAmbient) next.commands = nextCommands;
    return next;
  });
};

const removeCommandLocal = (
  set: (updater: (state: CommandsStore) => Partial<CommandsStore>) => void,
  get: () => CommandsStore,
  name: string,
  directory: string | null,
) => {
  const cacheKey = getCommandsCacheKey(directory);
  const isAmbient = cacheKey === getCommandsCacheKey(getRequestDirectory());
  const nextCommands = (get().commandsByDirectory[cacheKey] ?? []).filter((command) => command.name !== name);
  const clearSelection = get().selectedCommandName === name;
  set((state) => {
    const entries = { ...(state.commandConfigsByDirectory[cacheKey] ?? {}) };
    delete entries[name];
    const next: Partial<CommandsStore> = {
      commandsByDirectory: { ...state.commandsByDirectory, [cacheKey]: nextCommands },
      commandConfigsByDirectory: { ...state.commandConfigsByDirectory, [cacheKey]: entries },
    };
    if (isAmbient) next.commands = nextCommands;
    if (clearSelection) next.selectedCommandName = null;
    return next;
  });
};

/**
 * Directory a call operates on. Settings can browse another project without
 * moving the app, so every entry point takes one; omitting it means the project
 * the app is currently on.
 */
const resolveDirectory = (directory?: string | null): string | null => {
  if (directory !== undefined) {
    const trimmed = directory?.trim();
    return trimmed ? trimmed : null;
  }
  return getRequestDirectory();
};

const getRequestDirectory = (): string | null => {
  try {
    const projectsStore = useProjectsStore.getState();
    const activeProject = projectsStore.getActiveProject?.();
    
    // 1. Primary: Active project path from store
    if (activeProject?.path?.trim()) {
      return activeProject.path.trim();
    }

    // 2. Fallback: current OpenCode directory (session / runtime)
    const clientDir = openChamberClient.getDirectory();
    if (clientDir?.trim()) {
      return clientDir.trim();
    }
  } catch (err) {
    console.warn('[CommandsStore] Error resolving config directory:', err);
  }

  return null;
};

const MAX_HEALTH_WAIT_MS = 20000;
const FAST_HEALTH_POLL_INTERVAL_MS = 300;
const FAST_HEALTH_POLL_ATTEMPTS = 4;
const SLOW_HEALTH_POLL_BASE_MS = 800;
const SLOW_HEALTH_POLL_INCREMENT_MS = 200;
const SLOW_HEALTH_POLL_MAX_MS = 2000;

export interface CommandDraft {
  name: string;
  scope: CommandScope;
  description?: string;
  agent?: string | null;
  model?: string | null;
  template?: string;
  subagent?: boolean;
}

interface CommandsStore {

  selectedCommandName: string | null;
  /** Commands of the project the app is on. Chat and autocompletes read this one. */
  commands: Command[];
  /** Every directory loaded so far, including the ambient one. */
  commandsByDirectory: Record<string, Command[]>;
  /** Per-directory, per-command editable-config state, filled when a command is opened. */
  commandConfigsByDirectory: Record<string, Record<string, CommandConfigEntry>>;
  isLoading: boolean;
  commandDraft: CommandDraft | null;

  setSelectedCommand: (name: string | null) => void;
  setCommandDraft: (draft: CommandDraft | null) => void;
  loadCommands: (directory?: string | null) => Promise<boolean>;
  loadCommandConfig: (name: string, directory?: string | null) => Promise<CommandConfigStatus>;
  resetForRuntimeSwitch: () => void;
  createCommand: (config: CommandConfig, directory?: string | null) => Promise<boolean>;
  updateCommand: (name: string, config: Partial<CommandConfig>, directory?: string | null) => Promise<boolean>;
  deleteCommand: (name: string, directory?: string | null) => Promise<boolean>;
  getCommandByName: (name: string, directory?: string | null) => Command | undefined;
}

declare global {
  interface Window {
    __zustand_commands_store__?: UseBoundStore<StoreApi<CommandsStore>>;
  }
}

const EMPTY_COMMANDS: Command[] = [];

/**
 * Commands of one project. Returns a stored array so components can select it
 * directly; an omitted directory means the project the app is on.
 */
export const selectCommandsForDirectory = (
  state: Pick<CommandsStore, 'commandsByDirectory'>,
  directory?: string | null,
): Command[] => {
  const cacheKey = getCommandsCacheKey(resolveDirectory(directory));
  return state.commandsByDirectory[cacheKey] ?? EMPTY_COMMANDS;
};

/**
 * How much of a command's editable half is known for the given directory.
 * Panels use this to decide whether to ask the server for it and whether the
 * command has an editable config at all.
 */
export const selectCommandConfigStatus = (
  state: Pick<CommandsStore, 'commandConfigsByDirectory'>,
  directory: string | null | undefined,
  name: string | null | undefined,
): CommandConfigStatus => {
  if (!name) return 'unknown';
  const cacheKey = getCommandsCacheKey(resolveDirectory(directory));
  return state.commandConfigsByDirectory[cacheKey]?.[name]?.status ?? 'unknown';
};

export const useCommandsStore = create<CommandsStore>()(
  devtools(
    persist(
      (set, get) => ({

        selectedCommandName: null,
        commands: [],
        commandsByDirectory: {},
        commandConfigsByDirectory: {},
        isLoading: false,
        commandDraft: null,

        setSelectedCommand: (name: string | null) => {
          set({ selectedCommandName: name });
        },

        setCommandDraft: (draft: CommandDraft | null) => {
          set({ commandDraft: draft });
        },

        resetForRuntimeSwitch: () => {
          commandsGeneration += 1;
          for (const controller of commandReadControllers) controller.abort();
          commandReadControllers.clear();
          commandsLastLoadedAt.clear();
          commandsLoadInFlight.clear();
          set({ commands: [], commandsByDirectory: {}, commandConfigsByDirectory: {}, isLoading: false });
        },

        loadCommandConfig: async (name, requestedDirectory) => {
          const directory = resolveDirectory(requestedDirectory);
          const cacheKey = getCommandsCacheKey(directory);
          const existing = get().commandConfigsByDirectory[cacheKey]?.[name];
          // Any known answer is final for this session: retrying a 501 or a
          // failure on every render is exactly the flood this replaced.
          if (existing) return existing.status;

          const generation = commandsGeneration;
          writeCommandConfig(set, get, cacheKey, name, { status: 'loading' });
          try {
            const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';
            const response = await runtimeFetch(`/api/config/commands/${encodeURIComponent(name)}/config${queryParams}`, {
              headers: {
                'Cache-Control': 'no-cache',
                ...(directory ? { 'x-opencode-directory': directory } : {}),
              },
            });
            if (generation !== commandsGeneration) return 'unknown';

            if (response.ok) {
              // SAFETY: `/api/config/commands/:name/config` is OpenChamber's
              // own route; it normalizes the entry through `config-v2.js`
              // before answering.
              const data = await response.json() as CommandEntityEnvelope;
              if (generation !== commandsGeneration) return 'unknown';
              const scope = data.scope === 'project' || data.scope === 'user' ? data.scope : undefined;
              writeCommandConfig(set, get, cacheKey, name, {
                status: 'loaded',
                config: {
                  ...data.config,
                  scope,
                  path: data.path,
                  legacy: data.legacy === true,
                },
              });
              return 'loaded';
            }

            // OMP keeps commands as markdown files, so a command it lists but
            // has no file for (every built-in) answers the typed 501. That is
            // "nothing to edit here", not a failure.
            if (response.status === 501) {
              writeCommandConfig(set, get, cacheKey, name, { status: 'none' });
              return 'none';
            }

            writeCommandConfig(set, get, cacheKey, name, { status: 'error' });
            return 'error';
          } catch (error) {
            if (generation !== commandsGeneration) return 'unknown';
            console.warn(`[CommandsStore] Failed to load config for command ${name}:`, error);
            writeCommandConfig(set, get, cacheKey, name, { status: 'error' });
            return 'error';
          }
        },

        loadCommands: async (requestedDirectory?: string | null) => {
          const directory = resolveDirectory(requestedDirectory);
          const cacheKey = getCommandsCacheKey(directory);
          const isAmbient = cacheKey === getCommandsCacheKey(getRequestDirectory());
          const now = Date.now();
          const loadedAt = commandsLastLoadedAt.get(cacheKey) ?? 0;
          const cachedCommands = get().commandsByDirectory[cacheKey];
          if (isAmbient && get().commands !== (cachedCommands ?? EMPTY_COMMANDS)) {
            set({ commands: cachedCommands ?? EMPTY_COMMANDS });
          }

          if (cachedCommands !== undefined && now - loadedAt < COMMANDS_LOAD_CACHE_TTL_MS) {
            return true;
          }

          const inFlight = commandsLoadInFlight.get(cacheKey);
          if (inFlight) {
            return inFlight;
          }

          const generation = commandsGeneration;
          const request = (async () => {
            set({ isLoading: true });
            // Only this directory can supply the comparison baseline. The mirror
            // may still describe the project we just left.
            const previousCommands = get().commandsByDirectory[cacheKey];
            const previousSignature = buildCommandsSignature(previousCommands ?? EMPTY_COMMANDS);
            let lastError: unknown = null;

            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                // The list is scoped to the directory we write config for. It
                // carries the name and description the sidebar shows; a
                // command's editable fields are fetched only when it is
                // opened, because OMP lists built-in commands and skills whose
                // `/:name/config` is a 501.
                const commands = await readCommandMetadata(generation, (signal) => getAgentRuntime().listCommands(directory, signal));
                if (generation !== commandsGeneration) return false;

                const commandsWithConfig = mergeKnownConfig(commands, get().commandConfigsByDirectory[cacheKey]);
                if (generation !== commandsGeneration) return false;

                const nextSignature = buildCommandsSignature(commandsWithConfig);
                const nextCommands = previousCommands !== undefined && previousSignature === nextSignature
                  ? previousCommands
                  : commandsWithConfig;
                set((state) => {
                  const next: Partial<CommandsStore> = { isLoading: false };
                  if (state.commandsByDirectory[cacheKey] !== nextCommands) {
                    next.commandsByDirectory = { ...state.commandsByDirectory, [cacheKey]: nextCommands };
                  }
                  if (cacheKey === getCommandsCacheKey(getRequestDirectory())) {
                    next.commands = nextCommands;
                  }
                  return next;
                });
                commandsLastLoadedAt.set(cacheKey, Date.now());
                return true;
              } catch (error) {
                if (generation !== commandsGeneration) return false;
                lastError = error;
                const waitMs = 200 * (attempt + 1);
                await new Promise((resolve) => setTimeout(resolve, waitMs));
              }
            }

            if (generation !== commandsGeneration) return false;
            console.error("Failed to load commands:", lastError);
            // Keep the current directory cache, including edits made during the load.
            set({ isLoading: false });
            return false;
          })();

          commandsLoadInFlight.set(cacheKey, request);
          try {
            return await request;
          } finally {
            if (commandsLoadInFlight.get(cacheKey) === request) commandsLoadInFlight.delete(cacheKey);
          }
        },

        createCommand: async (config: CommandConfig, requestedDirectory?: string | null) => {
          const generation = commandsGeneration;
          try {
            console.log('[CommandsStore] Creating command:', config.name);

            const commandConfig: Record<string, unknown> = {
              template: config.template || '',
            };

            if (config.description) commandConfig.description = config.description;
            if (config.agent) commandConfig.agent = config.agent;
            if (config.model) commandConfig.model = config.model;
            if (config.subagent !== undefined) commandConfig.subagent = config.subagent;
            if (config.scope) commandConfig.scope = config.scope;

            const directory = resolveDirectory(requestedDirectory);
            const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';

            const response = await runtimeFetch(`/api/config/commands/${encodeURIComponent(config.name)}${queryParams}`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(directory ? { 'x-opencode-directory': directory } : {}),
              },
              body: JSON.stringify(commandConfig)
            });

            const payload = await response.json().catch(() => null);
            if (generation !== commandsGeneration) return false;
            if (!response.ok) {
              const message = payload?.error || 'Failed to create command';
              throw new Error(message);
            }

            console.log('[CommandsStore] Command created successfully');

            invalidateCommandsLoadCache(directory);
            // A newly created command's file exists, so its editable fields are
            // known without asking the server again.
            writeCommandConfig(set, get, getCommandsCacheKey(directory), config.name, { status: 'loaded', config });

            if (payload?.requiresManualRestart) {
              upsertCommandLocal(set, get, config.name, config, directory);
              return true;
            }

            if (payload?.requiresReload) {
              startConfigUpdate("Creating command configuration…");
              await performFullConfigRefresh({
                message: payload?.message,
                delayMs: payload?.reloadDelayMs,
              });
              return generation === commandsGeneration;
            }

            const loaded = await get().loadCommands(directory);
            if (generation !== commandsGeneration) return false;
            if (loaded) {
              emitConfigChange("commands", { source: CONFIG_EVENT_SOURCE });
            }
            return loaded;
          } catch (error) {
            console.error("[CommandsStore] Failed to create command:", error);
            return false;
          }
        },

        updateCommand: async (name: string, config: Partial<CommandConfig>, requestedDirectory?: string | null) => {
          const generation = commandsGeneration;
          try {
            console.log('[CommandsStore] Updating command:', name);

            const commandConfig: Record<string, unknown> = {};

            if (config.description !== undefined) commandConfig.description = config.description;
            if (config.agent !== undefined) commandConfig.agent = config.agent;
            if (config.model !== undefined) commandConfig.model = config.model;
            if (config.template !== undefined) commandConfig.template = config.template;
            if (config.subagent !== undefined) commandConfig.subagent = config.subagent;

            const directory = resolveDirectory(requestedDirectory);
            const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';

            const response = await runtimeFetch(`/api/config/commands/${encodeURIComponent(name)}${queryParams}`, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                ...(directory ? { 'x-opencode-directory': directory } : {}),
              },
              body: JSON.stringify(commandConfig)
            });

            const payload = await response.json().catch(() => null);
            if (generation !== commandsGeneration) return false;
            if (!response.ok) {
              const message = payload?.error || 'Failed to update command';
              throw new Error(message);
            }

            console.log('[CommandsStore] Command updated successfully');

            invalidateCommandsLoadCache(directory);
            // The reloaded list carries only names and descriptions; keep the
            // fields we just wrote so the open editor is not reset to empty.
            writeCommandConfig(set, get, getCommandsCacheKey(directory), name, { status: 'loaded', config });

            if (payload?.requiresManualRestart) {
              upsertCommandLocal(set, get, name, config, directory);
              return true;
            }

            if (payload?.requiresReload) {
              startConfigUpdate("Updating command configuration…");
              await performFullConfigRefresh({
                message: payload?.message,
                delayMs: payload?.reloadDelayMs,
              });
              return generation === commandsGeneration;
            }

            const loaded = await get().loadCommands(directory);
            if (generation !== commandsGeneration) return false;
            if (loaded) {
              emitConfigChange("commands", { source: CONFIG_EVENT_SOURCE });
            }
            return loaded;
          } catch (error) {
            console.error("[CommandsStore] Failed to update command:", error);
            return false;
          }
        },

        deleteCommand: async (name: string, requestedDirectory?: string | null) => {
          const generation = commandsGeneration;
          try {
            // Use active project root for project-level command support
            const directory = resolveDirectory(requestedDirectory);
            const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';

            const response = await runtimeFetch(`/api/config/commands/${encodeURIComponent(name)}${queryParams}`, {
              method: 'DELETE',
              headers: directory ? { 'x-opencode-directory': directory } : undefined,
            });

            const payload = await response.json().catch(() => null);
            if (generation !== commandsGeneration) return false;
            if (!response.ok) {
              const message = payload?.error || 'Failed to delete command';
              throw new Error(message);
            }

            console.log('[CommandsStore] Command deleted successfully');

            invalidateCommandsLoadCache(directory);
            clearCommandConfig(set, getCommandsCacheKey(directory), name);

            if (payload?.requiresManualRestart) {
              removeCommandLocal(set, get, name, directory);
              return true;
            }

            if (payload?.requiresReload) {
              startConfigUpdate("Deleting command configuration…");
              await performFullConfigRefresh({
                message: payload?.message,
                delayMs: payload?.reloadDelayMs,
              });
              return generation === commandsGeneration;
            }

            const loaded = await get().loadCommands(directory);
            if (generation !== commandsGeneration) return false;
            if (loaded) {
              emitConfigChange("commands", { source: CONFIG_EVENT_SOURCE });
            }

            if (get().selectedCommandName === name) {
              set({ selectedCommandName: null });
            }

            return loaded;
          } catch (error) {
            console.error("Failed to delete command:", error);
            return false;
          }
        },

        getCommandByName: (name: string, requestedDirectory?: string | null) => {
          return selectCommandsForDirectory(get(), requestedDirectory).find((command) => command.name === name);
        },
      }),
      {
        name: "commands-store",
        storage: createDeferredSafeJSONStorage(),
        partialize: (state) => ({
          selectedCommandName: state.selectedCommandName,
        }),
      },
    ),
    {
      name: "commands-store",
    },
  ),
);

if (typeof window !== "undefined") {
  window.__zustand_commands_store__ = useCommandsStore;
}

async function waitForOpenCodeConnection(delayMs?: number) {
  const initialPause = typeof delayMs === "number" && delayMs > 0
    ? Math.min(delayMs, FAST_HEALTH_POLL_INTERVAL_MS)
    : 0;

  if (initialPause > 0) {
    await sleep(initialPause);
  }

  const start = Date.now();
  let attempt = 0;
  let lastError: unknown = null;

  while (Date.now() - start < MAX_HEALTH_WAIT_MS) {
    attempt += 1;
    updateConfigUpdateMessage(`Waiting for OpenCode… (attempt ${attempt})`);

    try {
      const isHealthy = await openChamberClient.checkHealth();
      if (isHealthy) {
        return;
      }
      lastError = new Error("OpenCode health check reported not ready");
    } catch (error) {
      lastError = error;
    }

    const elapsed = Date.now() - start;

    const waitMs =
      attempt <= FAST_HEALTH_POLL_ATTEMPTS && elapsed < 1200
        ? FAST_HEALTH_POLL_INTERVAL_MS
        : Math.min(
            SLOW_HEALTH_POLL_BASE_MS +
              Math.max(0, attempt - FAST_HEALTH_POLL_ATTEMPTS) * SLOW_HEALTH_POLL_INCREMENT_MS,
            SLOW_HEALTH_POLL_MAX_MS,
          );

    await sleep(waitMs);
  }

  throw lastError || new Error("OpenCode did not become ready in time");
}

async function performFullConfigRefresh(options: { message?: string; delayMs?: number } = {}) {
  const { message, delayMs } = options;
  const generation = commandsGeneration;

  try {
    updateConfigUpdateMessage(message || "Refreshing commands…");
  } catch {
    // ignore
  }

  try {
    await waitForOpenCodeConnection(delayMs);
    if (generation !== commandsGeneration) return;
    updateConfigUpdateMessage("Refreshing commands…");

    const commandsStore = useCommandsStore.getState();

    invalidateCommandsLoadCache();
    await commandsStore.loadCommands();
    if (generation !== commandsGeneration) return;

    emitConfigChange("commands", { source: CONFIG_EVENT_SOURCE });
  } catch (error) {
    console.error("[CommandsStore] Failed to refresh configuration after OpenCode restart:", error);
    updateConfigUpdateMessage("OpenCode refresh failed. Please retry refreshing configuration manually.");
    await sleep(1500);
    throw error;
  } finally {
    finishConfigUpdate();
  }
}

let unsubscribeCommandsConfigChanges: (() => void) | null = null;

if (!unsubscribeCommandsConfigChanges) {
  unsubscribeCommandsConfigChanges = subscribeToConfigChanges((event) => {
    if (event.source === CONFIG_EVENT_SOURCE) {
      return;
    }

    if (scopeMatches(event, "commands")) {
      const { loadCommands } = useCommandsStore.getState();
      void loadCommands();
    }
  });
}
