/**
 * OMP tool approvals, surfaced as canonical permissions.
 *
 * OMP gates tools by asking the host through `extension_ui_request` frames
 * (`confirm`, `select`, `input`, `editor`) and waits for an
 * `extension_ui_response` on stdin. The UI knows permissions, not extension-UI
 * frames, so each ask is mapped to a `permission.asked` event and each answer
 * back to the response frame the RPC server is waiting for.
 *
 * Mapping (kept here so the shape conversion has one home):
 * - `confirm` -> `{ action: "tool", resources: [message ?? title], message: title }`;
 *   `once`/`always` -> `{ confirmed: true }`, `reject` -> `{ confirmed: false }`.
 * - `select` -> `{ action: "select", resources: options }`;
 *   `once` -> `{ value }` (the UI sends one), `reject` -> `{ cancelled: true }`.
 * - `input`/`editor` -> `{ action: "input", resources: [] }`;
 *   `once` -> `{ value }`, `reject` -> `{ cancelled: true }`.
 *
 * Frames with any other method (`notify`, `setStatus`, `setTitle`, `open_url`,
 * `cancel`, …) are not questions and are left alone.
 */

const ASKABLE_METHODS = new Set(['confirm', 'select', 'input', 'editor'])

const toPermissionRequest = (sessionId, frame) => {
  if (frame.method === 'confirm') {
    const resource = typeof frame.message === 'string' && frame.message ? frame.message : frame.title
    return { id: frame.id, sessionID: sessionId, action: 'tool', resources: [resource], message: frame.title }
  }
  if (frame.method === 'select') {
    return {
      id: frame.id,
      sessionID: sessionId,
      action: 'select',
      resources: Array.isArray(frame.options) ? frame.options : [],
      message: frame.title,
    }
  }
  return { id: frame.id, sessionID: sessionId, action: 'input', resources: [], message: frame.title }
}

const toResponse = (frame, reply, value) => {
  if (frame.method === 'confirm') {
    return { type: 'extension_ui_response', id: frame.id, confirmed: reply !== 'reject' }
  }
  if (reply === 'reject') {
    return { type: 'extension_ui_response', id: frame.id, cancelled: true }
  }
  const fallback = frame.method === 'select' && Array.isArray(frame.options) ? frame.options[0] ?? '' : ''
  return { type: 'extension_ui_response', id: frame.id, value: value ?? fallback }
}

export function createOmpApprovals({ broadcast }) {
  const pending = new Map();

  return {
    /** Records an ask and broadcasts it. Returns true when the frame was a question. */
    handleRequest(sessionId, frame) {
      if (!frame || frame.type !== 'extension_ui_request' || !ASKABLE_METHODS.has(frame.method)) return false;
      let byId = pending.get(sessionId);
      if (!byId) {
        byId = new Map();
        pending.set(sessionId, byId);
      }
      byId.set(frame.id, frame);
      broadcast({
        type: 'openchamber:omp',
        properties: { sessionID: sessionId, events: [{ type: 'permission.asked', properties: toPermissionRequest(sessionId, frame) }] },
      });
      return true;
    },

    /** The response frame for an answered ask, or null when it was never asked. */
    resolve(sessionId, requestId, reply, value) {
      const byId = pending.get(sessionId);
      const frame = byId?.get(requestId);
      if (!byId || !frame) return null;
      byId.delete(requestId);
      if (byId.size === 0) pending.delete(sessionId);
      broadcast({
        type: 'openchamber:omp',
        properties: { sessionID: sessionId, events: [{ type: 'permission.replied', properties: { sessionID: sessionId, requestID: requestId } }] },
      });
      return toResponse(frame, reply, value);
    },

    /** The still-open asks for a session, in the UI's permission shape. */
    pending(sessionId) {
      const byId = pending.get(sessionId);
      return byId ? [...byId.values()].map((frame) => toPermissionRequest(sessionId, frame)) : [];
    },

    /** Drops a session's asks when the session is deleted or the host is disposed. */
    forget(sessionId) {
      pending.delete(sessionId);
    },
  };
}
