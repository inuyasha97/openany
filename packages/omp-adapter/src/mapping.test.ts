import { describe, expect, test } from "bun:test"
import { toOmpModelInfo, toOmpSessionInfo } from "./mapping"

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

describe("toOmpModelInfo", () => {
  test("lifts a thinking model's efforts and default level, keeping the raw fields", () => {
    expect(
      toOmpModelInfo({
        id: "claude",
        provider: "anthropic",
        name: "Claude",
        reasoning: true,
        contextWindow: 200000,
        thinking: { mode: "effort", efforts: ["low", "high"], defaultLevel: "low" },
      }),
    ).toEqual({
      id: "claude",
      provider: "anthropic",
      name: "Claude",
      reasoning: true,
      contextWindow: 200000,
      thinking: { mode: "effort", efforts: ["low", "high"], defaultLevel: "low" },
      efforts: ["low", "high"],
      defaultLevel: "low",
    })
  })

  test("a model without thinking config projects empty efforts", () => {
    expect(toOmpModelInfo({ id: "plain", provider: "openai", reasoning: false })).toEqual({
      id: "plain",
      provider: "openai",
      reasoning: false,
      efforts: [],
    })
  })

  test("drops efforts and a default level that OMP did not declare valid", () => {
    expect(toOmpModelInfo({ id: "m", provider: "p", thinking: { efforts: ["low", "bogus"], defaultLevel: "nope" } })).toEqual({
      id: "m",
      provider: "p",
      reasoning: false,
      thinking: { efforts: ["low", "bogus"], defaultLevel: "nope" },
      efforts: ["low"],
    })
  })
})
