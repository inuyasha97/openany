import { describe, expect, test } from "bun:test"
import type { OmpRpcChild } from "./rpc-client"
import type { OmpSessionStore } from "./session-store"
import { createOmpHost, resolveOmpCommand } from "./rpc-host"

type FakeChild = {
  child: OmpRpcChild
  written: string[]
  emit: (line: string) => void
  /** Resolves with the next frame of `type` the host writes. */
  waitFor: (type: string) => Promise<{ id: string; type: string }>
}

const fakeChild = (): FakeChild => {
  const stdoutListeners: Array<(chunk: string | Uint8Array) => void> = []
  const written: string[] = []
  const waiters: Array<{ type: string; resolve: (frame: { id: string; type: string }) => void }> = []
  const child: OmpRpcChild = {
    stdout: { on: (_e, l) => stdoutListeners.push(l) },
    stderr: { on: () => {} },
    stdin: {
      write: (chunk) => {
        written.push(chunk)
        const frame = JSON.parse(chunk) as { id: string; type: string }
        for (let index = waiters.length - 1; index >= 0; index -= 1) {
          if (waiters[index].type === frame.type) waiters.splice(index, 1)[0].resolve(frame)
        }
      },
      end: () => {},
    },
    on: () => {},
    kill: () => {},
  }
  const emit = (line: string) => {
    for (const l of stdoutListeners) l(`${line}\n`)
  }
  const waitFor = (type: string) => {
    const { promise, resolve } = Promise.withResolvers<{ id: string; type: string }>()
    waiters.push({ type, resolve })
    return promise
  }
  return { child, written, emit, waitFor }
}

const emptyStore = () => ({ list: async () => [], delete: async () => {}, move: async () => { throw new Error("unused") } })

const lastFrame = (fake: { written: string[] }) => JSON.parse(fake.written.at(-1) ?? "{}") as { id: string; type: string }

/** Opens a session on a fake child and completes the get_state handshake. */
const openFakeSession = async (
  fake: FakeChild,
  store: OmpSessionStore = emptyStore(),
  input: { cwd?: string } = { cwd: "/repo" },
  readFile: (file: string) => string = () => "",
) => {
  const host = createOmpHost({ spawn: () => fake.child, store, readFile })
  const pending = host.openSession(input)
  fake.emit(JSON.stringify({ type: "ready" }))
  await Promise.resolve()
  const stateReq = lastFrame(fake)
  fake.emit(JSON.stringify({ id: stateReq.id, type: "response", command: "get_state", success: true, data: { sessionId: "ses_1", sessionFile: "/s/ses_1.jsonl", sessionName: "first" } }))
  const handle = await pending
  return { host, handle }
}

