import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { confirmWorkflowStep, createWorkflowRun, fetchWorkflowRun, fetchWorkflowRuns, releaseWorkflowSandbox, WorkflowRequestError } from './workflowsApi';

const originalFetch = globalThis.fetch;
let calls: Array<{ url: string; init: RequestInit }> = [];
let responses: Array<{ status: number; body: unknown }> = [];

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  responses = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift() ?? { status: 200, body: {} };
    return jsonResponse(next.body, next.status);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const headersOf = (index: number) => new Headers(calls[index].init.headers);

describe('fetchWorkflowRuns', () => {
  it('sends the directory the routes scope by', async () => {
    responses = [{ status: 200, body: { runs: [] } }];
    await fetchWorkflowRuns('/Users/me/project');
    expect(calls[0].url).toContain('/api/workflows/runs');
    expect(headersOf(0).get('x-opencode-directory')).toBe('/Users/me/project');
  });

  it('throws on a failed read instead of answering an empty list', async () => {
    responses = [{ status: 503, body: { error: 'the server is starting' } }];
    await expect(fetchWorkflowRuns('/Users/me/project')).rejects.toThrow(/the server is starting/);
  });
});

describe('fetchWorkflowRun', () => {
  it('reads the run out of the envelope', async () => {
    responses = [{ status: 200, body: { run: { runId: 'r1', steps: [] } } }];
    expect(await fetchWorkflowRun('/Users/me/project', 'r1')).toMatchObject({ runId: 'r1' });
  });

  it('carries the server message and status on the error', async () => {
    responses = [{ status: 404, body: { error: 'run r1 was not found' } }];
    await expect(fetchWorkflowRun('/Users/me/project', 'r1')).rejects.toMatchObject({
      name: 'WorkflowRequestError',
      status: 404,
      message: 'run r1 was not found',
    });
    expect(new WorkflowRequestError('x', 500)).toBeInstanceOf(Error);
  });
});

describe('createWorkflowRun', () => {
  it('posts the workflow and its input values', async () => {
    responses = [{ status: 201, body: { run: { runId: 'r1', steps: [] } } }];
    await createWorkflowRun('/Users/me/project', { workflowId: 'a', inputs: { request: 'x' } });
    expect(calls[0].url).toContain('/api/workflows/runs');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ workflowId: 'a', inputs: { request: 'x' } });
  });
});

describe('releaseWorkflowSandbox', () => {
  it('posts to the release action and reads the run out of the envelope', async () => {
    responses = [{ status: 200, body: { run: { runId: 'r1', worktreeReleasedAt: 42 } } }];
    const run = await releaseWorkflowSandbox('/Users/me/project', 'r1');
    expect(calls[0].url).toContain('/api/workflows/runs/r1/sandbox/release');
    expect(calls[0].init.method).toBe('POST');
    expect(headersOf(0).get('x-opencode-directory')).toBe('/Users/me/project');
    expect(run).toMatchObject({ runId: 'r1', worktreeReleasedAt: 42 });
  });

  it('carries the server refusal, so a screen can show it', async () => {
    responses = [{ status: 409, body: { error: 'run r1 is still running' } }];
    await expect(releaseWorkflowSandbox('/Users/me/project', 'r1')).rejects.toMatchObject({ status: 409, message: 'run r1 is still running' });
  });
});

describe('confirmWorkflowStep', () => {
  it('sends the decision and the reason', async () => {
    responses = [{ status: 200, body: { run: { runId: 'r1', steps: [] } } }];
    await confirmWorkflowStep('/Users/me/project', 'r1', 'spec', 'not_done', 'the spec is thin');
    expect(calls[0].url).toContain('/api/workflows/runs/r1/steps/spec/confirm');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ decision: 'not_done', reason: 'the spec is thin' });
  });

  it('leaves the reason out when there is none', async () => {
    responses = [{ status: 200, body: { run: { runId: 'r1', steps: [] } } }];
    await confirmWorkflowStep('/Users/me/project', 'r1', 'spec', 'done');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ decision: 'done' });
  });
});
