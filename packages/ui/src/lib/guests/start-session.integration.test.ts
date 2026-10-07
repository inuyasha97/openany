import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import type { AgentSession } from '@/lib/agent/contract';
import { openChamberClient } from '@/lib/openchamber/client';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import * as sessionActions from '@/sync/session-actions';
import { startGuestSession } from './start-session';
import * as worktreeCreate from '@/lib/worktrees/worktreeCreate';
import * as worktreeBootstrap from '@/lib/worktrees/worktreeBootstrap';
import * as projectConfig from '@/lib/openchamberConfig';
import * as sharedTrust from '@/lib/sharedTrustConfirmation';

import { registerAgentRuntime } from '@/lib/agent/registry';
import { createOpenCodeStubRuntime } from '@/lib/agent/testing/opencode-stub-runtime';
import { createOpenCodeStubSurface } from '@/lib/agent/testing/opencode-stub-runtime';
const agentSurface = createOpenCodeStubSurface()

// The registry's default runtime is the real OMP client; register a
// client-backed double so this test drives app logic with its mocked client.
registerAgentRuntime(createOpenCodeStubRuntime());
// Sessions the OpenCode client created carry `runtimeId: "opencode"`; the
// registry answers an unregistered id with the real OMP client, so register the
// double under that id too.
registerAgentRuntime(createOpenCodeStubRuntime('opencode'));

const created: AgentSession = {
  id: 'background-session', runtimeId: 'opencode', nativeSessionId: 'background-session', directory: '/project-b', title: 'Task', projectID: 'b', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
};
afterEach(() => mock.restore());
const setup = () => {
  // `agentSurface` starts empty and `spyOn` cannot install a method on a missing
  // key, so register a real mock the stub can answer from; `mock.restore()` in
  // afterEach clears it between tests.
  const create = mock(async (_input: unknown, directory?: string | null) => ({ ...created, directory: directory ?? created.directory }));
  agentSurface.createSession = create;
  spyOn(sessionActions, 'setLinkedIssue').mockResolvedValue(created);
  useProjectsStore.setState({ hasServerSnapshot: true, projects: [{ id: 'a', path: '/project-a', addedAt: 1 }, { id: 'b', path: '/project-b', addedAt: 1 }], activeProjectId: 'a' });
  useSessionUIStore.setState({ currentSessionId: 'existing-chat', currentSessionDirectory: '/project-a' });
  useUIStore.getState().setOpenGuestPage('board');
  return create;
};

test('a guest session in another project registers without changing the open page or chat', async () => {
  const create = setup();
  const result = await startGuestSession({ directory: '/project-a', t: (key) => key, assertAuthorized: () => {},
    request: { providerId: 'board', id: 'TASK-1', title: 'Task', url: 'https://example.com/task', projectId: 'b' } });
  expect(create.mock.calls[0]?.[1]).toBe('/project-b');
  expect(result).toMatchObject({ sessionId: created.id, directory: '/project-b', sent: 'skipped', linked: true });
  expect(useSessionUIStore.getState().currentSessionId).toBe('existing-chat');
  expect(useSessionUIStore.getState().currentSessionDirectory).toBe('/project-a');
  expect(useProjectsStore.getState().activeProjectId).toBe('a');
  expect(useUIStore.getState().openGuestPageId).toBe('board');
  expect(useGlobalSessionsStore.getState().entityById.get(created.id)?.directory).toBe('/project-b');
});

test('named worktrees forward the base ref through existing creation and keep bootstrap failures explicit', async () => {
  const create = setup();
  const createTree = spyOn(worktreeCreate, 'createWorktreeWithDefaults').mockResolvedValue({
    path: '/isolated-fix', projectDirectory: '/project-b', branch: 'fix-login', label: 'fix-login', name: 'fix-login', worktreeStatus: 'pending',
  });
  spyOn(sharedTrust, 'resolveWorktreeSetupCommands').mockResolvedValue([]);
  spyOn(projectConfig, 'getWorktreeSetupWaitEnabled').mockResolvedValue(true);
  spyOn(worktreeBootstrap, 'waitForWorktreeBootstrap').mockRejectedValue(new Error('Setup failed'));
  const result = await startGuestSession({ directory: '/project-a', t: (key) => key, assertAuthorized: () => {},
    request: { providerId: 'board', id: 'TASK-2', title: 'Task', url: 'https://example.com/task', projectId: 'b', worktree: { kind: 'new', name: 'fix-login', baseBranch: 'release' } } });
  expect(createTree.mock.calls[0]?.[0]).toMatchObject({ id: 'b', path: '/project-b' });
  expect(createTree.mock.calls[0]?.[1]).toMatchObject({ branchName: 'fix-login', worktreeName: 'fix-login', startRef: 'release' });
  expect(create.mock.calls.length).toBe(0);
  expect(result).toMatchObject({ sessionId: null, failure: 'bootstrap-failed', directory: '/isolated-fix', worktree: { branch: 'fix-login' } });
  expect(useUIStore.getState().openGuestPageId).toBe('board');
});

test('existing worktrees create sessions in their directory without creating or scanning worktrees', async () => {
  const create = setup();
  useSessionUIStore.setState({ availableWorktreesByProject: new Map([['/project-b', [{
    path: '/existing', projectDirectory: '/project-b', branch: 'existing', label: 'existing', worktreeStatus: 'ready',
  }]]]) });
  const tree = spyOn(worktreeCreate, 'createWorktreeWithDefaults');
  spyOn(projectConfig, 'getWorktreeSetupWaitEnabled').mockResolvedValue(false);
  const result = await startGuestSession({ directory: '/project-a', t: (key) => key, assertAuthorized: () => {},
    request: { providerId: 'board', id: 'TASK-3', title: 'Task', url: 'https://example.com/task', projectId: 'b', worktree: { kind: 'existing', directory: '/existing' } } });
  expect(create.mock.calls[0]?.[1]).toBe('/existing');
  expect(tree.mock.calls.length).toBe(0);
  expect(result).toMatchObject({ sessionId: created.id, directory: '/existing', worktree: { branch: 'existing' } });
  expect(useSessionUIStore.getState().currentSessionId).toBe('existing-chat');
});

test('a replaced SDK client cannot publish a late creation even when the runtime key is unchanged', async () => {
  const create = setup();
  let client = openChamberClient;
  spyOn(openChamberClient, 'getRuntimeIdentity').mockImplementation(() => `stub-${Math.random()}`);
  create.mockImplementation(async () => {
    client = openChamberClient;
    return { ...created, id: 'late-session' };
  });
  const result = await sessionActions.createSession('Late', '/project-b', undefined, undefined, undefined, 'preserve');
  expect(result).toBeNull();
  expect(useGlobalSessionsStore.getState().entityById.has('late-session')).toBe(false);
  expect(useSessionUIStore.getState().currentSessionId).toBe('existing-chat');
});
