import type { AgentRuntime } from "./contract"
import { OmpRuntimeClient } from "./omp-runtime"

const DEFAULT_RUNTIME_ID = "omp"

const registeredRuntimes = new Map<string, AgentRuntime>()
const sessionRuntimes = new Map<string, string>()
let cachedOmp: OmpRuntimeClient | null = null

/**
 * The concrete OMP client. The `AgentRuntime` contract carries session
 * operations only, so a page that needs an OMP-only call (provider login)
 * takes the client from here instead of casting the contract.
 */
export const getOmpRuntimeClient = (): OmpRuntimeClient => {
  cachedOmp ??= new OmpRuntimeClient()
  return cachedOmp
}

export const getAgentRuntime = (runtimeId: string = DEFAULT_RUNTIME_ID): AgentRuntime => {
  const registered = registeredRuntimes.get(runtimeId)
  if (registered) return registered
  return getOmpRuntimeClient()
}

export const registerSessionRuntime = (sessionId: string, runtimeId: string): void => {
  sessionRuntimes.set(sessionId, runtimeId)
}

export const forgetSessionRuntime = (sessionId: string): void => {
  sessionRuntimes.delete(sessionId)
}

export const runtimeIdForSession = (sessionId: string | undefined): string =>
  (sessionId ? sessionRuntimes.get(sessionId) : undefined) ?? DEFAULT_RUNTIME_ID

export const getAgentRuntimeForSession = (sessionId: string | undefined): AgentRuntime =>
  getAgentRuntime(runtimeIdForSession(sessionId))

export const registerAgentRuntime = (runtime: AgentRuntime): void => {
  registeredRuntimes.set(runtime.id, runtime)
}

export const clearAgentRuntimes = (): void => {
  registeredRuntimes.clear()
  sessionRuntimes.clear()
}
