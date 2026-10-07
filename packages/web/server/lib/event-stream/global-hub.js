import { randomUUID } from 'node:crypto';

import { serializeMessageStreamWsEvent } from './protocol.js';
import { translateWireEvent } from './translate-v2.js';
import { createDeltaCoalescer, DELTA_COALESCE_WINDOW_MS } from './delta-coalescer.js';

// Raised from 512 → 2048 to improve recovery after brief disconnects during
// long-running agent sessions where many events accumulate quickly.
const MESSAGE_STREAM_GLOBAL_REPLAY_LIMIT = 2048;
const MESSAGE_STREAM_GLOBAL_REPLAY_BYTES = 8 * 1024 * 1024;

/**
 * The server's shared event hub: it coalesces, numbers, replays and fans out
 * the events the runtime pushes into it (`injectEvent`) to every server-side
 * subscriber and to the browser stream bridge. There is no upstream HTTP
 * reader any more — the OMP runtime host is the only producer.
 */
export function createGlobalMessageStreamHub({
  replayLimit = MESSAGE_STREAM_GLOBAL_REPLAY_LIMIT,
  replayByteLimit = MESSAGE_STREAM_GLOBAL_REPLAY_BYTES,
  deltaCoalesceWindowMs = DELTA_COALESCE_WINDOW_MS,
}) {
  if (!Number.isSafeInteger(replayLimit) || replayLimit < 0 || !Number.isSafeInteger(replayByteLimit) || replayByteLimit < 0) {
    throw new RangeError('Replay limits must be nonnegative safe integers');
  }
  const eventSubscribers = new Set();
  // The event subscribers that also take the events of isolated spaces.
  const spaceSubscribers = new Set();
  const replay = [];
  let replayBytes = 0;
  let latestEventId;
  // The replay log is this hub's own, so events that carry no id (projected
  // runtime events do not) are numbered here. The per-process prefix makes a
  // cursor from before a restart miss instead of matching an unrelated
  // sequence number, which reports `replayReset` and sends the client to
  // repair.
  const replayIdPrefix = `oc-${randomUUID().slice(0, 8)}-`;
  let replaySequence = 0;

  const notifySubscriber = (kind, subscriber, payload) => {
    try {
      const result = subscriber(payload);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => {
          console.warn(`Global message stream ${kind} subscriber failed:`, error);
        });
      }
    } catch (error) {
      console.warn(`Global message stream ${kind} subscriber failed:`, error);
    }
  };

  const normalizeEvent = ({ envelope, payload }) => {
    const directory =
      typeof envelope?.directory === 'string' && envelope.directory.length > 0 ? envelope.directory : 'global';
    const eventId = typeof envelope?.eventId === 'string' && envelope.eventId.length > 0
      ? envelope.eventId
      : `${replayIdPrefix}${String(++replaySequence).padStart(12, '0')}`;
    // An event of an isolated space carries the space's id; subscribers see it only when they
    // asked for space events, because a consumer that acts on the host's runtime by
    // directory must never act on a space's directory.
    const spaceId = typeof envelope?.spaceId === 'string' && envelope.spaceId.length > 0 ? envelope.spaceId : null;
    let serializedFrame;
    let translated;
    return {
      envelope,
      payload,
      directory,
      eventId,
      spaceId,
      serialize() {
        serializedFrame ??= serializeMessageStreamWsEvent(payload, { directory, eventId });
        return serializedFrame;
      },
      // Browser clients receive the raw wire payload and translate it
      // themselves; server-side subscribers read this instead. Translating
      // lazily keeps the cost off the WS fan-out path when nothing listens.
      translated() {
        translated ??= translateWireEvent(payload);
        return translated;
      },
    };
  };

  // Replay and fan-out see the same committed sequence: an event enters the
  // replay buffer in the same step that delivers it, so a client's cursor
  // always names a frame the buffer can find.
  const commitEvent = (event) => {
    const normalized = normalizeEvent(event);
    latestEventId = normalized.eventId;
    const serializedFrame = normalized.serialize();
    const bytes = Buffer.byteLength(serializedFrame);
    if (bytes > replayByteLimit) {
      // An oversized live event creates a hole: retain only a contiguous
      // suffix after it, never replay an older prefix across the gap.
      replay.length = 0;
      replayBytes = 0;
    } else {
      replay.push({ eventId: normalized.eventId, serializedFrame, bytes });
      replayBytes += bytes;
      while (replay.length > replayLimit || replayBytes > replayByteLimit) {
        replayBytes -= replay.shift().bytes;
      }
    }

    for (const subscriber of Array.from(eventSubscribers)) {
      if (normalized.spaceId !== null && !spaceSubscribers.has(subscriber)) continue;
      notifySubscriber('event', subscriber, normalized);
    }
  };

  const coalescer = createDeltaCoalescer({ emit: commitEvent, windowMs: deltaCoalesceWindowMs });

  return {
    /**
     * `spaces: true` also delivers the events of isolated spaces, which carry `spaceId`.
     * Without it a subscriber sees the host's events only, as every consumer did before spaces.
     */
    subscribeEvent(subscriber, { spaces = false } = {}) {
      eventSubscribers.add(subscriber);
      if (spaces) spaceSubscribers.add(subscriber);
      return () => {
        eventSubscribers.delete(subscriber);
        spaceSubscribers.delete(subscriber);
      };
    },
    /**
     * One event of an isolated space, from that space's own connection, entered here as if it
     * had arrived upstream: numbered, coalesced, replayed and fanned out with the host's, so
     * a client keeps one cursor for everything. `directory` is the space's, `spaceId` marks it.
     */
    injectEvent({ payload, directory, spaceId }) {
      coalescer.push({ envelope: { directory, spaceId }, payload });
    },
    // A client that becomes ready must not receive text from before it was
    // ready merged into its first live delta, so the bridge commits pending
    // deltas before it reads the replay tail.
    flushPending() {
      coalescer.flush();
    },
    replayAfter(eventId) {
      if (!eventId) {
        return [];
      }

      const index = replay.findIndex((entry) => entry.eventId === eventId);
      if (eventId === latestEventId) return [];
      return index === -1 ? null : replay.slice(index + 1);
    },
  };
}
