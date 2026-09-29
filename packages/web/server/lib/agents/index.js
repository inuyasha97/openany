/**
 * Fork-owned OMP agent runtime (Phase 5.2).
 *
 * Mounts the OMP runtime into the OpenChamber server, off unless
 * `OPENCHAMBER_OMP_RUNTIME=1`. With the flag off the OpenCode-only path is
 * untouched: nothing below runs and the adapter is never imported.
 *
 * The adapter is a TypeScript workspace package and the OMP SDK ships
 * TypeScript-only, so the OMP path requires the server to run under Bun. The
 * import is lazy and only reached when the flag is on.
 */

import { createOmpRuntimeHost } from './omp-runtime-host.js';
import { registerOmpRoutes } from './omp-routes.js';

export const isOmpRuntimeEnabled = (env = process.env) => env.OPENCHAMBER_OMP_RUNTIME === '1';

const loadOmpAdapter = () => import('../../../../omp-adapter/src/index.ts');

/**
 * Creates and mounts the OMP runtime when enabled. Returns `null` when the
 * flag is off. A load or mount failure is logged and leaves the server running
 * without OMP rather than taking down the OpenCode path.
 */
export const installOmpAgentRuntime = async ({
  app,
  broadcast,
  env = process.env,
  adapter,
} = {}) => {
  if (!isOmpRuntimeEnabled(env)) return null;
  let resolved;
  try {
    resolved = adapter ?? (await loadOmpAdapter());
    const host = createOmpRuntimeHost({ adapter: resolved, broadcast });
    registerOmpRoutes(app, { host });
    console.log('[omp] OMP runtime mounted');
    return host;
  } catch (error) {
    console.error('[omp] failed to mount OMP runtime:', error instanceof Error ? error.message : error);
    return null;
  }
};