import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureOmpRuntimeHost } from '../agents/omp-host-access.js';
import { registerSmallModelRoutes } from './routes.js';
import { resetOpenCodeRuntimeProviders } from './client.js';

// The settings override is read straight from disk, so without this the suite
// would resolve whatever small model the developer running it has configured.
const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'small-model-settings-'));
process.env.OPENCHAMBER_DATA_DIR = TEMP_DATA_DIR;

const { generateSmallModelText, describeSmallModel, listAuthenticatedProviders } = await import('./index.js');

/** An OMP catalog entry: what `getOmpRuntimeHost().listModels()` reports. */
const MODEL = (overrides = {}) => ({
  id: 'claude-haiku-4-5',
  provider: 'anthropic',
  name: 'Claude Haiku',
  contextWindow: 8_000,
  maxTokens: 4_000,
  input: ['text'],
  ...overrides,
});

/** A canonical history record for an assistant turn. */
const assistantItem = (text, { completed = 1 } = {}) => ({
  info: {
    role: 'assistant',
    time: completed === undefined ? { created: 1 } : { created: 1, completed },
  },
  parts: typeof text === 'string' ? [{ type: 'text', text }] : [],
});

// The module reads the OMP runtime host per call, so a fake host exercises the
// same catalog and session shapes the running server sees.
const state = {
  models: [],
  created: [],
  deleted: [],
  setModels: [],
  prompts: [],
  /** `(id) => history page`; replace to fail or to keep a turn incomplete. */
  history: async () => ({ items: [assistantItem('generated')] }),
  nextId: 1,
};

const host = {
  listModels: async () => state.models,
  createSession: async (input = {}) => {
    const id = `throwaway-${state.nextId++}`;
    state.created.push({ id, cwd: input.cwd });
    return { id };
  },
  setModel: async (id, provider, modelId) => { state.setModels.push({ id, provider, modelId }); },
  prompt: async (id, text) => { state.prompts.push({ id, text }); return true; },
  getMessages: (id) => state.history(id),
  deleteSession: async (id) => { state.deleted.push(id); return true; },
};

beforeEach(() => {
  state.models = [MODEL()];
  state.created = [];
  state.deleted = [];
  state.setModels = [];
  state.prompts = [];
  state.history = async () => ({ items: [assistantItem('generated')] });
  state.nextId = 1;
  configureOmpRuntimeHost(() => host);
  resetOpenCodeRuntimeProviders();
});

afterEach(() => {
  configureOmpRuntimeHost(null);
});

afterAll(() => {
  fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true });
});

