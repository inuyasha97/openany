import { afterEach, describe, expect, test } from "bun:test"
import type { Session } from "@/lib/opencode/model"
import { OpenCodeRuntime, type SessionClient } from "./opencode-runtime"
import { getAgentRuntime, setAgentRuntime } from "./registry"

const sessionFixture: Session = {
  id: "ses_1",
  projectID: "p",
  directory: "/repo",
  title: "t",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
}

const client: SessionClient = {
  createSession: async () => sessionFixture,
  getSession: async () => sessionFixture,
  listSessions: async () => [sessionFixture],
  deleteSession: async () => true,
  renameSession: async () => undefined,
  moveSession: async () => undefined,
}

afterEach(() => setAgentRuntime(null))

describe("agent runtime registry", () => {
  test("defaults to the OpenCode runtime", () => {
    expect(getAgentRuntime().id).toBe("opencode")
  })

  test("returns the runtime set for tests or another adapter", () => {
    const custom = new OpenCodeRuntime(client)
    setAgentRuntime(custom)
    expect(getAgentRuntime()).toBe(custom)
  })
})
