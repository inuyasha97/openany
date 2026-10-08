/**
 * OMP tool approvals and the agent's own questions.
 *
 * OMP asks the host through `extension_ui_request` frames (`confirm`, `select`,
 * `input`, `editor`) and waits for an `extension_ui_response` on stdin. The UI
 * knows two surfaces, not extension-UI frames, so each ask is projected by
 * method and each answer mapped back to the frame the RPC server waits for:
 *
 * - `confirm` is a tool approval -> `permission.asked`; `once`/`always` answer
 *   `{ confirmed: true }`, `reject` answers `{ confirmed: false }`.
 * - `input` is a manual text prompt (OMP's OAuth code prompt, extension hooks)
 *   -> `permission.asked` with `action: "input"`; `once` answers `{ value }`,
 *   `reject` answers `{ cancelled: true }`.
 * - `select` and `editor` are the model asking the user a question (the `ask`
 *   tool). They are projected as a canonical `FormInfo` with one field: a
 *   string field carrying the frame's options for `select`, a free-text string
 *   field for `editor`. The reply (`{ value }`) and the cancellation
 *   (`{ cancelled: true }`) answer the original frame.
 * - `cancel` names a still-pending ask in `targetId`; OMP has given up on it,
 *   so the pending entry is dropped and the UI is told it settled.
 * - a frame carrying `timeout` is dropped (and settled) after that many
 *   milliseconds: OMP resolves the ask on its own clock, and a stale entry
 *   would keep `GET .../forms` advertising a question nobody can answer.
 *
 * A `select` frame carries no multi-select signal — the checkbox markers the
 * TUI uses never reach the host — so every frame answers with one value; a
 * multi-question `ask` arrives as one frame per question.
 *
 * Frames with any other method (`notify`, `setStatus`, `setTitle`, `open_url`,
 * `setWidget`, …) are not questions and are left alone.
 */

const ASKABLE_METHODS = new Set(['confirm', 'select', 'input', 'editor'])

/** Methods that are the model asking a question (a form), not a tool approval. */
const FORM_METHODS = new Set(['select', 'editor'])

/** The one field key a projected form carries; the reply reads it back. */
const OMP_FORM_FIELD_KEY = 'value'

const isFormMethod = (method) => FORM_METHODS.has(method)

/** The `FormInfo` field for one OMP question frame. */
const toFormField = (frame) => {
  if (frame.method === 'editor') {
    return {
      key: OMP_FORM_FIELD_KEY,
      type: 'string',
      title: frame.title,
      ...(typeof frame.prefill === 'string' && frame.prefill ? { default: frame.prefill } : {}),
    }
  }
  const options = Array.isArray(frame.options) ? frame.options : []
  const details = Array.isArray(frame.optionDetails) ? frame.optionDetails : []
  return {
    key: OMP_FORM_FIELD_KEY,
    type: 'string',
    title: frame.title,
    options: options.map((option, index) => {
      const description = details[index]?.description
      return { value: option, label: option, ...(description ? { description } : {}) }
    }),
  }
}

const toFormRequest = (sessionId, frame) => ({
  id: frame.id,
  sessionID: sessionId,
  title: typeof frame.title === 'string' ? frame.title : '',
  fields: [toFormField(frame)],
})

/** The `PermissionRequest` for an approval frame (`confirm`/`input`). */
const toPermissionRequest = (sessionId, frame) => {
  if (frame.method === 'confirm') {
    const resource = typeof frame.message === 'string' && frame.message ? frame.message : frame.title
    return { id: frame.id, sessionID: sessionId, action: 'tool', resources: [resource], message: frame.title }
  }
  return { id: frame.id, sessionID: sessionId, action: 'input', resources: [], message: frame.title }
}

/** The response frame an answered approval sends back to OMP. */
const toPermissionResponse = (frame, reply, value) => {
  if (frame.method === 'confirm') {
    return { type: 'extension_ui_response', id: frame.id, confirmed: reply !== 'reject' }
  }
  if (reply === 'reject') {
    return { type: 'extension_ui_response', id: frame.id, cancelled: true }
  }
  return { type: 'extension_ui_response', id: frame.id, value: value ?? '' }
}