describe("createOmpHost", () => {
  test("opens a session, fans out events and answers prompts", async () => {
    const fake = fakeChild()
    const { host, handle } = await openFakeSession(fake)
    expect(handle.id).toBe("ses_1")

    const seen: unknown[] = []
    const unsubscribe = handle.subscribe((event) => seen.push(event))
    fake.emit(JSON.stringify({ type: "turn_start" }))
    unsubscribe()
    expect(seen).toEqual([{ type: "turn_start" }])

    const prompted = host.prompt("ses_1", "hello")
    const promptReq = lastFrame(fake)
    expect(promptReq.type).toBe("prompt")
    fake.emit(JSON.stringify({ id: promptReq.id, type: "response", command: "prompt", success: true, data: { agentInvoked: true } }))
    expect(await prompted).toBe(true)

    await handle.dispose()
  })

  test("refuses to prompt a session that is not open", async () => {
    const host = createOmpHost({ spawn: () => fakeChild().child, store: emptyStore() })
    await expect(host.prompt("ses_missing", "hi")).rejects.toThrow("omp session is not open: ses_missing")
  })

  test("carries a prompt's images in the rpc frame and omits the field when empty", async () => {
    const fake = fakeChild()
    const { host, handle } = await openFakeSession(fake)

    const images = [{ type: "image" as const, data: "QUJD", mimeType: "image/png" }]
    const pictured = host.prompt("ses_1", "look", { images })
    const picked = JSON.parse(fake.written.at(-1) ?? "{}") as { id: string; message?: string; images?: unknown }
    expect(picked.message).toBe("look")
    expect(picked.images).toEqual(images)
    fake.emit(JSON.stringify({ id: picked.id, type: "response", command: "prompt", success: true, data: { agentInvoked: true } }))
    expect(await pictured).toBe(true)

    const plain = host.prompt("ses_1", "plain")
    const bare = lastFrame(fake)
    expect(bare.type).toBe("prompt")
    expect(JSON.parse(fake.written.at(-1) ?? "{}")).not.toHaveProperty("images")
    fake.emit(JSON.stringify({ id: bare.id, type: "response", command: "prompt", success: true, data: { agentInvoked: true } }))
    expect(await plain).toBe(true)

    await handle.dispose()
  })

  test("records the parent session when creating a fork", async () => {
    const fake = fakeChild()
    const openPromise = createOmpHost({ spawn: () => fake.child, store: emptyStore() }).openSession({ cwd: "/repo", parentSession: "/s/parent.jsonl" })
    fake.emit(JSON.stringify({ type: "ready" }))
    await Promise.resolve()
    const created = lastFrame(fake)
    expect(created.type).toBe("new_session")
    expect(JSON.parse(fake.written.at(-1) ?? "{}")).toMatchObject({ parentSession: "/s/parent.jsonl" })
    fake.emit(JSON.stringify({ id: created.id, type: "response", command: "new_session", success: true, data: { cancelled: false } }))
    await Promise.resolve()
    const stateReq = lastFrame(fake)
    expect(stateReq.type).toBe("get_state")
    fake.emit(JSON.stringify({ id: stateReq.id, type: "response", command: "get_state", success: true, data: { sessionId: "ses_fork", sessionFile: "/s/fork.jsonl" } }))
    expect((await openPromise).id).toBe("ses_fork")
  })

  test("forwards thinking level and fast mode commands", async () => {
    const fake = fakeChild()
    const { host, handle } = await openFakeSession(fake)

    const leveled = host.setThinkingLevel("ses_1", "xhigh")
    const levelReq = lastFrame(fake)
    expect(levelReq.type).toBe("set_thinking_level")
    expect(JSON.parse(fake.written.at(-1) ?? "{}")).toMatchObject({ level: "xhigh" })
    fake.emit(JSON.stringify({ id: levelReq.id, type: "response", command: "set_thinking_level", success: true }))
    expect(await leveled).toBe(true)

    const cycled = host.cycleThinkingLevel("ses_1")
    const cycleReq = lastFrame(fake)
    expect(cycleReq.type).toBe("cycle_thinking_level")
    fake.emit(JSON.stringify({ id: cycleReq.id, type: "response", command: "cycle_thinking_level", success: true, data: { level: "high" } }))
    expect(await cycled).toBe("high")

    const fast = host.setFastMode("ses_1", true)
    const fastReq = lastFrame(fake)
    expect(fastReq.type).toBe("set_fast_mode")
    fake.emit(JSON.stringify({ id: fastReq.id, type: "response", command: "set_fast_mode", success: true, data: { enabled: true, active: false } }))
    expect(await fast).toEqual({ enabled: true, active: false })

    await handle.dispose()
  })

  test("reports a compacting session as busy", async () => {
    const fake = fakeChild()
    const { host, handle } = await openFakeSession(fake)

    const status = host.getSessionStatus("ses_1")
    const statusReq = lastFrame(fake)
    expect(statusReq.type).toBe("get_state")
    fake.emit(
      JSON.stringify({
        id: statusReq.id,
        type: "response",
        command: "get_state",
        success: true,
        data: { sessionId: "ses_1", isStreaming: false, isCompacting: true, queuedMessageCount: 3, tokensPerSecond: 42, contextUsage: { tokens: 10, contextWindow: 100, percent: 10 } },
      }),
    )
    expect(await status).toEqual({
      busy: true,
      compacting: true,
      queuedCount: 3,
      tokensPerSecond: 42,
      contextUsage: { tokens: 10, contextWindow: 100, percent: 10 },
    })

    await handle.dispose()
  })

  test("reports an idle session when no process is open", async () => {
    const host = createOmpHost({ spawn: () => fakeChild().child, store: emptyStore() })
    expect(await host.getSessionStatus("ses_1")).toEqual({ busy: false, compacting: false, queuedCount: 0, tokensPerSecond: null, contextUsage: null })
  })

  test("resolves a projected cut to a session entry, follows the new session id and rejects an unknown cut", async () => {
    const fake = fakeChild()
    const sessionText = JSON.stringify({
      type: "message",
      id: "e7",
      parentId: "root",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1000 },
    })
    const { host, handle } = await openFakeSession(fake, emptyStore(), { cwd: "/repo" }, () => sessionText)

    // The cut is the UI's projected id; the host asks OMP which entries it will
    // branch at, then maps the cut's timestamp onto the session file's entry id.
    const branched = host.branch("ses_1", "omp:ses_1:user:1000")
    const listReq = lastFrame(fake)
    expect(listReq.type).toBe("get_branch_messages")
    const branchFrame = fake.waitFor("branch")
    fake.emit(JSON.stringify({ id: listReq.id, type: "response", command: "get_branch_messages", success: true, data: { messages: [{ entryId: "e7", text: "hello" }] } }))
    const branchReq = await branchFrame
    expect(JSON.parse(fake.written.at(-1) ?? "{}")).toMatchObject({ entryId: "e7" })
    const stateFrame = fake.waitFor("get_state")
    fake.emit(JSON.stringify({ id: branchReq.id, type: "response", command: "branch", success: true, data: { text: "hello", cancelled: false } }))
    const stateReq = await stateFrame
    fake.emit(JSON.stringify({ id: stateReq.id, type: "response", command: "get_state", success: true, data: { sessionId: "ses_2", sessionFile: "/s/ses_2.jsonl" } }))
    expect(await branched).toEqual({ id: "ses_2", sessionPath: "/s/ses_2.jsonl", cwd: "", title: "" })
    // The handle follows the branched session and the original id is released.
    expect(handle.id).toBe("ses_2")
    await expect(host.prompt("ses_1", "hi")).rejects.toThrow("omp session is not open: ses_1")
    const prompted = host.prompt("ses_2", "hi")
    fake.emit(JSON.stringify({ id: lastFrame(fake).id, type: "response", command: "prompt", success: true, data: { agentInvoked: true } }))
    expect(await prompted).toBe(true)

    await handle.dispose()
  })

  test("rejects a cut that names no session entry without branching", async () => {
    const fake = fakeChild()
    const { host, handle } = await openFakeSession(fake)

    const refused = host.branch("ses_1", "omp:ses_1:user:1000")
    const listReq = lastFrame(fake)
    fake.emit(JSON.stringify({ id: listReq.id, type: "response", command: "get_branch_messages", success: true, data: { messages: [] } }))
    const refusal = await refused.then(() => null, (error: unknown) => error as Error & { command?: string })
    expect(refusal?.message).toBe('No message in this session matches the branch cut "omp:ses_1:user:1000"; OMP branches before a user message, so the cut must name a message the session still has.')
    // The route keys its 400 on `command === 'branch'`, so the refusal carries it.
    expect(refusal?.command).toBe("branch")
    // The RPC `branch` frame is never sent, so OMP's session is left untouched.
    expect(fake.written.map((line) => JSON.parse(line).type).includes("branch")).toBe(false)

    await handle.dispose()
  })

  test("tracks askable frames and drops them on cancel and on reply", async () => {
    const fake = fakeChild()
    const { host, handle } = await openFakeSession(fake)

    fake.emit(JSON.stringify({ type: "extension_ui_request", id: "r1", method: "select", title: "Which one?", options: ["a", "b"], optionDetails: [{ description: "first" }, {}] }))
    expect(host.listPendingRequests("ses_1")).toEqual([
      {
        requestId: "r1",
        sessionId: "ses_1",
        method: "select",
        title: "Which one?",
        options: ["a", "b"],
        optionDetails: [{ description: "first" }, {}],
      },
    ])

    // A reply clears the ask it answered.
    handle.send({ type: "extension_ui_response", id: "r1", value: "a" })
    expect(host.listPendingRequests("ses_1")).toEqual([])

    // OMP's cancel frame clears the ask it supersedes.
    fake.emit(JSON.stringify({ type: "extension_ui_request", id: "r2", method: "editor", title: "Type something" }))
    expect(host.listPendingRequests("ses_1")).toHaveLength(1)
    fake.emit(JSON.stringify({ type: "extension_ui_request", id: "c1", method: "cancel", targetId: "r2" }))
    expect(host.listPendingRequests("ses_1")).toEqual([])

    // A non-ask frame is not tracked.
    fake.emit(JSON.stringify({ type: "extension_ui_request", id: "n1", method: "notify", message: "hi" }))
    expect(host.listPendingRequests("ses_1")).toEqual([])

    await handle.dispose()
  })

  test("lists sessions through the store", async () => {
    const store = {
      list: async () => [{ id: "ses_1", sessionPath: "/s/ses_1.jsonl", cwd: "/repo", title: "t" }],
      delete: async () => {},
      move: async () => { throw new Error("unused") },
    }
    const host = createOmpHost({ spawn: () => fakeChild().child, store })
    expect(await host.listSessions()).toEqual([{ id: "ses_1", sessionPath: "/s/ses_1.jsonl", cwd: "/repo", title: "t" }])
  })

  test("deletes a session through the store and disposes its client", async () => {
    const fake = fakeChild()
    const deleted: string[] = []
    const store = {
      list: async () => [{ id: "ses_1", sessionPath: "/s/ses_1.jsonl", cwd: "/repo", title: "t" }],
      delete: async (path: string) => {
        deleted.push(path)
      },
      move: async () => { throw new Error("unused") },
    }
    const { host } = await openFakeSession(fake, store)

    expect(await host.deleteSession("ses_1")).toBe(true)
    expect(deleted).toEqual(["/s/ses_1.jsonl"])
    expect(await host.deleteSession("missing")).toBe(false)
  })

  test("deletes a just-created session the store has not flushed yet", async () => {
    const fake = fakeChild()
    const deleted: string[] = []
    const store = {
      list: async () => [],
      delete: async (path: string) => {
        deleted.push(path)
      },
      move: async () => { throw new Error("unused") },
    }
    const host = createOmpHost({ spawn: () => fake.child, store })
    const handlePromise = host.openSession({ cwd: "/repo" })
    fake.emit(JSON.stringify({ type: "ready" }))
    await Promise.resolve()
    const stateReq = lastFrame(fake)
    fake.emit(JSON.stringify({ id: stateReq.id, type: "response", command: "get_state", success: true, data: { sessionId: "ses_new", sessionFile: "/s/lazy.jsonl" } }))
    await handlePromise

    expect(await host.deleteSession("ses_new")).toBe(true)
    expect(deleted).toEqual(["/s/lazy.jsonl"])
  })

  test("throws when renaming a session the store does not know", async () => {
    const store = emptyStore()
    const host = createOmpHost({ spawn: () => fakeChild().child, store })
    await expect(host.renameSession("missing", "x")).rejects.toThrow("unknown omp session: missing")
  })

  test("lists models on a short-lived rpc process that is disposed", async () => {
    const fake = fakeChild()
    let spawned = 0
    const host = createOmpHost({ spawn: () => { spawned += 1; return fake.child }, store: emptyStore() })
    const pending = host.listModels()
    fake.emit(JSON.stringify({ type: "ready" }))
    await Promise.resolve()
    const req = lastFrame(fake)
    fake.emit(
      JSON.stringify({
        id: req.id,
        type: "response",
        command: "get_available_models",
        success: true,
        data: { models: [{ provider: "anthropic", id: "claude", reasoning: true, thinking: { mode: "effort", efforts: ["low", "high"], defaultLevel: "low" } }, { provider: "openai", id: "plain", reasoning: false }] },
      }),
    )

    expect(await pending).toEqual([
      { provider: "anthropic", id: "claude", reasoning: true, thinking: { mode: "effort", efforts: ["low", "high"], defaultLevel: "low" }, efforts: ["low", "high"], defaultLevel: "low" },
      { provider: "openai", id: "plain", reasoning: false, efforts: [] },
    ])
    expect(spawned).toBe(1)
  })

  test("lists login providers on a short-lived rpc process", async () => {
    const fake = fakeChild()
    const host = createOmpHost({ spawn: () => fake.child, store: emptyStore() })
    const pending = host.listLoginProviders()
    fake.emit(JSON.stringify({ type: "ready" }))
    await Promise.resolve()
    const req = lastFrame(fake)
    expect(req.type).toBe("get_login_providers")
    fake.emit(JSON.stringify({ id: req.id, type: "response", command: "get_login_providers", success: true, data: { providers: [{ id: "anthropic", name: "Anthropic", available: true, authenticated: false }] } }))

    expect(await pending).toEqual([{ id: "anthropic", name: "Anthropic", available: true, authenticated: false }])
  })

  test("runs a login and hands each frame to the caller with a reply sink", async () => {
    const fake = fakeChild()
    const host = createOmpHost({ spawn: () => fake.child, store: emptyStore() })
    const frames: Array<Record<string, unknown>> = []
    const pending = host.login("anthropic", { onFrame: (frame) => frames.push(frame) })
    fake.emit(JSON.stringify({ type: "ready" }))
    await Promise.resolve()
    const req = JSON.parse(fake.written.at(-1) ?? "{}") as { id: string; type: string; providerId: string }
    expect(req.type).toBe("login")
    expect(req.providerId).toBe("anthropic")

    // OMP emits the browser URL and expects no answer for it.
    fake.emit(JSON.stringify({ type: "extension_ui_request", id: "ui_1", method: "open_url", url: "https://auth.example/start", launchUrl: "http://127.0.0.1:1234/launch" }))
    expect(frames).toEqual([{ type: "extension_ui_request", id: "ui_1", method: "open_url", url: "https://auth.example/start", launchUrl: "http://127.0.0.1:1234/launch" }])
    // `open_url` is not a question: the request is still the only frame written.
    expect(fake.written).toHaveLength(1)

    fake.emit(JSON.stringify({ id: req.id, type: "response", command: "login", success: true, data: { providerId: "anthropic" } }))
    expect(await pending).toEqual({ providerId: "anthropic" })
  })

  test("writes a reply frame the caller sends back for a prompt", async () => {
    const fake = fakeChild()
    const host = createOmpHost({ spawn: () => fake.child, store: emptyStore() })
    const pending = host.login("anthropic", {
      onFrame: (frame, reply) => {
        if (frame.method !== "input") return
        reply({ type: "extension_ui_response", id: frame.id, value: "the-code" })
      },
    })
    fake.emit(JSON.stringify({ type: "ready" }))
    await Promise.resolve()
    const req = lastFrame(fake)
    fake.emit(JSON.stringify({ type: "extension_ui_request", id: "ui_9", method: "input", title: "Paste the authorization code" }))

    expect(JSON.parse(fake.written.at(-1) ?? "{}")).toEqual({ type: "extension_ui_response", id: "ui_9", value: "the-code" })

    fake.emit(JSON.stringify({ id: req.id, type: "response", command: "login", success: true, data: { providerId: "anthropic" } }))
    await pending
  })

  test("rejects a login OMP refuses", async () => {
    const fake = fakeChild()
    const host = createOmpHost({ spawn: () => fake.child, store: emptyStore() })
    const pending = host.login("nope")
    fake.emit(JSON.stringify({ type: "ready" }))
    await Promise.resolve()
    const req = lastFrame(fake)
    fake.emit(JSON.stringify({ id: req.id, type: "response", command: "login", success: false, error: "Unknown OAuth provider: nope" }))

    await expect(pending).rejects.toThrow("Unknown OAuth provider: nope")
  })
})

describe("resolveOmpCommand", () => {
  test("prefers an explicit env path", () => {
    expect(resolveOmpCommand({ env: { OPENCHAMBER_OMP_PATH: "/opt/omp" }, resourcesPath: "/res", exists: () => true })).toBe("/opt/omp")
  })

  test("falls back to the bundled binary under resourcesPath", () => {
    expect(resolveOmpCommand({ env: {}, resourcesPath: "/res", exists: (candidate) => candidate === "/res/omp-cli/omp" })).toBe("/res/omp-cli/omp")
  })

  test("falls back to the PATH lookup name", () => {
    expect(resolveOmpCommand({ env: {}, resourcesPath: null, exists: () => false })).toBe("omp")
  })
})
