import { describe, expect, test } from "bun:test"
import type { AgentSession, MessagePage } from "./contract"
import type { RoutedSyncEvent } from "./events"
import { OpenCodeRuntime, type SessionClient } from "./opencode-runtime"

const sessionFixture: AgentSession = {
  id: "ses_1",
  runtimeId: "opencode",
  nativeSessionId: "ses_1",
  projectID: "p",
  directory: "/repo",
  title: "t",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
}

const emptyPage: MessagePage = { items: [], cursor: {} }

type Call = { method: string; args: readonly unknown[] }

const recordingClient = (calls: Call[]): SessionClient => ({
  createSession: async (...args) => { calls.push({ method: "createSession", args }); return sessionFixture },
  getSession: async (...args) => { calls.push({ method: "getSession", args }); return sessionFixture },
  listSessions: async (...args) => { calls.push({ method: "listSessions", args }); return [sessionFixture] },
  deleteSession: async (...args) => { calls.push({ method: "deleteSession", args }); return true },
  renameSession: async (...args) => { calls.push({ method: "renameSession", args }) },
  moveSession: async (...args) => { calls.push({ method: "moveSession", args }) },
  getSessionMessages: async (...args) => { calls.push({ method: "getSessionMessages", args }); return emptyPage },
  abortSession: async (...args) => { calls.push({ method: "abortSession", args }); return true },
  replyToPermission: async (...args) => { calls.push({ method: "replyToPermission", args }); return true },
  fetchPermission: async (...args) => { calls.push({ method: "fetchPermission", args }); return { state: "resolved" } },
  listPendingPermissions: async (...args) => { calls.push({ method: "listPendingPermissions", args }); return [] },
  switchSessionModel: async (...args) => { calls.push({ method: "switchSessionModel", args }) },
  switchSessionAgent: async (...args) => { calls.push({ method: "switchSessionAgent", args }) },
  getActiveSessionStatuses: async (...args) => { calls.push({ method: "getActiveSessionStatuses", args }); return null },
  forkSession: async (...args) => { calls.push({ method: "forkSession", args }); return sessionFixture },
  listAgents: async (...args) => { calls.push({ method: "listAgents", args }); return [] },
  listCommands: async (...args) => { calls.push({ method: "listCommands", args }); return [] },
  listMcpServers: async (...args) => { calls.push({ method: "listMcpServers", args }); return [] },
  connectMcpServer: async (...args) => { calls.push({ method: "connectMcpServer", args }) },
  disconnectMcpServer: async (...args) => { calls.push({ method: "disconnectMcpServer", args }) },
  listSkills: async (...args) => { calls.push({ method: "listSkills", args }); return [] },
  replyToForm: async (...args) => { calls.push({ method: "replyToForm", args }); return true },
  cancelForm: async (...args) => { calls.push({ method: "cancelForm", args }); return true },
  listPendingForms: async (...args) => { calls.push({ method: "listPendingForms", args }); return [] },
  // SessionRevert carries branded id types the fake cannot build cheaply, so
  // this method is compiler-covered and not exercised here.
  stageRevert: async () => { throw new Error("stageRevert not exercised") },
  commitRevert: async (...args) => { calls.push({ method: "commitRevert", args }) },
  clearRevert: async (...args) => { calls.push({ method: "clearRevert", args }) },
  getSessionTurnDiff: async (...args) => { calls.push({ method: "getSessionTurnDiff", args }); return [] },
  sendMessage: async (...args) => { calls.push({ method: "sendMessage", args }); return "msg_1" },
  sendCommand: async (...args) => { calls.push({ method: "sendCommand", args }) },
  listSessionsPage: async (...args) => { calls.push({ method: "listSessionsPage", args }); return { sessions: [], cursor: {} } },
})

const methodsOf = (calls: Call[]): string[] => calls.map((call) => call.method)

