#!/usr/bin/env node
/**
 * Fail packaging when the UI staged into `resources/web-dist` does not match the
 * current `packages/web/dist` build.
 *
 * The packaged app loads its UI from `resources/web-dist` over
 * `openchamber-ui://app` (see `resolveWebDistDir()` in `main.mjs`). Nothing in
 * the build noticed when `build:web-assets` was skipped, so a package could ship
 * a UI many hours older than the code in the repository. This check compares the
 * staged `index.html` mtime and a hash of the staged `assets/` entry names
 * against the built dist and exits non-zero when they differ.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(electronRoot, '..', '..');

const indexFile = (directory) => path.join(directory, 'index.html');

const statOrNull = (filePath) => {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
};

// Content identifies a stale stage better than `index.html` alone: vite renames
// every hashed asset on a rebuild, so the entry-name set changes together.
const assetsFingerprint = (directory) => {
  let names = [];
  try {
    names = fs.readdirSync(path.join(directory, 'assets'));
  } catch {
    names = [];
  }
  return crypto.createHash('sha256').update(names.slice().sort().join('\n')).digest('hex');
};

const formatAgeGap = (ageMs) => {
  const seconds = Math.max(0, Math.round(ageMs / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
};

export const verifyWebAssets = ({ webDist, builtDist } = {}) => {
  if (!webDist || !builtDist) {
    return { ok: false, reason: 'both the staged and the built web dist directories are required' };
  }

  const builtIndex = indexFile(builtDist);
  const builtStat = statOrNull(builtIndex);
  if (!builtStat) {
    return { ok: false, reason: `the web build is missing ${builtIndex}; run \`bun run --cwd packages/web build\`` };
  }

  const stagedIndex = indexFile(webDist);
  const stagedStat = statOrNull(stagedIndex);
  if (!stagedStat) {
    return { ok: false, reason: `the staged UI is missing ${stagedIndex}; run \`bun run --cwd packages/electron build:web-assets\`` };
  }

  const ageMs = builtStat.mtimeMs - stagedStat.mtimeMs;
  const assetsDiffer = assetsFingerprint(webDist) !== assetsFingerprint(builtDist);
  if (assetsDiffer || ageMs > 0) {
    const gap = ageMs > 0 ? ` by ${formatAgeGap(ageMs)}` : '';
    const detail = assetsDiffer ? ' and its assets do not match the current build' : '';
    return {
      ok: false,
      reason: `the staged UI ${webDist} is older than ${builtDist}${gap}${detail}; run \`bun run --cwd packages/electron build:web-assets\``,
    };
  }

  return { ok: true };
};

const main = () => {
  const verdict = verifyWebAssets({
    webDist: path.join(electronRoot, 'resources', 'web-dist'),
    builtDist: path.join(repoRoot, 'packages', 'web', 'dist'),
  });
  if (!verdict.ok) {
    console.error(`[electron] stale web assets: ${verdict.reason}`);
    process.exit(1);
  }
  console.log('[electron] verified staged web assets match packages/web/dist');
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
