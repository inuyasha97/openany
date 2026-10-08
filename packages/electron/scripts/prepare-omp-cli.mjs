#!/usr/bin/env node
/**
 * Stage the OMP standalone binary for the desktop build.
 *
 * OMP ships prebuilt Bun-embedded executables per platform on GitHub releases.
 * Download the matching artifact, verify it runs, stage under resources/omp-cli,
 * ship via extraResources. The server spawns it with `--mode rpc`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPinnedOmpCliVersion } from './omp-cli-version.mjs';
import { resolveTargetArchitecture } from './target-architecture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(__dirname, '..');
const outputDir = path.join(electronRoot, 'resources', 'omp-cli');
const cacheRoot = path.join(electronRoot, '.cache', 'omp-cli');

const arch = () => resolveTargetArchitecture().cli; // 'arm64' | 'x64'
const artifactForPlatform = (platform, a) => {
  if (platform === 'win32') return { name: `omp-windows-${a}.exe`, binary: 'omp.exe' };
  const os = platform === 'darwin' ? 'darwin' : 'linux';
  return { name: `omp-${os}-${a}`, binary: 'omp' };
};

const readVersion = (binaryPath) => {
  if (!fs.existsSync(binaryPath)) return null;
  const result = spawnSync(binaryPath, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, windowsHide: true });
  if (result.status !== 0) return null;
  return String(result.stdout).trim() || null;
};

const main = async () => {
  const version = readPinnedOmpCliVersion();
  const artifact = artifactForPlatform(process.platform, arch());
  const outputBinary = path.join(outputDir, artifact.binary);
  const tag = version.startsWith('v') ? version : `v${version}`;
  const cacheDir = path.join(cacheRoot, version, `${process.platform}-${arch()}`);
  const archivePath = path.join(cacheDir, artifact.name);
  const url = `https://github.com/can1357/oh-my-pi/releases/download/${tag}/${artifact.name}`;

  fs.mkdirSync(cacheDir, { recursive: true });
  if (!fs.existsSync(archivePath)) {
    console.log(`[electron] downloading OMP CLI ${version}: ${artifact.name}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
    fs.writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
  }

  fs.mkdirSync(outputDir, { recursive: true });
  for (const entry of fs.readdirSync(outputDir)) {
    if (entry !== '.gitkeep') fs.rmSync(path.join(outputDir, entry), { recursive: true, force: true });
  }
  fs.copyFileSync(archivePath, outputBinary);
  if (process.platform !== 'win32') fs.chmodSync(outputBinary, 0o755);

  const prepared = readVersion(outputBinary);
  if (!prepared) throw new Error(`Prepared OMP binary did not run: ${outputBinary}`);
  console.log(`[electron] prepared OMP CLI ${version}: ${outputBinary} (${prepared})`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
