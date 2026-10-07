/**
 * Test double for the app's default agent runtime.
 *
 * The registry's default runtime is `OmpRuntimeClient`: it rejects operations
 * OMP has no RPC surface for and translates no OpenCode wire payload. A test
 * that mocks `opencodeClient` and drives app logic through
 * `getAgentRuntimeForSession` therefore never reaches the mocked client.
 *
 * This double is registered under the default runtime id and forwards every
 * operation to `opencodeClient`, so those tests exercise the app logic they
 * mean to, with the client they already mock. It is a test fixture only; the
 * shipped runtime is the real client in `../omp-runtime.ts`.
 */

import { opencodeClient } from "@/lib/opencode/client"
import { translateWirePayload } from "@/lib/opencode/events"
import type { AgentRuntime } from "../contract"

export const createOpenCodeStubRuntime = (id = "omp"): AgentRuntime => ({
  id,
  capabilities: {
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
  },
  createSession: (params, directory) => opencodeClient.createSession(params, directory),
  getSession: (id, directory) => opencodeClient.getSession(id, directory),
  listSessions: (directory) => opencodeClient.listSessions(directory),
  deleteSession: (id, directory) => opencodeClient.deleteSession(id, directory),
  renameSession: (id, title, directory) => opencodeClient.renameSession(id, title, directory),
  moveSession: (id, toDirectory, options) => opencodeClient.moveSession(id, toDirectory, options),
  getMessages: (id, options, directory) => opencodeClient.getSessionMessages(id, options, directory),
  cancel: (id, directory) => opencodeClient.abortSession(id, directory),
  replyPermission: (sessionID, requestID, reply, options) => opencodeClient.replyToPermission(sessionID, requestID, reply, options),
  getPermission: (sessionID, requestID, directory) => opencodeClient.fetchPermission(sessionID, requestID, directory),
  listPermissions: (options) => opencodeClient.listPendingPermissions(options),
  selectModel: (id, model, directory) => opencodeClient.switchSessionModel(id, model, directory),
  selectAgent: (id, agent, directory) => opencodeClient.switchSessionAgent(id, agent, directory),
  getActiveStatus: (directory) => opencodeClient.getActiveSessionStatuses(directory),
  forkSession: (sessionId, options) => opencodeClient.forkSession(sessionId, options),
  listAgents: (directory) => opencodeClient.listAgents(directory),
  listCommands: (directory, signal) => opencodeClient.listCommands(directory, signal),
  listMcpServers: (directory) => opencodeClient.listMcpServers(directory),
  connectMcpServer: (server, directory) => opencodeClient.connectMcpServer(server, directory),
  disconnectMcpServer: (server, directory) => opencodeClient.disconnectMcpServer(server, directory),
  listSkills: (directory) => opencodeClient.listSkills(directory),
  replyForm: (sessionID, formID, answer, directory) => opencodeClient.replyToForm(sessionID, formID, answer, directory),
  cancelForm: (sessionID, formID, directory) => opencodeClient.cancelForm(sessionID, formID, directory),
  listPendingForms: (options) => opencodeClient.listPendingForms(options),
  stageRevert: (sessionId, messageId, options) => opencodeClient.stageRevert(sessionId, messageId, options),
  commitRevert: (sessionId, directory) => opencodeClient.commitRevert(sessionId, directory),
  clearRevert: (sessionId, directory) => opencodeClient.clearRevert(sessionId, directory),
  getSessionTurnDiff: (sessionId, options) => opencodeClient.getSessionTurnDiff(sessionId, options),
  sendPrompt: (params) => opencodeClient.sendMessage(params),
  sendCommand: (params) => opencodeClient.sendCommand(params),
  listSessionsPage: (options) => opencodeClient.listSessionsPage(options),
  translateEvent: (payload) => translateWirePayload(payload),
})
