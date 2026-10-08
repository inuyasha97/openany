import { describe, expect, test } from "bun:test"
import type { OmpModelInfo } from "./model"
import {
  OmpRuntime,
  type OmpEvent,
  type OmpHost,
  type OmpPendingRequest,
  type OmpPromptOptions,
  type OmpSessionHandle,
  type OmpSessionInfo,
  type OmpSessionStatus,
} from "./runtime"

type FakeHandle = OmpSessionHandle & {
  abortCalls: number
  disposed: boolean
  sent: Array<{ type: string; id?: string; [key: string]: unknown }>
  emit: (event: OmpEvent) => void
}

const makeHandle = (id: string): FakeHandle => {
  const listeners = new Set<(event: OmpEvent) => void>()
  const handle: FakeHandle = {
    id,
    abortCalls: 0,
    disposed: false,
    sent: [],
    sessionFile: `/sessions/${id}.json`,
    abort: async () => {
      handle.abortCalls += 1
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: async () => {
      handle.disposed = true
    },
    messages: async () => [],
    send: (frame) => {
      handle.sent.push(frame)
    },
    emit: (event) => {
      for (const listener of listeners) listener(event)
    },
  }
  return handle
}

const info = (id: string): OmpSessionInfo => ({ id, sessionPath: `/sessions/${id}.json`, cwd: "/repo", title: id })

const IDLE_STATUS: OmpSessionStatus = {
  busy: false,
  compacting: false,
  queuedCount: 0,
  tokensPerSecond: null,
  contextUsage: null,
}

type FakeHostOptions = {
  status?: OmpSessionStatus
  branchResult?: OmpSessionInfo
  pending?: OmpPendingRequest[]
  models?: OmpModelInfo[]
}

type HostHarness = {
  host: OmpHost
  opened: string[]
  handles: Map<string, FakeHandle>
  renamed: Array<[string, string]>
  deleted: string[]
  moved: Array<[string, string]>
  models: Array<[string, string, string]>
  openInputs: Array<{ sessionPath?: string; cwd?: string; parentSession?: string }>
  logins: string[]
  promptCalls: Array<{ id: string; text: string; options?: OmpPromptOptions }>
  commands: Array<Record<string, unknown>>
}

const makeHost = (infos: OmpSessionInfo[], options: FakeHostOptions = {}): HostHarness => {
  const handles = new Map<string, FakeHandle>()
  const opened: string[] = []
  const renamed: Array<[string, string]> = []
  const deleted: string[] = []
  const moved: Array<[string, string]> = []
  const models: Array<[string, string, string]> = []
  const openInputs: Array<{ sessionPath?: string; cwd?: string; parentSession?: string }> = []
  const logins: string[] = []
  const promptCalls: Array<{ id: string; text: string; options?: OmpPromptOptions }> = []
  const commands: Array<Record<string, unknown>> = []
  const status = options.status ?? IDLE_STATUS
  const branchResult = options.branchResult ?? info("ses_fork")
  const modelList: OmpModelInfo[] = options.models ?? [{ provider: "anthropic", id: "claude", reasoning: true, efforts: ["low", "high"] }]
  const host: OmpHost = {
    listSessions: async () => infos,
    openSession: async (input) => {
      openInputs.push(input)
      const id = input.sessionPath ? (input.sessionPath.split("/").pop() ?? "session").replace(".json", "") : "new-session"
      opened.push(id)
      const handle = makeHandle(id)
      handles.set(id, handle)
      return handle
    },
    prompt: async (id, text, promptOptions) => {
      promptCalls.push({ id, text, options: promptOptions })
      return true
    },
    branch: async (_id, entryId) => {
      commands.push({ type: "branch", entryId })
      return branchResult
    },
    renameSession: async (id, title) => {
      renamed.push([id, title])
    },
    deleteSession: async (id) => {
      deleted.push(id)
      return true
    },
    moveSession: async (id, to) => {
      moved.push([id, to])
    },
    setModel: async (id, provider, modelId) => {
      models.push([id, provider, modelId])
    },
    listModels: async () => modelList,
    listCommands: async () => [{ name: "goal", source: "builtin" }],
    setThinkingLevel: async (_id, level) => {
      commands.push({ type: "set_thinking_level", level })
      return true
    },
    cycleThinkingLevel: async () => {
      commands.push({ type: "cycle_thinking_level" })
      return "high"
    },
    setFastMode: async (_id, enabled) => {
      commands.push({ type: "set_fast_mode", enabled })
      return { enabled, active: enabled }
    },
    listLoginProviders: async () => [{ id: "anthropic", name: "Anthropic", available: true, authenticated: false }],
    login: async (providerId) => {
      logins.push(providerId)
      return { providerId }
    },
    getSessionStatus: async () => status,
    listPendingRequests: () => options.pending ?? [],
  }
  return { host, opened, handles, renamed, deleted, moved, models, openInputs, logins, promptCalls, commands }
}

describe("OmpRuntime", () => {
  test("lists sessions through the host", async () => {
    const runtime = new OmpRuntime(makeHost([info("ses_a")]).host)
    expect(await runtime.listSessions()).toEqual([info("ses_a")])
  })

  test("creates a session, attaches it and routes a prompt", async () => {
    const { host, promptCalls } = makeHost([])
    const runtime = new OmpRuntime(host)
    const created = await runtime.createSession({ cwd: "/repo" })
    expect(created.id).toBe("new-session")
    await runtime.prompt("new-session", "hi")
    expect(promptCalls).toEqual([{ id: "new-session", text: "hi", options: undefined }])
  })

  test("forwards prompt options to the host", async () => {
    const { host, promptCalls } = makeHost([])
    const runtime = new OmpRuntime(host)
    await runtime.createSession({ cwd: "/repo" })
    const images = [{ type: "image" as const, data: "QUJD", mimeType: "image/png" }]
    await runtime.prompt("new-session", "look", { images })
    expect(promptCalls).toEqual([{ id: "new-session", text: "look", options: { images } }])
  })

  test("reuses an attached session instead of opening it again", async () => {
    const { host, opened } = makeHost([info("ses_a")])
    const runtime = new OmpRuntime(host)
    const first = await runtime.getSession("ses_a")
    const second = await runtime.getSession("ses_a")
    expect(second).toBe(first)
    expect(opened).toEqual(["ses_a"])
  })

  test("opens a listed session by path and throws for an unknown one", async () => {
    const { host, opened, openInputs } = makeHost([info("ses_a")])
    const runtime = new OmpRuntime(host)
    await runtime.getSession("ses_a")
    expect(opened).toEqual(["ses_a"])
    // OMP refuses a switch that changes the working directory.
    expect(openInputs).toEqual([{ sessionPath: "/sessions/ses_a.json", cwd: "/repo" }])
    await expect(runtime.getSession("missing")).rejects.toThrow("unknown omp session: missing")
  })

  test("carries a parent session through session creation", async () => {
    const { host, openInputs } = makeHost([])
    const runtime = new OmpRuntime(host)
    await runtime.createSession({ cwd: "/repo", parentSession: "/sessions/parent.json" })
    expect(openInputs).toEqual([{ cwd: "/repo", parentSession: "/sessions/parent.json" }])
  })

  test("fans session events out to subscribers", async () => {
    const { host, handles } = makeHost([info("ses_a")])
    const runtime = new OmpRuntime(host)
    const seen: Array<[string, OmpEvent]> = []
    const unsubscribe = runtime.subscribe((sessionId, event) => seen.push([sessionId, event]))
    await runtime.getSession("ses_a")
    handles.get("ses_a")?.emit({ type: "turn_start" })
    unsubscribe()
    handles.get("ses_a")?.emit({ type: "turn_end" })
    expect(seen).toEqual([["ses_a", { type: "turn_start" }]])
  })

  test("delegates rename, delete and move to the host", async () => {
    const { host, renamed, deleted, moved, models } = makeHost([info("ses_a")])
    const runtime = new OmpRuntime(host)
    await runtime.renameSession("ses_a", "New title")
    expect(await runtime.deleteSession("ses_a")).toBe(true)
    await runtime.moveSession("ses_a", "/repo/b")
    await runtime.setModel("ses_a", "anthropic", "claude")
    expect(renamed).toEqual([["ses_a", "New title"]])
    expect(deleted).toEqual(["ses_a"])
    expect(moved).toEqual([["ses_a", "/repo/b"]])
    expect(models).toEqual([["ses_a", "anthropic", "claude"]])
  })

  test("reads models, commands and session status from the host", async () => {
    const status: OmpSessionStatus = { busy: true, compacting: true, queuedCount: 2, tokensPerSecond: 12, contextUsage: { tokens: 10, contextWindow: 100, percent: 10 } }
    const { host } = makeHost([], { status })
    const runtime = new OmpRuntime(host)
    expect(await runtime.listModels()).toEqual([{ provider: "anthropic", id: "claude", reasoning: true, efforts: ["low", "high"] }])
    expect(await runtime.listCommands()).toEqual([{ name: "goal", source: "builtin" }])
    expect(await runtime.getSessionStatus("ses_a")).toEqual(status)
  })

  test("sends a command as prompt text", async () => {
    const { host, promptCalls } = makeHost([info("ses_1")])
    const runtime = new OmpRuntime(host)
    await runtime.sendCommand({ id: "ses_1", command: "review", arguments: "the diff", directory: "/repo" })
    expect(promptCalls).toEqual([{ id: "ses_1", text: "/review the diff", options: { cwd: "/repo" } }])
  })

  test("sends a command with no arguments as the bare command", async () => {
    const { host, promptCalls } = makeHost([info("ses_1")])
    const runtime = new OmpRuntime(host)
    await runtime.sendCommand({ id: "ses_1", command: "init", arguments: "", directory: "/repo" })
    expect(promptCalls[0]?.text).toBe("/init")
  })

  test("forwards thinking level, cycle and fast mode to the host", async () => {
    const { host, commands } = makeHost([info("ses_1")])
    const runtime = new OmpRuntime(host)
    await runtime.setThinkingLevel("ses_1", "high")
    expect(await runtime.cycleThinkingLevel("ses_1")).toBe("high")
    expect(await runtime.setFastMode("ses_1", true)).toEqual({ enabled: true, active: true })
    expect(commands).toContainEqual({ type: "set_thinking_level", level: "high" })
    expect(commands).toContainEqual({ type: "cycle_thinking_level" })
    expect(commands).toContainEqual({ type: "set_fast_mode", enabled: true })
  })

  test("branches at an entry and follows the new session without reopening it", async () => {
    const fork: OmpSessionInfo = { id: "ses_2", sessionPath: "/sessions/ses_2.json", cwd: "/repo", title: "ses_2" }
    const { host, opened, handles, commands } = makeHost([info("ses_1")], { branchResult: fork })
    const runtime = new OmpRuntime(host)
    const forked = await runtime.forkSession({ id: "ses_1", entryId: "e7", directory: "/repo" })
    expect(commands).toContainEqual({ type: "branch", entryId: "e7" })
    expect(forked.id).toBe("ses_2")
    // The branched session is served by the same process, so it must not spawn a
    // second one: the rekeyed id resolves to the handle the original opened.
    expect(opened).toEqual(["ses_1"])
    expect(await runtime.getSession("ses_2")).toBe(handles.get("ses_1"))
    expect(opened).toEqual(["ses_1"])
  })

  test("lists the session's pending askable frames", async () => {
    const pending: OmpPendingRequest[] = [{ requestId: "r1", sessionId: "ses_1", method: "select", title: "Which?" }]
    const { host } = makeHost([info("ses_1")], { pending })
    const runtime = new OmpRuntime(host)
    expect(await runtime.listPendingRequests("ses_1")).toEqual(pending)
  })

  test("reads login providers and starts a login through the host", async () => {
    const { host, logins } = makeHost([])
    const runtime = new OmpRuntime(host)
    expect(await runtime.listLoginProviders()).toEqual([{ id: "anthropic", name: "Anthropic", available: true, authenticated: false }])
    expect(await runtime.login("anthropic")).toEqual({ providerId: "anthropic" })
    expect(logins).toEqual(["anthropic"])
  })

  test("writes an unsolicited frame to the session process", async () => {
    const { host, handles } = makeHost([info("ses_a")])
    const runtime = new OmpRuntime(host)
    await runtime.getSession("ses_a")
    await runtime.sendToSession("ses_a", { type: "extension_ui_response", id: "ui_1", confirmed: true })
    expect(handles.get("ses_a")?.sent).toEqual([{ type: "extension_ui_response", id: "ui_1", confirmed: true }])
  })

  test("awaits async handle messages", async () => {
    const { host, handles } = makeHost([info("ses_a")])
    const runtime = new OmpRuntime(host)
    await runtime.getSession("ses_a")
    expect(await runtime.getMessages("ses_a")).toEqual([])
    expect(typeof handles.get("ses_a")?.messages).toBe("function")
  })

  test("disposes an idle session process and re-opens it on next use", async () => {
    const { host, handles, opened } = makeHost([info("ses_a")])
    const runtime = new OmpRuntime(host)
    await runtime.getSession("ses_a")

    // Fresh: not swept.
    expect(await runtime.disposeIdle(60_000)).toEqual([])
    // Past the window: swept, and the process is gone.
    expect(await runtime.disposeIdle(1_000, Date.now() + 10_000)).toEqual(["ses_a"])
    expect(handles.get("ses_a")?.disposed).toBe(true)

    // The next use opens it again.
    await runtime.getSession("ses_a")
    expect(opened).toEqual(["ses_a", "ses_a"])
    expect(handles.get("ses_a")?.disposed).toBe(false)
  })

  test("disposes every session process opened in a directory", async () => {
    const { host, handles } = makeHost([info("ses_a")])
    const runtime = new OmpRuntime(host)
    await runtime.getSession("ses_a")
    await runtime.createSession({ cwd: "/repo" })

    expect(await runtime.disposeSessionsInDirectory("/elsewhere")).toEqual([])
    expect(await runtime.disposeSessionsInDirectory("/repo/")).toEqual(["ses_a", "new-session"])
    expect(handles.get("ses_a")?.disposed).toBe(true)
    expect(handles.get("new-session")?.disposed).toBe(true)
  })

  test("aborts and disposes attached sessions on teardown", async () => {
    const { host, handles } = makeHost([info("ses_a")])
    const runtime = new OmpRuntime(host)
    await runtime.getSession("ses_a")
    await runtime.abort("ses_a")
    expect(handles.get("ses_a")?.abortCalls).toBe(1)
    await runtime.dispose()
    expect(handles.get("ses_a")?.disposed).toBe(true)
  })
})
