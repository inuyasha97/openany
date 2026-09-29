import type { AgentRuntime } from "./contract"
import { OpenCodeRuntime } from "./opencode-runtime"
import { OmpRuntimeClient } from "./omp-runtime"

const DEFAULT_RUNTIME_ID = "opencode"
const OMP_RUNTIME_ID = "omp"

const registeredRuntimes = new Map<string, AgentRuntime>()
// Sessions the caller has bound to a non-default runtime. OpenCode sessions
// need no entry: the default id already resolves to it.
const sessionRuntimes = new Map<string, string>()
let cachedDefault: AgentRuntime | null = null
let cachedOmp: AgentRuntime | null = null

/**
 * The runtime for an id. A registered runtime wins; otherwise a built-in
 * runtime is built once and returned: OpenCode for the default id, OMP for
 * `"omp"`. Resolved at call time so a runtime switch is never cached across
 * endpoints.
 */
export const getAgentRuntime = (runtimeId: string = DEFAULT_RUNTIME_ID): AgentRuntime => {
  const registered = registeredRuntimes.get(runtimeId)
  if (registered) return registered
  if (runtimeId === OMP_RUNTIME_ID) {
    cachedOmp ??= new OmpRuntimeClient()
    return cachedOmp
  }
  cachedDefault ??= new OpenCodeRuntime()
  return cachedDefault
}

/**
 * Binds a session to the runtime that owns it. A session without a binding
 * resolves to OpenCode, so this stays inert until a second runtime creates
 * sessions.
 */
export const registerSessionRuntime = (sessionId: string, runtimeId: string): void => {
  sessionRuntimes.set(sessionId, runtimeId)
}

export const forgetSessionRuntime = (sessionId: string): void => {
  sessionRuntimes.delete(sessionId)
}

/** The runtime id a session belongs to, defaulting to OpenCode. */
export const runtimeIdForSession = (sessionId: string | undefined): string =>
  (sessionId ? sessionRuntimes.get(sessionId) : undefined) ?? DEFAULT_RUNTIME_ID

/** The runtime that owns a session. Callers that have the session id use this, not `getAgentRuntime()`. */
export const getAgentRuntimeForSession = (sessionId: string | undefined): AgentRuntime =>
  getAgentRuntime(runtimeIdForSession(sessionId))

export const registerAgentRuntime = (runtime: AgentRuntime): void => {
  registeredRuntimes.set(runtime.id, runtime)
}

export const clearAgentRuntimes = (): void => {
  registeredRuntimes.clear()
  sessionRuntimes.clear()
}
