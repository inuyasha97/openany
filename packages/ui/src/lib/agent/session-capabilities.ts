/**
 * What a session's runtime can do, for gating UI affordances.
 *
 * `AgentCapabilities` is the contract's answer to "does this runtime support
 * this operation". A component asks for the capabilities of the session it is
 * about to render a control for, instead of testing a runtime name. Sessions
 * with no binding and drafts on the default resolve to OMP, the only runtime.
 */

import type { AgentCapabilities } from "./contract"
import { getAgentRuntime, runtimeIdForSession } from "./registry"

export const resolveSessionCapabilities = (
  sessionId: string | null | undefined,
  draftRuntimeId?: string,
): AgentCapabilities => {
  const runtimeId = draftRuntimeId ?? (sessionId ? runtimeIdForSession(sessionId) : undefined)
  return getAgentRuntime(runtimeId).capabilities
}