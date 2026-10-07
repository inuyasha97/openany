/**
 * OpenChamber per-session metadata.
 *
 * Goal mode, session assist, obligatory context re-injection and pinned
 * notes/plans keep their per-session state under the `openchamber` namespace of
 * a session's metadata. The agent runtime does not hold it: OMP persists a
 * session as a JSONL transcript (its messages and a title) and its RPC surface
 * has no metadata route, so the state is OpenChamber's own — one JSON file per
 * data dir, `{ [sessionID]: metadata }` in `sessions-metadata.json`, beside the
 * runtime it describes — and the proxy folds it back onto the session records
 * it serves.
 *
 * The file has been through the other direction too: it started as the store
 * itself, and once OpenCode grew a session metadata route the record became the
 * authority and a pushed entry left the file. That route is gone with OpenCode,
 * so the file is the authority again and `listUnmigrated()` — the proxy's
 * overlay source — serves every entry it holds.
 *
 * Writers send a JSON Merge Patch (RFC 7386): nested objects merge key by key
 * and a `null` deletes. The store reads the record, merges, and writes the
 * whole result back, one write per session at a time, so goal mode saving
 * progress cannot drop an assist recap that was written a moment earlier.
 */

import fsDefault from 'node:fs';
import pathDefault from 'node:path';

const METADATA_FILE_NAME = 'sessions-metadata.json';

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * RFC 7386 merge. Returns a new object; `null` in the patch removes the key,
 * and a non-object patch value replaces whatever was there.
 */
export const mergeMetadataPatch = (current, patch) => {
  const base = isPlainObject(current) ? { ...current } : {};
  if (!isPlainObject(patch)) return base;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete base[key];
      continue;
    }
    base[key] = isPlainObject(value) ? mergeMetadataPatch(base[key], value) : value;
  }
  return base;
};

/**
 * @param {object} options
 * @param {string} options.dataDir OpenChamber data directory; holds the metadata file.
 * @param {typeof fsDefault.promises} [options.fsPromises]
 * @param {typeof pathDefault} [options.path]
 * @param {() => number} [options.now]
 */
