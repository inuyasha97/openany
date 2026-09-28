import { describe, expect, test } from "bun:test"
import { OmpRuntime, type OmpEvent, type OmpHost, type OmpSessionHandle, type OmpSessionInfo } from "./runtime"

type FakeHandle = OmpSessionHandle & {
  promptCalls: string[]
  abortCalls: number
  disposed: boolean
  emit: (event: OmpEvent) => void
}

const makeHandle = (id: string): FakeHandle => {
  const listeners = new Set<(event: OmpEvent) => void>()
  const handle: FakeHandle = {
    id,
    promptCalls: [],
    abortCalls: 0,
    disposed: false,
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
    emit: (event) => {
      for (const listener of listeners) listener(event)
    },
  }
  return handle
}

const info = (id: string): OmpSessionInfo => ({ id, sessionPath: `/sessions/${id}.json`, cwd: "/repo", title: id })

const makeHost = (infos: OmpSessionInfo[]): { host: OmpHost; opened: string[]; handles: Map<string, FakeHandle> } => {
  const handles = new Map<string, FakeHandle>()
  const opened: string[] = []
  const host: OmpHost = {
    listSessions: async () => infos,
    openSession: async (input) => {
      const id = input.sessionPath ? (input.sessionPath.split("/").pop() ?? "session").replace(".json", "") : "new-session"
      opened.push(id)
      const handle = makeHandle(id)
      handles.set(id, handle)
      return handle
    },
  }
  return { host, opened, handles }
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
    const { host, opened } = makeHost([info("ses_a")])
    const runtime = new OmpRuntime(host)
    await runtime.getSession("ses_a")
    expect(opened).toEqual(["ses_a"])
    await expect(runtime.getSession("missing")).rejects.toThrow("unknown omp session: missing")
  })

  test("fans session events out to subscribers", async () => {
    const { host, handles } = makeHost([info("ses_a")])
    const runtime = new OmpRuntime(host)
    const seen: OmpEvent[] = []
    const unsubscribe = runtime.subscribe((event) => seen.push(event))
    await runtime.getSession("ses_a")
    handles.get("ses_a")?.emit({ type: "message_update" })
    unsubscribe()
    handles.get("ses_a")?.emit({ type: "turn_end" })
    expect(seen).toEqual([{ type: "message_update" }])
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
