import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { ReactElement } from 'react';
import type { ThemeContextValue } from '@/contexts/theme-system-context';
import type { WorkflowRun } from '@/lib/workflowsApi';

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

const RUN_ID = '11111111-2222-4333-8444-555555555555';
const RUN_PATH = `/api/workflows/runs/${RUN_ID}`;
const RELEASE_PATH = `${RUN_PATH}/sandbox/release`;

const run = {
  runId: RUN_ID,
  projectId: 'proj-1',
  directory: '/tmp/worktrees/wf-1',
  workflowId: 'two-step',
  workflowVersion: 1,
  workflowHash: 'h'.repeat(64),
  inputs: {},
  status: 'done',
  cursor: 'first',
  createdAt: 1,
  updatedAt: 2,
  sandbox: 'worktree',
  worktreeBranch: `omp/wf/${RUN_ID}`,
  steps: [{ id: 'first', status: 'done', attempts: [], note: null }],
} satisfies WorkflowRun;

// What the release route answers, in order. Each entry is one release request.
let releaseAnswers: Array<() => Response> = [];
/** The bodies the release route was sent, so the test can see what was asked for. */
let releaseBodies: string[] = [];

const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  if (url.pathname === RUN_PATH) return Response.json({ run });
  if (url.pathname === RELEASE_PATH) {
    releaseBodies.push(String(init?.body ?? ''));
    const answer = releaseAnswers.shift();
    if (!answer) throw new Error('The release route was asked more often than the test allowed');
    return answer();
  }
  throw new Error(`Unexpected request: ${url.pathname}`);
});

// React and the component are imported after the DOM globals above: they read
// `document` and `window` as they load, so a static import would run them
// against the empty globals this file starts with.
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemContext } = await import('@/contexts/theme-system-context');
const { getDefaultTheme } = await import('@/lib/theme/themes');
const { RunDetail } = await import('./RunDetail');

const theme = getDefaultTheme(false);
const noThemeChange = (): never => { throw new Error('Unexpected theme change'); };
const themeContext = {
  currentTheme: theme, availableThemes: [theme], customThemeIds: [], customThemesLoading: false,
  setTheme: noThemeChange, reloadCustomThemes: noThemeChange, importTheme: noThemeChange, deleteImportedTheme: noThemeChange,
  isSystemPreference: false, setSystemPreference: noThemeChange, themeMode: 'light', setThemeMode: noThemeChange,
  lightThemeId: theme.metadata.id, darkThemeId: getDefaultTheme(true).metadata.id,
  setLightThemePreference: noThemeChange, setDarkThemePreference: noThemeChange,
} satisfies ThemeContextValue;

const project = { id: 'path_proj', path: '/tmp/proj' };
const REFUSAL = {
  error: `the run's checkout has uncommitted changes; commit or discard them before releasing the checkout: out/one.md, notes.txt`,
  uncommitted: ['out/one.md', 'notes.txt'],
};

let container: HTMLElement;
let unmount: (() => Promise<void>) | null = null;

afterAll(async () => {
  if (unmount) await unmount();
  fetchSpy.mockRestore();
  browser.close();
});

beforeEach(() => {
  releaseAnswers = [];
  releaseBodies = [];
});

const mount = async (pane: ReactElement) => {
  if (unmount) await unmount();
  const node = document.createElement('div');
  container = node;
  document.body.appendChild(node);
  const root = createRoot(node);
  unmount = async () => { await act(async () => root.unmount()); node.remove(); };
  await act(async () => root.render(
    <I18nProvider>
      <ThemeSystemContext.Provider value={themeContext}>{pane}</ThemeSystemContext.Provider>
    </I18nProvider>,
  ));
};

/** Lets a click's round trip to the routes finish before the DOM is read. */
const settle = async () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  await act(async () => promise);
};

// The dialog is rendered into a portal outside the pane's container, so the
// buttons are looked for in the document.
const button = (label: string) => {
  const found = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};
const hasButton = (label: string) => [...document.querySelectorAll('button')]
  .some((candidate) => candidate.textContent?.trim() === label);
const click = async (label: string) => {
  const target = button(label);
  await act(async () => target.click());
  await settle();
};

const pane = (
  <RunDetail run={run} project={project} definition={null} definitionsLoaded onEditDefinition={() => {}} />
);

