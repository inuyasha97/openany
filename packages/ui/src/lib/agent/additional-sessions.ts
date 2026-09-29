/**
 * Sessions owned by runtimes other than the default.
 *
 * The global session list is OpenCode's; a session another runtime owns never
 * appears in it. This module is the seam the list uses to learn about them, so
 * the store stays runtime-neutral and the OMP specifics live here.
 */

import type { Session } from "@/lib/opencode/model"
import type { AgentSession } from "./contract"
import { isOmpRuntimeAvailable } from "./omp-availability"
import { getAgentRuntime } from "./registry"

const DEFAULT_RUNTIME_ID = "opencode"

/** True for a session whose runtime is not the default, so the OpenCode list cannot see it. */
export const isAdditionalRuntimeSession = (session: Session): boolean => {
  // SAFETY: a projected session from another runtime carries its runtime id;
  // an OpenCode record leaves it absent.
  const runtimeId = (session as AgentSession).runtimeId
  return Boolean(runtimeId) && runtimeId !== DEFAULT_RUNTIME_ID
}

/**
 * Sessions from every mounted non-default runtime, for merging into the global
 * list. An unavailable runtime contributes nothing, and a listing failure must
 * not fail the OpenCode load, so it resolves to nothing; the caller preserves
 * what it already knows rather than dropping it.
 */
export const listAdditionalRuntimeSessions = async (): Promise<AgentSession[]> => {
  if (!(await isOmpRuntimeAvailable())) return []
  try {
    return await getAgentRuntime("omp").listSessions()
  } catch {
    return []
  }
}