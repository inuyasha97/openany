import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { createStore } from "zustand/vanilla"
import { registerAgentRuntime } from "@/lib/agent/registry"
import { createOpenCodeStubRuntime, createOpenCodeStubSurface } from "@/lib/agent/testing/opencode-stub-runtime"
import type { PermissionRequest, Session } from "@/lib/opencode/model"
import { bootstrapDirectory } from "./bootstrap"
import { INITIAL_STATE, type State } from "./types"
import { getBackgroundNetworkState, runBackgroundNetworkTask } from "../lib/background-network"

// The stub runtime answers from the surface object registered here; the test
// owns that object and spies on the methods directory initialization reads.
const agentSurface = createOpenCodeStubSurface()
// `spyOn` can only replace an existing property, so give each method a default
// before installing the spy; `mockReset` restores that default between tests.
for (const method of ["getActiveStatus", "listPermissions", "listMcpServers", "listCommands"] as const) {
  agentSurface[method] = async () => { throw new Error(`${method} not stubbed`) }
}
const statuses = spyOn(agentSurface, "getActiveStatus")
const permissions = spyOn(agentSurface, "listPermissions")
// `commands` and `mcp` are spied so the regression test can assert bootstrap
// never touches them; they are not part of directory initialization.
const mcp = spyOn(agentSurface, "listMcpServers")
const commands = spyOn(agentSurface, "listCommands")
const spies = [statuses, permissions]

// The registry's default runtime is the real OMP client; register a
// surface-backed double so this test drives app logic with its own fixtures.
registerAgentRuntime(createOpenCodeStubRuntime())
// Sessions the OpenCode client created carry `runtimeId: "opencode"`; the
// registry answers an unregistered id with the real OMP client, so register the
// double under that id too.
registerAgentRuntime(createOpenCodeStubRuntime("opencode"))

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

beforeEach(() => {
  for (const spy of [...spies, mcp, commands]) spy.mockReset()
  statuses.mockResolvedValue({})
  permissions.mockResolvedValue([])
  mcp.mockResolvedValue([])
  commands.mockResolvedValue([])
})

afterEach(() => {
  expect(getBackgroundNetworkState().active).toBe(0)
})

const inputFor = (state: Partial<State> = {}) => {
  const store = createStore<State>(() => ({ ...INITIAL_STATE, ...state }))
  return {
    directory: "/repo", store,
    set: (patch: Partial<State>) => { store.setState(patch) },
    global: { config: {}, projects: [], path: { directory: "", worktree: "", home: "/home" } },
    loadSessions: async () => undefined,
  }
}

const permission = (id: string, action = "read"): PermissionRequest => ({
  id, sessionID: "session", action, resources: ["*"],
})

