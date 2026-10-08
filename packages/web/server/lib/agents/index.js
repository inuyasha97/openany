/**
 * Fork-owned agent runtime (OMP).
 *
 * OpenCode is gone in this fork; OMP is the only agent runtime. Its routes are
 * registered once and always served — there is no flag or setting to gate them.
 * The adapter is imported lazily, on the first request, so nothing loads until
 * the runtime is actually used.
 */

import { createOmpRuntimeHost } from './omp-runtime-host.js';
import { registerOmpRoutes } from './omp-routes.js';

const loadOmpAdapter = () => import('../../../../omp-adapter/src/index.ts');

const createHostController = (loadHost) => {
  let hostPromise = null;
  return {
    getHost: () => {
      hostPromise ??= Promise.resolve().then(loadHost);
      return hostPromise;
    },
    async dispose() {
      const host = await Promise.resolve(hostPromise).catch(() => null);
      await host?.dispose?.();
    },
  };
};

/**
 * Registers the OMP routes and returns a controller for shutdown. The routes
 * are always served; the host is created on the first request.
 */
export const installOmpAgentRuntime = async ({ app, broadcast, adapter } = {}) => {
  const controller = createHostController(async () => {
    const resolved = adapter ?? (await loadOmpAdapter());
    return createOmpRuntimeHost({ adapter: resolved, broadcast });
  });
  registerOmpRoutes(app, { getHost: controller.getHost, isEnabled: async () => true });
  return controller;
};
