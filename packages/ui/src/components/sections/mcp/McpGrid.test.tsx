import { afterEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';
import type { McpServerWithScope } from '@/stores/useMcpConfigStore';

// The DOM globals must be installed before anything that touches `window` at
// module load is imported, so the app modules are loaded dynamically below.
// Static imports cannot work here.
const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  Event: browser.Event, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ home: '/test' }));
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { I18nProvider } = await import('@/lib/i18n');
const { McpGrid } = await import('./McpGrid');
const { useMcpConfigStore } = await import('@/stores/useMcpConfigStore');
const { useMcpStore } = await import('@/stores/useMcpStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useUIStore } = await import('@/stores/useUIStore');

const DIRECTORY = '/repo';

const signedServer: McpServerWithScope = {
  name: 'signed',
  type: 'remote',
  url: 'https://signed.test',
  oauth: { client_id: 'cid' },
  credentialId: 'mcp_oauth:profile:default:https://signed.test',
  authenticated: true,
};
const unsignedServer: McpServerWithScope = {
  name: 'unsigned',
  type: 'remote',
  url: 'https://unsigned.test',
  authenticated: false,
};

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let fetchCallsBeforeMount = 0;

const mount = async (servers: McpServerWithScope[]) => {
  fetchCallsBeforeMount = fetchSpy.mock.calls.length;
  useUIStore.setState({ settingsProjectPath: null });
  useProjectsStore.setState({ projects: [{ id: 'p1', path: DIRECTORY }], activeProjectId: 'p1' });
  useMcpConfigStore.setState({ serversByDirectory: { [DIRECTORY]: servers }, loadMcpConfigs: async () => true });
  useMcpStore.setState({ byDirectory: {}, lastErrorKeys: {} });

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ThemeSystemProvider>
        <I18nProvider>
          <McpGrid />
        </I18nProvider>
      </ThemeSystemProvider>,
    );
  });
};

const signInLabels = () => [...(container?.querySelectorAll('button') ?? [])]
  .map((button) => (button.textContent ?? '').trim())
  // A sign-in affordance is a button whose own label is the action; the card
  // itself is a button, and the hint inside it merely mentions signing in.
  .filter((label) => /^(sign in|log in|authenticate|authorize)\b/i.test(label));

const authCalls = () => fetchSpy.mock.calls
  .slice(fetchCallsBeforeMount)
  .map((call) => String(call[0]))
  .filter((url) => /oauth|auth|connect|signin|reauth/i.test(url));

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

test('an authenticated server shows it is authenticated and offers no sign-in', async () => {
  await mount([signedServer]);

  expect(container?.textContent).toContain('Authenticated');
  expect(container?.textContent).not.toContain('Not authenticated');
  expect(signInLabels()).toEqual([]);
  expect(authCalls()).toEqual([]);
});

test('an unauthenticated server shows the hint naming OMP\'s own reauth and starts no flow', async () => {
  await mount([unsignedServer]);

  expect(container?.textContent).toContain('Not authenticated');
  expect(container?.textContent).toContain('/mcp');
  expect(signInLabels()).toEqual([]);
  expect(authCalls()).toEqual([]);
});

test('a local server shows no auth state, so no reauth hint points at a stdio command', async () => {
  await mount([{ name: 'local-files', type: 'local', command: ['npx', 'server.js'] }]);

  expect(container?.textContent).not.toContain('Not authenticated');
  expect(container?.textContent).not.toContain('Authenticated');
  expect(container?.textContent).not.toContain('/mcp');
});
