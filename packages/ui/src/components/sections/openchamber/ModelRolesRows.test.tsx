/**
 * The rows read OMP's role table and write one key per choice. Both halves go
 * through the request the component is handed, so the test drives the real
 * component against a stub instead of mocking its modules.
 *
 * The role table is the user's config file: a role OMP does not set has to read
 * as unset rather than as some model this page picked for them.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';
import type { Model, Provider } from '@/lib/opencode/model';
import type { ModelRolesFetch } from './ModelRolesRows';

type CatalogProvider = Provider & { models: Model[] };
type WriteCall = { role: string; value: string | null };

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

const catalog: CatalogProvider[] = [
  provider('anthropic', 'Anthropic', [
    model('anthropic', 'claude-sonnet-4', 'Claude Sonnet 4'),
    model('anthropic', 'claude-haiku-4', 'Claude Haiku 4'),
  ]),
  provider('openai', 'OpenAI', [model('openai', 'gpt-5', 'GPT-5')]),
];

/** The roles the stubbed route answers: `smol` is the one this config leaves unset. */
const storedRoles = [
  { name: 'default', value: 'openai/gpt-5' },
  { name: 'smol', value: null },
  { name: 'task', value: null },
];

let browser: Window;
let container: HTMLElement;
let root: Root;
let writes: WriteCall[];
let fetchImpl: ModelRolesFetch;
let originals: Map<string, PropertyDescriptor | undefined>;

beforeEach(() => {
  browser = new Window({ url: 'http://model-roles.test/' });
  originals = new Map();
  for (const [name, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    localStorage: browser.localStorage,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    Node: browser.Node,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    MouseEvent: browser.MouseEvent,
    MutationObserver: browser.MutationObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  container = document.createElement('div');
  document.body.append(container);
  writes = [];
  fetchImpl = async (input, init) => {
    if ((init?.method ?? 'GET') === 'PUT') {
      // SAFETY: this stub is the only writer in the test, and every assertion
      // below reads the fields it parsed back out.
      const body = JSON.parse(String(init?.body)) as WriteCall;
      writes.push(body);
      return Response.json({
        ok: true,
        roles: storedRoles.map((role) => (role.name === body.role ? { ...role, value: body.value } : role)),
      });
    }
    return Response.json({ roles: storedRoles, known: storedRoles.map((role) => role.name) });
  };
});

afterEach(async () => {
  await act(async () => root?.unmount());
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  await browser.happyDOM.close();
});

// Imported after the DOM globals: React DOM binds to `window` at load time, and
// the component reads the config store the test seeds.
const loadComponent = async () => {
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { useConfigStore } = await import('@/stores/useConfigStore');
  const { ModelRolesRows } = await import('./ModelRolesRows');
  root = createRoot(container);
  return { I18nProvider, useConfigStore, ModelRolesRows };
};

describe('ModelRolesRows', () => {
  test('renders one row per role and says which roles are unset', async () => {
    const { I18nProvider, useConfigStore, ModelRolesRows } = await loadComponent();
    useConfigStore.setState({ providers: catalog });

    await act(async () => {
      root.render(<I18nProvider><ModelRolesRows fetchImpl={fetchImpl} /></I18nProvider>);
    });

    const rows = [...container.querySelectorAll<HTMLElement>('[data-settings-item^="sessions.model-role."]')];
    expect(rows.map((row) => row.dataset.settingsItem)).toEqual([
      'sessions.model-role.default',
      'sessions.model-role.smol',
      'sessions.model-role.task',
    ]);
    expect(container.textContent).toContain('Model roles');
    expect(container.textContent).toContain('Applies to sessions started after the change.');
    expect(container.textContent).toContain('openai/gpt-5');
    // The two roles the config leaves alone read as unset, not as a chosen model.
    expect(container.textContent?.split('Not set')).toHaveLength(3);
    expect(writes).toEqual([]);
  });

  test('sends one write for the role whose model the user picked', async () => {
    const { I18nProvider, useConfigStore, ModelRolesRows } = await loadComponent();
    useConfigStore.setState({ providers: catalog });

    await act(async () => {
      root.render(<I18nProvider><ModelRolesRows fetchImpl={fetchImpl} /></I18nProvider>);
    });

    const smolRow = container.querySelector<HTMLElement>('[data-settings-item="sessions.model-role.smol"]');
    const trigger = smolRow?.querySelector('button');
    expect(trigger?.textContent).toContain('Not set');

    await act(async () => trigger?.click());
    const picker = document.querySelector('[data-slot="model-role-picker"]');
    expect(picker).not.toBeNull();
    expect(picker?.textContent).toContain('Claude Sonnet 4');

    const option = [...(picker?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      .find((candidate) => candidate.textContent?.includes('Claude Sonnet 4'));
    await act(async () => option?.click());

    expect(writes).toEqual([{ role: 'smol', value: 'anthropic/claude-sonnet-4' }]);
    expect(document.querySelector('[data-slot="model-role-picker"]')).toBeNull();
    expect(smolRow?.querySelector('button')?.textContent).toContain('anthropic/claude-sonnet-4');

    // Clearing the same role writes `null`, which is how the key is removed.
    await act(async () => smolRow?.querySelector('button')?.click());
    const clear = document.querySelector<HTMLButtonElement>('[data-slot="model-role-picker"] button');
    await act(async () => clear?.click());

    expect(writes).toEqual([
      { role: 'smol', value: 'anthropic/claude-sonnet-4' },
      { role: 'smol', value: null },
    ]);
    expect(smolRow?.querySelector('button')?.textContent).toContain('Not set');
  });
});
