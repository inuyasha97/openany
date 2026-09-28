import type { AgentRuntime } from "./contract"
import { OpenCodeRuntime } from "./opencode-runtime"

const DEFAULT_RUNTIME_ID = "opencode"

const registeredRuntimes = new Map<string, AgentRuntime>()
let cachedDefault: AgentRuntime | null = null

/**
 * The runtime for an id. A registered runtime wins; otherwise the OpenCode
 * runtime is built once and returned. Resolved at call time so a runtime
 * switch is never cached across endpoints.
 */
export const getAgentRuntime = (runtimeId: string = DEFAULT_RUNTIME_ID): AgentRuntime => {
  const registered = registeredRuntimes.get(runtimeId)
  if (registered) return registered
  cachedDefault ??= new OpenCodeRuntime()
  return cachedDefault
}

export const registerAgentRuntime = (runtime: AgentRuntime): void => {
  registeredRuntimes.set(runtime.id, runtime)
}

export const clearAgentRuntimes = (): void => {
  registeredRuntimes.clear()
}
