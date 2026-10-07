import fs from 'fs';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'os';
import path from 'path';
import { getOmpRuntimeHost } from '../agents/omp-host-access.js';
import { readMergedSettingsSync } from '../openchamber/settings-files.js';
import { findModelInfo, listModelInfos } from './client.js';

const DEFAULT_TIMEOUT_MS = 60_000;

const OPENCHAMBER_SETTINGS_FILE = path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'settings.json',
);

// OpenChamber's own settings: when the user unchecks "use default small model"
// their explicit override outranks the model the runtime would pick.
const readSmallModelSettingsOverride = () => {
  const settings = readMergedSettingsSync({ fs, path, settingsFilePath: OPENCHAMBER_SETTINGS_FILE });
  if (settings.smallModelUseDefault !== false) return null;
  const override = typeof settings.smallModelOverride === 'string' ? settings.smallModelOverride.trim() : '';
  return override || null;
};

export function parseModelRef(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return {
    providerID: trimmed.slice(0, slash),
    modelID: trimmed.slice(slash + 1),
  };
}

// Rough safety clamp so a huge input never blows the model's context window.
// Token estimate is ~4 chars/token; when the runtime reports no limit for the
// model a conservative default applies.
const DEFAULT_CONTEXT_TOKENS = 64_000;
const OUTPUT_RESERVE_TOKENS = 4_000;

/**
 * Input budget in characters, given how much of the context the caller intends
 * to leave for the answer. The reserve must match the output budget the caller
 * will actually request, or the two disagree and the model overruns its context.
 */
export const getModelInputCharBudget = ({ modelInfo, outputReserveTokens }) => {
  const context = Number(modelInfo?.limit?.context);
  const known = context > 0;
  const contextTokens = known ? context : DEFAULT_CONTEXT_TOKENS;
  const reserve = Number(outputReserveTokens) > 0 ? Number(outputReserveTokens) : OUTPUT_RESERVE_TOKENS;
  const inputBudgetTokens = Math.max(1_000, contextTokens - reserve);
  return { maxChars: inputBudgetTokens * 4, contextTokens, contextKnown: known };
};

/**
 * The output budget the caller asked for, capped by what the model admits it
 * can emit. A session prompt takes no output budget of its own, so this number
 * only shapes the input reserve — but it has to stay the same number on both
 * sides or a caller that asks for a large answer overruns the context.
 */
const resolveOutputTokens = ({ modelInfo, maxOutputTokens }) => {
  const requested = Number(maxOutputTokens) > 0 ? Number(maxOutputTokens) : 0;
  if (!requested) return undefined;
  const limit = Number(modelInfo?.limit?.output);
  return limit > 0 ? Math.min(requested, limit) : requested;
};

// `truncate` keeps the historical behavior for callers whose prompt losing its
// tail is survivable (summaries, commit messages). `error` is for callers whose
// output would be quietly wrong on a clipped input — they need the failure.
const clampPromptToModelLimit = ({ prompt, modelInfo, providerID, modelID, onOverflow, outputReserveTokens }) => {
  const { maxChars } = getModelInputCharBudget({ modelInfo, outputReserveTokens });
  if (prompt.length <= maxChars) {
    return { prompt, truncated: false };
  }
  if (onOverflow === 'error') {
    throw Object.assign(
      new Error(`Input is too large for ${providerID}/${modelID}: ${prompt.length} characters exceeds the ${maxChars} the model's context allows`),
      { statusCode: 413, code: 'context-too-small', providerID, modelID, requiredChars: prompt.length, availableChars: maxChars },
    );
  }
  return { prompt: `${prompt.slice(0, maxChars)}…`, truncated: true };
};

/**
 * The model families that count as "small", most preferred first. The same
 * list OpenCode used for its own session titles (`Catalog.model.small` in
 * `packages/core/src/catalog.ts`); OMP exposes no such lookup, so the scan is
 * repeated here on the catalog.
 */
export const SMALL_MODEL_FAMILY_PRIORITY = ['gpt-luna', 'gemini-flash-lite', 'gemini-flash', 'claude-haiku', 'gpt-nano', 'gpt-mini'];
// The last two are not on OpenCode's list; v1 counted them as small and a
// provider with nothing else cheap (Copilot's utility models, for one)
// would otherwise fall through to the session's big model.

/**
 * A model's family: the catalog's `family` (models.dev) when it has one,
 * else read from the id. OMP reports no family, so every model takes the id
 * path — a custom provider or a subscription outside the catalog has no
 * `family`, yet its `gemini-3.6-flash` is still a flash.
 */
export const familyOf = (model) => {
  if (model?.family) return String(model.family);
  const id = String(model?.id ?? '').toLowerCase();
  if (id.includes('luna')) return 'gpt-luna';
  if (id.includes('flash-lite') || id.includes('flash_lite')) return 'gemini-flash-lite';
  if (id.includes('flash')) return 'gemini-flash';
  if (id.includes('haiku')) return 'claude-haiku';
  if (id.includes('nano')) return 'gpt-nano';
  if (id.includes('mini') && !id.includes('minimax')) return 'gpt-mini';
  return null;
};

