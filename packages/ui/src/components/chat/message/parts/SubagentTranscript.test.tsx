import type { ReactElement } from 'react';
import { act } from 'react';
import { expect, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';
import { loadMarkdownRendererModule } from '@/components/chat/markdownRendererLoader';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { SyncProvider } from '@/sync/sync-context';
import type { SubagentChild, SubagentTranscriptItem } from './SubagentTranscript';

// Bun does not implement Vite's worker asset-query imports. The transcript
// renders its text through the real markdown renderer, which pulls the worker
// module in; only that one import needs a shim.
plugin({
  name: 'subagent-transcript-markdown-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
      loader: 'js',
    }));
  },
});

// Imported here, not statically: the shim above has to be registered before the
// module graph that imports the worker URL is loaded.
const { SubagentList } = await import('./SubagentTranscript');

const children: SubagentChild[] = [
  { id: 'child-1', agent: 'scout', startedAt: '2026-10-16T12:00:01.000Z' },
  { id: 'child-2', agent: 'builder', startedAt: null },
];

const transcript: SubagentTranscriptItem[] = [
  { role: 'user', lines: [{ kind: 'text', text: 'Map the todo store' }] },
  {
    role: 'assistant',
    lines: [
      { kind: 'tool', name: 'Read File', output: 'src/stores/useTodoStore.ts' },
      { kind: 'text', text: 'The store lives in `useTodoStore`.' },
    ],
  },
];

const unavailable = (): never => { throw new Error('the transcript read must not call runtime APIs'); };
const runtimeApis: RuntimeAPIs = {
  runtime: { platform: 'web', isDesktop: false, isVSCode: false },
  get terminal() { return unavailable(); },
  get git() { return unavailable(); },
  get files() { return unavailable(); },
  get settings() { return unavailable(); },
  get permissions() { return unavailable(); },
  get notifications() { return unavailable(); },
};

// The real markdown renderer and the directory hooks below the transcript need
// the same providers the chat mounts it under.
const TestProviders = ({ children }: { children: ReactElement }) => (
  <RuntimeAPIContext.Provider value={runtimeApis}>
    <SyncProvider runtimeIdentity="test-runtime" directory="">
      <I18nProvider>{children}</I18nProvider>
    </SyncProvider>
  </RuntimeAPIContext.Provider>
);

const withWindow = async (run: () => Promise<void>) => {
  const happyWindow = new Window({ url: 'http://localhost' });
  // Without a doctype the markdown renderer's math runs in quirks mode.
  happyWindow.document.write('<!doctype html><html><head></head><body></body></html>');
  happyWindow.document.close();
  const globals = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    localStorage: happyWindow.localStorage,
    customElements: happyWindow.customElements,
    Node: happyWindow.Node,
    Text: happyWindow.Text,
    NodeList: happyWindow.NodeList,
    NodeFilter: happyWindow.NodeFilter,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    HTMLAnchorElement: happyWindow.HTMLAnchorElement,
    HTMLButtonElement: happyWindow.HTMLButtonElement,
    SVGElement: happyWindow.SVGElement,
    DOMParser: happyWindow.DOMParser,
    XMLSerializer: happyWindow.XMLSerializer,
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
    MouseEvent: happyWindow.MouseEvent,
    getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
    ResizeObserver: happyWindow.ResizeObserver,
    MutationObserver: happyWindow.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  try {
    await run();
  } finally {
    await happyWindow.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
};

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: Error) => void };

const deferred = <T,>(): Deferred<T> => {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  return { promise, resolve, reject };
};

const renderList = async (
  element: ReactElement,
  run: (container: HTMLElement) => Promise<void>,
) => {
  // Read through the globals installed above, so the container is the element
  // class React DOM expects rather than happy-dom's own.
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    // The markdown renderer's sanitizer binds to `window` when its module is
    // first imported, so it is loaded here — once this test's document exists,
    // and before anything renders through it.
    await loadMarkdownRendererModule();
    await act(async () => {
      root.render(<TestProviders>{element}</TestProviders>);
    });
    await run(container);
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
};

