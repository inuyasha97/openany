/**
 * A session's todo list, folded out of OMP's `todo` tool calls.
 *
 * OMP owns the list. The tool takes the whole list on the first call of a turn
 * (`list: [{ phase, items }]`), names a finished item later (`op: "done",
 * task`), and answers every call with text that lists what is still open
 * (`Remaining items (3): … [in_progress] …`). Nothing streams the list itself —
 * a live capture shows only `tool_execution_start`/`tool_execution_end` for it —
 * so this reducer is the only place the list exists outside OMP, and the caller
 * re-emits on each call rather than streaming within one.
 */

import type { JsonValue } from "@openchamber/ui/lib/opencode/model"
import type { TodoItem, TodoState } from "@openchamber/ui/lib/agent/events"

/** The `todo` tool's arguments, as OMP sends them. */
type TodoArgs = {
  i?: string
  list?: Array<{ phase?: string; items?: string[] }>
  op?: string
  task?: string
}

/** OMP brackets an item's state in its result text: `- ship it [in_progress]`. */
const STATUS_MARKER = /\[(pending|in_progress|done)\]/i

const statusOf = (marker: string): TodoItem["status"] => {
  const value = marker.toLowerCase()
  if (value === "done") return "done"
  if (value === "in_progress") return "in_progress"
  return "pending"
}

export type OmpTodoReducer = {
  /** Merge one `todo` call's input; `null` when nothing changed. */
  apply: (state: TodoState | null, args: Record<string, JsonValue>) => TodoState | null
  /** Merge one `todo` call's result text; `null` when nothing changed. */
  applyResult: (state: TodoState, text: string) => TodoState | null
}

export const createTodoReducer = (): OmpTodoReducer => {
  const apply = (state: TodoState | null, args: Record<string, JsonValue>): TodoState | null => {
    // SAFETY: OMP's `todo` tool is documented to send exactly these fields, and
    // every one of them is optional: a payload that matches nothing read below
    // narrows to "nothing to merge" instead of a throw.
    const { i, list, op, task } = args as TodoArgs
    const title = i ?? state?.title ?? ""
    if (Array.isArray(list)) {
      const items: TodoItem[] = []
      for (const phase of list) {
        const name = phase?.phase ?? ""
        for (const text of phase?.items ?? []) items.push({ phase: name, text, status: "pending" })
      }
      return items.length > 0 ? { title, items } : null
    }
    if (op !== "done" || !state || !task) return null
    let changed = false
    const items = state.items.map((item) => {
      if (item.text !== task || item.status === "done") return item
      changed = true
      return { ...item, status: "done" as const }
    })
    return changed ? { ...state, items } : null
  }

  const applyResult = (state: TodoState, text: string): TodoState | null => {
    const body = text ?? ""
    // A "Remaining items" answer lists only what is still open, so an item it
    // does not mention is done. A result that lists everything (OMP prints the
    // whole list when asked for it) must not be read that way, which is why the
    // inference is tied to the "Remaining items" phrasing.
    const remaining = body.includes("Remaining items")
    const listed: Record<string, TodoItem["status"]> = {}
    let listedCount = 0
    for (const line of body.split("\n")) {
      const trimmed = line.trim().replace(/^-\s*/, "")
      const match = STATUS_MARKER.exec(trimmed)
      if (!match || match.index === 0) continue
      const label = trimmed.slice(0, match.index).trim()
      if (!label) continue
      listed[label] = statusOf(match[1])
      listedCount += 1
    }
    if (listedCount === 0) return null
    let changed = false
    const items = state.items.map((item) => {
      const status = listed[item.text] ?? (remaining ? "done" : item.status)
      if (status === item.status) return item
      changed = true
      return { ...item, status }
    })
    return changed ? { ...state, items } : null
  }

  return { apply, applyResult }
}