/**
 * The small model within one provider: the newest enabled, active, text-in
 * text-out model of the first family in `SMALL_MODEL_FAMILY_PRIORITY` that the
 * provider has. Null when the provider has none of those families.
 */
export const pickSmallModelInProvider = (models, providerID) => pickSmallModel(models, (model) => model.providerID === providerID);

const pickSmallModel = (models, accept) => {
  const candidates = models
    .filter((model) => model && accept(model)
      && model.enabled !== false
      && (model.status === undefined || model.status === 'active')
      && (model.capabilities?.input ?? ['text']).some((item) => String(item).startsWith('text'))
      && (model.capabilities?.output ?? ['text']).some((item) => String(item).startsWith('text')))
    .sort((a, b) => (Number(b.time?.released) || 0) - (Number(a.time?.released) || 0));
  for (const family of SMALL_MODEL_FAMILY_PRIORITY) {
    const found = candidates.find((model) => familyOf(model) === family);
    if (found) return { providerID: found.providerID, modelID: found.id };
  }
  return null;
};

/**
 * Which model a resolution lands on, in order:
 *
 * 1. An explicit request model.
 * 2. OpenChamber's settings override (Settings → Sessions → Small Model).
 * 3. The small model of the caller's provider — the session's, or the one
 *    in the composer (family scan above) — `session-provider-small`. A caller
 *    that must not leave that provider then takes its own model
 *    (`session-model`): costlier, but never someone else's subscription.
 *
 * OpenCode's step 4 (`GET /api/model/default`) has no OMP equivalent — the
 * runtime exposes no default-model lookup — so a caller with no explicit
 * model, no settings override and no provider has nothing to resolve and gets
 * `null`.
 *
 * There is no step that picks a small model from whichever other provider
 * happens to be connected: the content (diffs, replies, session text) goes
 * only where the user sent their own work or configured on purpose.
 */
const resolveSmallModel = ({ models, model, preferredProviderID, preferredModelID, restrictToPreferredProvider }) => {
  const explicit = parseModelRef(model);
  if (explicit) return { ...explicit, source: 'request' };

  const fromSettings = parseModelRef(readSmallModelSettingsOverride());
  if (fromSettings) return { ...fromSettings, source: 'settings' };

  if (preferredProviderID) {
    const small = pickSmallModelInProvider(models, preferredProviderID);
    if (small) return { ...small, source: 'session-provider-small' };
  }
  if (restrictToPreferredProvider && preferredProviderID && preferredModelID) {
    return { providerID: preferredProviderID, modelID: preferredModelID, source: 'session-model' };
  }

  return null;
};

const noModelError = (reason) => Object.assign(
  new Error(`No small model available — ${reason}`),
  { statusCode: 404 },
);

/**
 * The text of an assistant record's text parts. Content lives in `parts` in
 * the canonical model, not in the message.
 */
const textOfParts = (parts) => (Array.isArray(parts) ? parts : [])
  .filter((part) => part?.type === 'text' && typeof part.text === 'string')
  .map((part) => part.text)
  .join('');

/**
 * The newest completed assistant reply on a history page, or `null` while the
 * turn is still running. The history only carries a turn once it is persisted,
 * so a completed assistant record with text is the reply.
 */
const findAssistantReply = (page) => {
  const items = Array.isArray(page?.items) ? page.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.info?.role !== 'assistant') continue;
    if (item.info.time?.completed === undefined) continue;
    const text = textOfParts(item.parts);
    if (text.trim()) return text;
  }
  return null;
};

const REPLY_POLL_MS = 250;

/**
 * Waits for the throwaway session's assistant reply. `prompt` returns as soon
 * as the runtime accepts the turn — events stream after — so the history is
 * polled until the reply lands, the deadline passes, or the caller aborts.
 */
const waitForAssistantReply = async ({ host, sessionId, timeoutMs, signal }) => {
  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeout;
  for (;;) {
    const reply = findAssistantReply(await host.getMessages(sessionId));
    if (reply !== null) return reply;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw Object.assign(
        new Error('Small model generation timed out'),
        { statusCode: 504, code: 'small-model-timeout' },
      );
    }
    await delay(Math.min(REPLY_POLL_MS, remaining), undefined, { signal });
  }
};

/**
 * Generates text with the user's small model through a throwaway OMP session.
 *
 * The OMP runtime has no one-shot generate, so a session is opened for the
 * call, pointed at the resolved model, prompted once, read back, and deleted —
 * always, even when the read fails. The session never outlives the call.
 * Credentials stay inside the runtime; this server only sends a prompt.
 *
 * Structured output stays out of scope: the runtime has no schema mode, and
 * the module will not pretend a reply matched one.
 */
