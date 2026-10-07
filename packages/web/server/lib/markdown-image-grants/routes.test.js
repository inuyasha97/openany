import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configureOmpRuntimeHost } from '../agents/omp-host-access.js';
import { registerMarkdownImageGrantRoutes } from './routes.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);
const roots = [];
const SESSION_ID = 'ses_1';
const MESSAGE_ID = 'msg_1';

afterEach(async () => {
  configureOmpRuntimeHost(null);
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const createFixture = async ({ sources, markdown } = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-session-assets-'));
  roots.push(root);
  const approvedTempRoot = path.join(root, 'opencode');
  const directory = path.join(root, 'workspace');
  await Promise.all([
    fs.mkdir(approvedTempRoot, { recursive: true }),
    fs.mkdir(directory, { recursive: true }),
  ]);
  const defaultPath = path.join(approvedTempRoot, 'image.png');
  await fs.writeFile(defaultPath, PNG);
  const requestedSources = sources ?? [new URL(`file://${defaultPath}`).toString()];
  const text = markdown ?? requestedSources.map((source) => `![image](${source})`).join('\n');

  // The canonical `{ info, parts }` page the OMP host serves.
  const items = [];
  const host = {
    listSessions: vi.fn(async () => [{ id: SESSION_ID, sessionPath: '/sessions/1.jsonl', cwd: directory, title: 'One' }]),
    getSessionStatus: vi.fn(async () => ({ busy: false })),
    getMessages: vi.fn(async () => ({ items, cursor: {} })),
  };
  configureOmpRuntimeHost(() => host);
  const setMessageText = (messageText, role = 'assistant') => {
    items.length = 0;
    items.push({
      info: { id: MESSAGE_ID, sessionID: SESSION_ID, role, time: { created: 1, completed: 2 } },
      parts: [{ type: 'text', text: messageText }],
    });
  };
  setMessageText(text);

  let fullReadCount = 0;
  const app = express();
  registerMarkdownImageGrantRoutes(app, {
    fsPromises: {
      ...fs,
      readFile: async (...args) => {
        fullReadCount += 1;
        return fs.readFile(...args);
      },
    },
    path,
    os,
    crypto,
    approvedTempRoot,
    validateDirectoryPath: async (candidate) => candidate === directory
      ? { ok: true, directory }
      : { ok: false, error: 'Invalid directory' },
  });
  return {
    app,
    approvedTempRoot,
    directory,
    host,
    setMessageText,
    fullReadCount: () => fullReadCount,
    root,
    sources: requestedSources,
  };
};

const prepare = (app, directory, sources) => request(app)
  .post(`/api/openchamber/sessions/${SESSION_ID}/markdown-image-grants`)
  .send({ directory, messageId: MESSAGE_ID, sources })
  .expect(200);

describe('session image assets', () => {
  it('reads the message from the session page', async () => {
    const fixture = await createFixture();
    await prepare(fixture.app, fixture.directory, ['image.png']);

    expect(fixture.host.getMessages).toHaveBeenCalledWith(SESSION_ID);
  });

  it('prepares workspace and approved temporary images with one message read', async () => {
    const fixture = await createFixture({ sources: ['workspace.png'] });
    await fs.writeFile(path.join(fixture.directory, 'workspace.png'), PNG);
    const temporaryPath = path.join(fixture.approvedTempRoot, 'temporary.png');
    await fs.writeFile(temporaryPath, PNG);
    const temporarySource = new URL(`file://${temporaryPath}`).toString();
    fixture.setMessageText(`![workspace](workspace.png)\n![temporary](${temporarySource})`);

    const response = await prepare(fixture.app, fixture.directory, ['workspace.png', temporarySource]);

    expect(fixture.host.getMessages).toHaveBeenCalledTimes(1);
    expect(fixture.fullReadCount()).toBe(0);
    expect(response.body.results).toHaveLength(2);
    const canonicalTemporaryPath = await fs.realpath(temporaryPath);
    expect(response.body.results[0]).toEqual({
      source: 'workspace.png',
      status: 'ready',
      path: path.join(fixture.directory, 'workspace.png'),
    });
    expect(response.body.results[1]).toEqual(expect.objectContaining({
      source: temporarySource,
      status: 'ready',
      path: canonicalTemporaryPath,
      outsideFileGrant: expect.any(String),
      expiresAt: expect.any(Number),
    }));
  });

  it('returns partial results without letting one missing image block valid images', async () => {
    const fixture = await createFixture({ sources: ['present.png', 'deleted.png'] });
    await fs.writeFile(path.join(fixture.directory, 'present.png'), PNG);

    const response = await prepare(fixture.app, fixture.directory, fixture.sources);

    expect(response.body.results).toEqual([
      expect.objectContaining({ source: 'present.png', status: 'ready' }),
      { source: 'deleted.png', status: 'missing' },
    ]);
  });

  it('resolves encoded workspace paths without treating query or fragment text as a filename', async () => {
    const source = 'screen%20shot.png?version=1#preview';
    const fixture = await createFixture({ sources: [source] });
    await fs.writeFile(path.join(fixture.directory, 'screen shot.png'), PNG);

    const response = await prepare(fixture.app, fixture.directory, fixture.sources);

    expect(response.body.results).toEqual([
      expect.objectContaining({ source, status: 'ready' }),
    ]);
  });

  it('authorizes reference-style image syntax using its resolved destination', async () => {
    const source = 'reference.png';
    const fixture = await createFixture({
      sources: [source],
      markdown: '![screenshot][result]\n\n[result]: reference.png',
    });
    await fs.writeFile(path.join(fixture.directory, source), PNG);

    const response = await prepare(fixture.app, fixture.directory, fixture.sources);

    expect(response.body.results).toEqual([
      expect.objectContaining({ source, status: 'ready' }),
    ]);
  });

  it('authorizes inline image destinations containing balanced parentheses', async () => {
    const source = 'screen(1).png';
    const fixture = await createFixture({
      sources: [source],
      markdown: `![screenshot](${source})`,
    });
    await fs.writeFile(path.join(fixture.directory, source), PNG);

    const response = await prepare(fixture.app, fixture.directory, fixture.sources);

    expect(response.body.results).toEqual([
      expect.objectContaining({ source, status: 'ready' }),
    ]);
  });

  it('requires inline image destinations with titles to close', async () => {
    const sources = ['valid.png', 'malformed.png'];
    const fixture = await createFixture({
      sources,
      markdown: '![valid](valid.png "preview")\n![malformed](malformed.png "preview"',
    });
    await Promise.all(sources.map((source) => fs.writeFile(path.join(fixture.directory, source), PNG)));

    const response = await prepare(fixture.app, fixture.directory, sources);

    expect(response.body.results).toEqual([
      expect.objectContaining({ source: 'valid.png', status: 'ready' }),
      { source: 'malformed.png', status: 'error' },
    ]);
  });

  it('rejects a source that the message does not reference', async () => {
    const fixture = await createFixture({ markdown: 'No image here.' });
    const response = await prepare(fixture.app, fixture.directory, fixture.sources);
    expect(response.body.results).toEqual([{ source: fixture.sources[0], status: 'error' }]);
  });

  it('does not authorize image syntax inside fenced or inline code', async () => {
    const fixture = await createFixture({
      markdown: '```md\n![fenced](FENCED)\n```\n`![inline](INLINE)`',
    });
    const sources = ['FENCED', 'INLINE'];

    const response = await prepare(fixture.app, fixture.directory, sources);

    expect(response.body.results).toEqual(sources.map((source) => ({ source, status: 'error' })));
  });

  it('rejects paths outside the workspace and approved temporary root', async () => {
    const fixture = await createFixture();
    const outsidePath = path.join(fixture.root, 'outside.png');
    await fs.writeFile(outsidePath, PNG);
    const source = new URL(`file://${outsidePath}`).toString();
    fixture.setMessageText(`![outside](${source})`);

    const response = await prepare(fixture.app, fixture.directory, [source]);
    expect(response.body.results).toEqual([{ source, status: 'error' }]);
  });

  it('rejects non-image bytes and symlink escapes per source', async () => {
    const fixture = await createFixture({ sources: ['invalid.png', 'linked.png'] });
    await fs.writeFile(path.join(fixture.directory, 'invalid.png'), 'not an image');
    await fs.writeFile(path.join(fixture.root, 'outside.png'), PNG);
    await fs.symlink(path.join(fixture.root, 'outside.png'), path.join(fixture.directory, 'linked.png'));

    const response = await prepare(fixture.app, fixture.directory, fixture.sources);
    expect(response.body.results).toEqual([
      { source: 'invalid.png', status: 'error' },
      { source: 'linked.png', status: 'error' },
    ]);
  });

  it('answers 404 when the session page does not carry the message', async () => {
    const fixture = await createFixture();
    fixture.setMessageText('![image](image.png)', 'user');

    await request(fixture.app)
      .post(`/api/openchamber/sessions/${SESSION_ID}/markdown-image-grants`)
      .send({ directory: fixture.directory, messageId: MESSAGE_ID, sources: ['image.png'] })
      .expect(404);
  });
});
