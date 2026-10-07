import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { McpServerStatus } from '@/lib/opencode/model';

import { registerAgentRuntime } from '@/lib/agent/registry';
import type { AgentRuntime } from '@/lib/agent/contract';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
};

let mcpStatusResponse: Deferred<McpServerStatus[]> = deferred();

// The store reads MCP status from the agent runtime; register a double whose
// `listMcpServers` is this test's deferred response. Register it under the
// default id and under `opencode`, the runtime id OpenCode-created sessions
// carry.
const createFakeRuntime = (id: string): AgentRuntime => ({
  id,
  listMcpServers: () => mcpStatusResponse.promise,
} as unknown as AgentRuntime);
registerAgentRuntime(createFakeRuntime('omp'));
registerAgentRuntime(createFakeRuntime('opencode'));

let skillsResponse: Deferred<Response> = deferred();
const runtimeFetchModule = await import('@/lib/runtime-fetch');
mock.module('@/lib/runtime-fetch', () => ({
  ...runtimeFetchModule,
  runtimeFetch: () => skillsResponse.promise,
}));

const { useMcpStore } = await import('./useMcpStore');
const { useSkillsStore } = await import('./useSkillsStore');

const connectedServer = (name: string): McpServerStatus[] => ([
  { name, status: { status: 'connected' } },
]);

describe('instance-scoped stores reject responses from the previous instance', () => {
  beforeEach(() => {
    mcpStatusResponse = deferred();
    skillsResponse = deferred();
    useMcpStore.getState().resetForRuntimeSwitch();
    useSkillsStore.getState().resetForRuntimeSwitch();
  });

  test('an MCP status in flight during a switch does not land in the new instance', async () => {
    const refresh = useMcpStore.getState().refresh({ directory: '/repo', silent: true });

    useMcpStore.getState().resetForRuntimeSwitch();
    mcpStatusResponse.resolve(connectedServer('from-instance-a'));
    await refresh;

    expect(useMcpStore.getState().getStatusForDirectory('/repo')).toEqual({});
  });

  test('an MCP status that arrives with no switch is stored', async () => {
    const refresh = useMcpStore.getState().refresh({ directory: '/repo', silent: true });
    mcpStatusResponse.resolve(connectedServer('server-a'));
    await refresh;

    expect(Object.keys(useMcpStore.getState().getStatusForDirectory('/repo'))).toEqual(['server-a']);
  });

  test('a skills load in flight during a switch does not land in the new instance', async () => {
    const load = useSkillsStore.getState().loadSkills('/repo');

    useSkillsStore.getState().resetForRuntimeSwitch();
    skillsResponse.resolve(new Response(
      JSON.stringify({ skills: [{ name: 'from-instance-a', path: '/repo/.agents/skills/a/SKILL.md' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    await load;

    expect(useSkillsStore.getState().skillsByDirectory['/repo']).toBe(undefined);
  });
});
