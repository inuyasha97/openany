import type { AgentRuntime } from "./contract"
import { getAgentRuntime } from "./registry"

/** React access to the active agent runtime. Resolved at call time, never cached. */
export const useAgentRuntime = (): AgentRuntime => getAgentRuntime()
