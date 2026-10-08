import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyWebAssets } from './verify-web-assets.mjs';

const withTempDirs = (build) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-web-assets-'));
  try {
    return build(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const writeDist = (directory, { asset, mtime }) => {
  fs.mkdirSync(path.join(directory, 'assets'), { recursive: true });
  const index = path.join(directory, 'index.html');
  fs.writeFileSync(index, '<!doctype html>');
  fs.writeFileSync(path.join(directory, 'assets', asset), 'export {}');
  fs.utimesSync(index, mtime, mtime);
};

test('a web-dist older than packages/web/dist fails the check', () => withTempDirs((root) => {
  const freshDir = path.join(root, 'web-dist');
  const staleDir = path.join(root, 'resources-web-dist');
  const now = Date.now() / 1000;
  writeDist(freshDir, { asset: 'index-new.js', mtime: now });
  writeDist(staleDir, { asset: 'index-old.js', mtime: now - 6 * 60 * 60 });

  const verdict = verifyWebAssets({ webDist: staleDir, builtDist: freshDir });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /older than/);
  assert.match(verdict.reason, /assets do not match the current build/);
}));

test('a matching stage passes the check', () => withTempDirs((root) => {
  const freshDir = path.join(root, 'web-dist');
  const stagedDir = path.join(root, 'resources-web-dist');
  const now = Date.now() / 1000;
  writeDist(freshDir, { asset: 'index-new.js', mtime: now });
  writeDist(stagedDir, { asset: 'index-new.js', mtime: now + 30 });

  assert.deepEqual(verifyWebAssets({ webDist: stagedDir, builtDist: freshDir }), { ok: true });
}));

test('a missing staged index.html fails the check', () => withTempDirs((root) => {
  const freshDir = path.join(root, 'web-dist');
  const stagedDir = path.join(root, 'resources-web-dist');
  writeDist(freshDir, { asset: 'index-new.js', mtime: Date.now() / 1000 });
  fs.mkdirSync(stagedDir, { recursive: true });

  const verdict = verifyWebAssets({ webDist: stagedDir, builtDist: freshDir });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /staged UI is missing/);
}));
