import { describe, expect, test } from "bun:test"
import type { TodoItem, TodoState } from "@openchamber/ui/lib/agent/events"
import { createTodoReducer } from "./todo-state"

const item = (text: string, status: TodoItem["status"] = "pending"): TodoItem => ({ phase: "P", text, status })
const stateOf = (...texts: string[]): TodoState => ({ title: "t", items: texts.map((text) => item(text)) })

describe("OMP todo state", () => {
  test("merges a phase list into items, keeping order", () => {
    const state = createTodoReducer().apply(null, {
      i: "Ship the parity work",
      list: [{ phase: "Evidence", items: ["check the store"] }, { phase: "Fix", items: ["map the frame"] }],
    })
    expect(state).toEqual({
      title: "Ship the parity work",
      items: [
        { phase: "Evidence", text: "check the store", status: "pending" },
        { phase: "Fix", text: "map the frame", status: "pending" },
      ],
    })
  })

  test("marks the named item done and ignores a name it does not hold", () => {
    const reducer = createTodoReducer()
    const first = reducer.apply(null, { i: "t", list: [{ phase: "P", items: ["a", "b"] }] })
    if (!first) throw new Error("the list did not merge")
    const second = reducer.apply(first, { op: "done", task: "a" })
    expect(second?.items.map((entry) => [entry.text, entry.status])).toEqual([["a", "done"], ["b", "pending"]])
    expect(reducer.apply(second, { op: "done", task: "nope" })).toBeNull()
  })

  test("reads progress markers out of a remaining-items result", () => {
    const next = createTodoReducer().applyResult(
      stateOf("a", "b"),
      "Remaining items (1):\n  - b [in_progress] (P)\nOverall: 1/2 done, 1 open.",
    )
    expect(next?.items.map((entry) => entry.status)).toEqual(["done", "in_progress"])
  })

  test("takes the statuses from a result that lists the whole list", () => {
    const next = createTodoReducer().applyResult(stateOf("a", "b"), "The list:\n  - a [done] (P)\n  - b [in_progress] (P)")
    expect(next?.items.map((entry) => entry.status)).toEqual(["done", "in_progress"])
  })

  test("returns nothing for an input it cannot read", () => {
    const reducer = createTodoReducer()
    expect(reducer.apply(null, {})).toBeNull()
    expect(reducer.apply(null, { op: "done", task: "a" })).toBeNull()
    expect(reducer.applyResult(stateOf("a"), "no markers here")).toBeNull()
    expect(reducer.applyResult(stateOf("a"), "- a [pending] (P)")).toBeNull()
  })
})
