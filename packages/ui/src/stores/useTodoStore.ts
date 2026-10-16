/**
 * A session's todo list, as OMP keeps it.
 *
 * OMP owns the list inside its session process and streams it only when its
 * `todo` tool runs, so the adapter projects each of those calls into a
 * `todo.updated` event and the server remembers the last one. This store is the
 * UI's copy: the pipeline writes every event into it, and the row and the
 * progress line both read it, so the two cannot disagree.
 *
 * A failed read never clears what is already here: "could not ask" is not "the
 * list is empty".
 */

import { create } from 'zustand';
import { z } from 'zod';

import type { TodoState } from '@/lib/agent/events';
import { runtimeFetch } from '@/lib/runtime-fetch';

type FetchTodo = (sessionID: string) => Promise<TodoState | null>;

/**
 * The route's payload. The status strings are the event vocabulary's, so a
 * server that drifts from it fails the read instead of rendering an item in a
 * state nothing knows how to draw.
 */
const todoResponseSchema = z.object({
  todo: z.object({
    title: z.string(),
    items: z.array(z.object({
      phase: z.string(),
      text: z.string(),
      status: z.enum(['pending', 'in_progress', 'done']),
    })),
  }).nullable(),
});

const fetchTodoFromServer: FetchTodo = async (sessionID) => {
  const response = await runtimeFetch(`/api/agents/omp/sessions/${encodeURIComponent(sessionID)}/todo`);
  if (!response.ok) throw new Error(`todo read failed: ${response.status}`);
  const parsed = todoResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('todo read answered an unexpected shape');
  return parsed.data.todo;
};

type TodoStoreState = {
  /** The last list each session reported. */
  bySession: Map<string, TodoState>;
  /** One event's worth of state; `null` clears the session's entry. */
  apply: (sessionID: string, todo: TodoState | null) => void;
  /** Ask the server for a session's list, for a UI that just opened it. */
  load: (sessionID: string, deps?: { fetchTodo?: FetchTodo }) => Promise<void>;
};

export const useTodoStore = create<TodoStoreState>()((set) => ({
  bySession: new Map(),

  apply: (sessionID, todo) => set((state) => {
    const bySession = new Map(state.bySession);
    if (todo === null) {
      if (!bySession.delete(sessionID)) return state;
      return { bySession };
    }
    bySession.set(sessionID, todo);
    return { bySession };
  }),

  load: async (sessionID, deps) => {
    const fetchTodo = deps?.fetchTodo ?? fetchTodoFromServer;
    try {
      const todo = await fetchTodo(sessionID);
      if (todo) useTodoStore.getState().apply(sessionID, todo);
    } catch {
      // Keep the last known list; the next event or load replaces it.
    }
  },
}));
