import { describe, expect, test } from "bun:test"
import type { OmpRpcChild } from "./rpc-client"
import { createOmpHost, resolveOmpCommand } from "./rpc-host"

const fakeChild = () => {
  const stdoutListeners: Array<(chunk: string | Uint8Array) => void> = []
  const written: string[] = []
  const child: OmpRpcChild = {
    stdout: { on: (_e, l) => stdoutListeners.push(l) },
    stderr: { on: () => {} },
    stdin: { write: (chunk) => written.push(chunk), end: () => {} },
    on: () => {},
    kill: () => {},
  }
  const emit = (line: string) => {
    for (const l of stdoutListeners) l(`${line}\n`)
  }
  return { child, written, emit }
}

describe("createOmpHost", () => {
  test("opens a session, fans out events and answers prompts", async () => {
    const fake = fakeChild()
    const store = { list: async () => [], delete: async () => {}, move: async () => { throw new Error("unused") } }
    const host = createOmpHost({ spawn: () => fake.child, store })
    const handlePromise = host.openSession({ cwd: "/repo" })
    fake.emit(JSON.stringify({ type: "ready" }))
    // openSession awaits get_state after ready
    await Promise.resolve()
    const stateReq = JSON.parse(fake.written.at(-1) ?? "{}") as { id: string; type: string }
    expect(stateReq.type).toBe("get_state")
    fake.emit(JSON.stringify({ id: stateReq.id, type: "response", command: "get_state", success: true, data: { sessionId: "ses_1", sessionFile: "/s/ses_1.jsonl" } }))
    const handle = await handlePromise
    expect(handle.id).toBe("ses_1")

    const seen: unknown[] = []
    const unsubscribe = handle.subscribe((event) => seen.push(event))
    fake.emit(JSON.stringify({ type: "turn_start" }))
    unsubscribe()
    expect(seen).toEqual([{ type: "turn_start" }])

    const prompted = handle.prompt("hello")
    const promptReq = JSON.parse(fake.written.at(-1) ?? "{}") as { id: string; type: string }
    expect(promptReq.type).toBe("prompt")
    fake.emit(JSON.stringify({ id: promptReq.id, type: "response", command: "prompt", success: true, data: { agentInvoked: true } }))
    expect(await prompted).toBe(true)

    await handle.dispose()
  })

  test("carries a prompt's images in the rpc frame and omits the field when empty", async () => {
    const fake = fakeChild()
    const store = { list: async () => [], delete: async () => {}, move: async () => { throw new Error("unused") } }
    const host = createOmpHost({ spawn: () => fake.child, store })
    const handlePromise = host.openSession({ cwd: "/repo" })
    fake.emit(JSON.stringify({ type: "ready" }))
    await Promise.resolve()
    const stateReq = JSON.parse(fake.written.at(-1) ?? "{}") as { id: string; type: string }
    fake.emit(JSON.stringify({ id: stateReq.id, type: "response", command: "get_state", success: true, data: { sessionId: "ses_1" } }))
    const handle = await handlePromise

    const images = [{ type: "image" as const, data: "QUJD", mimeType: "image/png" }]
    const pictured = handle.prompt("look", { images })
    const picked = JSON.parse(fake.written.at(-1) ?? "{}") as { id: string; message?: string; images?: unknown }
    expect(picked.message).toBe("look")
    expect(picked.images).toEqual(images)
    fake.emit(JSON.stringify({ id: picked.id, type: "response", command: "prompt", success: true, data: { agentInvoked: true } }))
    expect(await pictured).toBe(true)

    const plain = handle.prompt("plain")
    const bare = JSON.parse(fake.written.at(-1) ?? "{}") as { id: string; type: string }
    expect(bare.type).toBe("prompt")
    expect(bare).not.toHaveProperty("images")
    fake.emit(JSON.stringify({ id: bare.id, type: "response", command: "prompt", success: true, data: { agentInvoked: true } }))
    expect(await plain).toBe(true)

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
    const host = createOmpHost({ spawn: () => fake.child, store })
    const handlePromise = host.openSession({ cwd: "/repo" })
    fake.emit(JSON.stringify({ type: "ready" }))
    await Promise.resolve()
    const stateReq = JSON.parse(fake.written.at(-1) ?? "{}") as { id: string }
    fake.emit(JSON.stringify({ id: stateReq.id, type: "response", command: "get_state", success: true, data: { sessionId: "ses_1" } }))
    await handlePromise

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
    const stateReq = JSON.parse(fake.written.at(-1) ?? "{}") as { id: string }
    fake.emit(JSON.stringify({ id: stateReq.id, type: "response", command: "get_state", success: true, data: { sessionId: "ses_new", sessionFile: "/s/lazy.jsonl" } }))
    await handlePromise

    expect(await host.deleteSession("ses_new")).toBe(true)
    expect(deleted).toEqual(["/s/lazy.jsonl"])
  })

  test("throws when renaming a session the store does not know", async () => {    const store = { list: async () => [], delete: async () => {}, move: async () => { throw new Error("unused") } }
    const host = createOmpHost({ spawn: () => fakeChild().child, store })
    await expect(host.renameSession("missing", "x")).rejects.toThrow("unknown omp session: missing")
  })

  test("lists models on a short-lived rpc process that is disposed", async () => {
    const fake = fakeChild()
    let spawned = 0
    const store = { list: async () => [], delete: async () => {}, move: async () => { throw new Error("unused") } }
    const host = createOmpHost({ spawn: () => { spawned += 1; return fake.child }, store })
    const pending = host.listModels()
    fake.emit(JSON.stringify({ type: "ready" }))
    await Promise.resolve()
    const req = JSON.parse(fake.written.at(-1) ?? "{}") as { id: string }
    fake.emit(JSON.stringify({ id: req.id, type: "response", command: "get_available_models", success: true, data: { models: [{ provider: "anthropic", id: "claude" }] } }))

    expect(await pending).toEqual([{ provider: "anthropic", id: "claude" }])
    expect(spawned).toBe(1)
  })

  test("lists login providers on a short-lived rpc process", async () => {
    const fake = fakeChild()
    const store = { list: async () => [], delete: async () => {}, move: async () => { throw new Error("unused") } }
    const host = createOmpHost({ spawn: () => fake.child, store })
    const pending = host.listLoginProviders()
    fake.emit(JSON.stringify({ type: "ready" }))
    await Promise.resolve()
    const req = JSON.parse(fake.written.at(-1) ?? "{}") as { id: string; type: string }
    expect(req.type).toBe("get_login_providers")
    fake.emit(JSON.stringify({ id: req.id, type: "response", command: "get_login_providers", success: true, data: { providers: [{ id: "anthropic", name: "Anthropic", available: true, authenticated: false }] } }))

    expect(await pending).toEqual([{ id: "anthropic", name: "Anthropic", available: true, authenticated: false }])
  })

  test("runs a login and hands each frame to the caller with a reply sink", async () => {
    const fake = fakeChild()
    const store = { list: async () => [], delete: async () => {}, move: async () => { throw new Error("unused") } }
    const host = createOmpHost({ spawn: () => fake.child, store })
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
    const store = { list: async () => [], delete: async () => {}, move: async () => { throw new Error("unused") } }
    const host = createOmpHost({ spawn: () => fake.child, store })
    const pending = host.login("anthropic", {
      onFrame: (frame, reply) => {
        if (frame.method !== "input") return
        reply({ type: "extension_ui_response", id: frame.id, value: "the-code" })
      },
    })
    fake.emit(JSON.stringify({ type: "ready" }))
    await Promise.resolve()
    const req = JSON.parse(fake.written.at(-1) ?? "{}") as { id: string }
    fake.emit(JSON.stringify({ type: "extension_ui_request", id: "ui_9", method: "input", title: "Paste the authorization code" }))

    expect(JSON.parse(fake.written.at(-1) ?? "{}")).toEqual({ type: "extension_ui_response", id: "ui_9", value: "the-code" })

    fake.emit(JSON.stringify({ id: req.id, type: "response", command: "login", success: true, data: { providerId: "anthropic" } }))
    await pending
  })

  test("rejects a login OMP refuses", async () => {
    const fake = fakeChild()
    const store = { list: async () => [], delete: async () => {}, move: async () => { throw new Error("unused") } }
    const host = createOmpHost({ spawn: () => fake.child, store })
    const pending = host.login("nope")
    fake.emit(JSON.stringify({ type: "ready" }))
    await Promise.resolve()
    const req = JSON.parse(fake.written.at(-1) ?? "{}") as { id: string }
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
