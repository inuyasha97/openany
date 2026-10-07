/**
 * Fork-owned agent runtimes (Phase 5 OMP, Phase 6 ACP).
 *
 * OpenCode is gone in this fork; OMP is the only agent runtime. Its routes are
 * registered once and always served — there is no flag or setting to gate them.
 * The adapter is imported lazily, on the first request, so nothing loads until
 * the runtime is actually used.
 *
 * The ACP installer is still here for now; P3 removes it with the rest of the
 * non-OMP runtimes.
 */

import { createOmpRuntimeHost } from './omp-runtime-host.js';
import { registerOmpRoutes } from './omp-routes.js';
import { createAcpRuntimeHost } from './acp-runtime-host.js';
import { registerAcpRoutes } from './acp-routes.js';
import { createProcessTransport } from './acp-transport.js';

const isAcpRuntimeForced = (env = process.env) => env.OPENCHAMBER_ACP_RUNTIME === '1';

const loadOmpAdapter = () => import('../../../../omp-adapter/src/index.ts');
const loadAcpAdapter = () => import('../../../../acp-adapter/src/index.ts');

/** Default ACP agent: the bundled OMP CLI in its ACP mode. */
const createDefaultAcpTransport = (env) => (input) => createProcessTransport({
  command: env.OPENCHAMBER_ACP_COMMAND ?? 'omp',
  args: ['acp'],
  cwd: input.cwd,
});

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

// The ACP adapter is TypeScript with extensionless imports, so it loads only
// under Bun. The Electron desktop runs the server in-process under Node, where
// the import cannot resolve; ACP stays disabled there instead of failing the
// request. OMP has no such guard: it is reached over its RPC binary.
const defaultAdaptersRunnable = () => typeof Bun !== 'undefined';

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

/**
 * Registers the ACP routes and returns a controller for shutdown.
 */
export const installAcpAgentRuntime = async ({
  app,
  broadcast,
  env = process.env,
  isSettingEnabled,
  adapter,
  createTransport,
  adaptersRunnable = defaultAdaptersRunnable,
} = {}) => {
  const controller = createHostController(async () => {
    const resolved = adapter ?? (await loadAcpAdapter());
    return createAcpRuntimeHost({
      adapter: resolved,
      broadcast,
      createTransport: createTransport ?? createDefaultAcpTransport(env),
    });
  });
  const isEnabled = async () => {
    if (!adaptersRunnable()) return false;
    if (isAcpRuntimeForced(env)) return true;
    if (!isSettingEnabled) return false;
    return (await isSettingEnabled().catch(() => false)) === true;
  };
  registerAcpRoutes(app, { getHost: controller.getHost, isEnabled });
  return controller;
};
