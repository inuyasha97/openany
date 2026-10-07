/**
 * The model catalog for the small-model service, read from the OMP runtime.
 *
 * The OMP runtime host is wired globally (`configureOmpRuntimeHost` in
 * `../agents/omp-host-access.js`), so this module holds no connection of its
 * own: it reads the host per call and maps its catalog into the domain model
 * shape the resolver works with. OMP exposes no provider catalog and no
 * default-model lookup, so those answer "nothing" rather than guessing.
 */

import { getOmpRuntimeHost } from '../agents/omp-host-access.js';

/** Drops the cached catalog. An OMP restart can change the model list. */
export function resetOpenCodeRuntimeProviders() {
  modelCache = null;
  modelCacheAt = 0;
}

const MODEL_CACHE_TTL_MS = 30_000;
let modelCache = null;
let modelCacheAt = 0;

/**
 * Maps one OMP catalog model to the domain model the resolver reads.
 *
 * OMP already filters its catalog to models it has a credential for, so every
 * entry counts as enabled. It reports no model family, so `familyOf` reads the
 * family from the id. A model with no context or output limit is reported
 * without one, and the resolver falls back to its conservative default.
 */
const toModelInfo = (model) => {
  if (!model || typeof model.id !== 'string' || typeof model.provider !== 'string') return null;
  const context = Number(model.contextWindow);
  const output = Number(model.maxTokens);
  const input = Array.isArray(model.input) && model.input.length > 0 ? model.input : ['text'];
  return {
    id: model.id,
    modelID: typeof model.requestModelId === 'string' && model.requestModelId ? model.requestModelId : model.id,
    providerID: model.provider,
    name: typeof model.name === 'string' ? model.name : model.id,
    capabilities: { input, output: ['text'] },
    ...(context > 0 || output > 0
      ? { limit: { ...(context > 0 ? { context } : {}), ...(output > 0 ? { output } : {}) } }
      : {}),
  };
};

/**
 * Every model the running OMP can call, in the domain shape, or `null` when
 * the runtime is not mounted. An empty array means "asked and got nothing", so
 * callers fall back to conservative defaults rather than refusing.
 *
 * Cached briefly: a resolution needs the model's context and output limits, and
 * paying a round trip for them on every title or summary would be the wrong
 * trade. A momentarily failing runtime keeps the previous answer rather than
 * retracting it.
 */
export async function listModelInfos() {
  const host = await getOmpRuntimeHost();
  if (!host) return null;
  if (modelCache && Date.now() - modelCacheAt < MODEL_CACHE_TTL_MS) return modelCache;
  try {
    const models = await host.listModels();
    modelCache = (Array.isArray(models) ? models : []).map(toModelInfo).filter(Boolean);
    modelCacheAt = Date.now();
    return modelCache;
  } catch {
    return modelCache ?? [];
  }
}

/**
 * The model entry for a `provider/model` reference. `id` is the catalog key a
 * reference holds; `modelID` is the provider API name, shared by derived
 * entries (`gpt-6-luna` and `gpt-6-luna-fast`), so an exact `id` match wins.
 */
export function findModelInfo(models, providerID, modelID) {
  const ofProvider = models.filter((model) => model?.providerID === providerID);
  return ofProvider.find((model) => model.id === modelID)
    ?? ofProvider.find((model) => model.modelID === modelID)
    ?? null;
}