export function createOmpApprovals({ broadcast }) {
  /** sessionId -> (requestId -> { frame, timer }). */
  const pending = new Map();

  /** The recorded frame for an ask, without consuming it. */
  const peek = (sessionId, requestId) => pending.get(sessionId)?.get(requestId)?.frame ?? null;

  /** Removes a pending entry (and its timeout). Returns the frame, or null. */
  const take = (sessionId, requestId) => {
    const byId = pending.get(sessionId);
    if (!byId) return null;
    const entry = byId.get(requestId);
    if (!entry) return null;
    byId.delete(requestId);
    if (byId.size === 0) pending.delete(sessionId);
    if (entry.timer) clearTimeout(entry.timer);
    return entry.frame;
  };

  /** Tells the UI an ask is gone, on the surface that raised it. */
  const settle = (sessionId, frame) => {
    const event = isFormMethod(frame.method)
      ? { type: 'form.settled', properties: { sessionID: sessionId, formID: frame.id } }
      : { type: 'permission.replied', properties: { sessionID: sessionId, requestID: frame.id } };
    broadcast({
      type: 'openchamber:omp',
      properties: { sessionID: sessionId, events: [event] },
    });
  };

  const record = (sessionId, frame) => {
    let byId = pending.get(sessionId);
    if (!byId) {
      byId = new Map();
      pending.set(sessionId, byId);
    }
    // OMP ids are unique, but a repeat must not leak the earlier timeout.
    const previous = byId.get(frame.id);
    if (previous?.timer) clearTimeout(previous.timer);
    const timeout = Number.isFinite(frame.timeout) && frame.timeout > 0 ? frame.timeout : null;
    const timer = timeout === null ? null : setTimeout(() => {
      // OMP resolved this ask on its own clock; drop the ghost and tell the UI.
      const timedOut = take(sessionId, frame.id);
      if (timedOut) settle(sessionId, timedOut);
    }, timeout);
    timer?.unref?.();
    byId.set(frame.id, { frame, timer });
  };

  const handleCancel = (sessionId, frame) => {
    if (typeof frame.targetId !== 'string' || !frame.targetId) return false;
    const cancelled = take(sessionId, frame.targetId);
    if (cancelled) settle(sessionId, cancelled);
    // A cancel for an ask we never recorded still belongs to us.
    return true;
  };

  return {
    /** Records an ask and broadcasts it. Returns true when the frame was a question. */
    handleRequest(sessionId, frame) {
      if (!frame || frame.type !== 'extension_ui_request') return false;
      if (frame.method === 'cancel') return handleCancel(sessionId, frame);
      if (!ASKABLE_METHODS.has(frame.method)) return false;

      record(sessionId, frame);
      const event = isFormMethod(frame.method)
        ? { type: 'form.created', properties: { form: toFormRequest(sessionId, frame) } }
        : { type: 'permission.asked', properties: toPermissionRequest(sessionId, frame) };
      broadcast({
        type: 'openchamber:omp',
        properties: { sessionID: sessionId, events: [event] },
      });
      return true;
    },

    /**
     * The response frame for an answered approval (`confirm`/`input`), or null
     * when it was never asked or is a form.
     */
    resolve(sessionId, requestId, reply, value) {
      const existing = peek(sessionId, requestId);
      if (!existing || isFormMethod(existing.method)) return null;
      const frame = take(sessionId, requestId);
      if (!frame) return null;
      settle(sessionId, frame);
      return toPermissionResponse(frame, reply, value);
    },

    /**
     * The response frame for an answered question (`select`/`editor`), or null
     * when it was never asked or is an approval.
     */
    resolveForm(sessionId, requestId, value) {
      const existing = peek(sessionId, requestId);
      if (!existing || !isFormMethod(existing.method)) return null;
      const frame = take(sessionId, requestId);
      if (!frame) return null;
      settle(sessionId, frame);
      return { type: 'extension_ui_response', id: frame.id, value };
    },

    /** The response frame that declines a question, or null when unknown. */
    cancelForm(sessionId, requestId) {
      const existing = peek(sessionId, requestId);
      if (!existing || !isFormMethod(existing.method)) return null;
      const frame = take(sessionId, requestId);
      if (!frame) return null;
      settle(sessionId, frame);
      return { type: 'extension_ui_response', id: frame.id, cancelled: true };
    },

    /** The still-open approvals for a session, in the UI's permission shape. */
    pending(sessionId) {
      const byId = pending.get(sessionId);
      if (!byId) return [];
      return [...byId.values()]
        .filter(({ frame }) => !isFormMethod(frame.method))
        .map(({ frame }) => toPermissionRequest(sessionId, frame));
    },

    /** The still-open questions for a session, in the canonical form shape. */
    forms(sessionId) {
      const byId = pending.get(sessionId);
      if (!byId) return [];
      return [...byId.values()]
        .filter(({ frame }) => isFormMethod(frame.method))
        .map(({ frame }) => toFormRequest(sessionId, frame));
    },

    /** Drops a session's asks (and their timeouts) when the session goes away. */
    forget(sessionId) {
      const byId = pending.get(sessionId);
      if (byId) {
        for (const entry of byId.values()) {
          if (entry.timer) clearTimeout(entry.timer);
        }
      }
      pending.delete(sessionId);
    },
  };
}
