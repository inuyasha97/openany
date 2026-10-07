import { describe, expect, test } from "bun:test"
import { OmpRuntime, type OmpEvent, type OmpHost, type OmpSessionHandle, type OmpSessionInfo } from "./runtime"

type FakeHandle = OmpSessionHandle & {
  promptCalls: string[]
  abortCalls: number
  disposed: boolean
  sent: Array<{ type: string; id?: string; [key: string]: unknown }>
  emit: (event: OmpEvent) => void
}

const makeHandle = (id: string): FakeHandle => {
  const listeners = new Set<(event: OmpEvent) => void>()
  const handle: FakeHandle = {
    id,
    promptCalls: [],
    abortCalls: 0,
    disposed: false,
    sent: [],
    sessionFile: `/sessions/${id}.json`,
    prompt: async (text) => {
      handle.promptCalls.push(text)
      return true
    },
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

const makeHost = (infos: OmpSessionInfo[]): {
  host: OmpHost
  opened: string[]
  handles: Map<string, FakeHandle>
  renamed: Array<[string, string]>
  deleted: string[]
  moved: Array<[string, string]>
  models: Array<[string, string, string]>
  openInputs: Array<{ sessionPath?: string; cwd?: string }>
} => {
  const handles = new Map<string, FakeHandle>()
  const opened: string[] = []
  const renamed: Array<[string, string]> = []
  const deleted: string[] = []
  const moved: Array<[string, string]> = []
  const models: Array<[string, string, string]> = []
  const openInputs: Array<{ sessionPath?: string; cwd?: string }> = []
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
    listModels: async () => [{ provider: "anthropic", id: "claude" }],
    listCommands: async () => [{ name: "goal", source: "builtin" }],
    getSessionStatus: async () => ({ busy: false }),
  }
  return { host, opened, handles, renamed, deleted, moved, models, openInputs }
}

describe("OmpRuntime", () => {
  test("lists sessions through the host", async () => {
    const runtime = new OmpRuntime(makeHost([info("ses_a")]).host)
    expect(await runtime.listSessions()).toEqual([info("ses_a")])
  })

  test("creates a session, attaches it and routes a prompt", async () => {
    const { host, handles } = makeHost([])
    const runtime = new OmpRuntime(host)
    const created = await runtime.createSession({ cwd: "/repo" })
    expect(created.id).toBe("new-session")
    await runtime.prompt("new-session", "hi")
    expect(handles.get("new-session")?.promptCalls).toEqual(["hi"])
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
    const { host } = makeHost([])
    const runtime = new OmpRuntime(host)
    expect(await runtime.listModels()).toEqual([{ provider: "anthropic", id: "claude" }])
    expect(await runtime.listCommands()).toEqual([{ name: "goal", source: "builtin" }])
    expect(await runtime.getSessionStatus("ses_a")).toEqual({ busy: false })
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
