/**
 * Workflow runs and definitions, cached per project.
 *
 * The server owns the truth. This store holds a cache, applies the live frames
 * the server pushes, and keeps the last good data when a read fails: an error is
 * shown beside what is known, never instead of it.
 *
 * Two rules from the sync invariants apply here. A frame that arrives while a
 * load is in flight is newer than that load, so the load must not overwrite it.
 * And a project's entry is only created by a frame for a project already known,
 * so a frame cannot invent a project.
 */
import { create } from 'zustand';

import { fetchWorkflowDefinitions, fetchWorkflowRuns, type WorkflowDefinitionSummary, type WorkflowRun, type WorkflowStepStatus } from '@/lib/workflowsApi';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';

export interface WorkflowRunFrame {
  runId: string;
  projectId: string;
  status: WorkflowRun['status'];
  cursor: string | null;
  steps: Array<{ id: string; status: WorkflowStepStatus }>;
}

interface WorkflowEntry {
  runs: WorkflowRun[];
  definitions: WorkflowDefinitionSummary[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

export interface WorkflowStoreState {
  entries: Record<string, WorkflowEntry>;
  /** Frames for runs this client had not read yet, applied by the next load. */
  pendingFrames: Record<string, Record<string, WorkflowRunFrame>>;
  getEntry: (project: { id: string } | null | undefined) => WorkflowEntry;
  load: (project: { id: string; path: string }, options?: { force?: boolean }) => Promise<void>;
  setRun: (project: { id: string }, run: WorkflowRun) => void;
  removeRun: (project: { id: string }, runId: string) => void;
  applyRunFrame: (frame: WorkflowRunFrame) => void;
}

const EMPTY: WorkflowEntry = { runs: [], definitions: [], loaded: false, loading: false, error: null };

const patchRun = (run: WorkflowRun, frame: WorkflowRunFrame): WorkflowRun => ({
  ...run,
  status: frame.status,
  cursor: frame.cursor,
  steps: run.steps.map((step) => {
    const framed = frame.steps.find((candidate) => candidate.id === step.id);
    return framed && framed.status !== step.status ? { ...step, status: framed.status } : step;
  }),
});

export const useWorkflowStore = create<WorkflowStoreState>((set, get) => ({
  entries: {},
  pendingFrames: {},

  getEntry: (project) => (project ? get().entries[project.id] ?? EMPTY : EMPTY),

  load: async (project, options = {}) => {
    const current = get().entries[project.id] ?? EMPTY;
    if (current.loading && !options.force) return;
    set((state) => ({ entries: { ...state.entries, [project.id]: { ...current, loading: true, error: null } } }));

    try {
      const [runs, definitions] = await Promise.all([
        fetchWorkflowRuns(project.path),
        fetchWorkflowDefinitions(project.path),
      ]);
      set((state) => {
        // A frame that arrived for a run this load had not read yet is newer than
        // the read, so the read is patched with it rather than replacing it.
        const frames = state.pendingFrames[project.id] ?? {};
        const patched = runs.map((run) => (frames[run.runId] ? patchRun(run, frames[run.runId]) : run));
        const { [project.id]: _dropped, ...pendingFrames } = state.pendingFrames;
        return {
          pendingFrames,
          entries: { ...state.entries, [project.id]: { runs: patched, definitions, loaded: true, loading: false, error: null } },
        };
      });
    } catch (error) {
      set((state) => {
        const entry = state.entries[project.id] ?? EMPTY;
        return { entries: { ...state.entries, [project.id]: { ...entry, loading: false, error: error instanceof Error ? error.message : 'The workflow runs could not be read' } } };
      });
    }
  },

  setRun: (project, run) => set((state) => {
    const entry = state.entries[project.id] ?? EMPTY;
    const known = entry.runs.some((candidate) => candidate.runId === run.runId);
    return { entries: { ...state.entries, [project.id]: { ...entry, runs: known ? entry.runs.map((candidate) => (candidate.runId === run.runId ? run : candidate)) : [run, ...entry.runs] } } };
  }),

  removeRun: (project, runId) => set((state) => {
    const entry = state.entries[project.id] ?? EMPTY;
    return { entries: { ...state.entries, [project.id]: { ...entry, runs: entry.runs.filter((candidate) => candidate.runId !== runId) } } };
  }),

  applyRunFrame: (frame) => set((state) => {
    const entry = state.entries[frame.projectId];
    // A frame cannot invent a project this client has never loaded.
    if (!entry) return state;
    const existing = entry.runs.find((candidate) => candidate.runId === frame.runId);
    // Recorded for both halves: a load already in flight took its snapshot
    // before this frame, so it re-applies the frame when it resolves and then
    // clears the map.
    const pending = { ...state.pendingFrames, [frame.projectId]: { ...(state.pendingFrames[frame.projectId] ?? {}), [frame.runId]: frame } };
    if (!existing) {
      return { pendingFrames: pending };
    }
    return {
      pendingFrames: pending,
      entries: {
        ...state.entries,
        [frame.projectId]: {
          ...entry,
          runs: entry.runs.map((candidate) => (candidate.runId === frame.runId ? patchRun(candidate, frame) : candidate)),
        },
      },
    };
  }),
}));

export const subscribeWorkflowFrames = (): (() => void) => subscribeOpenchamberEvents((event) => {
  if (event.type !== 'workflow-run-updated') return;
  useWorkflowStore.getState().applyRunFrame({
    runId: event.runId,
    projectId: event.projectId,
    status: event.status,
    cursor: event.cursor,
    steps: event.steps,
  });
});