test('a refused release offers the deletion only after the refusal, and states the count', async () => {
  await mount(pane);
  // Nothing has been refused yet, so the only control is the ordinary release.
  expect(hasButton('Release the worktree')).toBe(true);
  expect(hasButton('Delete 2 uncommitted files and release the checkout')).toBe(false);

  releaseAnswers = [() => Response.json(REFUSAL, { status: 409 })];
  await click('Release the worktree');

  // The refusal names the paths, and the offer states how many files the
  // deletion would take.
  expect(container.textContent).toContain('out/one.md');
  expect(hasButton('Delete 2 uncommitted files and release the checkout')).toBe(true);
  // The refusal asked for no deletion.
  expect(releaseBodies).toEqual(['{}']);
});

test('the deletion is sent only after the confirmation that repeats the count', async () => {
  await mount(pane);
  releaseAnswers = [() => Response.json(REFUSAL, { status: 409 })];
  await click('Release the worktree');

  await click('Delete 2 uncommitted files and release the checkout');
  // The confirmation repeats the count, names every path it will delete, and
  // says the removal takes the whole checkout rather than only those paths.
  expect(document.body.textContent).toContain('not only the 2 files listed below');
  expect(document.body.textContent).toContain('the whole checkout directory');
  expect(document.body.textContent).toContain('out/one.md');
  expect(document.body.textContent).toContain('notes.txt');
  // Opening the confirmation still sent nothing.
  expect(releaseBodies).toEqual(['{}']);

  releaseAnswers = [() => Response.json({ run: { ...run, worktreeReleasedAt: 42 }, deleted: ['out/one.md', 'notes.txt'] })];
  await click('Delete and release');

  // The paths the person confirmed ride with the decision, so the server can
  // refuse when the checkout no longer holds exactly them.
  expect(releaseBodies).toEqual(['{}', '{"deleteUncommitted":true,"confirmed":["out/one.md","notes.txt"]}']);
  // The release happened, so neither control is offered any more — and the pane
  // says what went, which is the only place those paths can still be read.
  expect(hasButton('Delete 2 uncommitted files and release the checkout')).toBe(false);
  expect(hasButton('Release the worktree')).toBe(false);
  expect(container.textContent).toContain('the whole directory is gone');
  expect(container.textContent).toContain('out/one.md');
  expect(container.textContent).toContain('notes.txt');
});

test('a deletion the checkout no longer matches is refused into the pane, with the fresh count', async () => {
  await mount(pane);
  releaseAnswers = [() => Response.json(REFUSAL, { status: 409 })];
  await click('Release the worktree');
  await click('Delete 2 uncommitted files and release the checkout');

  // A third path appeared before the confirmation arrived, so the server refuses
  // the stale set and answers the one it read.
  releaseAnswers = [() => Response.json({
    error: "the run's checkout changed since the deletion was confirmed, so nothing was deleted; not confirmed but now uncommitted: late.md",
    uncommitted: ['out/one.md', 'notes.txt', 'late.md'],
  }, { status: 409 })];
  await click('Delete and release');

  // The failure is readable where the person is: the dialog is closed and the
  // pane states the reason, instead of a covered strip behind the modal.
  expect(hasButton('Delete and release')).toBe(false);
  expect(container.textContent).toContain('so nothing was deleted');
  expect(container.textContent).toContain('late.md');
  // The offer the person sees is the set the server just read, not the stale one.
  expect(hasButton('Delete 3 uncommitted files and release the checkout')).toBe(true);
  expect(hasButton('Delete 2 uncommitted files and release the checkout')).toBe(false);
});

test('a refusal that names no paths clears the offer instead of keeping the old count', async () => {
  await mount(pane);
  releaseAnswers = [() => Response.json(REFUSAL, { status: 409 })];
  await click('Release the worktree');
  expect(hasButton('Delete 2 uncommitted files and release the checkout')).toBe(true);

  // The second release fails for another reason: its status read failed, so the
  // refusal carries no list. The stale one must go with it.
  releaseAnswers = [() => Response.json({ error: "the run's checkout could not be read, so it was not released" }, { status: 409 })];
  await click('Release the worktree');

  expect(container.textContent).toContain('could not be read');
  expect(hasButton('Delete 2 uncommitted files and release the checkout')).toBe(false);
  expect(container.textContent).not.toContain('out/one.md');
  // The ordinary release is still offered, because that is what would re-read
  // the checkout and answer a list worth confirming.
  expect(hasButton('Release the worktree')).toBe(true);
});
