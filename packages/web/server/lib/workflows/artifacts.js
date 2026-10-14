// packages/web/server/lib/workflows/artifacts.js
/**
 * Artifact checks for a step: which files a glob matches, and their hashes.
 *
 * The matcher is local rather than a dependency: `packages/web` has no glob
 * package, and the patterns a definition uses are path segments with `*` and
 * `**`. Patterns are relative to the run's directory and can never escape it.
 */
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const toSegments = (pattern) => String(pattern)
  .replace(/\\/g, '/')
  .split('/')
  .filter((segment) => segment.length > 0 && segment !== '.');

const segmentMatches = (segment, name) => {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}$`).test(name);
};

const walk = async (directory, segments) => {
  const [head, ...rest] = segments;
  if (head === undefined) return [];
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'EACCES') return [];
    throw error;
  }

  const matches = [];
  if (head === '**') {
    // `**` is zero or more segments. A trailing `**` means every file at or
    // below this directory; otherwise the rest of the pattern is tried in this
    // same directory (the zero case) and once more per directory below it. The
    // zero case is the one that is easy to lose: without it `docs/**/*.md`
    // misses a file sitting directly in `docs/`, and `docs/**` matches nothing,
    // so a pattern a person wrote correctly reads as a failed check.
    if (rest.length === 0) {
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        if (entry.isFile()) matches.push(absolute);
        else if (entry.isDirectory()) matches.push(...await walk(absolute, segments));
      }
      return matches;
    }
    matches.push(...await walk(directory, rest));
    for (const entry of entries) {
      if (entry.isDirectory()) matches.push(...await walk(path.join(directory, entry.name), segments));
    }
    return matches;
  }

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (!segmentMatches(head, entry.name)) continue;
    if (rest.length === 0) {
      if (entry.isFile()) matches.push(absolute);
      continue;
    }
    if (entry.isDirectory()) matches.push(...await walk(absolute, rest));
  }
  return matches;
};

export const matchArtifacts = async ({ directory, pattern }) => {
  const raw = String(pattern);
  // An absolute pattern is a mistake in a definition, and silently treating it
  // as relative would look at the wrong tree.
  if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) return [];
  const segments = toSegments(raw);
  if (segments.length === 0 || segments.includes('..')) return [];
  const matched = await walk(directory, segments);
  return [...new Set(matched)]
    .map((absolute) => path.relative(directory, absolute).split(path.sep).join('/'))
    .sort();
};

export const hashFile = async (absolutePath) => {
  // Size and digest come from the same read, so the pair always describes the
  // same bytes. Comparing them later is what tells a checkpoint whether the file
  // still holds what it held when a person confirmed it.
  const digest = crypto.createHash('sha256');
  let size = 0;
  const source = createReadStream(absolutePath);
  source.on('data', (chunk) => { size += chunk.length; });
  await pipeline(source, digest);
  return { size, sha256: digest.digest('hex') };
};

export const inspectArtifacts = async ({ directory, patterns }) => {
  const results = [];
  for (const pattern of patterns) {
    const matches = await matchArtifacts({ directory, pattern: pattern.glob });
    if (matches.length === 0) {
      results.push({ glob: pattern.glob, path: null, exists: false, size: null, sha256: null });
      continue;
    }
    for (const relative of matches) {
      if (pattern.hash === true) {
        const { size, sha256 } = await hashFile(path.join(directory, relative));
        results.push({ glob: pattern.glob, path: relative, exists: true, size, sha256 });
      } else {
        const stats = await fs.stat(path.join(directory, relative));
        results.push({ glob: pattern.glob, path: relative, exists: true, size: stats.size, sha256: null });
      }
    }
  }
  return results;
};
