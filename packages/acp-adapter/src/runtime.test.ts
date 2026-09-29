import { describe, expect, test } from "bun:test"
import { AcpRuntime, type AcpEvent, type AcpHost, type AcpSessionHandle, type AcpSessionInfo } from "./runtime"

type FakeHandle = AcpSessionHandle & {
  promptCalls: string[]
  cancelCalls: number
  permissionReplies: Array<{ requestId: string; optionId: string }>
  disposed: boolean
  emit: (event: AcpEvent) => void
}

const makeHandle = (id: string): FakeHandle => {
  const listeners = new Set<(event: AcpEvent) => void>()
  const handle: FakeHandle = {
    id,
    promptCalls: [],
    cancelCalls: 0,
    permissionReplies: [],
    disposed: false,
    prompt: async (text) => {
      handle.promptCalls.push(text)
      return true
    },
    cancel: async () => {
      handle.cancelCalls += 1
    },
    replyPermission: async (reply) => {
      handle.permissionReplies.push(reply)
      return true
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

const info = (id: string): AcpSessionInfo => ({ id, cwd: "/repo", title: id })

const makeHost = (infos: AcpSessionInfo[], unknownIds: string[] = []) => {
  const handles = new Map<string, FakeHandle>()
  const opened: string[] = []
  const host: AcpHost = {
    listSessions: async () => infos,
    openSession: async (input) => {
      const id = input.sessionId ?? "new-session"
      if (unknownIds.includes(id)) throw new Error(`unknown acp session: ${id}`)
      opened.push(id)
      const handle = makeHandle(id)
      handles.set(id, handle)
      return handle
    },
  }
  return { host, opened, handles }
}

describe("AcpRuntime", () => {
  test("lists sessions through the host", async () => {
    const runtime = new AcpRuntime(makeHost([info("ses_a")]).host)
    expect(await runtime.listSessions()).toEqual([info("ses_a")])
  })

  test("creates a session, attaches it and routes a prompt", async () => {
    const { host, handles } = makeHost([])
    const runtime = new AcpRuntime(host)
    const created = await runtime.createSession({ cwd: "/repo" })
    expect(created.id).toBe("new-session")
    await runtime.prompt("new-session", "hi")
    expect(handles.get("new-session")?.promptCalls).toEqual(["hi"])
  })

  test("reuses an attached session instead of opening it again", async () => {
    const { host, opened } = makeHost([info("ses_a")])
    const runtime = new AcpRuntime(host)
    const first = await runtime.getSession("ses_a")
    const second = await runtime.getSession("ses_a")
    expect(second).toBe(first)
    expect(opened).toEqual(["ses_a"])
  })

  test("throws for a session the host refuses", async () => {
    const runtime = new AcpRuntime(makeHost([], ["missing"]).host)
    await expect(runtime.getSession("missing")).rejects.toThrow("unknown acp session: missing")
  })

  test("fans session events out to subscribers with the session id", async () => {
    const { host, handles } = makeHost([info("ses_a")])
    const runtime = new AcpRuntime(host)
    const seen: Array<[string, AcpEvent]> = []
    const unsubscribe = runtime.subscribe((sessionId, event) => seen.push([sessionId, event]))
    await runtime.getSession("ses_a")
    handles.get("ses_a")?.emit({ type: "turn_ended", stopReason: "end_turn" })
    unsubscribe()
    handles.get("ses_a")?.emit({ type: "turn_ended" })
    expect(seen).toEqual([["ses_a", { type: "turn_ended", stopReason: "end_turn" }]])
  })

  test("routes a permission reply to the session handle", async () => {
    const { host, handles } = makeHost([info("ses_a")])
    const runtime = new AcpRuntime(host)
    expect(await runtime.replyPermission("ses_a", { requestId: "req_1", optionId: "allow_once" })).toBe(true)
    expect(handles.get("ses_a")?.permissionReplies).toEqual([{ requestId: "req_1", optionId: "allow_once" }])
  })

  test("cancels and disposes attached sessions on teardown", async () => {
    const { host, handles } = makeHost([info("ses_a")])
    const runtime = new AcpRuntime(host)
    await runtime.getSession("ses_a")
    await runtime.cancel("ses_a")
    expect(handles.get("ses_a")?.cancelCalls).toBe(1)
    await runtime.dispose()
    expect(handles.get("ses_a")?.disposed).toBe(true)
  })
})
