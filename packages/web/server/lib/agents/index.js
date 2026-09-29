/**
 * Fork-owned agent runtimes (Phase 5 OMP, Phase 6 ACP).
 *
 * Mounts a runtime into the OpenChamber server, each off unless its own env
 * flag is set. With the flags off the OpenCode-only path is untouched: nothing
 * below runs and the adapter is never imported.
 *
 * The adapters are TypeScript workspace packages and the OMP SDK ships
 * TypeScript-only, so these paths require the server to run under Bun. The
 * imports are lazy and only reached when the flag is on.
 */

import { createOmpRuntimeHost } from './omp-runtime-host.js';
import { registerOmpRoutes } from './omp-routes.js';
import { createAcpRuntimeHost } from './acp-runtime-host.js';
import { registerAcpRoutes } from './acp-routes.js';
import { createProcessTransport } from './acp-transport.js';

export const isOmpRuntimeEnabled = (env = process.env) => env.OPENCHAMBER_OMP_RUNTIME === '1';
export const isAcpRuntimeEnabled = (env = process.env) => env.OPENCHAMBER_ACP_RUNTIME === '1';

const loadOmpAdapter = () => import('../../../../omp-adapter/src/index.ts');
const loadAcpAdapter = () => import('../../../../acp-adapter/src/index.ts');

/** Default ACP agent: the bundled OMP CLI in its ACP mode. */
const createDefaultAcpTransport = (env) => (input) => createProcessTransport({
  command: env.OPENCHAMBER_ACP_COMMAND ?? 'omp',
  args: ['acp'],
  cwd: input.cwd,
});

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

/**
 * Creates and mounts the ACP runtime when enabled. Returns `null` when the
 * flag is off. A load or mount failure is logged and leaves the server running
 * without ACP rather than taking down the OpenCode path.
 */
export const installAcpAgentRuntime = async ({
  app,
  broadcast,
  env = process.env,
  adapter,
  createTransport,
} = {}) => {
  if (!isAcpRuntimeEnabled(env)) return null;
  try {
    const resolved = adapter ?? (await loadAcpAdapter());
    const host = createAcpRuntimeHost({
      adapter: resolved,
      broadcast,
      createTransport: createTransport ?? createDefaultAcpTransport(env),
    });
    registerAcpRoutes(app, { host });
    console.log('[acp] ACP runtime mounted');
    return host;
  } catch (error) {
    console.error('[acp] failed to mount ACP runtime:', error instanceof Error ? error.message : error);
    return null;
  }
};