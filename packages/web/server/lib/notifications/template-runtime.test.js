import { afterEach, describe, expect, it, vi } from 'vitest';

import { configureOmpRuntimeHost } from '../agents/omp-host-access.js';
import { createNotificationTemplateRuntime } from './template-runtime.js';

const createRuntime = (settings = {}) => createNotificationTemplateRuntime({
  readSettingsFromDisk: async () => settings,
  persistSettings: vi.fn(async () => {}),
  resolveGitBinaryForSpawn: () => 'git',
});

afterEach(() => {
  configureOmpRuntimeHost(null);
});

describe('notification template runtime zen models', () => {
  it('returns no selectable zen models after provider retirement', async () => {
    const runtime = createRuntime();
    const models = await runtime.fetchFreeZenModels();

    expect(models).toEqual([]);
  });

  it('preserves stored zen model value for compatibility without validation', async () => {
    const runtime = createRuntime({ zenModel: 'trinity-large-preview-free' });

    await expect(runtime.resolveZenModel()).resolves.toBe('trinity-large-preview-free');
  });
});

describe('notification template message extraction', () => {
  it('excludes reasoning parts from payload message text', () => {
    const runtime = createRuntime();

    expect(runtime.extractLastMessageText({
      properties: {
        info: {
          parts: [
            { type: 'reasoning', text: 'private chain of thought' },
            { type: 'text', text: 'final answer' },
          ],
        },
      },
    })).toBe('final answer');
  });

  it('ignores untyped parts even when they contain text', () => {
    const runtime = createRuntime();

    expect(runtime.extractLastMessageText({
      properties: {
        info: {
          parts: [
            { text: 'untyped text' },
            { content: 'untyped content' },
            { type: 'text', text: 'typed final answer' },
          ],
        },
      },
    })).toBe('typed final answer');
  });

  it('excludes reasoning parts when fetching assistant messages', async () => {
    // The canonical `{ info, parts }` page the OMP host serves, oldest first.
    configureOmpRuntimeHost(() => ({
      getMessages: async () => ({
        items: [
          { info: { id: 'msg-u', sessionID: 'session-1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'ask' }] },
          {
            info: { id: 'msg-1', sessionID: 'session-1', role: 'assistant', finish: 'stop', time: { created: 1, completed: 2 } },
            parts: [
              { type: 'reasoning', text: 'private chain of thought' },
              { type: 'text', text: 'final answer' },
            ],
          },
        ],
        cursor: {},
      }),
      listSessions: async () => [],
    }));
    const runtime = createRuntime();

    await expect(runtime.fetchLastAssistantMessageText('session-1', 'msg-1')).resolves.toBe('final answer');
  });

  it('reads the session title from the runtime record', async () => {
    configureOmpRuntimeHost(() => ({
      listSessions: async () => [{ id: 'session-1', sessionPath: '/sessions/1.jsonl', cwd: '/repo', title: 'Fix the billing export' }],
      getMessages: async () => ({ items: [], cursor: {} }),
    }));
    const runtime = createRuntime();

    await expect(runtime.buildTemplateVariables({ properties: { info: {} } }, 'session-1'))
      .resolves.toMatchObject({ session_name: 'Fix the billing export' });
  });
});
