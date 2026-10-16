import { describe, expect, test } from "bun:test"
import type { TodoItem, TodoState } from "@openchamber/ui/lib/agent/events"
import { createTodoReducer } from "./todo-state"

const item = (text: string, status: TodoItem["status"] = "pending"): TodoItem => ({ phase: "P", text, status })
const stateOf = (...texts: string[]): TodoState => ({ title: "t", items: texts.map((text) => item(text)) })
const statuses = (state: TodoState | null) => state?.items.map((entry) => [entry.text, entry.status])

describe("OMP todo state", () => {
  test("merges a named phase list and starts the first item", () => {
    const state = createTodoReducer().apply(null, {
      i: "Ship the parity work",
      op: "init",
      list: [{ phase: "Evidence", items: ["check the store"] }, { phase: "Fix", items: ["map the frame"] }],
    })
    expect(state).toEqual({
      title: "Ship the parity work",
      items: [
        { phase: "Evidence", text: "check the store", status: "in_progress" },
        { phase: "Fix", text: "map the frame", status: "pending" },
      ],
    })
  })

  test("files a flat item list under the default phase", () => {
    const state = createTodoReducer().apply(null, { i: "Recording three tasks", op: "init", items: ["alpha", "beta"] })
    expect(state?.items).toEqual([
      { phase: "Tasks", text: "alpha", status: "in_progress" },
      { phase: "Tasks", text: "beta", status: "pending" },
    ])
  })

  test("finishes the worked item and starts the one the call names", () => {
    const reducer = createTodoReducer()
    const first = reducer.apply(null, { i: "t", op: "init", list: [{ phase: "Tasks", items: ["alpha", "beta", "gamma"] }] })
    const second = reducer.apply(first, { op: "done", task: "beta" })
    expect(statuses(second)).toEqual([["alpha", "done"], ["beta", "in_progress"], ["gamma", "pending"]])
    const third = reducer.apply(second, { op: "done", task: "gamma" })
    expect(statuses(third)).toEqual([["alpha", "done"], ["beta", "done"], ["gamma", "in_progress"]])
    const last = reducer.apply(third, { op: "done" })
    expect(statuses(last)).toEqual([["alpha", "done"], ["beta", "done"], ["gamma", "done"]])
    expect(reducer.apply(last, { op: "done" })).toBeNull()
  })

  test("appends items to a phase and removes them again", () => {
    const reducer = createTodoReducer()
    const first = reducer.apply(null, { i: "t", op: "init", list: [{ phase: "Tasks", items: ["alpha"] }] })
    const grew = reducer.apply(first, { op: "append", phase: "Hardening", items: ["add a guard"] })
    expect(statuses(grew)).toEqual([["alpha", "in_progress"], ["add a guard", "pending"]])
    expect(grew?.items[1].phase).toBe("Hardening")
    const dropped = reducer.apply(grew, { op: "drop", task: "add a guard" })
    expect(statuses(dropped)).toEqual([["alpha", "in_progress"]])
    const emptied = reducer.apply(dropped, { op: "rm", phase: "Tasks" })
    expect(emptied).toEqual({ title: "t", items: [] })
    expect(reducer.apply(emptied, { op: "rm", phase: "Tasks" })).toBeNull()
  })

  test("leaves the ops that only read or restate to the result text", () => {
    const reducer = createTodoReducer()
    const state = reducer.apply(null, { i: "t", op: "init", list: [{ phase: "Tasks", items: ["alpha"] }] })
    expect(reducer.apply(state, { op: "view", i: "Viewing stale todos" })).toBeNull()
    expect(reducer.apply(state, { op: "start", task: "alpha" })).toBeNull()
    expect(reducer.apply(null, { op: "done", task: "alpha" })).toBeNull()
    expect(reducer.apply(null, {})).toBeNull()
  })

  test("reads progress markers out of a remaining-items result", () => {
    const next = createTodoReducer().applyResult(
      stateOf("a", "b"),
      "Remaining items (1):\n  - b [in_progress] (P)\nOverall: 1/2 done, 1 open.",
    )
    expect(next?.items.map((entry) => entry.status)).toEqual(["done", "in_progress"])
  })

  test("reads checkboxes out of a result that lists the whole list", () => {
    const next = createTodoReducer().applyResult(stateOf("a", "b"), "The list:\n  - [X] a (P)\n  - [ ] b (P)")
    expect(next?.items.map((entry) => entry.status)).toEqual(["done", "pending"])
  })

  test("returns nothing for a result it cannot read", () => {
    const reducer = createTodoReducer()
    expect(reducer.applyResult(stateOf("a"), "no markers here")).toBeNull()
    expect(reducer.applyResult(stateOf("a"), "- a [pending] (P)")).toBeNull()
  })
})
