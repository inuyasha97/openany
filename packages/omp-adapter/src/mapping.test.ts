import { describe, expect, test } from "bun:test"
import { toOmpSessionInfo } from "./mapping"

describe("toOmpSessionInfo", () => {
  test("maps the SDK session fields onto the runtime shape", () => {
    expect(toOmpSessionInfo({ id: "ses_a", path: "/sessions/a.json", cwd: "/repo", title: "A" })).toEqual({
      id: "ses_a",
      sessionPath: "/sessions/a.json",
      cwd: "/repo",
      title: "A",
    })
  })

  test("an untitled session gets an empty title rather than undefined", () => {
    expect(toOmpSessionInfo({ id: "ses_b", path: "/sessions/b.json", cwd: "" }).title).toBe("")
  })
})
