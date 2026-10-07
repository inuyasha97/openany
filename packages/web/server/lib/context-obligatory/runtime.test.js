import { afterEach, describe, expect, it, vi } from 'vitest';

import { configureOmpRuntimeHost } from '../agents/omp-host-access.js';
import { createContextObligatoryRuntime } from './runtime.js';

/**
 * Pinned messages and the compaction cursor live in OpenChamber's own session
 * metadata store. `readSessionMetadata` and `persistContextCursor` are the
 * seams; without both the runtime stays inert and says so once.
 *
 * `session.compacted` is the hub's translation of the runtime's
 * `session.compaction.ended`. The compaction is read from the canonical
 * `{ info, parts }` page the OMP host serves.
 */

const SESSION_ID = 'ses_1';
const SESSION_RECORD = { id: SESSION_ID, sessionPath: '/sessions/1.jsonl', cwd: '/repo', title: 'One' };
const runtimes = [];

const makeRuntime = (overrides = {}) => {
  const runtime = createContextObligatoryRuntime({ ...overrides });
  runtimes.push(runtime);
  return { runtime };
};

const compactionEvent = () => ({ type: 'session.compacted', properties: { sessionID: SESSION_ID } });

/**
 * A fake OMP runtime holding one finished compaction and two pinned messages.
 */
const stubOmp = ({ items = defaultItems() } = {}) => {
  const host = {
    listSessions: vi.fn(async () => [SESSION_RECORD]),
    getSessionStatus: vi.fn(async () => ({ busy: false })),
    getMessages: vi.fn(async () => ({ items, cursor: {} })),
    prompt: vi.fn(async () => true),
  };
  configureOmpRuntimeHost(() => host);
  return host;
};

const textItem = (id, role, text, created, extra = {}) => ({
  info: { id, sessionID: SESSION_ID, role, time: { created }, ...extra },
  parts: [{ type: 'text', text }],
});

function defaultItems() {
  return [
    textItem('msg_u', 'user', 'Keep this rule', 1),
    textItem('msg_a', 'assistant', 'Old answer', 2),
    textItem('msg_compact', 'compaction', 'S', 5, { status: 'completed', reason: 'auto', summary: 'S' }),
  ];
}

const pinnedMetadata = (extra = {}) => ({
  openchamber: {
    context_obligatory_messages: [
      { id: 'msg_a', createdAt: 2, role: 'assistant' },
      { id: 'msg_u', createdAt: 1, role: 'user' },
    ],
    ...extra,
  },
});

afterEach(() => {
  while (runtimes.length > 0) runtimes.pop().stop();
  configureOmpRuntimeHost(null);
  vi.restoreAllMocks();
});

describe('context obligatory runtime', () => {
  it('fails visibly instead of dropping the restored context, and does not advance the cursor', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const host = stubOmp();
    const persistContextCursor = vi.fn(async () => undefined);
    const { runtime } = makeRuntime({ readSessionMetadata: async () => pinnedMetadata(), persistContextCursor });

    await runtime.processPayload(compactionEvent(), '/repo');

    // The compaction and the pinned texts were read from the runtime's page.
    expect(host.getMessages).toHaveBeenCalledWith(SESSION_ID);
    const failure = warn.mock.calls.find(([line]) => String(line).includes('[context-obligatory] injection failed'));
    expect(failure).toBeDefined();
    expect(String(failure[1])).toContain('synthetic message');
    expect(String(failure[1])).toContain('not supported on the OMP runtime');
    // Unadvanced: an OMP equivalent must re-inject, not skip the compaction.
    expect(persistContextCursor).not.toHaveBeenCalled();
  });

  it('does not re-send for a compaction it already handled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const host = stubOmp();
    const { runtime } = makeRuntime({
      readSessionMetadata: async () => pinnedMetadata({ context_obligatory_last_compaction_message_id: 'msg_compact' }),
      persistContextCursor: vi.fn(async () => undefined),
    });

    await runtime.processPayload(compactionEvent(), '/repo');

    expect(host.getMessages).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does nothing when the page carries no finished compaction', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubOmp({ items: [textItem('msg_u', 'user', 'Keep this rule', 1), textItem('msg_a', 'assistant', 'Old answer', 2)] });
    const persistContextCursor = vi.fn(async () => undefined);
    const { runtime } = makeRuntime({ readSessionMetadata: async () => pinnedMetadata(), persistContextCursor });

    await runtime.processPayload(compactionEvent(), '/repo');

    expect(warn).not.toHaveBeenCalled();
    expect(persistContextCursor).not.toHaveBeenCalled();
  });

  it('needs both seams: a read alone leaves it inert', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const host = stubOmp();
    const { runtime } = makeRuntime({ readSessionMetadata: async () => ({}) });

    await runtime.processPayload(compactionEvent());

    expect(host.listSessions).not.toHaveBeenCalled();
    expect(host.getMessages).not.toHaveBeenCalled();
  });

  it('explains itself once, not on every event', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runtime } = makeRuntime();

    runtime.processPayload(compactionEvent());
    runtime.processPayload({ type: 'session.idle', properties: { sessionID: 'ses_2' } });

    const notices = log.mock.calls.filter(([line]) => String(line).includes('[context-obligatory] parked'));
    expect(notices).toHaveLength(1);
  });

  it('ignores everything after stop', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runtime } = makeRuntime();

    runtime.stop();
    runtime.processPayload(compactionEvent());

    expect(log).not.toHaveBeenCalled();
  });
});
