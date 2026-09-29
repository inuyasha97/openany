import { afterEach, describe, expect, test } from "bun:test"
import { OpenCodeRuntime } from "./opencode-runtime"
import {
  clearAgentRuntimes,
  forgetSessionRuntime,
  getAgentRuntime,
  getAgentRuntimeForSession,
  registerAgentRuntime,
  registerSessionRuntime,
  runtimeIdForSession,
} from "./registry"
import { resolveSessionCapabilities } from "./session-capabilities"

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

  test("resolves the built-in OMP runtime for the omp id", () => {
    expect(getAgentRuntime("omp").id).toBe("omp")
  })

  test("resolves the built-in ACP runtime for the acp id", () => {
    const runtime = getAgentRuntime("acp")
    expect(runtime.id).toBe("acp")
    expect(runtime.capabilities.permissions).toBe(true)
    expect(runtime.capabilities.modelSelection).toBe(false)
  })

  test("falls back to the default runtime for an unregistered id", () => {
    expect(getAgentRuntime("gemini").id).toBe("opencode")
  })

  test("resolves a session to its bound runtime, OpenCode by default", () => {
    expect(runtimeIdForSession("ses_a")).toBe("opencode")
    registerSessionRuntime("ses_a", "omp")
    expect(runtimeIdForSession("ses_a")).toBe("omp")
    expect(getAgentRuntimeForSession("ses_a").id).toBe("omp")
    forgetSessionRuntime("ses_a")
    expect(getAgentRuntimeForSession("ses_a").id).toBe("opencode")
    expect(getAgentRuntimeForSession(undefined).id).toBe("opencode")
  })

  test("clearing runtimes also clears session bindings", () => {
    registerSessionRuntime("ses_a", "omp")
    clearAgentRuntimes()
    expect(runtimeIdForSession("ses_a")).toBe("opencode")
  })

  test("session capabilities follow the session's runtime", () => {
    expect(resolveSessionCapabilities("ses_a").modelSelection).toBe(true)
    expect(resolveSessionCapabilities(null, "omp").modelSelection).toBe(false)
    registerSessionRuntime("ses_a", "omp")
    expect(resolveSessionCapabilities("ses_a").modelSelection).toBe(false)
  })
})
