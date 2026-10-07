const TURN_LIMIT = 3;
const USER_CHAR_LIMIT = 8_000;
const ANSWER_CHAR_LIMIT = 16_000;

// Mirrors the persisted context contract owned by UI lib/messages/contextParts.ts.
// Read only the fields needed for model context; malformed attached text fails
// this generation instead of silently dropping the user's comment.
const QUOTE_FIELDS = new Map([
  ['code-comment', 'code'], ['file-quote', 'quote'], ['chat-quote', 'quote'],
  ['browser-annotation', 'prompt'], ['pr-comment', 'body'], ['pr-check', 'output'],
  ['terminal', 'output'],
]);
const LINK_KINDS = new Set(['github-issue', 'github-pr', 'linear-issue']);

export function excerpt(text, limit) {
  if (text.length <= limit) return text;
  const marker = '\n[Content omitted]\n';
  if (limit <= marker.length) return text.slice(0, Math.max(0, limit));
  const head = Math.ceil((limit - marker.length) / 2);
  const tail = limit - marker.length - head;
  return text.slice(0, head) + marker + (tail > 0 ? text.slice(-tail) : '');
}

/**
 * The message text a canonical record carries: its `text` parts, joined with a
 * blank line between them. Tool, reasoning, and file parts contribute nothing —
 * tool payloads never enter this view.
 */
