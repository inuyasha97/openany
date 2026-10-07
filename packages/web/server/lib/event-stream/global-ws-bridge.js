import { sendMessageStreamWsEvent, sendMessageStreamWsFrame, sendSerializedMessageStreamWsFrame, serializeMessageStreamWsEvent } from './protocol.js';

/**
 * The browser stream bridge: it fans the hub's events out to the connected
 * `/api/global/event/ws` sockets and answers each new one with a `ready`
 * frame plus whatever the replay log still holds. There is no upstream
 * connection to wait for any more — the hub is fed by the runtime host — so a
 * client is ready the moment it is accepted, and the frames the broadcaster
 * writes to `wsClients` reach it.
 */
export function createGlobalMessageStreamWsBridge({
  globalHub,
  wsClients,
  processForwardedEventPayload,
  heartbeatIntervalMs,
}) {
  const clients = new Set();
  const clientLastEventIds = new Map();
  const readyClients = new Set();

  const removeClient = (socket) => {
    clients.delete(socket);
    clientLastEventIds.delete(socket);
    readyClients.delete(socket);
    wsClients.delete(socket);
  };

  const replayEvents = (socket, entries) => {
    for (const entry of entries) {
      const sent = sendSerializedMessageStreamWsFrame(socket, entry.serializedFrame);
      if (!sent) {
        removeClient(socket);
        return;
      }
    }
  };

  const markReady = (socket, requestedLastEventId) => {
    if (socket.readyState !== 1) {
      return;
    }

    globalHub.flushPending();
    const replay = globalHub.replayAfter(requestedLastEventId);
    const ready = { type: 'ready', scope: 'global' };
    if (replay === null) ready.replayReset = true;
    const sent = sendMessageStreamWsFrame(socket, ready);
    if (!sent) {
      removeClient(socket);
      return;
    }

    readyClients.add(socket);
    wsClients.add(socket);
    if (replay !== null) replayEvents(socket, replay);
  };

  // Browser clients take the events of isolated spaces too: each frame carries its directory,
  // and a space's directory is one more project directory to the UI.
  const unsubscribeEvent = globalHub.subscribeEvent((event) => {
    const { payload } = event;
    for (const socket of Array.from(clients)) {
      if (!readyClients.has(socket)) {
        continue;
      }
      const sent = sendSerializedMessageStreamWsFrame(socket, event.serialize());
      if (!sent) {
        removeClient(socket);
      }
    }

    processForwardedEventPayload(payload, (syntheticPayload) => {
      if (readyClients.size === 0) return;
      const serializedFrame = serializeMessageStreamWsEvent(syntheticPayload, { directory: 'global' });
      for (const socket of Array.from(clients)) {
        if (!readyClients.has(socket)) {
          continue;
        }
        const sent = sendSerializedMessageStreamWsFrame(socket, serializedFrame);
        if (!sent) {
          removeClient(socket);
        }
      }
    });
  }, { spaces: true });

  const accept = (socket, { requestedLastEventId = '' } = {}) => {
    const pingInterval = setInterval(() => {
      if (socket.readyState !== 1) {
        return;
      }

      try {
        socket.ping();
      } catch {
      }
    }, heartbeatIntervalMs);

    const heartbeatInterval = setInterval(() => {
      sendMessageStreamWsEvent(socket, { type: 'openchamber:heartbeat', timestamp: Date.now() }, { directory: 'global' });
    }, heartbeatIntervalMs);

    socket.on('close', () => {
      clearInterval(pingInterval);
      clearInterval(heartbeatInterval);
      removeClient(socket);
    });

    socket.on('error', () => {
      void 0;
    });

    clients.add(socket);
    clientLastEventIds.set(socket, requestedLastEventId);
    markReady(socket, requestedLastEventId);
  };

  const close = () => {
    unsubscribeEvent();
    for (const socket of Array.from(clients)) {
      removeClient(socket);
    }
  };

  return {
    accept,
    close,
  };
}
