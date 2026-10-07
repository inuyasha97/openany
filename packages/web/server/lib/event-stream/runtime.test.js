import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { createMessageStreamWsRuntime } from './runtime.js';
import { createGlobalMessageStreamHub } from './global-hub.js';

const makeRuntime = () => {
  const server = new EventEmitter();
  const hub = createGlobalMessageStreamHub({ deltaCoalesceWindowMs: 0 });
  const wsClients = new Set();
  const runtime = createMessageStreamWsRuntime({
    server,
    uiAuthController: { enabled: false },
    isRequestOriginAllowed: async () => true,
    rejectWebSocketUpgrade: vi.fn(),
    processForwardedEventPayload: () => {},
    wsClients,
    globalEventHub: hub,
    heartbeatIntervalMs: 60_000,
  });
  return { server, hub, wsClients, runtime };
};

const fakeSocket = () => {
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.sent = [];
  socket.send = (frame) => socket.sent.push(typeof frame === 'string' ? frame : frame.toString());
  socket.ping = vi.fn();
  socket.terminate = vi.fn();
  socket.close = vi.fn();
  return socket;
};

describe('createMessageStreamWsRuntime', () => {
  it('readies a global websocket on accept and fans hub events out to it', () => {
    const { hub, wsClients, runtime } = makeRuntime();

    const socket = fakeSocket();
    runtime.wsServer.emit('connection', socket, { url: '/api/global/event/ws' });
    expect(JSON.parse(socket.sent[0])).toMatchObject({ type: 'ready', scope: 'global' });
    expect(wsClients.has(socket)).toBe(true);

    hub.injectEvent({ payload: { id: 'evt-1', type: 'session.updated', properties: {} }, directory: 'global' });
    expect(socket.sent.some((frame) => frame.includes('evt-1'))).toBe(true);

    socket.emit('close');
    expect(wsClients.has(socket)).toBe(false);
  });

  it('treats a directory websocket connection as the same global stream', () => {
    const { wsClients, runtime } = makeRuntime();

    const socket = fakeSocket();
    runtime.wsServer.emit('connection', socket, { url: '/api/event/ws?directory=%2Fproj' });
    expect(JSON.parse(socket.sent[0])).toMatchObject({ type: 'ready', scope: 'global' });
    expect(wsClients.has(socket)).toBe(true);
  });

  it('ignores upgrades on paths it does not serve', () => {
    const { server, runtime } = makeRuntime();
    const socket = { destroy: vi.fn() };
    const handleUpgrade = vi.spyOn(runtime.wsServer, 'handleUpgrade');
    server.emit('upgrade', { url: '/api/other' }, socket, Buffer.alloc(0));
    expect(handleUpgrade).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
  });
});