test('lists the session sub-agents and opens one transcript read-only', async () => {
  await withWindow(async () => {
    const childrenRead = deferred<SubagentChild[]>();
    const opened: Array<[string, string]> = [];
    const fetchMessages = async (sessionId: string, childId: string) => {
      opened.push([sessionId, childId]);
      return transcript;
    };

    await renderList(
      <SubagentList
        sessionId="parent"
        progressText="Running agent scout…"
        jobNames={['WordReply', 'scout']}
        fetchChildren={() => childrenRead.promise}
        fetchMessages={fetchMessages}
      />,
      async (container) => {
        // Nothing read yet: the row says so instead of showing an empty list.
        expect(container.textContent).toContain('Loading...');
        expect(container.textContent).toContain('Subagents');

        await act(async () => {
          childrenRead.resolve(children);
        });

        // The two children the server listed, plus the agent only `hub` named,
        // with no duplicate for the job that matches a listed child.
        expect(container.textContent).toContain('scout');
        expect(container.textContent).toContain('builder');
        expect(container.textContent).toContain('WordReply');
        expect(container.querySelectorAll('button').length).toBe(3);
        // The start time of the child whose header carried one.
        expect(container.textContent).toContain('12:00');
        // The live status line, and the agent it names marked as working.
        expect(container.textContent).toContain('Running agent scout…');
        expect(container.textContent).toContain('is working');

        const scoutButton = [...container.querySelectorAll('button')]
          .find((button) => button.getAttribute('aria-label') === 'Open scout');
        if (!scoutButton) throw new Error('no control to open the sub-agent');
        await act(async () => {
          scoutButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });

        expect(opened).toEqual([['parent', 'child-1']]);
        // The tool the child called renders as a row of its own.
        expect(container.textContent).toContain('Read File');
        expect(container.textContent).toContain('src/stores/useTodoStore.ts');
        // Its words go to the markdown renderer, one boundary per text line.
        // What that renderer paints is not asserted here: it binds to the first
        // document of the process, so another test file's document can leave it
        // with nothing to paint.
        expect(container.querySelectorAll('[data-markdown-content]').length).toBe(2);
        // The child's prompt is the muted item; its answer is not.
        expect(container.querySelector('.text-muted-foreground [data-markdown-content]')).not.toBe(null);
      },
    );
  });
});

test('a hub-named agent the server has not listed yet opens by its name', async () => {
  await withWindow(async () => {
    const opened: Array<[string, string]> = [];

    await renderList(
      <SubagentList
        sessionId="parent"
        jobNames={['WordReply']}
        fetchChildren={async () => []}
        fetchMessages={async (sessionId, childId) => {
          opened.push([sessionId, childId]);
          return transcript;
        }}
      />,
      async (container) => {
        const button = [...container.querySelectorAll('button')]
          .find((candidate) => candidate.getAttribute('aria-label') === 'Open WordReply');
        if (!button) throw new Error('no control to open the sub-agent');
        expect(container.textContent).toContain('Subagents');
        await act(async () => {
          button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });

        // The transcript route resolves an agent name the same as a child id.
        expect(opened).toEqual([['parent', 'WordReply']]);
        expect(container.textContent).toContain('src/stores/useTodoStore.ts');
      },
    );
  });
});

test('a failed read says so instead of an empty roster', async () => {
  await withWindow(async () => {
    const childrenRead = deferred<SubagentChild[]>();

    await renderList(
      <SubagentList sessionId="parent" fetchChildren={() => childrenRead.promise} />,
      async (container) => {
        await act(async () => {
          childrenRead.reject(new Error('sub-agent list failed: 503'));
        });

        expect(container.textContent).toContain('Error:');
        expect(container.textContent).toContain('sub-agent list failed: 503');
        expect(container.querySelectorAll('button').length).toBe(0);
      },
    );
  });
});
