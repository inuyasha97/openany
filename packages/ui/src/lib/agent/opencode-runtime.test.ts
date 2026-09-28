import { describe, expect, test } from "bun:test"
import type { Session } from "@/lib/opencode/model"
import { OpenCodeRuntime, type SessionClient } from "./opencode-runtime"

const sessionFixture: Session = {
  id: "ses_1",
  projectID: "p",
  directory: "/repo",
  title: "t",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
}

const recordingClient = (): { client: SessionClient; seen: string[] } => {
  const seen: string[] = []
  const client: SessionClient = {
    createSession: async () => { seen.push("createSession"); return sessionFixture },
    getSession: async () => { seen.push("getSession"); return sessionFixture },
    listSessions: async () => { seen.push("listSessions"); return [sessionFixture] },
    deleteSession: async () => { seen.push("deleteSession"); return true },
    renameSession: async () => { seen.push("renameSession") },
    moveSession: async () => { seen.push("moveSession") },
  }
  return { client, seen }
}

describe("OpenCodeRuntime", () => {
  test("declares the OpenCode capability set", () => {
    const runtime = new OpenCodeRuntime(recordingClient().client)
    expect(runtime.id).toBe("opencode")
    expect(runtime.capabilities).toEqual({
      fork: true,
      commands: true,
      mcp: true,
      agents: true,
      permissions: true,
      modelSelection: true,
      agentSelection: true,
    })
  })

  test("delegates every session method to the same client method", async () => {
    const { client, seen } = recordingClient()
    const runtime = new OpenCodeRuntime(client)
    await runtime.createSession({ title: "t" }, "/repo")
    await runtime.getSession("ses_1", "/repo")
    await runtime.listSessions("/repo")
    await runtime.deleteSession("ses_1", "/repo")
    await runtime.renameSession("ses_1", "t", "/repo")
    await runtime.moveSession("ses_1", "/repo2")
    expect(seen).toEqual(["createSession", "getSession", "listSessions", "deleteSession", "renameSession", "moveSession"])
  })

  test("forwards arguments and returns the client value", async () => {
    let received: unknown[] = []
    const client: SessionClient = {
      createSession: async (params, directory) => { received = [params, directory]; return sessionFixture },
      getSession: async () => sessionFixture,
      listSessions: async () => [sessionFixture],
      deleteSession: async () => true,
      renameSession: async () => undefined,
      moveSession: async () => undefined,
    }
    const runtime = new OpenCodeRuntime(client)
    const created = await runtime.createSession({ title: "x" }, "/repo")
    expect(received).toEqual([{ title: "x" }, "/repo"])
    expect(created).toBe(sessionFixture)
  })
})
