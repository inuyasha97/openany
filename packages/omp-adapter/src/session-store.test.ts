import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createSessionStore, parseSessionFile } from "./session-store"

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sessions-"))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const writeSession = (project: string, file: string, lines: string[]) => {
  fs.mkdirSync(path.join(root, project), { recursive: true })
  const full = path.join(root, project, file)
  fs.writeFileSync(full, `${lines.join("\n")}\n`)
  return full
}

describe("parseSessionFile", () => {
  test("reads the session header and overlays the title record", () => {
    const text = [
      JSON.stringify({ type: "title", v: 1, title: "refactor importer", source: "user", updatedAt: "2026-05-14T10:14:22.000Z", pad: " " }),
      JSON.stringify({ type: "session", version: 3, id: "ses_1", timestamp: "2026-05-14T10:12:03.000Z", cwd: "/repo/api", title: "old" }),
    ].join("\n")
    expect(parseSessionFile(text)).toEqual({ id: "ses_1", cwd: "/repo/api", title: "refactor importer" })
  })

  test("falls back to the header title when there is no title record", () => {
    const text = JSON.stringify({ type: "session", version: 3, id: "ses_2", timestamp: "2026-05-14T10:12:03.000Z", cwd: "/repo/web", title: "from header" })
    expect(parseSessionFile(text)).toEqual({ id: "ses_2", cwd: "/repo/web", title: "from header" })
  })

  test("returns null for a file without a session header", () => {
    expect(parseSessionFile("")).toBeNull()
  })
})

describe("createSessionStore.list", () => {
  test("lists sessions discovered under the root", async () => {
    writeSession("repo-api", "20260514101203_ses_1.jsonl", [
      JSON.stringify({ type: "title", v: 1, title: "importer", source: "user", updatedAt: "t", pad: " " }),
      JSON.stringify({ type: "session", version: 3, id: "ses_1", timestamp: "2026-05-14T10:12:03.000Z", cwd: "/repo/api", title: "importer" }),
    ])
    writeSession("repo-web", "20260514101204_ses_2.jsonl", [
      JSON.stringify({ type: "session", version: 3, id: "ses_2", timestamp: "2026-05-14T10:12:04.000Z", cwd: "/repo/web", title: "web" }),
    ])
    const store = createSessionStore({ root })
    const sessions = await store.list()
    expect(sessions.map((s) => s.id).sort()).toEqual(["ses_1", "ses_2"])
    expect(sessions.find((s) => s.id === "ses_1")).toMatchObject({ cwd: "/repo/api", title: "importer" })
  })

  test("skips malformed files instead of failing the listing", async () => {
    writeSession("repo-api", "broken.jsonl", ["not json"])
    const store = createSessionStore({ root })
    expect(await store.list()).toEqual([])
  })

  test("ignores subagent transcripts nested under a session", async () => {
    writeSession("repo-api", "20260514101203_ses_1.jsonl", [
      JSON.stringify({ type: "session", version: 3, id: "ses_1", timestamp: "t", cwd: "/repo/api", title: "a" }),
    ])
    const nested = path.join(root, "repo-api", "ses_1")
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(
      path.join(nested, "agent_1.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "ses_agent", timestamp: "t", cwd: "/repo/api", title: "sub" })}\n`,
    )

    const sessions = await createSessionStore({ root }).list()
    expect(sessions.map((session) => session.id)).toEqual(["ses_1"])
  })
})

describe("createSessionStore mutations", () => {
  test("deletes a session file", async () => {
    const full = writeSession("repo-api", "ses_1.jsonl", [
      JSON.stringify({ type: "session", version: 3, id: "ses_1", timestamp: "t", cwd: "/repo/api", title: "a" }),
    ])
    const store = createSessionStore({ root })
    await store.delete(full)
    expect(await store.list()).toEqual([])
  })

  test("moves a session file under the target directory", async () => {
    const full = writeSession("repo-api", "ses_1.jsonl", [
      JSON.stringify({ type: "session", version: 3, id: "ses_1", timestamp: "t", cwd: "/repo/api", title: "a" }),
    ])
    const store = createSessionStore({ root })
    const target = path.join(root, "elsewhere")
    const moved = await store.move(full, target)
    expect(moved).toMatchObject({ id: "ses_1", cwd: target })
    expect(fs.existsSync(moved.sessionPath)).toBe(true)
    expect(fs.existsSync(full)).toBe(false)
  })
})
