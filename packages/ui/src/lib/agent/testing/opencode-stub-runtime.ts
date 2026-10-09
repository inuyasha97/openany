/**
 * Test double for the app's default agent runtime.
 *
 * The registry's default runtime is `OmpRuntimeClient`, which rejects the
 * operations OMP has no RPC surface for. A test that drives app logic through
 * `getAgentRuntimeForSession` therefore needs a runtime whose behaviour the
 * test controls.
 *
 * The double takes its whole agent surface from the test: register the
 * implementations with {@link setOpenCodeStubSurface} and every runtime call
 * forwards to them. A method the test did not register fails loudly instead of
 * answering an empty result, so a missing fixture is visible at the call site.
 * The OpenChamber-owned calls the code under test makes — the directory cursor,
 * the host status snapshots, the filesystem routes — do not come through here:
 * those go to `@/lib/openchamber/client`, which a test mocks directly.
 *
 * It is a test fixture only; the shipped runtime is the real client in
 * `../omp-runtime.ts`.
 */

import type { AgentCapabilities, AgentRuntime } from "../contract"

/** The behaviour the double answers with; one entry per runtime method. */
export type OpenCodeStubSurface = Record<string, ((...callArgs: never[]) => unknown) | undefined>

let surface: OpenCodeStubSurface = {}

/** Register the agent behaviour the double answers with. */
export const setOpenCodeStubSurface = (next: OpenCodeStubSurface): void => {
  surface = next
}

/**
 * A mutable surface a test can spy on and register in one step: the object it
 * returns is the one the double reads, so `spyOn(surface, "deleteSession")`
 * controls what the runtime call behind it does.
 */
export const createOpenCodeStubSurface = (): OpenCodeStubSurface => {
  const registered: OpenCodeStubSurface = {}
  setOpenCodeStubSurface(registered)
  return registered
}

/**
 * Fixtures written against the pre-runtime client name these methods after the
 * OpenChamber client wrapper (`getActiveSessionStatuses`, `sendMessage`, ...).
 * Both names resolve, so a fixture keeps the name it was written with.
 */
const SURFACE_ALIASES: Record<string, string | undefined> = {
  getActiveStatus: "getActiveSessionStatuses",
  getMessages: "getSessionMessages",
  cancel: "abortSession",
  replyPermission: "replyToPermission",
  getPermission: "fetchPermission",
  listPermissions: "listPendingPermissions",
  selectModel: "switchSessionModel",
  replyForm: "replyToForm",
  sendPrompt: "sendMessage",
}

/** Answers from the registered surface, or fails loudly naming the method. */
const delegate = <R>(operation: string, args: unknown[]): R => {
  const byLegacyName = SURFACE_ALIASES[operation]
  const impl = surface[operation] ?? (byLegacyName ? surface[byLegacyName] : undefined)
  if (!impl) {
    return Promise.reject(
      new Error(`createOpenCodeStubRuntime: no surface registered for ${operation} — call setOpenCodeStubSurface()`),
    ) as R
  }
  return (impl as (...callArgs: unknown[]) => unknown)(...args) as R
}

const CAPABILITIES: AgentCapabilities = {
  fork: true,
  commands: true,
  mcp: true,
  agents: true,
  permissions: true,
  modelSelection: true,
  agentSelection: true,
  forms: true,
  revert: true,
  turnDiff: true,
  skills: true,
  rename: true,
  delete: true,
  move: true,
  attachments: true,
}

export const createOpenCodeStubRuntime = (id = "omp"): AgentRuntime => ({
  id,
  capabilities: CAPABILITIES,

  createSession: (params, directory) => delegate("createSession", [params, directory]),
  getSession: (sessionId, directory) => delegate("getSession", [sessionId, directory]),
  listSessions: (directory) => delegate("listSessions", [directory]),
  deleteSession: (sessionId, directory) => delegate("deleteSession", [sessionId, directory]),
  renameSession: (sessionId, title, directory) => delegate("renameSession", [sessionId, title, directory]),
  moveSession: (sessionId, toDirectory, options) => delegate("moveSession", [sessionId, toDirectory, options]),

  getMessages: (sessionId, options, directory) => delegate("getMessages", [sessionId, options, directory]),
  cancel: (sessionId, directory) => delegate("cancel", [sessionId, directory]),
  replyPermission: (sessionID, requestID, reply, options) => delegate("replyPermission", [sessionID, requestID, reply, options]),
  getPermission: (sessionID, requestID, directory) => delegate("getPermission", [sessionID, requestID, directory]),
  listPermissions: (options) => delegate("listPermissions", [options]),
  selectModel: (sessionId, model, directory) => delegate("selectModel", [sessionId, model, directory]),
  setThinkingLevel: (sessionId, level, directory) => delegate("setThinkingLevel", [sessionId, level, directory]),
  setFastMode: (sessionId, enabled, directory) => delegate("setFastMode", [sessionId, enabled, directory]),
  getActiveStatus: (directory) => delegate("getActiveStatus", [directory]),

  forkSession: (sessionId, options) => delegate("forkSession", [sessionId, options]),
  listAgents: (directory) => delegate("listAgents", [directory]),
  listCommands: (directory, signal) => delegate("listCommands", [directory, signal]),
  listMcpServers: (directory) => delegate("listMcpServers", [directory]),
  connectMcpServer: (server, directory) => delegate("connectMcpServer", [server, directory]),
  disconnectMcpServer: (server, directory) => delegate("disconnectMcpServer", [server, directory]),
  listSkills: (directory) => delegate("listSkills", [directory]),
  replyForm: (sessionID, formID, answer, directory) => delegate("replyForm", [sessionID, formID, answer, directory]),
  cancelForm: (sessionID, formID, directory) => delegate("cancelForm", [sessionID, formID, directory]),
  listPendingForms: (options) => delegate("listPendingForms", [options]),
  stageRevert: (sessionId, messageId, options) => delegate("stageRevert", [sessionId, messageId, options]),
  commitRevert: (sessionId, directory) => delegate("commitRevert", [sessionId, directory]),
  clearRevert: (sessionId, directory) => delegate("clearRevert", [sessionId, directory]),
  getSessionTurnDiff: (sessionId, options) => delegate("getSessionTurnDiff", [sessionId, options]),

  sendPrompt: (params) => delegate("sendPrompt", [params]),
  sendCommand: (params) => delegate("sendCommand", [params]),
  listSessionsPage: (options) => delegate("listSessionsPage", [options]),

  // OMP publishes its events through the server's bridge, not through a wire
  // payload a runtime translates, so there is nothing for a fixture to supply.
  translateEvent: () => [],
})
