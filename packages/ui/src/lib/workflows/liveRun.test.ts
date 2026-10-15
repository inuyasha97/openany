import { describe, expect, it } from 'bun:test';

import { liveRunForDefinition, runIsLive } from './liveRun';
import type { WorkflowRun, WorkflowRunStatus } from '@/lib/workflowsApi';

const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  runId: 'r1',
  projectId: 'p1',
  directory: '/tmp/p1',
  workflowId: 'two-step',
  workflowVersion: 1,
  workflowHash: 'h',
  inputs: {},
  status: 'idle',
  cursor: 'first',
  createdAt: 1,
  updatedAt: 1,
  sandbox: 'working-tree',
  steps: [],
  ...overrides,
});

describe('runIsLive', () => {
  it('reads a run the engine can still advance as live', () => {
    for (const status of ['idle', 'running', 'waiting'] as const) expect(runIsLive(status)).toBe(true);
  });

  it('reads the three statuses a run stops at as settled', () => {
    for (const status of ['done', 'failed', 'cancelled'] as const) expect(runIsLive(status)).toBe(false);
  });

  it('covers every status the client knows, so a new one cannot be read as settled by accident', () => {
    const statuses: WorkflowRunStatus[] = ['idle', 'running', 'waiting', 'done', 'failed', 'cancelled'];
    expect(statuses.filter((status) => !runIsLive(status))).toEqual(['done', 'failed', 'cancelled']);
  });
});

describe('liveRunForDefinition', () => {
  it('names the live run that references the definition', () => {
    const live = run({ runId: 'r-live', status: 'waiting' });
    const found = liveRunForDefinition([run({ runId: 'r-done', status: 'done' }), live], 'two-step');
    expect(found?.runId).toBe('r-live');
  });

  it('answers null once every run of that definition has finished', () => {
    const runs = [run({ runId: 'r1', status: 'done' }), run({ runId: 'r2', status: 'failed' })];
    expect(liveRunForDefinition(runs, 'two-step')).toBeNull();
  });

  it('ignores a live run of another definition', () => {
    expect(liveRunForDefinition([run({ workflowId: 'other', status: 'running' })], 'two-step')).toBeNull();
  });

  it('answers null when the project has no run at all', () => {
    expect(liveRunForDefinition([], 'two-step')).toBeNull();
  });
});
