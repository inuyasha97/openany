import { afterEach, describe, expect, test } from "bun:test"
import { OpenCodeRuntime } from "./opencode-runtime"
import { clearAgentRuntimes, getAgentRuntime, registerAgentRuntime } from "./registry"

afterEach(() => clearAgentRuntimes())

describe("agent runtime registry", () => {
  test("defaults to the OpenCode runtime", () => {
    expect(getAgentRuntime().id).toBe("opencode")
  })

  test("returns the runtime registered for an id", () => {
    const custom = new OpenCodeRuntime()
    registerAgentRuntime(custom)
    expect(getAgentRuntime("opencode")).toBe(custom)
    expect(getAgentRuntime()).toBe(custom)
  })

  test("falls back to the default runtime for an unregistered id", () => {
    expect(getAgentRuntime("omp").id).toBe("opencode")
  })
})
