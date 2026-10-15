import { afterAll, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { ReactElement } from 'react';
import type { ThemeContextValue } from '@/contexts/theme-system-context';
import type { WorkflowDefinitionSummary } from '@/lib/workflowsApi';
import type { DefinitionSwitch } from './DefinitionEditor';

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
// The editor reads one definition when it opens, and its first save writes one and
// re-reads what the surface lists. Nothing else talks to the server: the switch
// guard is the pane's own decision.
const RAW = 'id: two-step\nname: Two steps\nversion: 1\n';
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  if (url.pathname === '/api/workflows/definitions/two-step') {
    return Response.json({ definition: null, raw: RAW, hash: 'h'.repeat(64) });
  }
  if (url.pathname === '/api/workflows/definitions/fresh-idea') {
    return Response.json({ written: { file: 'fresh-idea.yaml', id: 'fresh-idea', hash: 's'.repeat(64) } });
  }
  // The save re-reads the surface, so the list and the runs are asked for again.
  if (url.pathname === '/api/workflows/definitions') return Response.json({ definitions: [] });
  if (url.pathname === '/api/workflows/runs') return Response.json({ runs: [] });
  throw new Error(`Unexpected request: ${url.pathname}`);
});
// React, CodeMirror and the component are imported after the DOM globals above:
// they read `document` and `window` as they load, so a static import would run
// them against the empty globals this file starts with.
const { act } = await import('react');
const { useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemContext } = await import('@/contexts/theme-system-context');
const { getDefaultTheme } = await import('@/lib/theme/themes');
const { EditorView } = await import('@codemirror/view');
const { DefinitionEditor } = await import('./DefinitionEditor');

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
const summary = {
  file: 'two-step.yaml', hash: 'h'.repeat(64), id: 'two-step', name: 'Two steps', version: 1,
  errors: [], steps: [], inputs: [], sandbox: 'worktree',
} satisfies WorkflowDefinitionSummary;
/** Another definition the list could ask for: the switch that leaves the pane. */
const other = { ...summary, file: 'other.yaml', id: 'other', name: 'Other steps' } satisfies WorkflowDefinitionSummary;
const switchToOther: DefinitionSwitch = { creating: false, definition: other };
const switchToNew: DefinitionSwitch = { creating: true };

let container: HTMLElement;
let unmount: (() => Promise<void>) | null = null;
afterAll(async () => {
  if (unmount) await unmount();
  fetchSpy.mockRestore();
  browser.close();
});

/** The answers the pane gave to the switches it was handed. */
let answers: boolean[] = [];
/** True once the pane asked to be closed. */
let closed = false;
let handSwitch: (pending: DefinitionSwitch | null) => void = () => {};

const mount = async (pane: ReactElement) => {
  // A pane an earlier test mounted is unmounted here: a pane left in the document
  // would answer button lookups meant for the one this test drives.
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
const view = () => {
  const node = container.querySelector<HTMLElement>('.cm-editor');
  if (!node) throw new Error('The definition editor is missing');
  const editor = EditorView.findFromDOM(node);
  if (!editor) throw new Error('The CodeMirror view is missing');
  return editor;
};

/**
 * Types into the id field. React tracks an input's value through a property it
 * installs on the node, so the value is set through the prototype setter the way a
 * keystroke reaches it: assigning `.value` would update React's tracker and never
 * fire `onChange`.
 */
const typeId = async (value: string) => {
  const field = container.querySelector('input');
  if (!field) throw new Error('The id field is missing');
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

/** The pane for a definition that exists, whose switch resolution the test drives. */
const EditHarness = () => {
  const [pending, setPending] = useState<DefinitionSwitch | null>(null);
  handSwitch = setPending;
  return (
    <DefinitionEditor
      project={project}
      summary={summary}
      onClose={() => { closed = true; }}
      pendingSwitch={pending}
      onSwitchResolved={(discard) => { answers.push(discard); setPending(null); }}
    />
  );
};

test('a switch into another definition asks before it takes typed text, and a clean buffer is not asked about', async () => {
  answers = [];
  closed = false;
  await mount(<EditHarness />);
  expect(container.textContent).toContain('two-step.yaml');

  // Nothing typed yet: the switch is the whole change, so it goes through.
  await act(async () => handSwitch(switchToOther));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(answers).toEqual([true]);

  const typed = `${RAW}name: edited in the buffer\n`;
  await act(async () => {
    const editor = view();
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: typed } });
  });

  // The same switch now holds text the file does not: it waits for an answer.
  await act(async () => handSwitch(switchToOther));
  const asked = document.querySelector('[role="dialog"]');
  expect(asked).not.toBeNull();
  expect(asked?.textContent).toContain('Discard and switch');
  expect(asked?.textContent).toContain('Keep editing');
  expect(answers).toEqual([true]);

  // "Keep editing" answers the switch with no, and the buffer is still there.
  await act(async () => button('Keep editing').click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(answers).toEqual([true, false]);
  expect(view().state.doc.toString()).toBe(typed);

  // "Discard and switch" is the answer that lets the parent take the buffer.
  await act(async () => handSwitch(switchToOther));
  await act(async () => button('Discard and switch').click());
  expect(answers.filter(Boolean)).toHaveLength(2);
  expect(answers[answers.length - 1]).toBe(true);
  expect(closed).toBe(false);
});

