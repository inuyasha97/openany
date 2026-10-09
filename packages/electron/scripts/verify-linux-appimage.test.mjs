import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { linuxAppImageArchSuffix, readElfArchitecture, verifyExtractedPayload } from './verify-linux-appimage.mjs';

const writeElf = (filePath, architecture) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const header = Buffer.alloc(20);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  header.writeUInt16LE(architecture === 'x64' ? 62 : 183, 18);
  fs.writeFileSync(filePath, header, { mode: 0o755 });
};

const createPayload = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-payload-test-'));
  fs.writeFileSync(path.join(root, 'openany.desktop'), [
    '[Desktop Entry]', 'Name=OpenAny', 'Exec=AppRun --no-sandbox %U', 'Icon=openany', 'StartupWMClass=openany', '',
  ].join('\n'));
  writeElf(path.join(root, 'openany'), 'x64');
  writeElf(path.join(root, 'resources/omp-cli/omp'), 'x64');
  for (const name of ['pty.node', 'sherpa-onnx.node']) {
    writeElf(path.join(root, 'resources/app.asar.unpacked/node_modules', name), 'x64');
  }
  // A dependency that ships every platform's binaries: Linux never loads the
  // darwin one, so it must not be architecture-checked (it is not even ELF).
  const foreign = path.join(
    root,
    'resources/app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v3/darwin/arm64/onnxruntime_binding.node',
  );
  fs.mkdirSync(path.dirname(foreign), { recursive: true });
  fs.writeFileSync(foreign, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), { mode: 0o755 });
  // The same dependency also ships the other architecture for this platform,
  // outside `prebuilds/`. CI rejected it as an x64 mismatch once.
  const otherArch = path.join(
    root,
    'resources/app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v3/linux/arm64/onnxruntime_binding.node',
  );
  fs.mkdirSync(path.dirname(otherArch), { recursive: true });
  fs.writeFileSync(otherArch, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), { mode: 0o755 });
  return root;
};

test('reads supported ELF architectures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-elf-test-'));
  try {
    writeElf(path.join(root, 'x64'), 'x64');
    writeElf(path.join(root, 'arm64'), 'arm64');
    assert.equal(readElfArchitecture(path.join(root, 'x64')), 'x64');
    assert.equal(readElfArchitecture(path.join(root, 'arm64')), 'arm64');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AppImage artifact names use electron-builder arch suffixes', () => {
  assert.equal(linuxAppImageArchSuffix('x64'), 'x86_64');
  assert.equal(linuxAppImageArchSuffix('arm64'), 'arm64');
});

test('verifies identity, version, and native payload architecture', () => {
  const root = createPayload();
  try {
    const result = verifyExtractedPayload({
      root,
      targetArchitecture: 'x64',
      expectedCliVersion: '18.1.11',
      runCliVersion: () => '18.1.11',
    });
    // The darwin-only binding in the payload is not counted or checked.
    assert.equal(result.nativeModuleCount, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails on a missing native module', () => {
  const root = createPayload();
  try {
    fs.rmSync(path.join(root, 'resources/app.asar.unpacked/node_modules/pty.node'));
    assert.throws(() => verifyExtractedPayload({
      root,
      targetArchitecture: 'x64',
      expectedCliVersion: '18.1.11',
      runCliVersion: () => '18.1.11',
    }), /Missing packaged native module: pty\.node/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails on wrong CLI version or native architecture', () => {
  const root = createPayload();
  try {
    assert.throws(() => verifyExtractedPayload({
      root,
      targetArchitecture: 'x64',
      expectedCliVersion: '18.1.11',
      runCliVersion: () => '18.1.10',
    }), /OMP CLI version mismatch/);
    writeElf(path.join(root, 'resources/app.asar.unpacked/node_modules/pty.node'), 'arm64');
    assert.throws(() => verifyExtractedPayload({
      root,
      targetArchitecture: 'x64',
      expectedCliVersion: '18.1.11',
      runCliVersion: () => '18.1.11',
    }), /Native module architecture mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
