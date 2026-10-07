import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionMetadataStore, mergeMetadataPatch } from './session-metadata-store.js';

const tempDirs = [];

const makeDataDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-metadata-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('mergeMetadataPatch', () => {
  it('merges nested objects key by key instead of replacing them', () => {
    const current = { openchamber: { goal: { id: 'g1', status: 'active' }, assist: { recap: 'r' } } };
    const merged = mergeMetadataPatch(current, { openchamber: { goal: { status: 'complete' } } });

    expect(merged).toEqual({
      openchamber: { goal: { id: 'g1', status: 'complete' }, assist: { recap: 'r' } },
    });
    // The input is untouched: callers keep whatever they already held.
    expect(current.openchamber.goal.status).toBe('active');
  });

  it('deletes a key when its patch value is null', () => {
    expect(mergeMetadataPatch({ a: 1, b: 2 }, { b: null })).toEqual({ a: 1 });
    expect(mergeMetadataPatch({ openchamber: { goal: {}, assist: {} } }, { openchamber: { assist: null } }))
      .toEqual({ openchamber: { goal: {} } });
  });

  it('replaces arrays and scalars rather than merging into them', () => {
    expect(mergeMetadataPatch({ pins: ['a', 'b'] }, { pins: ['c'] })).toEqual({ pins: ['c'] });
    expect(mergeMetadataPatch({ a: { nested: true } }, { a: 'flat' })).toEqual({ a: 'flat' });
  });

  it('treats a missing or non-object base as empty', () => {
    expect(mergeMetadataPatch(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(mergeMetadataPatch('nope', { a: 1 })).toEqual({ a: 1 });
    expect(mergeMetadataPatch({ a: 1 }, 'nope')).toEqual({ a: 1 });
  });
});

const metadataFile = (dataDir) => path.join(dataDir, 'sessions-metadata.json');
const writeMetadataFile = (dataDir, content) => {
  fs.writeFileSync(metadataFile(dataDir), typeof content === 'string' ? content : JSON.stringify(content));
};
const readMetadataFile = (dataDir) => JSON.parse(fs.readFileSync(metadataFile(dataDir), 'utf8'));

describe('createSessionMetadataStore', () => {
  it('stores metadata in the data dir and reads back what it wrote, per session', async () => {
    const dataDir = makeDataDir();
    const store = createSessionMetadataStore({ dataDir });

    await expect(store.get('ses_1')).resolves.toEqual({});
    await store.setSessionMetadata('ses_1', { openchamber: { goal: { id: 'g1' } } });

    expect(readMetadataFile(dataDir)).toEqual({ ses_1: { openchamber: { goal: { id: 'g1' } } } });
    await expect(store.get('ses_1')).resolves.toEqual({ openchamber: { goal: { id: 'g1' } } });
    await expect(store.get('ses_2')).resolves.toEqual({});
  });

  it('reads the file it is pointed at, so a fresh store sees what the last one wrote', async () => {
    const dataDir = makeDataDir();
    writeMetadataFile(dataDir, { ses_1: { openchamber: { kind: 'review' } } });

    await expect(createSessionMetadataStore({ dataDir }).get('ses_1'))
      .resolves.toEqual({ openchamber: { kind: 'review' } });
  });

  it('merges a patch onto the stored record and writes the whole result back', async () => {
    const dataDir = makeDataDir();
    writeMetadataFile(dataDir, { ses_1: { openchamber: { kind: 'review', assist: { recap: 'r' } } } });
    const store = createSessionMetadataStore({ dataDir });

    const merged = await store.setSessionMetadata('ses_1', { openchamber: { goal: { status: 'active' } } });

    expect(merged).toEqual({ openchamber: { kind: 'review', assist: { recap: 'r' }, goal: { status: 'active' } } });
    expect(readMetadataFile(dataDir).ses_1).toEqual(merged);
    await store.setSessionMetadata('ses_1', { openchamber: { assist: null } });
    expect(readMetadataFile(dataDir).ses_1).toEqual({ openchamber: { kind: 'review', goal: { status: 'active' } } });
  });

  it('keeps both of two concurrent patches to the same session', async () => {
    const dataDir = makeDataDir();
    const store = createSessionMetadataStore({ dataDir });

    await Promise.all([
      store.setSessionMetadata('ses_1', { openchamber: { goal: { status: 'active' } } }),
      store.setSessionMetadata('ses_1', { openchamber: { assist: { recap: 'r' } } }),
    ]);

    expect(readMetadataFile(dataDir).ses_1).toEqual({
      openchamber: { goal: { status: 'active' }, assist: { recap: 'r' } },
    });
  });

  it('keeps concurrent writes to different sessions', async () => {
    const dataDir = makeDataDir();
    const store = createSessionMetadataStore({ dataDir });

    await Promise.all([
      store.setSessionMetadata('ses_1', { a: 1 }),
      store.setSessionMetadata('ses_2', { b: 2 }),
    ]);

    // Whichever write landed last, the file holds both.
    expect(readMetadataFile(dataDir)).toEqual({ ses_1: { a: 1 }, ses_2: { b: 2 } });
  });

  it('decides a conditional patch against the record as it is at write time', async () => {
    const dataDir = makeDataDir();
    writeMetadataFile(dataDir, { ses_1: { openchamber: { work: { state: 'open' } } } });
    const store = createSessionMetadataStore({ dataDir });
    const closeUnlessDone = (current) => (current.openchamber?.work?.state === 'done'
      ? null
      : { openchamber: { work: { state: 'done' } } });

    // Queued behind the first write, the second decision sees its result.
    const [first, second] = await Promise.all([
      store.updateSessionMetadata('ses_1', closeUnlessDone),
      store.updateSessionMetadata('ses_1', closeUnlessDone),
    ]);

    expect(first).toEqual({ metadata: { openchamber: { work: { state: 'done' } } }, changed: true });
    expect(second.changed).toBe(false);
  });

  it('rejects a missing id or a non-object patch without writing', async () => {
    const dataDir = makeDataDir();
    const store = createSessionMetadataStore({ dataDir });

    await expect(store.setSessionMetadata('', { a: 1 })).rejects.toThrow();
    await expect(store.setSessionMetadata('ses_1', ['a'])).rejects.toThrow();
    expect(fs.existsSync(metadataFile(dataDir))).toBe(false);
  });

  it('serves every entry it holds to the proxy overlay', async () => {
    const dataDir = makeDataDir();
    writeMetadataFile(dataDir, { ses_1: { a: 1 } });
    const store = createSessionMetadataStore({ dataDir });
    await store.setSessionMetadata('ses_2', { b: 2 });

    await expect(store.listUnmigrated()).resolves.toEqual({ ses_1: { a: 1 }, ses_2: { b: 2 } });
  });

  it('has nothing to migrate: the file is the store', async () => {
    const dataDir = makeDataDir();
    writeMetadataFile(dataDir, { ses_1: { a: 1 } });
    const store = createSessionMetadataStore({ dataDir });

    await expect(store.migrateLegacy()).resolves.toBe(0);
    expect(readMetadataFile(dataDir)).toEqual({ ses_1: { a: 1 } });
    await expect(store.get('ses_1')).resolves.toEqual({ a: 1 });
  });

  it('moves a malformed file aside and starts empty', async () => {
    const dataDir = makeDataDir();
    writeMetadataFile(dataDir, '{ not json');
    const store = createSessionMetadataStore({ dataDir });

    await expect(store.get('ses_1')).resolves.toEqual({});
    expect(fs.readdirSync(dataDir).some((name) => name.startsWith('sessions-metadata.json.corrupt-'))).toBe(true);
  });

  it('refuses to read or write while the file cannot be read, then recovers', async () => {
    const dataDir = makeDataDir();
    const readFile = vi.fn(async () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    const store = createSessionMetadataStore({
      dataDir,
      fsPromises: { ...fs.promises, readFile },
    });

    await expect(store.get('ses_1')).rejects.toThrow('permission denied');
    await expect(store.setSessionMetadata('ses_1', { a: 1 })).rejects.toThrow('permission denied');
    expect(fs.existsSync(metadataFile(dataDir))).toBe(false);

    readFile.mockImplementation(async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    await expect(store.setSessionMetadata('ses_1', { a: 1 })).resolves.toEqual({ a: 1 });
    await expect(store.get('ses_1')).resolves.toEqual({ a: 1 });
  });

  it('keeps the value the file holds when a write does not land', async () => {
    const dataDir = makeDataDir();
    writeMetadataFile(dataDir, { ses_1: { a: 1 } });
    let failWrites = true;
    const store = createSessionMetadataStore({
      dataDir,
      fsPromises: {
        ...fs.promises,
        writeFile: async (...args) => {
          if (failWrites) throw new Error('disk full');
          return fs.promises.writeFile(...args);
        },
      },
    });

    await expect(store.setSessionMetadata('ses_1', { b: 2 })).rejects.toThrow('disk full');
    // The in-memory record must not claim a value the file does not hold.
    await expect(store.get('ses_1')).resolves.toEqual({ a: 1 });

    failWrites = false;
    await expect(store.setSessionMetadata('ses_1', { b: 2 })).resolves.toEqual({ a: 1, b: 2 });
    expect(readMetadataFile(dataDir).ses_1).toEqual({ a: 1, b: 2 });
  });
});