describe("OpenCodeRuntime", () => {
  test("declares the OpenCode capability set", () => {
    const runtime = new OpenCodeRuntime(recordingClient([]))
    expect(runtime.id).toBe("opencode")
    expect(runtime.capabilities).toEqual({
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
    })
  })

  test("delegates every session method to the same client method", async () => {
    const calls: Call[] = []
    const runtime = new OpenCodeRuntime(recordingClient(calls))
    await runtime.createSession({ title: "t" }, "/repo")
    await runtime.getSession("ses_1", "/repo")
    await runtime.listSessions("/repo")
    await runtime.deleteSession("ses_1", "/repo")
    await runtime.renameSession("ses_1", "t", "/repo")
    await runtime.moveSession("ses_1", "/repo2")
    expect(methodsOf(calls)).toEqual(["createSession", "getSession", "listSessions", "deleteSession", "renameSession", "moveSession"])
  })

  test("forwards createSession arguments and returns the client value", async () => {
    const calls: Call[] = []
    const runtime = new OpenCodeRuntime(recordingClient(calls))
    const created = await runtime.createSession({ title: "x" }, "/repo")
    expect(calls[0].args).toEqual([{ title: "x" }, "/repo"])
    expect(created).toBe(sessionFixture)
  })

  test("routes each agent-domain method to the matching client method", async () => {
    const calls: Call[] = []
    const runtime = new OpenCodeRuntime(recordingClient(calls))
    await runtime.getMessages("ses_1", undefined, "/repo")
    await runtime.cancel("ses_1", "/repo")
    await runtime.replyPermission("ses_1", "req_1", "once", { directory: "/repo" })
    await runtime.getPermission("ses_1", "req_1", "/repo")
    await runtime.listPermissions({ directories: ["/repo"] })
    await runtime.selectModel("ses_1", { providerID: "p", id: "m" }, "/repo")
    await runtime.selectAgent("ses_1", "build", "/repo")
    await runtime.getActiveStatus("/repo")
    await runtime.forkSession("ses_1", { directory: "/repo" })
    await runtime.listAgents("/repo")
    await runtime.listCommands("/repo")
    await runtime.listMcpServers("/repo")
    await runtime.connectMcpServer("srv", "/repo")
    await runtime.disconnectMcpServer("srv", "/repo")
    await runtime.listSkills("/repo")
    await runtime.replyForm("ses_1", "form_1", {}, "/repo")
    await runtime.cancelForm("ses_1", "form_1", "/repo")
    await runtime.listPendingForms({ directories: ["/repo"] })
    await runtime.commitRevert("ses_1", "/repo")
    await runtime.clearRevert("ses_1", "/repo")
    await runtime.getSessionTurnDiff("ses_1", { directory: "/repo" })
    expect(methodsOf(calls)).toEqual([
      "getSessionMessages",
      "abortSession",
      "replyToPermission",
      "fetchPermission",
      "listPendingPermissions",
      "switchSessionModel",
      "switchSessionAgent",
      "getActiveSessionStatuses",
      "forkSession",
      "listAgents",
      "listCommands",
      "listMcpServers",
      "connectMcpServer",
      "disconnectMcpServer",
      "listSkills",
      "replyToForm",
      "cancelForm",
      "listPendingForms",
      "commitRevert",
      "clearRevert",
      "getSessionTurnDiff",
    ])
  })

  test("delegates event translation to the injected translator", () => {
    const routed: RoutedSyncEvent[] = [{ directory: "global", event: { type: "server.connected", properties: {} } }]
    const runtime = new OpenCodeRuntime(recordingClient([]), () => routed)
    expect(runtime.translateEvent({ anything: true })).toBe(routed)
  })

  test("routes prompt, command and session page to the client", async () => {
    const calls: Call[] = []
    const runtime = new OpenCodeRuntime(recordingClient(calls))
    await runtime.sendPrompt({ id: "ses_1", providerID: "p", text: "hi" })
    await runtime.sendCommand({ id: "ses_1", command: "help" })
    await runtime.listSessionsPage({ directory: "/repo" })
    expect(methodsOf(calls)).toEqual(["sendMessage", "sendCommand", "listSessionsPage"])
  })
})
