import { describe, expect, spyOn, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { openChamberClient } from '@/lib/openchamber/client'
import { SyncProvider, useChildStoreManager, useSyncDirectory } from './sync-context'
import { usePrefetchSessionMessages } from './use-sync'
import { installHookTestDom } from '../components/session/sidebar/test-utils/testDom'
import { useSessionUIStore } from './session-ui-store'
import type { Message, Part } from '@/lib/opencode/model'

// The provider's own data access goes through the `openChamberClient` singleton;

import { registerAgentRuntime } from '@/lib/agent/registry';
import { createOpenCodeStubRuntime } from '@/lib/agent/testing/opencode-stub-runtime';
import { createOpenCodeStubSurface } from '@/lib/agent/testing/opencode-stub-runtime';
const agentSurface = createOpenCodeStubSurface()

// The mounted provider drives its runtime reads through this surface. The
// session-page retry/backoff harness below needs `listSessionsPage` to exist
// before it can install a spy over it, and the provider's other background
// reads (status snapshot, permissions, pending forms) answer instead of
// rejecting, so a mount does not log a storm of missing-fixture failures.
agentSurface.listSessionsPage = async () => ({ sessions: [], cursor: {} })
agentSurface.getActiveStatus = async () => ({})
agentSurface.listPermissions = async () => []
agentSurface.listPendingForms = async () => []

// The registry's default runtime is the real OMP client; register a
// client-backed double so this test drives app logic with its mocked client.
registerAgentRuntime(createOpenCodeStubRuntime());
// Sessions the OpenCode client created carry `runtimeId: "opencode"`; the
// registry answers an unregistered id with the real OMP client, so register the
// double under that id too.
registerAgentRuntime(createOpenCodeStubRuntime('opencode'));

describe('SyncProvider selection boundary', () => {
  for (const mode of ['confirmed', 'adopted'] as const) {
    test(`keeps the selected transcript whole after its directory is ${mode}`, async () => {
      const dom = installHookTestDom()
      const previousSurface = window.__OPENCHAMBER_SURFACE__
      window.__OPENCHAMBER_SURFACE__ = 'desktop'
      const root = createRoot(dom.container)
      let manager: ReturnType<typeof useChildStoreManager> | undefined
      const Probe = () => { manager = useChildStoreManager(); return null }
      const sessionID = `selected-${mode}`
      const directory = `/workspace/actual-${mode}`
      try {
        await act(async () => root.render(<SyncProvider runtimeIdentity="test-runtime" directory="/workspace/guess"><Probe /></SyncProvider>))
        if (!manager) throw new Error('Directory manager was not mounted')
        const store = manager.ensureChild(directory, { bootstrap: false })
        const messages: Message[] = Array.from({ length: 10 }, (_, index) => ({
          id: `${sessionID}-${index}`, sessionID, role: 'user', time: { created: index },
        }))
        const parts: { [id: string]: Part[] } = Object.fromEntries(messages.map((message) => [message.id, [{
          id: `part-${message.id}`, sessionID, messageID: message.id, type: 'text', text: 'prompt',
        }]]))
        await act(async () => {
          openChamberClient.setDirectory('/workspace/guess')
          useSessionUIStore.getState().setCurrentSession(sessionID, mode === 'confirmed' ? '/workspace/guess' : undefined)
          store.setState({
            session: [{
              id: sessionID, projectID: 'project', directory, title: sessionID, cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
            }],
            message: { [sessionID]: messages }, part: parts,
          })
          if (mode === 'confirmed') useSessionUIStore.getState().setSessionDirectory(sessionID, directory)
          else useSessionUIStore.getState().adoptAuthoritativeSessionDirectory()
          await Promise.resolve()
        })
        expect(useSessionUIStore.getState().currentSessionDirectory).toBe(directory)
        expect(store.getState().message[sessionID]).toHaveLength(10)
        // Leaving starts the idle grace; the transcript stays whole meanwhile.
        await act(async () => { useSessionUIStore.getState().setCurrentSession(null); await Promise.resolve() })
        expect(store.getState().message[sessionID]).toHaveLength(10)
      } finally {
        useSessionUIStore.getState().setCurrentSession(null)
        await act(async () => root.unmount())
        window.__OPENCHAMBER_SURFACE__ = previousSurface
        dom.restore()
      }
    })
  }

  test('bounds failed session-page retries and preserves the last directory snapshot', async () => {
    const dom = installHookTestDom()
    const previousSurface = window.__OPENCHAMBER_SURFACE__
    window.__OPENCHAMBER_SURFACE__ = 'desktop'
    const root = createRoot(dom.container)
    let manager: ReturnType<typeof useChildStoreManager> | undefined
    const Probe = () => {
      manager = useChildStoreManager()
      return null
    }
    let fail = false
    let failedPageRequests = 0
    // Providers unmounted by earlier tests keep retrying their own directory's
    // bootstrap in the background (their `session.active` read never succeeds
    // here); only this directory's requests measure the retry bound.
    const list = spyOn(agentSurface, 'listSessionsPage').mockImplementation(async (options?: { directory?: string }) => {
      if (fail) {
        if (options?.directory === '/workspace/a') failedPageRequests += 1
        throw Object.assign(new Error('OpenCode API unavailable'), { status: 503 })
      }
      return { sessions: [], cursor: {} }
    })

    try {
      await act(async () => root.render(<SyncProvider runtimeIdentity="test-runtime" directory="/workspace/a"><Probe /></SyncProvider>))
      if (!manager) throw new Error('Bootstrap manager was not mounted')
      const mountedManager = manager
      const waitForState = (expected: 'complete' | 'failed') => new Promise<void>((resolve) => {
        if (mountedManager.getBootstrapState('/workspace/a') === expected) return resolve()
        const unsubscribe = mountedManager.subscribeBootstrap(() => {
          if (mountedManager.getBootstrapState('/workspace/a') !== expected) return
          unsubscribe()
          resolve()
        })
      })
      await act(() => waitForState('complete'))
      const store = manager.getChild('/workspace/a')
      if (!store) throw new Error('Directory store was not created')
      const cached = [{
        id: 'cached', title: 'Cached session', projectID: 'project',
        directory: '/workspace/a', time: { created: 1, updated: 1 }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }]
      store.setState({ session: cached, sessionListSource: 'authoritative' })
      fail = true
      await act(async () => {
        mountedManager.requestBootstrap({ directory: '/workspace/a', priority: 'selected', reason: 'current-directory', force: true })
        await waitForState('failed')
      })
      expect(failedPageRequests).toBe(3)
      expect(store.getState().session).toBe(cached)
    } finally {
      await act(async () => root.unmount())
      list.mockRestore()
      window.__OPENCHAMBER_SURFACE__ = previousSurface
      dom.restore()
    }
  }, 15_000)

  test('does not rerender a stable prefetch consumer when only current directory changes', async () => {
    const dom = installHookTestDom()
    const previousSurface = window.__OPENCHAMBER_SURFACE__
    window.__OPENCHAMBER_SURFACE__ = 'desktop'
    const root = createRoot(dom.container)
    let runtimeRenders = 0
    let directoryRenders = 0
    let callback: ReturnType<typeof usePrefetchSessionMessages> | undefined
    const RuntimeConsumer = React.memo(() => {
      callback = usePrefetchSessionMessages()
      runtimeRenders += 1
      return null
    })
    const DirectoryConsumer = () => {
      useSyncDirectory()
      directoryRenders += 1
      return null
    }

    try {
      await act(async () => root.render(
        <SyncProvider runtimeIdentity="test-runtime" directory="/workspace/a">
          <RuntimeConsumer />
          <DirectoryConsumer />
        </SyncProvider>,
      ))
      const initialCallback = callback
      await act(async () => root.render(
        <SyncProvider runtimeIdentity="test-runtime" directory="/workspace/b">
          <RuntimeConsumer />
          <DirectoryConsumer />
        </SyncProvider>,
      ))
      expect(runtimeRenders).toBe(1)
      expect(callback).toBe(initialCallback)
      expect(directoryRenders).toBe(2)
    } finally {
      await act(async () => root.unmount())
      window.__OPENCHAMBER_SURFACE__ = previousSurface
      dom.restore()
    }
  })
})
