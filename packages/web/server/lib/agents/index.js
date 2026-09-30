/**
 * Fork-owned agent runtimes (Phase 5 OMP, Phase 6 ACP).
 *
 * Each runtime's routes are always registered, so a settings toggle takes
 * effect on the next request instead of needing a restart. A request is served
 * only when the runtime is enabled — the env flag forces it on, otherwise the
 * OpenChamber setting decides. The adapter (and the OMP SDK) is imported
 * lazily, on the first enabled request, so a disabled runtime costs nothing.
 *
 * The adapters are TypeScript workspace packages and the OMP SDK ships
 * TypeScript-only, so these paths require the server to run under Bun.
 */

import { createOmpRuntimeHost } from './omp-runtime-host.js';
import { registerOmpRoutes } from './omp-routes.js';
import { createAcpRuntimeHost } from './acp-runtime-host.js';
import { registerAcpRoutes } from './acp-routes.js';
import { createProcessTransport } from './acp-transport.js';

export const isOmpRuntimeForced = (env = process.env) => env.OPENCHAMBER_OMP_RUNTIME === '1';
export const isAcpRuntimeForced = (env = process.env) => env.OPENCHAMBER_ACP_RUNTIME === '1';

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

// The adapters are TypeScript with extensionless imports, and the OMP SDK ships
// TypeScript-only, so they load only under Bun. The Electron desktop runs the
// server in-process under Node, where the import cannot resolve; the runtimes
// stay disabled there instead of failing the request.
const defaultAdaptersRunnable = () => typeof Bun !== 'undefined';

/**
 * Registers the OMP routes and returns a controller for shutdown. Returns a
 * controller even when the runtime is disabled, because the routes are always
 * present and read the setting per request.
 */
export const installOmpAgentRuntime = async ({
  app,
  broadcast,
  env = process.env,
  isSettingEnabled,
  adapter,
  adaptersRunnable = defaultAdaptersRunnable,
} = {}) => {
  const controller = createHostController(async () => {
    const resolved = adapter ?? (await loadOmpAdapter());
    return createOmpRuntimeHost({ adapter: resolved, broadcast });
  });
  const isEnabled = async () => {
    if (!adaptersRunnable()) return false;
    if (isOmpRuntimeForced(env)) return true;
    if (!isSettingEnabled) return false;
    return (await isSettingEnabled().catch(() => false)) === true;
  };
  registerOmpRoutes(app, { getHost: controller.getHost, isEnabled });
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