export const createSessionMetadataStore = ({
  dataDir,
  fsPromises = fsDefault.promises,
  path = pathDefault,
  now = Date.now,
}) => {
  const filePath = path.join(dataDir, METADATA_FILE_NAME);

  /** sessionID → metadata, as the file held them. */
  const entries = new Map();
  let loadPromise = null;

  const parseFile = (raw) => {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) throw new Error('session metadata file is not a JSON object');
    const result = new Map();
    for (const [sessionID, value] of Object.entries(parsed)) {
      const id = asNonEmptyString(sessionID);
      if (id && isPlainObject(value)) result.set(id, value);
    }
    return result;
  };

  /**
   * Resolves once the file has been read. A read failure rejects and lets the
   * next call retry: writing over a file we could not read would drop exactly
   * the state we are protecting.
   */
  const load = () => {
    if (!loadPromise) {
      loadPromise = (async () => {
        let raw;
        try {
          raw = await fsPromises.readFile(filePath, 'utf8');
        } catch (error) {
          if (error?.code === 'ENOENT') return;
          throw new Error(`session metadata is unavailable: ${error?.message ?? error}`);
        }
        try {
          for (const [id, metadata] of parseFile(raw)) entries.set(id, metadata);
        } catch (error) {
          // Unreadable bytes are kept for the user; there is nothing to read.
          const backup = `${filePath}.corrupt-${now()}`;
          await fsPromises.rename(filePath, backup).catch(() => undefined);
          console.warn(`[openchamber-sessions] session metadata was unreadable and was moved to ${backup}: ${error?.message ?? error}`);
        }
      })().catch((error) => {
        loadPromise = null;
        throw error;
      });
    }
    return loadPromise;
  };

  /** File rewrites, one at a time so an older snapshot never lands last. */
  let fileChain = Promise.resolve();
  const runFileWrite = (work) => {
    const next = fileChain.then(work, work);
    fileChain = next.then(() => undefined, () => undefined);
    return next;
  };

  /**
   * Writes the whole record set. The snapshot is taken inside the chained work,
   * so a write already queued is not overtaken by one that started later.
   */
  const persist = () => runFileWrite(async () => {
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    await fsPromises.writeFile(tmpPath, JSON.stringify(Object.fromEntries(entries)), 'utf8');
    await fsPromises.rename(tmpPath, filePath);
  });

  /**
   * One chain per session: read, merge and write cannot interleave with another
   * write to the same session. Different sessions proceed in parallel.
   */
  const sessionChains = new Map();
  const runForSession = (id, work) => {
    const previous = sessionChains.get(id) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.then(() => undefined, () => undefined);
    sessionChains.set(id, settled);
    void settled.then(() => {
      if (sessionChains.get(id) === settled) sessionChains.delete(id);
    });
    return next;
  };

  /**
   * The session's full metadata, `{}` for a session the store does not hold.
   * Throws when the file could not be read.
   */
  const get = async (sessionID) => {
    const id = asNonEmptyString(sessionID);
    if (!id) return {};
    await load();
    return entries.get(id) ?? {};
  };

  /**
   * Applies a merge patch and returns the full metadata afterwards. Nothing is
   * written when the current record cannot be read, so a patch never replaces
   * fields it could not see.
   */
  const setSessionMetadata = async (sessionID, patch) => {
    const id = asNonEmptyString(sessionID);
    if (!id) throw new Error('a session id is required to store session metadata');
    if (!isPlainObject(patch)) throw new Error('a session metadata patch must be an object');
    await load();

    return runForSession(id, async () => {
      const previous = entries.get(id);
      const merged = mergeMetadataPatch(previous, patch);
      entries.set(id, merged);
      try {
        await persist();
      } catch (error) {
        // The write did not land: keep the value the file still holds.
        if (previous === undefined) entries.delete(id);
        else entries.set(id, previous);
        throw error;
      }
      return merged;
    });
  };

  /**
   * Like `setSessionMetadata`, but the patch is decided from the record as it
   * is when this session's turn in the write queue comes: `decide(current)`
   * returns a merge patch, or null to leave the record alone. A writer whose
   * change depends on the current value (open only when not closed after the
   * request) cannot be overtaken between its read and its write this way.
   * Resolves `{ metadata, changed }`.
   */
  const updateSessionMetadata = async (sessionID, decide, { directory = '' } = {}) => {
    void directory;
    const id = asNonEmptyString(sessionID);
    if (!id) throw new Error('a session id is required to store session metadata');
    await load();

    return runForSession(id, async () => {
      const current = entries.get(id) ?? {};
      const patch = decide(current);
      if (!isPlainObject(patch)) return { metadata: current, changed: false };
      const previous = entries.get(id);
      const merged = mergeMetadataPatch(current, patch);
      entries.set(id, merged);
      try {
        await persist();
      } catch (error) {
        // The write did not land: keep the value the file still holds.
        if (previous === undefined) entries.delete(id);
        else entries.set(id, previous);
        throw error;
      }
      return { metadata: merged, changed: true };
    });
  };

  /**
   * Nothing to migrate: the file is the store, so there is no runtime record to
   * push entries into. Kept because the startup path awaits it — it reads the
   * file once and reports the number of entries still waiting (always 0).
   */
  const migrateLegacy = async () => {
    await load();
    return 0;
  };

  /**
   * `{ [sessionID]: metadata }` for every entry the store holds. The proxy lays
   * these over the session records it serves; the name is the one the proxy's
   * wiring calls, from when an entry left the file once the runtime had taken it.
   */
  const listUnmigrated = async () => {
    await load();
    return Object.fromEntries(entries);
  };

  return {
    get,
    setSessionMetadata,
    updateSessionMetadata,
    migrateLegacy,
    listUnmigrated,
    filePath,
  };
};
