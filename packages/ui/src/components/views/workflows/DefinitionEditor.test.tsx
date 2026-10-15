import { afterAll, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { ReactElement } from 'react';
import type { ThemeContextValue } from '@/contexts/theme-system-context';
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
// The editor reads one definition when it opens. Nothing else in this file talks
// to the server: the switch guard is the pane's own decision.
const RAW = 'id: two-step\nname: Two steps\nversion: 1\n';
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  if (url.pathname === '/api/workflows/definitions/two-step') {
    return Response.json({ definition: null, raw: RAW, hash: 'h'.repeat(64) });
  }
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

let container: HTMLElement;
let unmount: (() => Promise<void>) | null = null;
afterAll(async () => {
  if (unmount) await unmount();
  fetchSpy.mockRestore();
  browser.close();
});

/** The answers the pane gave to the switches it was handed. */
let answers: boolean[] = [];
let handSwitch: (pending: boolean) => void = () => {};

const mount = async (pane: ReactElement) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  unmount = async () => { await act(async () => root.unmount()); container.remove(); };
  await act(async () => root.render(
    <I18nProvider>
      <ThemeSystemContext.Provider value={themeContext}>{pane}</ThemeSystemContext.Provider>
    </I18nProvider>,
  ));
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

/** The pane for a definition that exists, whose switch resolution the test drives. */
const EditHarness = () => {
  const [pending, setPending] = useState(false);
  handSwitch = setPending;
  return (
    <DefinitionEditor
      project={project}
      summary={summary}
      onClose={() => { throw new Error('The pane closed without being asked to'); }}
      pendingSwitch={pending}
      onSwitchResolved={(discard) => { answers.push(discard); setPending(false); }}
    />
  );
};

test('a switch into another definition asks before it takes typed text, and a clean buffer is not asked about', async () => {
  answers = [];
  await mount(<EditHarness />);
  expect(container.textContent).toContain('two-step.yaml');

  // Nothing typed yet: the switch is the whole change, so it goes through.
  await act(async () => handSwitch(true));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(answers).toEqual([true]);

  const typed = `${RAW}name: edited in the buffer\n`;
  await act(async () => {
    const editor = view();
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: typed } });
  });

  // The same switch now holds text the file does not: it waits for an answer.
  await act(async () => handSwitch(true));
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
  await act(async () => handSwitch(true));
  await act(async () => button('Discard and switch').click());
  expect(answers.filter(Boolean)).toHaveLength(2);
  expect(answers[answers.length - 1]).toBe(true);
});

/** The pane for a definition that does not exist yet, entered with no definition. */
const CreateHarness = () => {
  const [pending, setPending] = useState(false);
  handSwitch = setPending;
  return (
    <DefinitionEditor
      project={project}
      summary={null}
      onClose={() => { throw new Error('The pane closed without being asked to'); }}
      pendingSwitch={pending}
      onSwitchResolved={(discard) => { answers.push(discard); setPending(false); }}
    />
  );
};

test('the create pane asks before a switch takes an id a person typed for it', async () => {
  answers = [];
  await mount(<CreateHarness />);
  const field = container.querySelector('input');
  if (!field) throw new Error('The id field is missing');

  // A create pane with nothing in it is nothing to lose.
  await act(async () => handSwitch(true));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(answers).toEqual([true]);

  // React tracks an input's value through a property it installs on the node, so
  // the value is set through the prototype setter the way a keystroke reaches it:
  // assigning `.value` would update React's tracker and never fire `onChange`.
  const typeId = async (value: string) => {
    const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  await typeId('fresh-idea');
  expect(container.textContent).toContain('fresh-idea.yaml');

  // The id names the file this pane would write, so the switch waits for an answer.
  await act(async () => handSwitch(true));
  const asked = document.querySelector('[role="dialog"]');
  expect(asked?.textContent).toContain('Discard and switch');
  expect(answers).toEqual([true]);

  await act(async () => button('Keep editing').click());
  expect(answers).toEqual([true, false]);
  expect(container.querySelector('input')?.value).toBe('fresh-idea');
});