function messageText(parts) {
  return (Array.isArray(parts) ? parts : [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n\n');
}

// `text` is the message's own text, read from its parts: a linked item carries
// no body of its own and passes that text through.
function attachedText(info, text) {
  const context = info?.metadata?.openchamberContext;
  if (QUOTE_FIELDS.has(context?.kind)) {
    const source = (context[QUOTE_FIELDS.get(context.kind)] ?? '').trim();
    const authored = (context.text ?? '').trim();
    const label = excerpt((context.fileLabel ?? context.label ?? context.pageUrl ?? context.terminalLabel ?? '').trim(), 300);
    const location = Number.isInteger(context.startLine) ? `, lines ${context.startLine}-${context.endLine ?? context.startLine}` : '';
    const quote = excerpt(source, 4_000).split('\n').map((line) => `> ${line}`).join('\n');
    return { text: `Attached ${context.kind}${label ? ` (${label}${location})` : ''}:\n${quote}\n\nUser comment:\n${excerpt(authored, USER_CHAR_LIMIT)}`, authored };
  }
  if (LINK_KINDS.has(context?.kind)) return { text: excerpt(text ?? '', USER_CHAR_LIMIT), authored: '' };
  const comment = info?.metadata?.opencodeComment;
  if (comment) {
    const authored = comment.comment.trim();
    const source = (comment.preview ?? '').trim();
    const label = excerpt((comment.path ?? '').trim(), 300);
    return { text: `Attached file context (${label}):\n${excerpt(source, 4_000)}\n\nUser comment:\n${excerpt(authored, USER_CHAR_LIMIT)}`, authored };
  }
  return null;
}

// Records that carry no conversation content: the switches the runtime may
// append around a turn, and the `idle` marker that closes it. They are
// invisible to turn boundaries and to "what is the newest message". An `idle`
// whose outcome is not `succeeded` is not transparent: it is the evidence that
// the turn failed or was interrupted.
const TRANSPARENT_ROLES = new Set(['agent-switched', 'model-switched', 'location-switched']);

function isTransparent(info) {
  if (info?.role === 'idle') return info.outcome === 'succeeded';
  return TRANSPARENT_ROLES.has(info?.role);
}

/**
 * The id of the newest canonical record that is conversation content, given a
 * page in its oldest-first order; null when the page holds only service
 * records. Both the assist reader and the pre-write re-check use it so they
 * agree on what "the last message" is.
 */
export function newestContentId(records) {
  const items = Array.isArray(records) ? records : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const info = items[index]?.info;
    if (!info?.id || isTransparent(info)) continue;
    return info.id;
  }
  return null;
}

/**
 * One canonical `{ info, parts }` record as this module reads it. Text lives in
 * the parts; a user message's attachments ride on `info.metadata`, and context
 * items the transport keeps as their own `synthetic` message are folded into
 * the user message that follows. Tool payloads never enter this view.
 */
function readMessage(record) {
  const info = record?.info ?? {};
  const parts = Array.isArray(record?.parts) ? record.parts : [];
  const role = info.role;
  const ownText = messageText(parts);
  const blocks = [];
  const authored = [];

  if (role === 'user') {
    const attached = attachedText(info, ownText);
    if (attached) {
      blocks.push(attached.text);
      authored.push(attached.authored);
    } else if (ownText) {
      blocks.push(ownText);
      // Legacy terminal selections are source material, not a language sample.
      authored.push(ownText.replace(/\n*<terminal_context>\n[\s\S]*?\n<\/terminal_context>\s*$/, ''));
    }
  } else if (role === 'assistant') {
    if (ownText) blocks.push(ownText);
  } else if (role === 'synthetic') {
    // Context the user attached to the message that follows: in v1 it was a
    // `synthetic` text part inside the user message, in v2 it is its own turn.
    const attached = attachedText(info, info.text ?? '');
    if (attached) {
      blocks.push(attached.text);
      authored.push(attached.authored);
    } else if (typeof info.text === 'string') {
      blocks.push(info.text);
    }
  }

  return {
    id: info.id,
    role,
    created: Number.isFinite(info.time?.created) ? info.time.created : null,
    transparent: isTransparent(info),
    // A turn is the run of records between one user message and the assistant
    // reply that follows it; only the assistant carries a model, which is what
    // `collectTurns` walks.
    providerID: role === 'assistant' ? info.providerID : undefined,
    modelID: role === 'assistant' ? info.modelID : undefined,
    complete: role === 'assistant'
      && info.finish === 'stop'
      && Boolean(info.time?.completed)
      && !info.error,
    text: excerpt(blocks.join('\n\n').trim(), role === 'user' ? USER_CHAR_LIMIT : ANSWER_CHAR_LIMIT),
    authored: excerpt(authored.filter(Boolean).join('\n\n').trim(), USER_CHAR_LIMIT),
  };
}

/**
 * A turn is one user message and the assistant reply that closes it. The
 * boundary is positional: everything between two user messages belongs to the
 * turn the earlier one opened.
 *
 * Synthetic messages are the context the user attached to the message they are
 * about to send — v1 carried them as parts of that user message — so they are
 * folded into the next user message instead of opening a turn of their own.
 */
function collectTurns(messages, limit = TURN_LIMIT) {
  const turns = [];
  let active = null;
  let attached = [];
  for (const message of messages) {
    if (message.transparent) continue;
    if (message.role === 'synthetic') {
      if (message.text) attached.push(message);
      continue;
    }
    if (message.role === 'user') {
      const text = [...attached.map((entry) => entry.text), message.text].filter(Boolean).join('\n\n');
      const authored = [...attached.map((entry) => entry.authored), message.authored].filter(Boolean).join('\n\n');
      attached = [];
      if (!text) continue;
      active = { user: { ...message, text, authored }, assistant: null, complete: false };
      turns.push(active);
      continue;
    }
    attached = [];
    if (!active || message.role !== 'assistant') continue;
    if (message.text) active.assistant = message;
    active.complete = message.complete && Boolean(message.text);
  }
  return turns.slice(-limit);
}

const settledTurns = (messages) => collectTurns(messages, Infinity)
  .filter((turn) => turn.complete)
  .slice(-TURN_LIMIT);

/**
 * The session's records as this module reads them, oldest first. The OMP
 * runtime serves the whole history in one page (`{ items }`), so a single read
 * covers every turn the callers below can need. `null` or an `items` that is
 * not an array is a failed read: it is thrown rather than read as "no history".
 */
async function readHistory({ readPage, signal }) {
  signal.throwIfAborted();
  const page = await readPage();
  signal.throwIfAborted();
  if (!Array.isArray(page?.items)) throw new Error('Session message page is unavailable');
  const seen = new Set();
  const messages = [];
  for (const record of page.items) {
    const id = record?.info?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    messages.push(readMessage(record));
  }
  return messages;
}

/**
 * The settled turns before a message that was just sent, oldest first: what a
 * classifier reads next to the new request. The newest records may already
 * hold that message (and nothing after it); a turn without a completed answer
 * is not settled and is left out. Failure is thrown; an empty list means the
 * session has no settled turn yet.
 */
export async function loadSettledTurns({ readPage, signal }) {
  return settledTurns(await readHistory({ readPage, signal }));
}

/** Failure is thrown; null means no eligible final answer within the history. */
export async function loadAssistContext({ readPage, signal }) {
  const messages = await readHistory({ readPage, signal });
  // The newest record that is conversation content: the runtime keeps no
  // service records, so it is normally the last one.
  const last = messages.findLast((message) => !message.transparent);
  if (!last || !last.complete || !last.text) return null;
  const turns = collectTurns(messages);
  if (!turns.at(-1)?.complete || turns.at(-1).assistant.id !== last.id) return null;
  return { turns, last };
}