test('a switch to the definition already open is resolved without asking', async () => {
  answers = [];
  closed = false;
  await mount(<EditHarness />);
  expect(container.textContent).toContain('two-step.yaml');

  const typed = `${RAW}name: edited in the buffer\n`;
  await act(async () => {
    const editor = view();
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: typed } });
  });

  // The switch names the definition this pane already holds, so the pane it would
  // open is this one: the confirm would be about text nothing is about to take,
  // and applying the switch would only read the file again over the buffer. The
  // pane answers "no" on its own, and the buffer stays exactly as it was.
  await act(async () => handSwitch({ creating: false, definition: summary }));
  // A regression puts the confirm on screen here. It is asked for as a boolean — a
  // DOM node under a failed expectation is a diff the printer walks forever — and
  // dismissed before the assertion, so a failure is the assertion and not a run
  // that never ends.
  const confirmOpen = document.querySelector('[role="dialog"]') !== null;
  if (confirmOpen) await act(async () => button('Keep editing').click());
  expect(confirmOpen).toBe(false);
  expect(answers).toEqual([false]);
  expect(view().state.doc.toString()).toBe(typed);
  expect(closed).toBe(false);
});

/** The pane for a definition that does not exist yet, entered with no definition. */
const CreateHarness = () => {
  const [pending, setPending] = useState<DefinitionSwitch | null>(null);
  handSwitch = setPending;
  return (
    <DefinitionEditor
      project={project}
      summary={null}
      onClose={() => { closed = true; }}
      pendingSwitch={pending}
      onSwitchResolved={(discard) => { answers.push(discard); setPending(null); }}
    />
  );
};

test('the create pane asks before a switch takes an id a person typed for it', async () => {
  answers = [];
  closed = false;
  await mount(<CreateHarness />);

  // A create pane with nothing in it is nothing to lose.
  await act(async () => handSwitch(switchToNew));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(answers).toEqual([true]);

  await typeId('fresh-idea');
  expect(container.textContent).toContain('fresh-idea.yaml');

  // The id names the file this pane would write, so the switch waits for an answer.
  await act(async () => handSwitch(switchToNew));
  const asked = document.querySelector('[role="dialog"]');
  expect(asked?.textContent).toContain('Discard and switch');
  expect(answers).toEqual([true]);

  await act(async () => button('Keep editing').click());
  expect(answers).toEqual([true, false]);
  expect(container.querySelector('input')?.value).toBe('fresh-idea');
  expect(closed).toBe(false);
});

test('the create pane stops reporting unsaved once its first save has written the file', async () => {
  answers = [];
  closed = false;
  await mount(<CreateHarness />);

  await typeId('fresh-idea');
  await act(async () => button('Start from the SDLC template').click());
  expect(container.textContent).toContain('Unsaved changes');

  // Before the save the id names a file that does not exist yet, and the buffer is
  // the only copy of the definition: the close is an exit that would drop both, so
  // it asks.
  await act(async () => button('Back to the diagram').click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Discard and close');
  await act(async () => button('Keep editing').click());
  expect(closed).toBe(false);

  await act(async () => button('Save').click());
  await settle();

  // The file is written under the id that names it, and the pane is now a pane over
  // a file: the buffer matches the disk, the id is fixed and no longer offered, and
  // the header stops reporting changes. There is nothing left for an exit to take.
  expect(container.querySelector('input') === null).toBe(true);
  expect(container.textContent).not.toContain('Unsaved changes');

  // The close the residue was about: the same click now goes straight through.
  await act(async () => button('Back to the diagram').click());
  // A regression leaves the close confirm open here, so it is dismissed before the
  // assertion as the switch test above does.
  const confirmOpen = document.querySelector('[role="dialog"]') !== null;
  if (confirmOpen) await act(async () => button('Keep editing').click());
  expect(confirmOpen).toBe(false);
  expect(closed).toBe(true);
});
