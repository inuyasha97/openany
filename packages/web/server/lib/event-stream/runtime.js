import { WebSocketServer } from 'ws';

import { parseRequestPathname } from '../terminal/terminal-ws-protocol.js';
import {
  MESSAGE_STREAM_DIRECTORY_WS_PATH,
  MESSAGE_STREAM_GLOBAL_WS_PATH,
  MESSAGE_STREAM_WS_HEARTBEAT_INTERVAL_MS,
  serializeMessageStreamWsEvent,
  sendSerializedMessageStreamWsFrame,
} from './protocol.js';
import { createGlobalMessageStreamHub } from './global-hub.js';
import { createGlobalMessageStreamWsBridge } from './global-ws-bridge.js';

export function createGlobalUiEventBroadcaster({
  sseClients,
  wsClients,
  writeSseEvent,
}) {
  return (payload, options = {}) => {
    const hasSseClients = sseClients.size > 0;
    const hasWsClients = wsClients.size > 0;
    if (!hasSseClients && !hasWsClients) {
      return;
    }

    if (hasSseClients) {
      const serializedPayload = JSON.stringify(payload);
      for (const res of sseClients) {
        try {
          writeSseEvent(res, payload, serializedPayload);
        } catch {
        }
      }
    }

    if (hasWsClients) {
      const serializedFrame = serializeMessageStreamWsEvent(payload, {
        directory: typeof options.directory === 'string' && options.directory.length > 0 ? options.directory : 'global',
        eventId: typeof options.eventId === 'string' && options.eventId.length > 0 ? options.eventId : undefined,
      });
      for (const socket of Array.from(wsClients)) {
        const sent = sendSerializedMessageStreamWsFrame(socket, serializedFrame);
        if (!sent) {
          wsClients.delete(socket);
        }
      }
    }
  };
}

/**
 * The WS surface of the shared event hub: `/api/global/event/ws` and
 * `/api/event/ws` both join the same bridge and receive the same frames.
 * There is no per-directory upstream reader any more; the runtime host is the
 * only producer and its frames carry their own directory.
 */
export function createMessageStreamWsRuntime({
  server,
  uiAuthController,
  isRequestOriginAllowed,
  rejectWebSocketUpgrade,
  processForwardedEventPayload,
  wsClients,
  heartbeatIntervalMs = MESSAGE_STREAM_WS_HEARTBEAT_INTERVAL_MS,
  globalEventHub = null,
}) {
  const wsServer = new WebSocketServer({
    noServer: true,
  });

  const globalHub = globalEventHub ?? createGlobalMessageStreamHub();
  const globalBridge = createGlobalMessageStreamWsBridge({
    globalHub,
    wsClients,
    processForwardedEventPayload,
    heartbeatIntervalMs,
  });

  wsServer.on('connection', (socket, req) => {
    const rawUrl = typeof req?.url === 'string' ? req.url : MESSAGE_STREAM_GLOBAL_WS_PATH;
    const requestUrl = new URL(rawUrl, 'http://127.0.0.1');
    const requestedLastEventId = requestUrl.searchParams.get('lastEventId')?.trim() || '';
    globalBridge.accept(socket, { requestedLastEventId });
  });

  const upgradeHandler = (req, socket, head) => {
    const pathname = parseRequestPathname(req.url);
    if (pathname !== MESSAGE_STREAM_GLOBAL_WS_PATH && pathname !== MESSAGE_STREAM_DIRECTORY_WS_PATH) {
      return;
    }

    const handleUpgrade = async () => {
      try {
        if (uiAuthController?.enabled) {
          const sessionToken = await uiAuthController?.ensureSessionToken?.(req, null);
          if (!sessionToken) {
            rejectWebSocketUpgrade(socket, 401, 'UI authentication required');
            return;
          }

          const originAllowed = await isRequestOriginAllowed(req);
          if (!originAllowed) {
            rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
            return;
          }
        }

        wsServer.handleUpgrade(req, socket, head, (ws) => {
          wsServer.emit('connection', ws, req);
        });
      } catch {
        rejectWebSocketUpgrade(socket, 500, 'Upgrade failed');
      }
    };

    void handleUpgrade();
  };

  server.on('upgrade', upgradeHandler);

  return {
    wsServer,
    async close() {
      server.off('upgrade', upgradeHandler);
      globalBridge.close();

      try {
        for (const client of wsServer.clients) {
          try {
            client.terminate();
          } catch {
          }
        }

        await new Promise((resolve) => {
          wsServer.close(() => resolve());
        });
      } catch {
      } finally {
        wsClients.clear();
      }
    },
  };
}
