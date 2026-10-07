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
  test("declares the omp id, its capabilities and an inert translator", () => {
    const { client } = makeClient({})
    expect(client.id).toBe("omp")
    expect(client.capabilities).toMatchObject({
      rename: true, delete: true, move: true, commands: true, skills: true, permissions: true, mcp: true, modelSelection: true,
      attachments: true, attachmentKinds: "images",
      forms: false, revert: false, turnDiff: false, agentSelection: false,
    })
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

  test("renames, deletes and moves a session", async () => {
    const { client, calls } = makeClient({
      "PATCH /api/agents/omp/sessions/ses_a": { body: { ok: true } },
      "DELETE /api/agents/omp/sessions/ses_a": { body: { ok: true } },
      "POST /api/agents/omp/sessions/ses_a/move": { body: { ok: true } },
    })
    await client.renameSession("ses_a", "Renamed")
    expect(await client.deleteSession("ses_a")).toBe(true)
    await client.moveSession("ses_a", "/repo/b")
    expect(calls).toEqual([
      { url: "/api/agents/omp/sessions/ses_a", method: "PATCH", body: { title: "Renamed" } },
      { url: "/api/agents/omp/sessions/ses_a", method: "DELETE", body: undefined },
      { url: "/api/agents/omp/sessions/ses_a/move", method: "POST", body: { directory: "/repo/b" } },
    ])
  })

  test("lists commands and derives skills", async () => {
    const { client } = makeClient({
      "GET /api/agents/omp/commands": { body: { commands: [
        { name: "goal", source: "builtin", description: "g" },
        { name: "commit", source: "skill", description: "c" },
      ] } },
    })
    expect((await client.listCommands()).map((c) => c.name)).toEqual(["goal", "commit"])
    expect((await client.listSkills()).map((s) => s.name)).toEqual(["commit"])
  })

  test("reads per-session busy status for the directory", async () => {
    const { client } = makeClient({
      "GET /api/agents/omp/sessions": { body: { sessions: [
        { id: "ses_a", sessionPath: "/s/a.json", cwd: "/repo", title: "A" },
        { id: "ses_b", sessionPath: "/s/b.json", cwd: "/other", title: "B" },
      ] } },
      "GET /api/agents/omp/sessions/ses_a/status": { body: { busy: true } },
    })
    expect(await client.getActiveStatus("/repo")).toEqual({ ses_a: { type: "busy" } })
  })

  test("returns null when the status snapshot cannot be read", async () => {
    const { client } = makeClient({ "GET /api/agents/omp/sessions": { body: { sessions } } })
    expect(await client.getActiveStatus("/repo")).toBeNull()
  })

  test("answers a permission and lists the pending ones", async () => {
    const permission = { id: "ui_1", sessionID: "ses_a", action: "tool", resources: ["rm -rf build"], message: "Run bash?" }
    const { client, calls } = makeClient({
      "GET /api/agents/omp/sessions": { body: { sessions } },
      "POST /api/agents/omp/sessions/ses_a/permissions/ui_1": { body: { ok: true } },
      "GET /api/agents/omp/sessions/ses_a/permissions": { body: { permissions: [permission] } },
    })
    expect(await client.replyPermission("ses_a", "ui_1", "once")).toBe(true)
    expect(calls[0]).toEqual({ url: "/api/agents/omp/sessions/ses_a/permissions/ui_1", method: "POST", body: { reply: "once" } })
    expect(await client.getPermission("ses_a", "ui_1")).toEqual({ state: "ok", permission })
    expect(await client.getPermission("ses_a", "ui_2")).toEqual({ state: "unknown" })
    expect((await client.listPermissions()).map((entry) => entry.id)).toEqual(["ui_1"])
  })

  test("lists MCP servers and toggles one by name", async () => {
    const { client, calls } = makeClient({
      "GET /api/agents/omp/mcp": { body: { servers: [
        { name: "files", scope: "user", enabled: true, type: "stdio", command: "files-bin" },
        { name: "web", scope: "project", enabled: false, type: "http", url: "https://web" },
      ] } },
      "POST /api/agents/omp/mcp/files/enabled": { body: { ok: true } },
    })
    expect(await client.listMcpServers()).toEqual([
      { name: "files", status: { status: "connected" } },
      { name: "web", status: { status: "disabled" } },
    ])
    await client.disconnectMcpServer("files")
    await client.connectMcpServer("files")
    expect(calls).toEqual([
      { url: "/api/agents/omp/mcp", method: "GET", body: undefined },
      { url: "/api/agents/omp/mcp/files/enabled", method: "POST", body: { enabled: false } },
      { url: "/api/agents/omp/mcp/files/enabled", method: "POST", body: { enabled: true } },
    ])
  })

  test("switches a session's model", async () => {
    const { client, calls } = makeClient({
      "POST /api/agents/omp/sessions/ses_a/model": { body: { ok: true } },
    })
    await client.selectModel("ses_a", { providerID: "anthropic", id: "claude" })
    expect(calls).toEqual([
      { url: "/api/agents/omp/sessions/ses_a/model", method: "POST", body: { provider: "anthropic", modelId: "claude" } },
    ])
  })

  test("sends an image attachment as the prompt's images payload", async () => {
    const { client, calls } = makeClient({
      "POST /api/agents/omp/sessions/ses_a/prompt": { body: { ok: true } },
    })
    await client.sendPrompt({
      id: "ses_a",
      providerID: "anthropic",
      text: "what is this",
      files: [{ type: "file", mime: "image/png", filename: "shot.png", url: "data:image/png;base64,QUJD" }],
    })
    expect(calls[0].body).toEqual({
      text: "what is this",
      images: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
    })
  })

  test("carries a path-backed attachment as an @path mention", async () => {
    const { client, calls } = makeClient({
      "POST /api/agents/omp/sessions/ses_a/prompt": { body: { ok: true } },
    })
    await client.sendPrompt({
      id: "ses_a",
      providerID: "anthropic",
      text: "review this",
      files: [{ type: "file", mime: "text/plain", filename: "a.ts", url: "file:///repo/src/a.ts" }],
    })
    expect(calls[0].body).toEqual({ text: "review this @/repo/src/a.ts" })
  })

  test("does not repeat a path the prompt already mentions", async () => {
    const { client, calls } = makeClient({
      "POST /api/agents/omp/sessions/ses_a/prompt": { body: { ok: true } },
    })
    await client.sendPrompt({
      id: "ses_a",
      providerID: "anthropic",
      text: "look at @src/a.ts please",
      files: [{ type: "file", mime: "text/plain", filename: "a.ts", url: "file:///repo/src/a.ts" }],
    })
    expect(calls[0].body).toEqual({ text: "look at @src/a.ts please" })
  })

  test("quotes a mentioned path that contains whitespace", async () => {
    const { client, calls } = makeClient({
      "POST /api/agents/omp/sessions/ses_a/prompt": { body: { ok: true } },
    })
    await client.sendPrompt({
      id: "ses_a",
      providerID: "anthropic",
      text: "read it",
      files: [{ type: "file", mime: "text/plain", filename: "a b.ts", url: "file:///repo/my%20dir/a%20b.ts" }],
    })
    expect(calls[0].body).toEqual({ text: 'read it @"/repo/my dir/a b.ts"' })
  })

  test("fails loudly for a file that is neither an image nor path-backed", async () => {
    const { client, calls } = makeClient({
      "POST /api/agents/omp/sessions/ses_a/prompt": { body: { ok: true } },
    })
    const send = client.sendPrompt({
      id: "ses_a",
      providerID: "anthropic",
      text: "look",
      files: [{ type: "file", mime: "application/pdf", filename: "report.pdf", url: "data:application/pdf;base64,QUJD" }],
    })
    await expect(send).rejects.toThrow('OMP cannot attach "report.pdf"')
    expect(calls).toEqual([])
  })

  test("folds context ahead of the message, description first", async () => {
    const { client, calls } = makeClient({
      "POST /api/agents/omp/sessions/ses_a/prompt": { body: { ok: true } },
    })
    await client.sendPrompt({
      id: "ses_a",
      providerID: "anthropic",
      text: "fix it",
      context: [
        { text: "Issue #12: crash on start" },
        { text: "the diff", description: "Pull request #34" },
      ],
    })
    expect(calls[0].body).toEqual({
      text: "Issue #12: crash on start\n\nPull request #34\n\nthe diff\n\nfix it",
    })
  })

  test("fails loudly for a context item that carries no text", async () => {
    const { client, calls } = makeClient({
      "POST /api/agents/omp/sessions/ses_a/prompt": { body: { ok: true } },
    })
    const send = client.sendPrompt({
      id: "ses_a",
      providerID: "anthropic",
      text: "go",
      context: [{ text: "   " }],
    })
    await expect(send).rejects.toThrow("OMP cannot send context item 1")
    expect(calls).toEqual([])
  })

  test("lists login providers and starts a login", async () => {
    const providers = [{ id: "anthropic", name: "Anthropic", available: true, authenticated: false }]
    const { client, calls } = makeClient({
      "GET /api/agents/omp/login/providers": { body: { providers } },
      "POST /api/agents/omp/login": { body: {
        providerId: "anthropic",
        loginId: "omp-login-1",
        url: "https://auth.example/start",
        launchUrl: "http://127.0.0.1:1/launch",
        instructions: "Finish in the browser",
      } },
    })

    expect(await client.listLoginProviders()).toEqual(providers)
    expect(await client.login("anthropic")).toEqual({
      providerId: "anthropic",
      loginId: "omp-login-1",
      url: "https://auth.example/start",
      launchUrl: "http://127.0.0.1:1/launch",
      instructions: "Finish in the browser",
    })
    expect(calls).toEqual([
      { url: "/api/agents/omp/login/providers", method: "GET", body: undefined },
      { url: "/api/agents/omp/login", method: "POST", body: { providerId: "anthropic" } },
    ])
  })

  test("accepts a login that finished without a browser step", async () => {
    const { client } = makeClient({ "POST /api/agents/omp/login": { body: { providerId: "anthropic" } } })
    expect(await client.login("anthropic")).toEqual({ providerId: "anthropic" })
  })

  test("surfaces a refused login instead of an empty result", async () => {
    const { client } = makeClient({ "POST /api/agents/omp/login": { status: 500, body: { error: "Unknown OAuth provider: nope" } } })
    await expect(client.login("nope")).rejects.toThrow("OMP request failed: 500")
  })
})