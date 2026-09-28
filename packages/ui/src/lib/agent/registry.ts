import type { AgentRuntime } from "./contract"
import { OpenCodeRuntime } from "./opencode-runtime"

let activeRuntime: AgentRuntime | null = null
let defaultRuntime: AgentRuntime | null = null

/** Resolved at call time so a runtime switch is never cached across endpoints. */
export const getAgentRuntime = (): AgentRuntime => {
  if (activeRuntime) return activeRuntime
  defaultRuntime ??= new OpenCodeRuntime()
  return defaultRuntime
}

export const setAgentRuntime = (runtime: AgentRuntime | null): void => {
  activeRuntime = runtime
}
