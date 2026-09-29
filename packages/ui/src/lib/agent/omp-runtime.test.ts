import { describe, expect, test } from "bun:test"
import { OmpRuntimeClient } from "./omp-runtime"

const sessions = [
  { id: "ses_a", sessionPath: "/s/a.json", cwd: "/repo", title: "A" },
]

const makeClient = (routes: Record<string, { status?: number; body: unknown }>) => {
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  const client = new OmpRuntimeClient(async (input, init) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const route = routes[`${method} ${url}`]
    if (!route) return new Response("not found", { status: 404 })
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { "content-type": "application/json" } })
  })
  return { client, calls }
}

describe("OmpRuntimeClient", () => {
  test("declares the omp id, no optional capabilities and an inert translator", () => {
    const { client } = makeClient({})
    expect(client.id).toBe("omp")
    expect(Object.values(client.capabilities)).toEqual([false, false, false, false, false, false, false, false, false, false, false, false, false, false, false])
    expect(client.translateEvent()).toEqual([])
  })

  test("lists sessions as AgentSessions carrying the runtime identity", async () => {
    const { client } = makeClient({ "GET /api/agents/omp/sessions": { body: { sessions } } })
    const listed = await client.listSessions()
    expect(listed).toEqual([
      {
        id: "ses_a",
        runtimeId: "omp",
        nativeSessionId: "ses_a",
        projectID: "",
        directory: "/repo",
        title: "A",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 0, updated: 0 },
      },
    ])
    expect(await client.listSessionsPage()).toEqual({ sessions: listed, cursor: {} })
  })

  test("throws for an unknown session", async () => {
    const { client } = makeClient({ "GET /api/agents/omp/sessions": { body: { sessions } } })
    await expect(client.getSession("missing")).rejects.toThrow("unknown omp session: missing")
  })

  test("creates a session with the directory as cwd", async () => {
    const { client, calls } = makeClient({
      "POST /api/agents/omp/sessions": { body: { session: { id: "ses_new", sessionFile: "/s/new.json" } } },
    })
    const session = await client.createSession({}, "/repo")
    expect(session.id).toBe("ses_new")
    expect(session.runtimeId).toBe("omp")
    expect(calls[0]).toEqual({ url: "/api/agents/omp/sessions", method: "POST", body: { cwd: "/repo" } })
  })

  test("prompts and cancels", async () => {
    const { client, calls } = makeClient({
      "POST /api/agents/omp/sessions/ses_a/prompt": { body: { ok: true } },
      "POST /api/agents/omp/sessions/ses_a/abort": { body: { ok: true } },
    })
    expect(await client.sendPrompt({ id: "ses_a", providerID: "anthropic", text: "hi" })).toBe("")
    expect(await client.cancel("ses_a")).toBe(true)
    expect(calls).toEqual([
      { url: "/api/agents/omp/sessions/ses_a/prompt", method: "POST", body: { text: "hi" } },
      { url: "/api/agents/omp/sessions/ses_a/abort", method: "POST", body: undefined },
    ])
  })

  test("reads messages and forwards a client message id", async () => {
    const { client, calls } = makeClient({
      "GET /api/agents/omp/sessions/ses_a/messages": { body: { items: [{ info: { id: "m1", role: "user" }, parts: [] }], cursor: {} } },
      "POST /api/agents/omp/sessions/ses_a/prompt": { body: { ok: true } },
    })
    const page = await client.getMessages("ses_a")
    expect(page.items.length).toBe(1)
    expect(page.items[0].info.id).toBe("m1")
    expect(await client.sendPrompt({ id: "ses_a", providerID: "anthropic", text: "hi", messageId: "client-1" })).toBe("client-1")
    expect(calls[1]).toEqual({ url: "/api/agents/omp/sessions/ses_a/prompt", method: "POST", body: { text: "hi", messageId: "client-1" } })
  })

  test("rejects an unsupported operation with a clear error", async () => {
    const { client } = makeClient({})
    await expect(client.listAgents()).rejects.toThrow("OMP runtime does not support listAgents")
  })

  test("surfaces an HTTP failure instead of an empty result", async () => {
    const { client } = makeClient({})
    await expect(client.listSessions()).rejects.toThrow("OMP request failed: 404")
  })
})