export async function generateSmallModelText({ prompt, system, maxOutputTokens, model, directory, preferredProviderID, preferredModelID, restrictToPreferredProvider = false, responseSchema, timeoutMs, signal, onOverflow = 'truncate' }) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw Object.assign(new Error('prompt is required'), { statusCode: 400 });
  }
  if (responseSchema) {
    throw Object.assign(
      new Error('Structured output is not available — the OMP runtime has no structured-output mode'),
      { statusCode: 422, code: 'structured-output-unsupported' },
    );
  }

  const host = await getOmpRuntimeHost();
  if (!host) throw noModelError('the OMP runtime is not reachable');

  const models = (await listModelInfos()) ?? [];
  const resolved = resolveSmallModel({
    models,
    model,
    preferredProviderID,
    preferredModelID,
    restrictToPreferredProvider,
  });
  if (!resolved) throw noModelError('the OMP runtime resolved no model');

  // A caller that must stay on its session's provider is only overruled by an
  // explicit user choice (the settings override or a request model).
  if (restrictToPreferredProvider
    && !['settings', 'request'].includes(resolved.source)
    && preferredProviderID
    && resolved.providerID !== preferredProviderID) {
    throw noModelError('no model within the session provider');
  }

  const modelInfo = findModelInfo(models, resolved.providerID, resolved.modelID);
  const outputTokens = resolveOutputTokens({ modelInfo, maxOutputTokens });
  const clamped = clampPromptToModelLimit({
    prompt: prompt.trim(),
    modelInfo,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    onOverflow,
    outputReserveTokens: outputTokens,
  });

  // A session prompt takes one message, so the system instructions lead it.
  const sections = [];
  if (typeof system === 'string' && system.trim()) sections.push(system.trim());
  sections.push(clamped.prompt);
  const fullPrompt = sections.join('\n\n');

  const cwd = typeof directory === 'string' && directory.trim() ? directory.trim() : os.tmpdir();
  const session = await host.createSession({ cwd });
  let text;
  try {
    await host.setModel(session.id, resolved.providerID, resolved.modelID);
    await host.prompt(session.id, fullPrompt);
    text = await waitForAssistantReply({ host, sessionId: session.id, timeoutMs, signal });
  } finally {
    await host.deleteSession(session.id);
  }

  return {
    text: text.trim(),
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    source: resolved.source,
    ...(clamped.truncated ? { inputTruncated: true } : {}),
  };
}

/**
 * Provider ids the small model can call. A provider counts when the runtime
 * has at least one model for it — OMP's catalog already excludes providers it
 * has no credential for, and it exposes no provider list of its own.
 */
export async function listAuthenticatedProviders() {
  const models = await listModelInfos();
  if (!models) return [];
  const ids = new Set();
  for (const model of models) {
    if (model?.enabled === false) continue;
    if (typeof model.providerID === 'string' && model.providerID) ids.add(model.providerID);
  }
  return Array.from(ids);
}

/**
 * The reserve, resolved against the model that was actually picked.
 *
 * A caller that wants "as much answer room as this model allows" cannot state a
 * number up front — it does not know which model it will get. Passing a
 * function lets it decide once the limits are known, and keeps the reserve and
 * the eventual request the same number by construction.
 */
const resolveReserveTokens = (outputReserveTokens, limits) => (
  typeof outputReserveTokens === 'function' ? outputReserveTokens(limits) : outputReserveTokens
);

/**
 * Reports which model would be used, without calling it.
 *
 * `structuredOutput` stays `null`: OMP cannot run a generation at all, so no
 * model can promise structured output, and the capability is not knowable from
 * the catalog. Callers read `null` as "not settled", never as `false`.
 */
export async function describeSmallModel({ preferredProviderID, outputReserveTokens, overrideModel } = {}) {
  const models = await listModelInfos();
  if (!models) return null;

  // A caller with its own model setting (the diff walkthrough) outranks the
  // small-model chain entirely — it asked for this model on purpose.
  const resolved = resolveSmallModel({
    models,
    model: overrideModel,
    preferredProviderID,
  });
  if (!resolved) return null;

  const modelInfo = findModelInfo(models, resolved.providerID, resolved.modelID);
  const outputTokenLimit = Number(modelInfo?.limit?.output) > 0 ? Number(modelInfo.limit.output) : null;

  // Two passes: the first only to learn the context, which a caller-supplied
  // reserve function needs before it can answer.
  const { contextTokens, contextKnown } = getModelInputCharBudget({ modelInfo });
  const reserveTokens = resolveReserveTokens(outputReserveTokens, { contextTokens, outputTokenLimit });
  const { maxChars } = getModelInputCharBudget({ modelInfo, outputReserveTokens: reserveTokens });

  // OMP's catalog is already credential-filtered, so a model it lists is
  // callable. A model we cannot find at all is not evidence either way, so it
  // counts as usable.
  const hasLogin = modelInfo ? modelInfo.enabled !== false : true;

  return {
    ...resolved,
    hasLogin,
    inputCharBudget: maxChars,
    contextTokens,
    contextKnown,
    // What the caller should ask for, so the request and the reserve above
    // cannot drift apart.
    outputTokens: Number(reserveTokens) > 0 ? Number(reserveTokens) : null,
    structuredOutput: null,
    outputTokenLimit,
  };
}
