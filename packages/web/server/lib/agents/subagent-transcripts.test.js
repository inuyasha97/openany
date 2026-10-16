import { describe, expect, it, vi } from 'vitest';

import { listSubagentTranscripts, readSubagentMessages } from './subagent-transcripts.js';

const PARENT = '/s/2026-10-14T12-00-00Z_aaa.jsonl';
const CHILD_DIRECTORY = '/s/2026-10-14T12-00-00Z_aaa';

const header = (overrides = {}) => ({
  type: 'session',
  id: 'child-1',
  cwd: '/repo',
  timestamp: '2026-10-14T12:00:01.000Z',
  parentSession: PARENT,
  ...overrides,
});

describe('sub-agent transcripts', () => {
  it('lists a child per transcript file and skips locks and unreadable files', async () => {
    const readdir = vi.fn(() => ['ImplArtifacts.jsonl', '.ImplArtifacts.jsonl.lock.os', 'ReReview.jsonl', 'empty.jsonl', 'notes.txt']);
    const readHeader = (file) => (file.includes('empty') ? null : header({ id: `child-${file.endsWith('ReReview.jsonl') ? '2' : '1'}` }));

    const children = await listSubagentTranscripts({ sessionPath: PARENT, readdir, readHeader });

    expect(readdir).toHaveBeenCalledWith(CHILD_DIRECTORY);
    expect(children.map((child) => child.agent)).toEqual(['ImplArtifacts', 'ReReview']);
    expect(children[0]).toEqual({
      id: 'child-1',
      agent: 'ImplArtifacts',
      sessionPath: `${CHILD_DIRECTORY}/ImplArtifacts.jsonl`,
      startedAt: '2026-10-14T12:00:01.000Z',
    });
    expect(children[1].id).toBe('child-2');
  });

  it('ignores a child whose parent link points elsewhere', async () => {
    const children = await listSubagentTranscripts({
      sessionPath: '/s/a.jsonl',
      readdir: () => ['other.jsonl'],
      readHeader: () => header({ parentSession: '/s/somewhere-else.jsonl' }),
    });

    expect(children).toEqual([]);
  });

  it('tolerates a missing directory and a file whose header cannot be read', async () => {
    expect(await listSubagentTranscripts({ sessionPath: PARENT, readdir: () => { throw new Error('ENOENT'); } })).toEqual([]);
    expect(
      await listSubagentTranscripts({
        sessionPath: PARENT,
        readdir: () => ['half-written.jsonl'],
        readHeader: () => { throw new Error('EBUSY'); },
      }),
    ).toEqual([]);
  });

  it('reports no start time when a header carries no timestamp', async () => {
    const children = await listSubagentTranscripts({
      sessionPath: PARENT,
      readdir: () => ['WordReply.jsonl'],
      readHeader: () => header({ timestamp: undefined }),
    });

    expect(children.map((child) => child.startedAt)).toEqual([null]);
  });

  it('reads a child through the injected reader and answers null for an unknown one', async () => {
    const readMessages = vi.fn(async () => ({ items: [], cursor: {} }));
    const readdir = () => ['Impl.jsonl'];
    const readHeader = () => header({ id: 'child-9' });

    const page = await readSubagentMessages({ sessionPath: PARENT, childId: 'child-9', readdir, readHeader, readMessages });

    expect(page).toEqual({ items: [], cursor: {} });
    expect(readMessages).toHaveBeenCalledWith({ id: 'child-9', sessionPath: `${CHILD_DIRECTORY}/Impl.jsonl` });

    expect(await readSubagentMessages({ sessionPath: PARENT, childId: 'nope', readdir, readHeader, readMessages })).toBeNull();
    expect(readMessages).toHaveBeenCalledTimes(1);
  });

  it('accepts the agent name the tool row knows when the child id is not known yet', async () => {
    const readMessages = vi.fn(async () => ({ items: [{ info: { id: 'm1' }, parts: [] }], cursor: {} }));
    const readHeader = () => header({ id: 'child-9' });

    const page = await readSubagentMessages({
      sessionPath: PARENT,
      childId: 'Impl',
      readdir: () => ['Impl.jsonl'],
      readHeader,
      readMessages,
    });

    expect(page.items).toHaveLength(1);
    expect(readMessages).toHaveBeenCalledWith({ id: 'child-9', sessionPath: `${CHILD_DIRECTORY}/Impl.jsonl` });
  });
});
