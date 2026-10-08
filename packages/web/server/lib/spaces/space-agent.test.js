import { describe, expect, it } from 'vitest';

import { WINDOW_PLACEHOLDER_KEY, buildProviderConfig, createSpaceAgent } from './space-agent.js';

const ID = 'a1b2c3d4e5f6';
const GRANTS = [
  { kind: 'model', id: 'anthropic', provider: 'anthropic', upstream: 'https://api.anthropic.com/v1', header: 'x-api-key' },
  { kind: 'domain', id: 'open-1', upstream: 'https://registry.npmjs.org/' },
  { kind: 'model', id: 'openai', provider: 'openai', upstream: 'https://api.openai.com/v1', header: 'authorization' },
];

describe('buildProviderConfig', () => {
  it('names each granted provider as the host does, at the window, with a placeholder key, and leaves domains out', () => {
    expect(buildProviderConfig(GRANTS)).toEqual({
      providers: {
        anthropic: { baseUrl: 'http://gatekeeper:8080/model/anthropic', apiKey: WINDOW_PLACEHOLDER_KEY },
        openai: { baseUrl: 'http://gatekeeper:8080/model/openai', apiKey: WINDOW_PLACEHOLDER_KEY },
      },
    });
    expect(buildProviderConfig([])).toEqual({ providers: {} });
    // The upstream is the gatekeeper's business; nothing of it is written where the agent reads.
    expect(JSON.stringify(buildProviderConfig(GRANTS))).not.toContain('api.anthropic.com');
  });

  it('writes OMP\'s models.yml shape: no schema URL and no provider options wrapper', () => {
    const config = buildProviderConfig(GRANTS);
    expect(config).not.toHaveProperty('$schema');
    expect(config.providers.anthropic).not.toHaveProperty('options');
    expect(Object.keys(config.providers.anthropic)).toEqual(['baseUrl', 'apiKey']);
  });
});

describe('createSpaceAgent', () => {
  it('writes the whole file over exec, as YAML on stdin, through a temporary name, inside the agent directory', async () => {
    const calls = [];
    const agent = createSpaceAgent({ exec: async (spaceId, argv, options) => { calls.push({ spaceId, argv, options }); return { code: 0, stdout: '', stderr: '' }; } });
    await agent.writeProviderConfig(ID, GRANTS);
    expect(calls).toEqual([{
      spaceId: ID,
      argv: ['/bin/sh', '-c', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; mkdir -p /home/space/.omp/agent && cat > /home/space/.omp/agent/models.yml.new && mv /home/space/.omp/agent/models.yml.new /home/space/.omp/agent/models.yml'],
      options: {
        stdin: [
          'providers:',
          '  anthropic:',
          '    baseUrl: http://gatekeeper:8080/model/anthropic',
          '    apiKey: space-window',
          '  openai:',
          '    baseUrl: http://gatekeeper:8080/model/openai',
          '    apiKey: space-window',
          '',
        ].join('\n'),
      },
    }]);
  });

  it('says what failed inside', async () => {
    const agent = createSpaceAgent({ exec: async () => ({ code: 1, stdout: '', stderr: 'sh: cannot create: Read-only file system\n' }) });
    await expect(agent.writeProviderConfig(ID, GRANTS)).rejects.toMatchObject({ code: 'space_setup_failed', message: expect.stringContaining('Read-only file system') });
  });
});
