import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Command } from './useCommandsStore';

import { registerAgentRuntime } from '@/lib/agent/registry';
import type { AgentRuntime } from '@/lib/agent/contract';

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Promise not initialized'); };
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  return { promise, resolve: (value: T) => resolve(value) };
}

let activeProjectPath = '/workspace/project';

let listCommandsCalls = 0;
let listCommandsImpl: (directory?: string | null) => Promise<Command[]> = async () => [];
let getDirectoryImpl: () => string = () => '/fallback/project';
// `/api/config/commands/:name/config` answers the stored entity plus where it
// lives; the v2 `CommandInfo` the list returns carries only name + description.
let runtimeFetchImpl: () => Promise<Response> = async () => new Response(
  JSON.stringify({ source: 'md', scope: 'project', path: null, legacy: false, config: {} }),
  { headers: { 'Content-Type': 'application/json' } },
);

const listCommandsMock = async (directory?: string | null) => {
  listCommandsCalls += 1;
  return listCommandsImpl(directory);
};

const getDirectoryMock = () => getDirectoryImpl();
let runtimeFetchCalls: string[] = [];
const runtimeFetchMock = async (url: string) => {
  runtimeFetchCalls.push(String(url));
  return runtimeFetchImpl();
};

// The store reads commands from the agent runtime; register a double whose
// `listCommands` is this test's deferred mock. The registry's default runtime
// is the real OMP client, and sessions created by the OpenCode client carry
// `runtimeId: "opencode"`, so register the double under both ids.
const createFakeRuntime = (id: string): AgentRuntime => ({
  id,
  listCommands: listCommandsMock,
} as unknown as AgentRuntime);
registerAgentRuntime(createFakeRuntime('omp'));
registerAgentRuntime(createFakeRuntime('opencode'));

mock.module('@/lib/openchamber/client', () => ({
  openChamberClient: {
    getDirectory: getDirectoryMock,
  },
}));

mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      getActiveProject: () => ({ path: activeProjectPath }),
    }),
  },
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: runtimeFetchMock,
}));

mock.module('@/lib/configUpdate', () => ({
  startConfigUpdate: mock(() => undefined),
  finishConfigUpdate: mock(() => undefined),
  updateConfigUpdateMessage: mock(() => undefined),
}));

mock.module('@/lib/configSync', () => ({
  emitConfigChange: mock(() => undefined),
  scopeMatches: mock(() => false),
  subscribeToConfigChanges: mock(() => () => undefined),
}));

const { useCommandsStore, invalidateCommandsLoadCache, selectCommandsForDirectory, selectCommandConfigStatus } = await import('./useCommandsStore');

