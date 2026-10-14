// packages/web/server/lib/workflows/artifacts.js
/**
 * Artifact checks for a step: which files a glob matches, and their hashes.
 *
 * The matcher is local rather than a dependency: `packages/web` has no glob
 * package, and the patterns a definition uses are path segments with `*` and
 * `**`. Patterns are relative to the run's directory and can never escape it.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

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
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (head === '**') {
      if (entry.isDirectory()) {
        matches.push(...await walk(absolute, segments));
      }
      matches.push(...await walk(absolute, rest));
      continue;
    }
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
  const segments = toSegments(pattern);
  if (segments.length === 0 || segments.includes('..')) return [];
  const matched = await walk(directory, segments);
  return [...new Set(matched)]
    .map((absolute) => path.relative(directory, absolute).split(path.sep).join('/'))
    .sort();
};

export const hashFile = async (absolutePath) => {
  const buffer = await fs.readFile(absolutePath);
  return { size: buffer.byteLength, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
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