describe('generateSmallModelText', () => {
  it('rejects a missing prompt without opening a session', async () => {
    await expect(generateSmallModelText({ prompt: '   ' })).rejects.toMatchObject({ statusCode: 400 });
    expect(state.created).toEqual([]);
  });

  it('round-trips create → setModel → prompt → messages → delete', async () => {
    const result = await generateSmallModelText({
      prompt: 'write a commit',
      directory: '/proj',
      model: 'anthropic/claude-haiku-4-5',
    });

    expect(result).toEqual({
      text: 'generated',
      providerID: 'anthropic',
      modelID: 'claude-haiku-4-5',
      source: 'request',
    });
    expect(state.created).toEqual([{ id: 'throwaway-1', cwd: '/proj' }]);
    expect(state.setModels).toEqual([{ id: 'throwaway-1', provider: 'anthropic', modelId: 'claude-haiku-4-5' }]);
    expect(state.prompts).toEqual([{ id: 'throwaway-1', text: 'write a commit' }]);
    expect(state.deleted).toEqual(['throwaway-1']);
  });

  it('leads the prompt with the system instructions', async () => {
    await generateSmallModelText({
      prompt: 'the task',
      system: 'you are terse',
      directory: '/proj',
      model: 'anthropic/claude-haiku-4-5',
    });

    expect(state.prompts[0].text).toBe('you are terse\n\nthe task');
  });

  it('falls back to the temp directory when the caller names none', async () => {
    await generateSmallModelText({ prompt: 'hi', model: 'anthropic/claude-haiku-4-5' });

    expect(state.created[0].cwd).toBe(os.tmpdir());
  });

  it('resolves the small model of the preferred provider', async () => {
    state.models = [MODEL({ id: 'claude-sonnet-5' }), MODEL({ id: 'claude-haiku-4-5' })];

    const result = await generateSmallModelText({ prompt: 'hi', directory: '/proj', preferredProviderID: 'anthropic' });

    expect(result).toMatchObject({ providerID: 'anthropic', modelID: 'claude-haiku-4-5', source: 'session-provider-small' });
  });

  it('joins every text part of the newest completed assistant turn', async () => {
    state.history = async () => ({
      items: [
        assistantItem('old'),
        { info: { role: 'assistant', time: { created: 2 } }, parts: [{ type: 'text', text: 'partial' }] },
        { info: { role: 'assistant', time: { created: 3, completed: 3 } }, parts: [{ type: 'text', text: 'first ' }, { type: 'text', text: 'second' }] },
      ],
    });

    const result = await generateSmallModelText({ prompt: 'hi', model: 'anthropic/claude-haiku-4-5' });

    expect(result.text).toBe('first second');
  });

  it('deletes the throwaway session even when the read fails', async () => {
    state.history = async () => { throw new Error('history read failed'); };

    await expect(generateSmallModelText({ prompt: 'hi', model: 'anthropic/claude-haiku-4-5' })).rejects.toThrow('history read failed');
    expect(state.deleted).toEqual(['throwaway-1']);
  });

  it('deletes the throwaway session even when the prompt fails', async () => {
    const failing = { ...host, prompt: async () => { throw new Error('prompt rejected'); } };
    configureOmpRuntimeHost(() => failing);

    await expect(generateSmallModelText({ prompt: 'hi', model: 'anthropic/claude-haiku-4-5' })).rejects.toThrow('prompt rejected');
    expect(state.deleted).toEqual(['throwaway-1']);
  });

  it('times out without an answer and still deletes the session', async () => {
    state.history = async () => ({ items: [{ info: { role: 'assistant', time: { created: 1 } }, parts: [{ type: 'text', text: 'partial' }] }] });

    await expect(generateSmallModelText({ prompt: 'hi', model: 'anthropic/claude-haiku-4-5', timeoutMs: 20 }))
      .rejects.toMatchObject({ statusCode: 504, code: 'small-model-timeout' });
    expect(state.deleted).toEqual(['throwaway-1']);
  });

  it('fails as no small model when the runtime is not mounted', async () => {
    configureOmpRuntimeHost(null);

    await expect(generateSmallModelText({ prompt: 'hi' })).rejects.toMatchObject({ statusCode: 404 });
    expect(state.created).toEqual([]);
  });

  it('fails as no small model when nothing resolves', async () => {
    await expect(generateSmallModelText({ prompt: 'hi', directory: '/proj' })).rejects.toMatchObject({ statusCode: 404 });
    expect(state.created).toEqual([]);
  });

  it('refuses structured output rather than pretending', async () => {
    await expect(generateSmallModelText({
      prompt: 'describe',
      model: 'anthropic/claude-haiku-4-5',
      responseSchema: { type: 'object' },
    })).rejects.toMatchObject({ statusCode: 422, code: 'structured-output-unsupported' });
    expect(state.created).toEqual([]);
  });

  it('truncates and flags an oversized prompt by default', async () => {
    const result = await generateSmallModelText({
      prompt: 'x'.repeat(20_000),
      model: 'anthropic/claude-haiku-4-5',
      directory: '/proj',
    });

    expect(result.inputTruncated).toBe(true);
    expect(state.prompts[0].text.length).toBeLessThan(20_000);
    expect(state.prompts[0].text.endsWith('…')).toBe(true);
  });

  it('refuses without opening a session when the caller cannot survive truncation', async () => {
    await expect(generateSmallModelText({
      prompt: 'x'.repeat(20_000),
      model: 'anthropic/claude-haiku-4-5',
      directory: '/proj',
      onOverflow: 'error',
    })).rejects.toMatchObject({
      statusCode: 413,
      code: 'context-too-small',
      requiredChars: 20_000,
      availableChars: 16_000,
    });

    expect(state.created).toEqual([]);
  });
});

