import { afterEach, describe, expect, test } from "bun:test"
import { OpenCodeRuntime } from "./opencode-runtime"
import { getAgentRuntime, setAgentRuntime } from "./registry"

afterEach(() => setAgentRuntime(null))

describe("agent runtime registry", () => {
  test("defaults to the OpenCode runtime", () => {
    expect(getAgentRuntime().id).toBe("opencode")
  })

  test("returns the runtime set for tests or another adapter", () => {
    const custom = new OpenCodeRuntime()
    setAgentRuntime(custom)
    expect(getAgentRuntime()).toBe(custom)
  })
})