describe("bootstrapDirectory", () => {
  test("finishes session loading while the status read is unresolved", async () => {
    const blocked = deferred<void>()
    statuses.mockImplementation(async () => { await blocked.promise; return {} })
    const input = inputFor()
    let initialized = false
    const bootstrap = bootstrapDirectory(input)
    void bootstrap.environment.then(() => { initialized = true })
    try {
      expect(await bootstrap.sessions).toBe("complete")
      expect(initialized).toBe(false)
      expect(input.store.getState().status).toBe("partial")
    } finally {
      blocked.resolve()
      expect(await bootstrap.environment).toBe("complete")
      expect(input.store.getState().status).toBe("complete")
    }
  })

  test("keeps session-list failure separate from successful environment initialization", async () => {
    const cached: Session[] = [{
      id: "cached", projectID: "project-a", directory: "/repo", title: "Cached",
      time: { created: 1, updated: 1 }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }]
    const input = inputFor({ session: cached })
    const bootstrap = bootstrapDirectory({ ...input, loadSessions: async () => { throw new Error("unavailable") } })
    expect(await bootstrap.sessions).toBe("failed")
    expect(await bootstrap.environment).toBe("complete")
    expect(input.store.getState().session).toBe(cached)
  })

  test("a permission failure cannot suppress status recovery", async () => {
    permissions.mockRejectedValue(Object.assign(new Error("unavailable"), { status: 400 }))
    statuses.mockResolvedValue({ session: { type: "busy" } })
    const input = inputFor()
    const bootstrap = bootstrapDirectory(input)
    expect(await bootstrap.sessions).toBe("complete")
    expect(await bootstrap.environment).toBe("failed")
    expect(input.store.getState().sessionStatusReady).toBe(true)
    expect(input.store.getState().session_status).toEqual({ session: { type: "busy" } })
  })

  test("a failed status snapshot preserves live state and does not grant idle authority", async () => {
    const previous: State["session_status"] = { session: { type: "busy" } }
    statuses.mockResolvedValue(null)
    const input = inputFor({ session_status: previous })
    const bootstrap = bootstrapDirectory(input)
    expect(await bootstrap.sessions).toBe("complete")
    expect(await bootstrap.environment).toBe("failed")
    expect(input.store.getState().session_status).toBe(previous)
    expect(input.store.getState().sessionStatusReady).toBeUndefined()
  })

  test("never reads MCP-initializing endpoints during directory initialization", async () => {
    // Reading MCP status initializes the directory's entire stdio server
    // fleet, and listing commands enumerates MCP prompts, which touches the
    // same state. Bootstrap used to run for every known project directory, so
    // either read spawned a fleet per project at startup. MCP and command
    // surfaces fetch on demand instead.
    const input = inputFor()
    const bootstrap = bootstrapDirectory(input)
    expect(await bootstrap.sessions).toBe("complete")
    expect(await bootstrap.environment).toBe("complete")
    expect(mcp.mock.calls).toHaveLength(0)
    expect(commands.mock.calls).toHaveLength(0)
  })

  test("rejects stale work before starting either phase", async () => {
    const input = inputFor()
    const state = input.store.getState()
    let lists = 0
    const bootstrap = bootstrapDirectory({ ...input, isStale: () => true, loadSessions: async () => { lists += 1 } })
    expect(await bootstrap.sessions).toBe("stale")
    expect(await bootstrap.environment).toBe("stale")
    expect(lists).toBe(0)
    for (const spy of spies) expect(spy.mock.calls).toHaveLength(0)
    expect(input.store.getState()).toBe(state)
  })

  test("drops queued initialization reads after the directory generation changes", async () => {
    const blocked = Array.from({ length: getBackgroundNetworkState().limit }, () => deferred<void>())
    const occupied = blocked.map((task) => runBackgroundNetworkTask(() => task.promise))
    let stale = false
    const input = inputFor()
    const bootstrap = bootstrapDirectory({ ...input, isStale: () => stale })
    expect(await bootstrap.sessions).toBe("complete")
    stale = true
    const state = input.store.getState()
    for (const task of blocked) task.resolve()
    await Promise.all(occupied)
    expect(await bootstrap.environment).toBe("stale")
    for (const spy of spies) expect(spy.mock.calls).toHaveLength(0)
    expect(input.store.getState()).toBe(state)
  })

  test("an in-flight response cannot commit after its initialization is superseded", async () => {
    const response = deferred<State["session_status"]>()
    const started = deferred<void>()
    let stale = false
    statuses.mockImplementation(() => { started.resolve(); return response.promise })
    const input = inputFor()
    const bootstrap = bootstrapDirectory({ ...input, isStale: () => stale })
    await bootstrap.sessions
    await started.promise
    stale = true
    const state = input.store.getState()
    response.resolve({ session: { type: "busy" } })
    expect(await bootstrap.environment).toBe("stale")
    expect(input.store.getState()).toBe(state)
  })

  test("addresses directory reads explicitly and names the directory to the v2 active-status read", async () => {
    for (const directory of ["/workspace/Alpha", "C:/Users/Developer/Tree", "//Server/Share/Project", "C:/Users/Ірина/Project with spaces/100%", "C:/"]) {
      for (const spy of [...spies, mcp, commands]) spy.mock.calls.length = 0
      const input = { ...inputFor(), directory }
      const bootstrap = bootstrapDirectory(input)
      expect(await bootstrap.sessions).toBe("complete")
      expect(await bootstrap.environment).toBe("complete")
      // The directory travels with the read; the client keeps the host's snapshot global and
      // asks a directory inside an isolated space for its own.
      expect(statuses.mock.calls).toEqual([[directory]])
      expect(permissions.mock.calls).toEqual([[{ directories: [directory], includeGlobal: false }]])
    }
  })

  test("retries transient permission failures without replaying the session list", async () => {
    let lists = 0
    const pending = permission("pending")
    permissions.mockRejectedValueOnce(Object.assign(new Error("warming up"), { status: 503 })).mockResolvedValue([pending])
    const input = inputFor()
    const bootstrap = bootstrapDirectory({ ...input, loadSessions: async () => { lists += 1 } })
    expect(await bootstrap.sessions).toBe("complete")
    expect(await bootstrap.environment).toBe("complete")
    expect(permissions.mock.calls).toHaveLength(2)
    expect(lists).toBe(1)
    expect(input.store.getState().permission.session).toEqual([pending])
  })

  test("fetched permissions replace unchanged records and retain same-session live additions", async () => {
    const old = permission("perm-1")
    const added = permission("perm-2")
    const updated = permission("perm-1", "write")
    const input = inputFor({ permission: { session: [old] } })
    permissions.mockImplementation(async () => {
      input.store.setState({ permission: { session: [old, added] } })
      return [updated]
    })
    const bootstrap = bootstrapDirectory(input)
    await bootstrap.sessions
    expect(await bootstrap.environment).toBe("complete")
    expect(input.store.getState().permission.session).toEqual([updated, added])
  })
})
