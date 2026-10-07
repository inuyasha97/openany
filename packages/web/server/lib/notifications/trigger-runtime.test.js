import { afterEach, describe, expect, it, vi } from 'vitest';

import { configureOmpRuntimeHost } from '../agents/omp-host-access.js';
import { createNotificationTriggerRuntime } from './runtime.js';

/**
 * The "ready" push is built from the translated assistant-step events: the
 * step start names agent and model, the step end carries the finish. What is
 * pinned here: the finish is announced with the agent and model from the
 * start, a user abort announces nothing, and an active goal (which lives in
 * OpenChamber's own metadata) silences the push.
 */

afterEach(() => {
  configureOmpRuntimeHost(null);
});

const makeRuntime = ({ metadata = {} } = {}) => {
  const emitDesktopNotification = vi.fn(() => true);
  const runtime = createNotificationTriggerRuntime({
    readSettingsFromDisk: async () => ({ nativeNotificationsEnabled: true, notificationMode: 'always', notifyOnCompletion: true }),
    prepareNotificationLastMessage: async ({ message }) => message,
    buildTemplateVariables: async () => ({}),
    extractLastMessageText: () => 'done',
    fetchLastAssistantMessageText: async () => 'done',
    resolveNotificationTemplate: () => '',
    shouldApplyResolvedTemplateMessage: () => false,
    emitDesktopNotification,
    broadcastUiNotification: vi.fn(),
    sendPushToAllUiSessions: vi.fn(async () => undefined),
    sendApnsToAllUiSessions: vi.fn(async () => undefined),
    isAnyInteractiveClientVisible: () => true,
    readSessionMetadata: async () => metadata,
  });
  return { runtime, emitDesktopNotification };
};

const stepStarted = (sessionID, id) => ({
  type: 'message.updated',
  properties: { sessionID, info: { id, sessionID, role: 'assistant', agent: 'build', providerID: 'anthropic', modelID: 'claude-sonnet-5', time: { created: 1 } } },
});
const stepEnded = (sessionID, id) => ({
  type: 'message.updated',
  properties: { sessionID, info: { id, sessionID, role: 'assistant', finish: 'stop', time: { completed: 2 } } },
});

const turnEnded = (sessionID) => ({ type: 'session.idle', properties: { sessionID } });

/** A fake OMP runtime answering one busy flag per session. */
const stubOmp = ({ busy = {} } = {}) => {
  const host = {
    listSessions: vi.fn(async () => [{ id: 'ses_1', sessionPath: '/sessions/1.jsonl', cwd: '/repo', title: 'One' }]),
    getSessionStatus: vi.fn(async (id) => ({ busy: busy[id] === true })),
    getMessages: vi.fn(async () => ({ items: [], cursor: {} })),
  };
  configureOmpRuntimeHost(() => host);
  return host;
};

describe('ready notification on assistant step events', () => {
  it('announces the turn end with the agent and model of its last step', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubOmp();
    const { runtime, emitDesktopNotification } = makeRuntime();

    await runtime.maybeSendPushForTrigger(stepStarted('ses_1', 'msg_1'));
    expect(emitDesktopNotification).not.toHaveBeenCalled();

    // A step's `stop` is not the end of the turn: the execution may still
    // drain steering input, so only its idle event announces readiness.
    await runtime.maybeSendPushForTrigger(stepEnded('ses_1', 'msg_1'));
    expect(emitDesktopNotification).not.toHaveBeenCalled();

    await runtime.maybeSendPushForTrigger(turnEnded('ses_1'));
    expect(emitDesktopNotification).toHaveBeenCalledTimes(1);
    expect(emitDesktopNotification.mock.calls[0][0]).toMatchObject({
      kind: 'ready',
      title: 'Build agent is ready',
      body: 'Claude Sonnet 5 completed the task',
    });
  });

  it('announces nothing for a user abort', async () => {
    stubOmp();
    const { runtime, emitDesktopNotification } = makeRuntime();

    await runtime.maybeSendPushForTrigger({
      type: 'session.idle',
      properties: { sessionID: 'ses_2', aborted: true, reason: 'user', error: { name: 'MessageAbortedError', message: 'aborted' } },
    });

    expect(emitDesktopNotification).not.toHaveBeenCalled();
  });

  it('stays quiet while a goal from OpenChamber\'s own metadata is active', async () => {
    stubOmp();
    const { runtime, emitDesktopNotification } = makeRuntime({
      metadata: { openchamber: { goal: { id: 'g', status: 'active', objective: 'x' } } },
    });

    await runtime.maybeSendPushForTrigger(stepStarted('ses_3', 'msg_3'));
    await runtime.maybeSendPushForTrigger(stepEnded('ses_3', 'msg_3'));
    await runtime.maybeSendPushForTrigger(turnEnded('ses_3'));

    expect(emitDesktopNotification).not.toHaveBeenCalled();
  });
});

