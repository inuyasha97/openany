import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { ReactElement } from 'react';
import type { WorkflowDefinitionSummary } from '@/lib/workflowsApi';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  customElements: browser.customElements, localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  HTMLTextAreaElement: browser.HTMLTextAreaElement, Text: browser.Text, NodeList: browser.NodeList,
  Event: browser.Event, FocusEvent: browser.FocusEvent,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const CREATE_PATH = '/api/workflows/runs';
/** The bodies the create route was sent, so the test can see the chosen mode. */
let createBodies: string[] = [];

const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  if (url.pathname === CREATE_PATH) {
    createBodies.push(String(init?.body ?? ''));
    const sent = JSON.parse(String(init?.body ?? '{}')) as { workflowId: string; sandbox?: string };
    return Response.json({
      run: {
        runId: '11111111-2222-4333-8444-555555555555', projectId: 'proj-1', directory: '/tmp/proj',
        workflowId: sent.workflowId, workflowVersion: 1, workflowHash: 'h'.repeat(64), inputs: {},
        status: 'idle', cursor: null, createdAt: 1, updatedAt: 1, sandbox: sent.sandbox ?? 'worktree', steps: [],
      },
    }, { status: 201 });
  }
  throw new Error(`Unexpected request: ${url.pathname}`);
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { RunList } = await import('./RunList');

let container: HTMLElement;
let unmount: (() => Promise<void>) | null = null;

afterAll(async () => {
  if (unmount) await unmount();
  fetchSpy.mockRestore();
  browser.close();
});

beforeEach(() => {
  createBodies = [];
});

const mount = async (pane: ReactElement) => {
  if (unmount) await unmount();
  const node = document.createElement('div');
  container = node;
  document.body.appendChild(node);
  const root = createRoot(node);
  unmount = async () => { await act(async () => root.unmount()); node.remove(); };
  await act(async () => root.render(<I18nProvider>{pane}</I18nProvider>));
};

/** Lets a click's round trip to the routes finish before the DOM is read. */
const settle = async () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  await act(async () => promise);
};

const buttonContaining = (text: string) => {
  const found = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(text));
  if (!found) throw new Error(`Missing button containing: ${text}`);
  return found;
};
const button = (label: string) => {
  const found = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};
const radio = (label: string) => {
  const found = document.querySelector(`[role="radio"][aria-label="${label}"]`);
  if (!found) throw new Error(`Missing radio: ${label}`);
  return found as HTMLElement;
};
const click = async (target: HTMLElement) => {
  await act(async () => target.click());
  await settle();
};

const WORKTREE_LABEL = 'A git worktree: this run gets its own checkout of the project';
const WORKING_TREE_LABEL = 'The working tree: this run works in the project\u2019s own files';

const definition = (sandbox: 'worktree' | 'working-tree'): WorkflowDefinitionSummary => ({
  file: 'a.yaml', hash: 'h'.repeat(64), id: 'a', name: 'A', version: 1, errors: [], steps: [], inputs: [], sandbox,
});

const project = { id: 'path_proj', path: '/tmp/proj' };

const render = (definitions: WorkflowDefinitionSummary[], onSelect: (runId: string) => void = () => {}) => (
  <RunList
    runs={[]}
    definitions={definitions}
    selectedRunId={null}
    onSelect={onSelect}
    onEditDefinition={() => {}}
    onNewDefinition={() => {}}
    project={project}
  />
);

test('starting asks for the mode instead of creating the run, pre-selected from the definition', async () => {
  await mount(render([definition('worktree')]));
  // The definition declares no input, yet nothing is created on one click: the
  // mode is a choice, so the dialog opens to ask for it.
  await click(buttonContaining('A'));
  expect(createBodies).toEqual([]);
  expect(document.body.textContent).toContain('Where this run executes');
  expect(radio(WORKTREE_LABEL).getAttribute('aria-checked')).toBe('true');
  expect(radio(WORKING_TREE_LABEL).getAttribute('aria-checked')).toBe('false');
});

test('the mode the person chose is what the create sends, so the run records it', async () => {
  await mount(render([definition('worktree')]));
  await click(buttonContaining('A'));
  await click(radio(WORKING_TREE_LABEL));
  expect(radio(WORKING_TREE_LABEL).getAttribute('aria-checked')).toBe('true');
  await click(button('Start'));
  expect(createBodies).toEqual(['{"workflowId":"a","inputs":{},"sandbox":"working-tree"}']);
});

test('a definition that declares the working tree is pre-selected as such', async () => {
  await mount(render([definition('working-tree')]));
  await click(buttonContaining('A'));
  expect(radio(WORKING_TREE_LABEL).getAttribute('aria-checked')).toBe('true');
});