describe('describeSmallModel', () => {
  it('answers null when the runtime is not mounted', async () => {
    configureOmpRuntimeHost(null);

    expect(await describeSmallModel({ directory: '/proj' })).toBeNull();
  });

  // OpenCode's default-model lookup has no OMP equivalent: with no explicit
  // model, no settings override and no provider there is nothing to resolve.
  it('answers null when nothing resolves', async () => {
    expect(await describeSmallModel({ directory: '/proj' })).toBeNull();
  });

  it('resolves the small model of the preferred provider from the catalog', async () => {
    state.models = [
      MODEL({ id: 'claude-sonnet-5' }),
      MODEL({ id: 'claude-haiku-4-5' }),
      MODEL({ id: 'gemini-3.6-flash', provider: 'google' }),
    ];

    const described = await describeSmallModel({ directory: '/proj', preferredProviderID: 'anthropic' });

    expect(described).toMatchObject({
      providerID: 'anthropic',
      modelID: 'claude-haiku-4-5',
      source: 'session-provider-small',
      inputCharBudget: 16_000,
      contextTokens: 8_000,
      contextKnown: true,
      hasLogin: true,
      outputTokenLimit: 4_000,
      // The capability is not knowable before a call, so it is never a
      // settled `false` — callers must try it.
      structuredOutput: null,
    });
  });

  it('answers null when the preferred provider has no small family', async () => {
    state.models = [MODEL({ id: 'claude-sonnet-5' })];

    const described = await describeSmallModel({
      directory: '/proj',
      preferredProviderID: 'anthropic',
      preferredModelID: 'claude-sonnet-5',
    });

    expect(described).toBeNull();
  });

  it('honours an explicit override model', async () => {
    const described = await describeSmallModel({ directory: '/proj', overrideModel: 'google/gemini-3.6-flash' });

    expect(described).toMatchObject({ providerID: 'google', modelID: 'gemini-3.6-flash', source: 'request' });
  });

  it('reports the settings override instead of the provider small model', async () => {
    fs.writeFileSync(
      path.join(TEMP_DATA_DIR, 'settings.json'),
      JSON.stringify({ smallModelUseDefault: false, smallModelOverride: 'openai/gpt-5.6-luna' }),
    );

    try {
      const described = await describeSmallModel({ directory: '/proj', preferredProviderID: 'anthropic' });
      expect(described).toMatchObject({ providerID: 'openai', modelID: 'gpt-5.6-luna', source: 'settings' });
    } finally {
      fs.rmSync(path.join(TEMP_DATA_DIR, 'settings.json'), { force: true });
    }
  });

  it('reads the family from the model id when the catalog has none', async () => {
    state.models = [
      MODEL({ id: 'my-big-model', provider: 'my-proxy' }),
      MODEL({ id: 'gemini-3.6-flash', provider: 'my-proxy' }),
    ];

    const described = await describeSmallModel({ directory: '/proj', preferredProviderID: 'my-proxy' });

    expect(described).toMatchObject({ providerID: 'my-proxy', modelID: 'gemini-3.6-flash', source: 'session-provider-small' });
  });

  it('finds a derived catalog entry by its wire model id', async () => {
    state.models = [MODEL({ id: 'claude-haiku-4-5', requestModelId: 'claude-haiku-4-5-20260101' })];

    const described = await describeSmallModel({
      directory: '/proj',
      overrideModel: 'anthropic/claude-haiku-4-5-20260101',
    });

    // Matched through `modelID`, so the limits come back with it.
    expect(described).toMatchObject({ contextTokens: 8_000, outputTokenLimit: 4_000 });
  });

  it('lets the reserve be decided from the resolved model limits', async () => {
    state.models = [MODEL({ contextWindow: 100_000, maxTokens: 8_000 })];

    const described = await describeSmallModel({
      directory: '/proj',
      preferredProviderID: 'anthropic',
      outputReserveTokens: ({ contextTokens, outputTokenLimit }) => Math.min(contextTokens / 10, outputTokenLimit),
    });

    // 100k context, 8k output limit → 8k reserved, leaving 92k tokens.
    expect(described.outputTokens).toBe(8_000);
    expect(described.inputCharBudget).toBe(92_000 * 4);
  });

  it('falls back to a conservative context when the catalog does not list the model', async () => {
    state.models = [];

    const described = await describeSmallModel({ directory: '/proj', overrideModel: 'ghost/not-listed' });

    expect(described).toMatchObject({ contextKnown: false, contextTokens: 64_000, hasLogin: true });
    expect(described.inputCharBudget).toBe(60_000 * 4);
  });
});

describe('listAuthenticatedProviders', () => {
  it('offers a provider the catalog has a model for', async () => {
    expect(await listAuthenticatedProviders()).toEqual(['anthropic']);
  });

  it('offers each provider once', async () => {
    state.models = [MODEL(), MODEL({ id: 'haiku', provider: 'claude-code' })];

    expect(await listAuthenticatedProviders()).toEqual(['anthropic', 'claude-code']);
  });

  it('answers an empty list when the runtime is not mounted', async () => {
    configureOmpRuntimeHost(null);

    expect(await listAuthenticatedProviders()).toEqual([]);
  });
});

describe('small model routes', () => {
  const handlers = { get: {}, post: {} };
  const app = {
    get(route, handler) { handlers.get[route] = handler; },
    post(route, handler) { handlers.post[route] = handler; },
  };
  registerSmallModelRoutes(app, { getSmallModelService: async () => import('./index.js') });

  const respond = () => {
    const response = { statusCode: 200, payload: undefined };
    response.status = (value) => { response.statusCode = value; return response; };
    response.json = (value) => { response.payload = value; };
    return response;
  };

  it('reports availability and the authenticated providers', async () => {
    const response = respond();
    await handlers.get['/api/small-model']({ query: {} }, response);

    expect(response.payload).toEqual({ available: false, model: null, authenticatedProviders: ['anthropic'] });
  });

  it('reports the resolved model for a provider the caller names', async () => {
    const response = respond();
    await handlers.get['/api/small-model']({ query: { providerID: 'anthropic' } }, response);

    expect(response.payload).toMatchObject({
      available: true,
      model: { providerID: 'anthropic', modelID: 'claude-haiku-4-5', source: 'session-provider-small' },
    });
  });

  it('returns the generated text on POST', async () => {
    const response = respond();
    await handlers.post['/api/small-model/generate']({ body: { prompt: 'commit', model: 'anthropic/claude-haiku-4-5' } }, response);

    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({ text: 'generated', providerID: 'anthropic', modelID: 'claude-haiku-4-5' });
  });

  it('surfaces the unavailable failure on POST', async () => {
    configureOmpRuntimeHost(null);
    const response = respond();
    await handlers.post['/api/small-model/generate']({ body: { prompt: 'commit' } }, response);

    expect(response.statusCode).toBe(404);
    expect(response.payload).toEqual({ error: 'No small model available — the OMP runtime is not reachable' });
  });
});
