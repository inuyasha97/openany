import { afterEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Model, Provider } from '@/lib/opencode/model';

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

// ProviderLogo reads `import.meta.glob`, which only Vite transforms; resolve the
// same hook against the real logo files instead.
plugin({
  name: 'providers-page-logos',
  setup(build) {
    build.onLoad({ filter: /useProviderLogo\.ts$/ }, ({ path }) => {
      const directory = resolve(dirname(path), '../assets/provider-logos');
      const logos = Object.fromEntries(readdirSync(directory).filter((name) => name.endsWith('.svg')).map((name) => [
        `../assets/provider-logos/${name}`, pathToFileURL(resolve(directory, name)).href,
      ]));
      return { contents: readFileSync(path, 'utf8').replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`), loader: 'ts' };
    });
  },
});

// These modules are imported after the DOM globals above: React DOM binds to
// `window`/`document` at load time, so a static import would run too early.
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { useConfigStore } = await import('@/stores/useConfigStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useUIStore } = await import('@/stores/useUIStore');
const { ProvidersPage } = await import('./ProvidersPage');

const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
afterEach(async () => { await act(async () => root.unmount()); fetchSpy.mockRestore(); await browser.happyDOM.close(); });

type CatalogProvider = Provider & { models: Model[] };

const model = (providerID: string, id: string, name: string): Model => ({
  id, modelID: id, providerID, name,
  capabilities: { tools: true, input: ['text'], output: ['text'] },
  variants: [], time: { released: 0 },
  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
  status: 'active', enabled: true,
  limit: { context: 200_000, output: 8_192 },
});

const provider = (id: string, name: string, models: Model[]): CatalogProvider => ({
  id, name, activation: 'enabled', package: '', models,
});

test('renders the OMP catalog, refreshes it, and shows the empty state', async () => {
  const calls: Array<{ directory?: string | null; source?: string }> = [];
  useProjectsStore.setState({ projects: [], activeProjectId: null });
  useUIStore.setState({ settingsProvidersClassificationRequested: false });
  useConfigStore.setState({
    activeDirectoryKey: '__global__',
    providersLoaded: true,
    providers: [
      provider('anthropic', 'Anthropic', [model('anthropic', 'claude-sonnet-4', 'Claude Sonnet 4')]),
      provider('openai', 'OpenAI', []),
    ],
    loadProviders: async (options) => { calls.push(options ?? {}); },
  });

  await act(async () => {
    root.render(<ThemeSystemProvider><I18nProvider><ProvidersPage /></I18nProvider></ThemeSystemProvider>);
  });

  const anthropic = container.querySelector('[data-provider-id="anthropic"]');
  expect(anthropic?.textContent).toContain('Anthropic');
  expect(anthropic?.textContent).toContain('anthropic');
  expect(anthropic?.textContent).toContain('Claude Sonnet 4');
  expect(anthropic?.textContent).toContain('claude-sonnet-4');
  expect(container.querySelectorAll('[data-provider-id]')).toHaveLength(2);

  await act(async () => {
    [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Refresh'))?.click();
  });
  expect(calls).toEqual([{ directory: null, source: 'settings:providers' }]);

  await act(async () => { useConfigStore.setState({ providers: [] }); });
  expect(container.querySelectorAll('[data-provider-id]')).toHaveLength(0);
  expect(container.textContent).toContain('No providers yet');
});
