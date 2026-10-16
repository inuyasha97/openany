/**
 * A session's todo list, folded out of OMP's `todo` tool.
 *
 * OMP owns the list; the adapter is the only place it is kept outside OMP.
 * The tool is driven by ops — `init` carries the whole list
 * (`list: [{ phase, items }]`, or a flat `items` list in the default phase),
 * `done`/`start`/`block`/`drop` name one item, `append`/`rm` name a phase, and
 * `view` only reads. Every call also answers with text listing what is still
 * open (`Remaining items (3): … [in_progress] (Tasks)`), and that answer is the
 * tool's own statement of the state: structure comes from the input, statuses
 * come from the answer, so an op this reducer reads loosely is still corrected
 * by what the tool said it did.
 */

import type { TodoItem, TodoState } from "@openchamber/ui/lib/agent/events"
import type { JsonValue } from "@openchamber/ui/lib/opencode/model"

/** The phase OMP files a flat `items` list under. */
const DEFAULT_PHASE = "Tasks"

/** The `todo` tool's arguments, as OMP sends them. */
type TodoArgs = {
  i?: string
  items?: string[]
  list?: Array<{ phase?: string; items?: string[] }>
  op?: string
  phase?: string
  task?: string
}

/** OMP brackets an item's state in its result text: `- ship it [in_progress]`. */
const STATUS_MARKER = /\[(pending|in_progress|blocked|done)\]/

/** OMP prints the whole list as checkboxes: `- [X] ship it` / `- [ ] ship it`. */
const CHECKBOX_MARKER = /^\[([xX ])\]\s*(.+)$/

const statusOf = (marker: string): TodoItem["status"] => {
  const value = marker.toLowerCase()
  if (value === "done") return "done"
  // `blocked` has no counterpart in the shared todo item, which carries the
  // three states the UI renders.
  return value === "in_progress" ? "in_progress" : "pending"
}

const pending = (phase: string, text: string): TodoItem => ({ phase, text, status: "pending" })

/** The list an `init` call describes: named phases first, then a flat item list. */
const listOf = (args: TodoArgs): TodoItem[] => {
  const built: TodoItem[] = []
  for (const phase of args.list ?? []) {
    const name = phase?.phase || DEFAULT_PHASE
    for (const text of phase?.items ?? []) built.push(pending(name, text))
  }
  for (const text of args.items ?? []) built.push(pending(DEFAULT_PHASE, text))
  return built
}

/** The tool works one item at a time, starting at the first open one. */
const activateFirst = (items: TodoItem[]): TodoItem[] => {
  if (items.some((item) => item.status === "in_progress")) return items
  const index = items.findIndex((item) => item.status === "pending")
  if (index < 0) return items
  return items.map((item, at): TodoItem => (at === index ? { ...item, status: "in_progress" } : item))
}

export type OmpTodoReducer = {
  /** Merge one `todo` call's input; `null` when nothing changed. */
  apply: (state: TodoState | null, args: Record<string, JsonValue>) => TodoState | null
  /** Merge one `todo` call's result text; `null` when nothing changed. */
  applyResult: (state: TodoState, text: string) => TodoState | null
}

export const createTodoReducer = (): OmpTodoReducer => {
  const apply = (state: TodoState | null, args: Record<string, JsonValue>): TodoState | null => {
    // SAFETY: the union of fields OMP's `todo` tool sends, every one optional: a
    // payload that matches nothing read below narrows to "nothing to merge".
    const { i, items, list, op, phase, task } = args as TodoArgs
    const title = i || state?.title || ""

    if (op === "init") {
      const built = listOf({ items, list })
      if (built.length === 0) return null
      return { title, items: activateFirst(built) }
    }
    if (!state) return null

    if (op === "append") {
      if (!items || items.length === 0) return null
      const name = phase || state.items.at(-1)?.phase || DEFAULT_PHASE
      return { title, items: activateFirst([...state.items, ...items.map((text) => pending(name, text))]) }
    }
    if (op === "drop" && task) {
      const kept = state.items.filter((item) => item.text !== task)
      return kept.length === state.items.length ? null : { title, items: activateFirst(kept) }
    }
    if (op === "rm" && phase) {
      const kept = state.items.filter((item) => item.phase !== phase)
      return kept.length === state.items.length ? null : { title, items: activateFirst(kept) }
    }
    if (op === "done") {
      // `done` finishes the item being worked on and, when it names one, makes
      // that the item being worked on: the shape every recorded call used.
      const inPhase = (item: TodoItem) => !phase || item.phase === phase
      const active = state.items.findIndex((item) => inPhase(item) && item.status === "in_progress")
      const open = state.items.findIndex((item) => inPhase(item) && item.status === "pending")
      const finishing = active >= 0 ? active : open
      if (finishing < 0) return null
      const moved = state.items.map((item, at): TodoItem => {
        if (at === finishing) return { ...item, status: "done" }
        if (item.status === "in_progress") return { ...item, status: "pending" }
        return item
      })
      const named = task ? moved.findIndex((item) => item.text === task && item.status === "pending") : -1
      if (named < 0) return { title, items: activateFirst(moved) }
      return { title, items: moved.map((item, at): TodoItem => (at === named ? { ...item, status: "in_progress" } : item)) }
    }
    // `start`, `block` and `view` carry no structure the answer does not restate.
    return null
  }

  const applyResult = (state: TodoState, text: string): TodoState | null => {
    const body = text ?? ""
    // A "Remaining items" answer lists only what is still open, so an item it
    // does not mention is done. A result that lists everything (OMP prints the
    // whole list when asked for it) must not be read that way, which is why the
    // inference is tied to the "Remaining items" phrasing.
    const remaining = body.includes("Remaining items")
    const listed: Array<{ label: string; status: TodoItem["status"] }> = []
    for (const line of body.split("\n")) {
      const trimmed = line.trim().replace(/^-\s*/, "")
      const box = CHECKBOX_MARKER.exec(trimmed)
      if (box) {
        listed.push({ label: box[2].trim(), status: box[1] === " " ? "pending" : "done" })
        continue
      }
      const match = STATUS_MARKER.exec(trimmed)
      if (!match || match.index === 0) continue
      const label = trimmed.slice(0, match.index).trim()
      if (label) listed.push({ label, status: statusOf(match[1]) })
    }
    if (listed.length === 0) return null
    // The tool renders a line as `text (phase)`, so a line belongs to an item
    // when its label is that item's text or the text followed by the phase.
    const statusFor = (item: TodoItem): TodoItem["status"] => {
      for (const entry of listed) {
        if (entry.label === item.text || entry.label.startsWith(`${item.text} `)) return entry.status
      }
      return remaining ? "done" : item.status
    }
    let changed = false
    const items = state.items.map((item): TodoItem => {
      const status = statusFor(item)
      if (status === item.status) return item
      changed = true
      return { ...item, status }
    })
    return changed ? { ...state, items } : null
  }

  return { apply, applyResult }
}
