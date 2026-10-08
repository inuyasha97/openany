import { afterEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.defineProperty(browser.navigator, 'userAgent', { value: 'TestAgent/1.0', configurable: true });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, Event: browser.Event, FocusEvent: browser.FocusEvent,
  CustomEvent: browser.CustomEvent, MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver, getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}));

// Static imports would evaluate React DOM and the component before the DOM
// globals above exist; these must load after the happy-dom bootstrap.
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ChooserScreen } = await import('@/components/onboarding/ChooserScreen');

const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
afterEach(async () => { await act(async () => root.unmount()); fetchSpy.mockRestore(); browser.close(); });

// The launcher resolves the CLI from OPENCHAMBER_OMP_PATH / OPENCHAMBER_OMP_BIN /
// OMP_BINARY and searches PATH for `omp`. A hint naming another variable or
// binary sends the user to a setting nothing reads.
test('the onboarding local-setup hints name the CLI and env var the launcher reads', async () => {
  await act(async () => { root.render(<I18nProvider><ChooserScreen /></I18nProvider>); });
  const hints = [...container.querySelectorAll('ul li')].map((item) => item.textContent ?? '');
  expect(hints.length).toBeGreaterThan(0);
  expect(hints.some((hint) => hint.includes('OPENCHAMBER_OMP_PATH'))).toBe(true);
  expect(hints.some((hint) => /\bomp\b/i.test(hint) && hint.includes('PATH'))).toBe(true);
  expect(hints.join(' ')).not.toContain('OPENCODE_BINARY');
  expect(/opencode/i.test(hints.join(' '))).toBe(false);
});
