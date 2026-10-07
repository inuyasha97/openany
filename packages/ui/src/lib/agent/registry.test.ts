import { afterEach, describe, expect, test } from "bun:test"
import type { AgentCapabilities, AgentRuntime } from "./contract"
import {
  clearAgentRuntimes, forgetSessionRuntime, getAgentRuntime, getAgentRuntimeForSession,
  registerAgentRuntime, registerSessionRuntime, runtimeIdForSession,
} from "./registry"
import { resolveSessionCapabilities } from "./session-capabilities"

afterEach(() => clearAgentRuntimes())

const stub = (id: string, caps: Partial<AgentCapabilities> = {}): AgentRuntime =>
  ({ id, capabilities: { fork: false, commands: false, mcp: false, agents: false, permissions: false, modelSelection: false, agentSelection: false, forms: false, revert: false, turnDiff: false, skills: false, rename: false, delete: false, move: false, attachments: false, ...caps } }) as AgentRuntime

describe("agent runtime registry", () => {
  test("defaults to the omp runtime", () => {
    expect(getAgentRuntime().id).toBe("omp")
  })

  test("returns the runtime registered for an id", () => {
    const custom = stub("custom")
    registerAgentRuntime(custom)
    expect(getAgentRuntime("custom")).toBe(custom)
  })

  test("falls back to the default runtime for an unregistered id", () => {
    expect(getAgentRuntime("gemini").id).toBe("omp")
  })

  test("resolves a session to its bound runtime, omp by default", () => {
    expect(runtimeIdForSession("ses_a")).toBe("omp")
    registerSessionRuntime("ses_a", "custom")
    expect(runtimeIdForSession("ses_a")).toBe("custom")
    forgetSessionRuntime("ses_a")
    expect(getAgentRuntimeForSession("ses_a").id).toBe("omp")
    expect(getAgentRuntimeForSession(undefined).id).toBe("omp")
  })

  test("session capabilities follow the session's runtime", () => {
    expect(resolveSessionCapabilities(null, "omp").commands).toBe(true)
  })
})
