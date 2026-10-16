/**
 * A session's sub-agent transcripts.
 *
 * OMP writes each sub-agent's transcript as its own session file inside a
 * directory named after the session file it belongs to —
 * `<project>/<session-file-without-.jsonl>/<AgentName>.jsonl` — so a child is
 * never a session the runtime lists (`createSessionStore` discovers exactly
 * `<project>/<file>.jsonl`) and nothing but the files themselves says a child
 * exists. The `session` header's `parentSession` is the authority: a file is
 * this session's child only when its own header names this session file, so a
 * stray file in the directory is not a child and a child moved in the directory
 * still is one.
 *
 * Both reads are Node-side. The runtime has no RPC for a session it does not
 * have open, and `switch_session` would move the live process off the parent,
 * so the transcript files are read directly. Every file-system and read seam is
 * injectable, so the tests need no files and a directory OMP is writing into
 * (a `.lock.os` beside it, a half-written last line) is tolerated rather than
 * treated as a failure: a transcript appears while the model is still running.
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const JSONL = '.jsonl';
const LOCK = '.lock.os';

/**
 * How much of a transcript the header read parses. OMP writes the header as the
 * file's first logical record (after a fixed-width title record), so a bounded
 * read finds it without pulling a multi-megabyte transcript into memory.
 */
const HEAD_BYTES = 64 * 1024;

// Loaded on first use, like `server/lib/agents/index.js`: a server that never
// opens a sub-agent transcript never loads the OMP SDK graph behind the adapter.
let adapterPromise = null;
const loadAdapter = () => {
  adapterPromise ??= import('@openchamber/omp-adapter');
  return adapterPromise;
};

/** The directory OMP writes this session's sub-agent transcripts into. */
const transcriptsDirectory = (sessionPath) =>
  path.join(path.dirname(sessionPath), path.basename(sessionPath).replace(/\.jsonl$/, ''));

/**
 * One JSONL record of a transcript: an object of any shape. OMP writes more
 * record kinds than this module reads, so the record's fields are decoded per
 * reader rather than here.
 */
const recordSchema = z.object({}).passthrough();

/** The names of a directory listing; entries that are not names are dropped, not read. */
const namesSchema = z.array(z.string());

/**
 * The `session` header a transcript starts with (after OMP's fixed-width title
 * record). `parentSession` names the session file the sub-agent was spawned
 * from, which is what makes a file a child of this session; `timestamp` is the
 * child's start.
 */
const sessionHeaderSchema = z
  .object({
    type: z.literal('session'),
    id: z.string().min(1),
    parentSession: z.string().min(1),
    timestamp: z.string().optional(),
  })
  .passthrough();

/** One stored message record; the message itself is the OMP shape the adapter projects. */
const messageRecordSchema = z.object({ type: z.literal('message'), message: z.looseObject({ role: z.string() }) }).passthrough();

/**
 * One JSONL record, or `null` for a blank line and for a line that does not
 * parse — the last line of a file OMP is still appending to.
 */
const parseRecord = (line) => {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = recordSchema.safeParse(JSON.parse(trimmed));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/**
 * The `session` record of a transcript, or `null` when the file carries none: an
 * empty file, a file whose header has not landed yet, or one that is not a
 * session at all. The record is returned as it was stored; its fields are
 * decoded by the caller, so an injected header reader is held to the same shape.
 */
const parseSessionHeader = (text) => {
  for (const line of text.split('\n')) {
    const record = parseRecord(line);
    if (record?.type === 'session') return record;
  }
  return null;
};

/** The names in a transcript directory; a missing directory is the caller's to swallow. */
const readTranscriptDirectory = (directory) => fs.readdirSync(directory, { encoding: 'utf8' });

/** A transcript file's `session` header, read from its bounded head. */
const readTranscriptHeader = (file) => {
  const handle = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(handle, buffer, 0, HEAD_BYTES, 0);
    return parseSessionHeader(buffer.toString('utf8', 0, read));
  } finally {
    fs.closeSync(handle);
  }
};

/**
 * The stored messages of a transcript, in file order. A stored record's
 * `message` is the same OMP message shape the runtime reports over RPC, so the
 * adapter's history projector renders a transcript file and an open session
 * alike. Records of any other type (the header, model changes, tool-execution
 * markers) carry no message and are skipped.
 */
const parseTranscriptMessages = (text) => {
  const messages = [];
  for (const line of text.split('\n')) {
    const parsed = messageRecordSchema.safeParse(parseRecord(line));
    if (parsed.success) messages.push(parsed.data.message);
  }
  return messages;
};

/** A transcript file as the message page the session route answers with. */
const readTranscriptMessages = async ({ id, sessionPath }) => {
  const adapter = await loadAdapter();
  const messages = parseTranscriptMessages(fs.readFileSync(sessionPath, 'utf8'));
  return adapter.projectOmpHistory(id, messages);
};

/**
 * The sub-agent transcripts of one session, as
 * `{ id, agent, sessionPath, startedAt }`: the child's own session id, the name
 * OMP gave it, the file to read, and when it started (`null` when its header
 * carries no timestamp). A directory that does not exist, a lock file, an
 * unreadable file, an empty one and a file whose header names another parent are
 * all skipped rather than failing the listing.
 */
export const listSubagentTranscripts = async ({
  sessionPath,
  readdir = readTranscriptDirectory,
  readHeader = readTranscriptHeader,
} = {}) => {
  if (!sessionPath) return [];
  const directory = transcriptsDirectory(sessionPath);
  let listing;
  try {
    listing = namesSchema.safeParse(await readdir(directory));
  } catch {
    // A session that never spawned a sub-agent has no such directory.
    return [];
  }
  if (!listing.success) return [];
  const children = [];
  for (const name of listing.data) {
    if (!name.endsWith(JSONL) || name.startsWith('.') || name.endsWith(LOCK)) continue;
    const file = path.join(directory, name);
    let header;
    try {
      header = sessionHeaderSchema.safeParse(await readHeader(file));
    } catch {
      // A file OMP is writing, or holding a lock on, is not a readable child.
      continue;
    }
    if (!header.success || header.data.parentSession !== sessionPath) continue;
    children.push({
      id: header.data.id,
      agent: name.slice(0, -JSONL.length),
      sessionPath: file,
      startedAt: header.data.timestamp ?? null,
    });
  }
  return children;
};

/**
 * One child's transcript as the `{ items, cursor }` page the session's own
 * messages route answers with, or `null` when this session has no child under
 * that id. The name the model spoke for the child is also accepted, because the
 * tool row knows the agent's name before it knows the child's session id; an id
 * wins when both are known. `childId` is matched against the discovered
 * children, never joined into a path, so a request cannot name a file itself.
 */
export const readSubagentMessages = async ({
  sessionPath,
  childId,
  readdir,
  readHeader,
  readMessages = readTranscriptMessages,
} = {}) => {
  const children = await listSubagentTranscripts({ sessionPath, readdir, readHeader });
  const child = children.find((entry) => entry.id === childId) ?? children.find((entry) => entry.agent === childId);
  if (!child) return null;
  return readMessages({ id: child.id, sessionPath: child.sessionPath });
};