describe('useCommandsStore', () => {
  beforeEach(() => {
    activeProjectPath = '/workspace/project';
    invalidateCommandsLoadCache(activeProjectPath);
    invalidateCommandsLoadCache('/workspace/other');
    listCommandsCalls = 0;
    runtimeFetchCalls = [];
    listCommandsImpl = async () => [];
    getDirectoryImpl = () => '/fallback/project';
    runtimeFetchImpl = async () => new Response(
      JSON.stringify({ source: 'md', scope: 'project', path: null, legacy: false, config: {} }),
      { headers: { 'Content-Type': 'application/json' } },
    );

    useCommandsStore.setState({
      selectedCommandName: null,
      commands: [],
      commandsByDirectory: {},
      commandConfigsByDirectory: {},
      isLoading: false,
      commandDraft: null,
    });
  });

  test('runtime reset rejects old discovery without deleting a new in-flight request or user draft', async () => {
    const old = deferred<Command[]>();
    const fresh = deferred<Command[]>();
    const draft = { name: 'unsaved', scope: 'project' as const, template: 'keep this draft' };
    useCommandsStore.getState().setCommandDraft(draft);
    listCommandsImpl = () => old.promise;
    const oldLoad = useCommandsStore.getState().loadCommands();
    await Promise.resolve();
    await Promise.resolve();
    useCommandsStore.getState().resetForRuntimeSwitch();
    listCommandsImpl = () => fresh.promise;
    const newLoad = useCommandsStore.getState().loadCommands();
    await Promise.resolve();
    await Promise.resolve();
    old.resolve([{ name: 'old-command' }]);
    expect(await oldLoad).toBe(false);
    expect(useCommandsStore.getState().isLoading).toBe(true);
    const joined = useCommandsStore.getState().loadCommands();
    await Promise.resolve();
    await Promise.resolve();
    expect(listCommandsCalls).toBe(2);
    fresh.resolve([{ name: 'new-command' }]);
    expect(await newLoad).toBe(true);
    expect(await joined).toBe(true);
    expect(useCommandsStore.getState().commands.map((command) => command.name)).toEqual(['new-command']);
    expect(useCommandsStore.getState().commandDraft).toBe(draft);
    useCommandsStore.getState().setCommandDraft(null);
  });

  test('responses from old-runtime command mutations cannot alter the new runtime cache', async () => {
    const actions = [
      () => useCommandsStore.getState().createCommand({ name: 'same', template: 'old template' }),
      () => useCommandsStore.getState().updateCommand('same', { template: 'old template' }),
      () => useCommandsStore.getState().deleteCommand('same'),
    ];
    for (const action of actions) {
      const response = deferred<Response>();
      runtimeFetchImpl = () => response.promise;
      const pending = action();
      useCommandsStore.getState().resetForRuntimeSwitch();
      const current = [{ name: 'same', template: 'new runtime template' }];
      useCommandsStore.setState({ commands: current, commandsByDirectory: { [activeProjectPath]: current } });
      response.resolve(Response.json({ requiresManualRestart: true }));
      expect(await pending).toBe(false);
      expect(useCommandsStore.getState().commands).toBe(current);
    }
  });

  test('loading another project leaves the active project\'s commands alone', async () => {
    // Settings can browse a project the app is not on. Chat reads `commands`,
    // so that list must keep describing the active project.
    const activeCommands = [{
      name: 'active-only',
      description: 'Active project command',
      template: 'run it',
      scope: 'project' as const,
    }];
    useCommandsStore.setState({
      commands: activeCommands,
      commandsByDirectory: { [activeProjectPath]: activeCommands },
    });
    listCommandsImpl = async () => [
      { name: 'other-only', description: 'Other project command', template: 'run there' },
    ];

    const result = await useCommandsStore.getState().loadCommands('/workspace/other');

    expect(result).toBe(true);
    const state = useCommandsStore.getState();
    expect(state.commands).toEqual(activeCommands);
    expect(state.commandsByDirectory['/workspace/other']?.map((command) => command.name)).toEqual(['other-only']);
    expect(state.commandsByDirectory[activeProjectPath]).toEqual(activeCommands);
  });

  test('loadCommands preserves previous commands when the command list fails', async () => {
    const previousCommands = [{
      name: 'existing',
      description: 'Existing command',
      template: 'do the previous thing',
      scope: 'project' as const,
    }];
    useCommandsStore.setState({ commands: previousCommands, commandsByDirectory: { [activeProjectPath]: previousCommands } });
    listCommandsImpl = async () => {
      throw new Error('network down');
    };

    const result = await useCommandsStore.getState().loadCommands();

    expect(result).toBe(false);
    expect(listCommandsCalls).toBe(3);
    expect(useCommandsStore.getState().commands).toEqual(previousCommands);
    expect(useCommandsStore.getState().isLoading).toBe(false);
  });

  test('first load publishes a directory even when its commands match the previous project', async () => {
    const commands = [{ name: 'shared', scope: 'project' as const, path: null, legacy: false }];
    useCommandsStore.setState({
      commands,
      commandsByDirectory: { '/workspace/other': commands },
    });
    listCommandsImpl = async () => commands;

    expect(await useCommandsStore.getState().loadCommands()).toBe(true);
    expect(selectCommandsForDirectory(useCommandsStore.getState(), activeProjectPath)).toEqual(commands);
    expect(await useCommandsStore.getState().loadCommands()).toBe(true);
    expect(listCommandsCalls).toBe(1);
  });

  test('revisiting a cached project restores its mirror without another request', async () => {
    listCommandsImpl = async () => [{ name: 'first' }];
    await useCommandsStore.getState().loadCommands();
    const firstCommands = useCommandsStore.getState().commands;
    activeProjectPath = '/workspace/other';
    listCommandsImpl = async () => [{ name: 'second' }];
    await useCommandsStore.getState().loadCommands();
    activeProjectPath = '/workspace/project';

    await useCommandsStore.getState().loadCommands();
    expect(useCommandsStore.getState().commands).toBe(firstCommands);
    expect(listCommandsCalls).toBe(2);

    invalidateCommandsLoadCache(activeProjectPath);
    listCommandsImpl = async () => [{ name: 'first' }];
    useCommandsStore.setState({ commands: [] });
    await useCommandsStore.getState().loadCommands();
    expect(useCommandsStore.getState().commands).toBe(firstCommands);
  });

  test('a late response only updates its own directory after a project switch', async () => {
    const pending = deferred<Command[]>();
    const started = deferred<void>();
    listCommandsImpl = async (directory) => {
      expect(directory).toBe('/workspace/project');
      started.resolve();
      return pending.promise;
    };
    const firstLoad = useCommandsStore.getState().loadCommands();
    await started.promise;
    activeProjectPath = '/workspace/other';
    listCommandsImpl = async () => [{ name: 'second' }];
    await useCommandsStore.getState().loadCommands();
    const secondCommands = useCommandsStore.getState().commands;
    pending.resolve([{ name: 'first' }]);
    await firstLoad;

    expect(useCommandsStore.getState().commands).toBe(secondCommands);
    expect(selectCommandsForDirectory(useCommandsStore.getState(), '/workspace/project').map(c => c.name)).toEqual(['first']);
  });

  test('successful empty discovery clears only that project and is cached', async () => {
    const commands = [{ name: 'old' }];
    useCommandsStore.setState({ commands, commandsByDirectory: { [activeProjectPath]: commands } });
    expect(await useCommandsStore.getState().loadCommands()).toBe(true);
    expect(selectCommandsForDirectory(useCommandsStore.getState(), activeProjectPath)).toEqual([]);
    expect(useCommandsStore.getState().commands).toEqual([]);
    await useCommandsStore.getState().loadCommands();
    expect(listCommandsCalls).toBe(1);
  });


  test('a failed first load cannot copy the previous project and can recover on retry', async () => {
    const otherCommands = [{ name: 'other-only' }];
    useCommandsStore.setState({ commands: otherCommands, commandsByDirectory: { '/workspace/other': otherCommands } });
    listCommandsImpl = async () => { throw new Error('unavailable'); };
    expect(await useCommandsStore.getState().loadCommands()).toBe(false);
    expect(useCommandsStore.getState().commands).toEqual([]);
    expect(useCommandsStore.getState().commandsByDirectory[activeProjectPath]).toBeUndefined();
    expect(selectCommandsForDirectory(useCommandsStore.getState(), '/workspace/other')).toBe(otherCommands);

    listCommandsImpl = async () => [{ name: 'recovered' }];
    expect(await useCommandsStore.getState().loadCommands()).toBe(true);
    expect(selectCommandsForDirectory(useCommandsStore.getState(), activeProjectPath).map(c => c.name)).toEqual(['recovered']);
  });

  test('listing commands issues no per-command config request', async () => {
    // OMP lists ~100 built-in commands and skills whose `/:name/config`
    // answers 501; asking per row flooded the network with answers the page
    // never used. The list is the only request a listing needs.
    listCommandsImpl = async () => Array.from({ length: 120 }, (_, index) => ({
      name: `command-${index}`,
      description: `Command ${index}`,
    }));

    expect(await useCommandsStore.getState().loadCommands()).toBe(true);

    expect(useCommandsStore.getState().commands).toHaveLength(120);
    expect(runtimeFetchCalls.filter((url) => url.includes('/config'))).toEqual([]);
  });

  test('opening a command whose config section is unsupported reports no editable config', async () => {
    listCommandsImpl = async () => [{ name: 'goal', description: 'Set a goal' }];
    await useCommandsStore.getState().loadCommands();
    runtimeFetchImpl = async () => new Response(
      JSON.stringify({ error: 'OMP has no commands section', code: 'OMP_UNSUPPORTED_CONFIG_SECTION' }),
      { status: 501, headers: { 'Content-Type': 'application/json' } },
    );

    expect(await useCommandsStore.getState().loadCommandConfig('goal')).toBe('none');
    expect(selectCommandConfigStatus(useCommandsStore.getState(), activeProjectPath, 'goal')).toBe('none');
    expect(runtimeFetchCalls.filter((url) => url.includes('commands/goal/config'))).toHaveLength(1);

    // The answer is cached: reopening the command must not ask again.
    expect(await useCommandsStore.getState().loadCommandConfig('goal')).toBe('none');
    expect(runtimeFetchCalls.filter((url) => url.includes('commands/goal/config'))).toHaveLength(1);
  });

  test('opening an editable command loads its config once and merges it into the list', async () => {
    listCommandsImpl = async () => [{ name: 'ship', description: 'Ship it' }];
    await useCommandsStore.getState().loadCommands();
    runtimeFetchImpl = async () => Response.json({
      source: 'md',
      scope: 'project',
      path: '/repo/.omp/commands/ship.md',
      legacy: true,
      config: { template: 'Ship the release.', description: 'Ship it', agent: 'builder' },
    });

    expect(await useCommandsStore.getState().loadCommandConfig('ship')).toBe('loaded');
    const stored = useCommandsStore.getState().commands.find((command) => command.name === 'ship');
    expect(stored?.template).toBe('Ship the release.');
    expect(stored?.scope).toBe('project');
    expect(stored?.path).toBe('/repo/.omp/commands/ship.md');
    expect(stored?.legacy).toBe(true);
    expect(runtimeFetchCalls.filter((url) => url.includes('commands/ship/config'))).toHaveLength(1);

    // Reopening is served from the loaded entry.
    expect(await useCommandsStore.getState().loadCommandConfig('ship')).toBe('loaded');
    expect(runtimeFetchCalls.filter((url) => url.includes('commands/ship/config'))).toHaveLength(1);
  });

  test('refreshing the list keeps an already-loaded editable config', async () => {
    listCommandsImpl = async () => [{ name: 'ship', description: 'Ship it' }];
    await useCommandsStore.getState().loadCommands();
    runtimeFetchImpl = async () => Response.json({
      source: 'md',
      scope: 'user',
      path: null,
      legacy: false,
      config: { template: 'Ship the release.' },
    });
    await useCommandsStore.getState().loadCommandConfig('ship');

    invalidateCommandsLoadCache(activeProjectPath);
    listCommandsImpl = async () => [{ name: 'ship', description: 'Ship it' }];
    expect(await useCommandsStore.getState().loadCommands()).toBe(true);

    const stored = useCommandsStore.getState().commands.find((command) => command.name === 'ship');
    expect(stored?.template).toBe('Ship the release.');
    expect(stored?.scope).toBe('user');
  });

  test('an in-flight settings load becomes the active mirror if its project is selected', async () => {
    const pending = deferred<Command[]>();
    listCommandsImpl = () => pending.promise;
    const settingsLoad = useCommandsStore.getState().loadCommands('/workspace/other');
    activeProjectPath = '/workspace/other';
    const activeLoad = useCommandsStore.getState().loadCommands();
    pending.resolve([{ name: 'selected' }]);
    expect(await settingsLoad).toBe(true);
    expect(await activeLoad).toBe(true);
    expect(listCommandsCalls).toBe(1);
    expect(useCommandsStore.getState().commands.map(c => c.name)).toEqual(['selected']);
  });

});