describe('ready notification while a background turn runs', () => {
  it('announces the idle: the runtime lists no subagent sessions', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const host = stubOmp({ busy: { ses_1: true } });
    const { runtime, emitDesktopNotification } = makeRuntime();

    await runtime.maybeSendPushForTrigger(stepStarted('ses_1', 'msg_1'));
    await runtime.maybeSendPushForTrigger(turnEnded('ses_1'));

    // OMP keeps a subagent inside its parent's turn and lists no child
    // sessions, so the idle is the end of the turn and announces.
    expect(host.listSessions).toHaveBeenCalled();
    expect(emitDesktopNotification).toHaveBeenCalledTimes(1);
  });

  it('announces the idle when the status read cannot be made', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // No runtime mounted: the probe answers `null`, and the notice must not be
    // swallowed by a check that could not run.
    configureOmpRuntimeHost(null);
    const { runtime, emitDesktopNotification } = makeRuntime();

    await runtime.maybeSendPushForTrigger(stepStarted('ses_1', 'msg_1'));
    await runtime.maybeSendPushForTrigger(turnEnded('ses_1'));
    expect(emitDesktopNotification).toHaveBeenCalledTimes(1);
  });
});

describe('push content in enterprise mode', () => {
  const makePushRuntime = () => {
    const sendPushToAllUiSessions = vi.fn(async () => undefined);
    const sendApnsToAllUiSessions = vi.fn(async () => undefined);
    const runtime = createNotificationTriggerRuntime({
      readSettingsFromDisk: async () => ({ nativeNotificationsEnabled: true, notificationMode: 'always', notifyOnCompletion: true }),
      prepareNotificationLastMessage: async ({ message }) => message,
      buildTemplateVariables: async () => ({ session_name: 'Fix the billing export' }),
      extractLastMessageText: () => 'The customer table is migrated',
      fetchLastAssistantMessageText: async () => 'The customer table is migrated',
      resolveNotificationTemplate: (template, variables) => template.replace('{last_message}', variables.last_message ?? ''),
      shouldApplyResolvedTemplateMessage: () => true,
      emitDesktopNotification: vi.fn(() => true),
      broadcastUiNotification: vi.fn(),
      sendPushToAllUiSessions,
      sendApnsToAllUiSessions,
      isAnyInteractiveClientVisible: () => false,
      readSessionMetadata: async () => ({}),
    });
    return { runtime, sendPushToAllUiSessions, sendApnsToAllUiSessions };
  };

  it('sends only the scenario title and the deep link, on both channels', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubOmp();
    process.env.OPENCHAMBER_ENTERPRISE_MODE = 'true';
    try {
      const { runtime, sendPushToAllUiSessions, sendApnsToAllUiSessions } = makePushRuntime();
      await runtime.maybeSendPushForTrigger(stepStarted('ses_e', 'msg_e'));
      await runtime.maybeSendPushForTrigger(turnEnded('ses_e'));

      const web = sendPushToAllUiSessions.mock.calls[0][0];
      expect(web).toMatchObject({ title: 'Agent response is ready', body: '', data: { sessionId: 'ses_e', type: 'ready' } });
      expect(web.data.sessionName).toBeUndefined();
      expect(sendApnsToAllUiSessions.mock.calls[0][0]).toMatchObject({ title: 'Agent response is ready', body: '' });
      expect(JSON.stringify([web, sendApnsToAllUiSessions.mock.calls[0][0]])).not.toMatch(/billing|customer/);
    } finally {
      delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    }
  });
});

describe('subagent finish with subagent notifications off', () => {
  const makeSubtaskRuntime = () => {
    const emitDesktopNotification = vi.fn(() => true);
    const runtime = createNotificationTriggerRuntime({
      readSettingsFromDisk: async () => ({ nativeNotificationsEnabled: true, notificationMode: 'always', notifyOnCompletion: true, notifyOnSubtasks: false }),
      prepareNotificationLastMessage: async ({ message }) => message,
      buildTemplateVariables: async () => ({}),
      extractLastMessageText: () => 'done',
      fetchLastAssistantMessageText: async () => 'done',
      resolveNotificationTemplate: () => '',
      shouldApplyResolvedTemplateMessage: () => false,
      emitDesktopNotification,
      broadcastUiNotification: vi.fn(),
      sendPushToAllUiSessions: vi.fn(async () => undefined),
      sendApnsToAllUiSessions: vi.fn(async () => undefined),
      isAnyInteractiveClientVisible: () => true,
      readSessionMetadata: async () => ({}),
    });
    return { runtime, emitDesktopNotification };
  };

  it('asks the runtime whether the session is a subagent session', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // OMP exposes no parent on a session record, so the runtime's answer is
    // "no parent" — the finish is announced.
    const host = stubOmp();
    const { runtime, emitDesktopNotification } = makeSubtaskRuntime();

    await runtime.maybeSendPushForTrigger(stepStarted('ses_1', 'msg_c'));
    await runtime.maybeSendPushForTrigger(turnEnded('ses_1'));

    expect(host.listSessions).toHaveBeenCalled();
    expect(emitDesktopNotification).toHaveBeenCalledTimes(1);
  });

  it('a partial session update does not erase a known parent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // No runtime mounted: the fallback lookup cannot be made.
    configureOmpRuntimeHost(null);
    const { runtime, emitDesktopNotification } = makeSubtaskRuntime();

    await runtime.maybeSendPushForTrigger({ type: 'session.created', properties: { sessionID: 'ses_child', info: { id: 'ses_child', parentID: 'ses_parent' } } });
    // Usage updates arrive as `session.updated` with a partial record.
    await runtime.maybeSendPushForTrigger({ type: 'session.updated', properties: { sessionID: 'ses_child', info: { id: 'ses_child', cost: 1 } } });
    await runtime.maybeSendPushForTrigger(stepStarted('ses_child', 'msg_c'));
    await runtime.maybeSendPushForTrigger(turnEnded('ses_child'));

    expect(emitDesktopNotification).not.toHaveBeenCalled();
  });
});
