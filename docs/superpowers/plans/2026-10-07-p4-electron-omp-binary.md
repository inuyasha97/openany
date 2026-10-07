# Phase 4: Electron OMP binary + OpenCode bundling removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bundle the OMP standalone binary into the desktop app, spawn it via RPC, and delete the OpenCode CLI bundling and readiness code.

**Architecture:** Mirror the OpenCode pattern exactly. `prepare-omp-cli.mjs` stages a per-platform executable into `resources/omp-cli`; electron-builder ships it via `extraResources`; the server resolves it through `resolveOmpCommand` (env -> bundled resources -> `PATH`). OMP ships a Bun-embedded standalone executable, so Node can spawn it with no Bun install.

**Tech Stack:** Node `child_process`/`fetch`, electron-builder, the P1 RPC adapter, `node --check` for the main bundle.

**Spec:** `docs/superpowers/specs/2026-10-07-omp-only-runtime-design.md`

## Global Constraints

- Pinned OMP version **18.1.11** (`OPENCHAMBER_OMP_CLI_VERSION` overrides).
- **Verify the release tag and artifact names against the real `can1357/oh-my-pi` release before trusting the URLs.** The plan assumes `v<version>/omp-<os>-<arch>[.exe]`.
- Desktop runs the server in-process under Node; the OMP binary is a spawned child, never inlined into the JS bundle.
- `bundle-main.mjs` keeps `@openchamber/web` external; do not change that.
- Do not modify `../opencode`.

## File Structure

- Create: `packages/electron/scripts/prepare-omp-cli.mjs`
- Delete: `scripts/prepare-opencode-cli.mjs`, `scripts/opencode-cli-version.mjs`, `scripts/verify-opencode-cli.mjs`, `scripts/verify-opencode-cli.test.mjs`, `opencode-cwd.mjs`, `opencode-cwd.test.mjs`, `opencode-readiness.mjs`, `opencode-readiness.test.mjs`
- Modify: `packages/electron/package.json`, `packages/electron/main.mjs`
- Modify: `packages/omp-adapter/src/rpc-host.ts` (+ test)

---

### Task 1: `prepare-omp-cli.mjs`

**Files:** Create `packages/electron/scripts/prepare-omp-cli.mjs`

**Interfaces:** Produces `resources/omp-cli/omp` (POSIX) or `resources/omp-cli/omp.exe` (Windows); prints the version.

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
/**
 * Stage the OMP standalone binary for the desktop build.
 *
 * OMP ships prebuilt Bun-embedded executables per platform on GitHub releases.
 * Mirrors prepare-opencode-cli.mjs: download the matching artifact, verify it
 * runs, stage under resources/omp-cli, ship via extraResources. The server
 * spawns it with `--mode rpc`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTargetArchitecture } from './target-architecture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(__dirname, '..');
const outputDir = path.join(electronRoot, 'resources', 'omp-cli');
const cacheRoot = path.join(electronRoot, '.cache', 'omp-cli');
const OMP_CLI_VERSION = process.env.OPENCHAMBER_OMP_CLI_VERSION || '18.1.11';

const arch = () => resolveTargetArchitecture().opencode; // 'arm64' | 'x64'
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
  if (!/^\d+\.\d+\.\d+/.test(OMP_CLI_VERSION)) throw new Error(`Invalid OMP CLI version: ${OMP_CLI_VERSION}`);
  const artifact = artifactForPlatform(process.platform, arch());
  const outputBinary = path.join(outputDir, artifact.binary);
  const tag = OMP_CLI_VERSION.startsWith('v') ? OMP_CLI_VERSION : `v${OMP_CLI_VERSION}`;
  const cacheDir = path.join(cacheRoot, OMP_CLI_VERSION, `${process.platform}-${arch()}`);
  const archivePath = path.join(cacheDir, artifact.name);
  const url = `https://github.com/can1357/oh-my-pi/releases/download/${tag}/${artifact.name}`;

  fs.mkdirSync(cacheDir, { recursive: true });
  if (!fs.existsSync(archivePath)) {
    console.log(`[electron] downloading OMP CLI ${OMP_CLI_VERSION}: ${artifact.name}`);
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
  console.log(`[electron] prepared OMP CLI ${OMP_CLI_VERSION}: ${outputBinary} (${prepared})`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
```

- [ ] **Step 2: Run it** — `node ./scripts/prepare-omp-cli.mjs` (workdir `packages/electron`); expects a download and a version print.
- [ ] **Step 3: Verify** — `packages/electron/resources/omp-cli/omp --version`.
- [ ] **Step 4: Commit** — `build(electron): stage the omp standalone binary`.

---

### Task 2: Bundled-binary resolution in the adapter

**Files:** Modify `packages/omp-adapter/src/rpc-host.ts`; test `rpc-host.test.ts`.

**Interfaces:** Produces `resolveOmpCommand(options?)`; order `OPENCHAMBER_OMP_PATH` -> `OPENCHAMBER_OMP_BIN` -> `OMP_BINARY` -> `OPENCHAMBER_BUNDLED_OMP_CLI_DIR/omp` -> `resourcesPath/omp-cli/omp` -> `"omp"`.

- [ ] **Step 1: Write the failing test**

```ts
import { resolveOmpCommand } from "./rpc-host"

describe("resolveOmpCommand", () => {
  test("prefers an explicit env path", () => {
    expect(resolveOmpCommand({ env: { OPENCHAMBER_OMP_PATH: "/opt/omp" }, resourcesPath: "/res", exists: () => true })).toBe("/opt/omp")
  })
  test("falls back to the bundled binary under resourcesPath", () => {
    expect(resolveOmpCommand({ env: {}, resourcesPath: "/res", exists: (p) => p === "/res/omp-cli/omp" })).toBe("/res/omp-cli/omp")
  })
  test("falls back to the PATH lookup name", () => {
    expect(resolveOmpCommand({ env: {}, resourcesPath: null, exists: () => false })).toBe("omp")
  })
})
```

- [ ] **Step 2: Run to verify failure** — `bun test src/rpc-host.test.ts`.
- [ ] **Step 3: Implement** (replace the P1 `resolveCommand`):

```ts
import fs from "node:fs"
import path from "node:path"

export type ResolveOmpCommandOptions = {
  env?: Record<string, string | undefined>
  resourcesPath?: string | null
  exists?: (file: string) => boolean
}

export const resolveOmpCommand = (options: ResolveOmpCommandOptions = {}): string => {
  const env = options.env ?? process.env
  const exists = options.exists ?? ((file: string) => fs.existsSync(file))
  const explicit = [env.OPENCHAMBER_OMP_PATH, env.OPENCHAMBER_OMP_BIN, env.OMP_BINARY].map((v) => v?.trim()).filter(Boolean) as string[]
  for (const candidate of explicit) if (exists(candidate)) return candidate
  const resourcesPath = options.resourcesPath === undefined
    ? (process as { resourcesPath?: string }).resourcesPath ?? null
    : options.resourcesPath
  const binaryName = process.platform === "win32" ? "omp.exe" : "omp"
  const roots = [env.OPENCHAMBER_BUNDLED_OMP_CLI_DIR, resourcesPath ? path.join(resourcesPath, "omp-cli") : null]
  for (const root of roots) {
    if (!root) continue
    const candidate = path.join(root, binaryName)
    if (exists(candidate)) return candidate
  }
  return explicit[0] ?? "omp"
}
```

Use `resolveOmpCommand({ env: options.env })` in `createOmpHost`.

- [ ] **Step 4: Gate** — `bun test && bun run type-check` (workdir `packages/omp-adapter`).
- [ ] **Step 5: Commit** — `feat(omp): resolve the bundled omp binary`.

---

### Task 3: Package the binary, drop OpenCode bundling, update main.mjs

**Files:** Modify `packages/electron/package.json`, `packages/electron/main.mjs`; delete the OpenCode files.

- [ ] **Step 1: `package.json`**
  - Delete `"opencodeCli": { "version": "2.0.18" }`.
  - Scripts: replace `"prepare:opencode-cli"` with `"prepare:omp-cli": "node ./scripts/prepare-omp-cli.mjs"`; delete `"verify:opencode-cli"` and `"verify:opencode-cli:packaged"`; drop `verify-opencode-cli.test.mjs` from `test:architecture` if listed.
  - `"package"`: `... && bun run prepare:omp-cli && bundle:main ...`.
  - `extraResources`: replace the `opencode-cli` entry with `{ "from": "resources/omp-cli", "to": "omp-cli" }`.

- [ ] **Step 2: Delete files**

```bash
git rm packages/electron/scripts/prepare-opencode-cli.mjs \
  packages/electron/scripts/opencode-cli-version.mjs \
  packages/electron/scripts/verify-opencode-cli.mjs \
  packages/electron/scripts/verify-opencode-cli.test.mjs \
  packages/electron/opencode-cwd.mjs packages/electron/opencode-cwd.test.mjs \
  packages/electron/opencode-readiness.mjs packages/electron/opencode-readiness.test.mjs
```

- [ ] **Step 3: Sweep references**

```bash
grep -rn "opencode-cli\|opencodeCli\|prepare-opencode\|opencode-cwd\|opencode-readiness\|opencode-cli-version\|verify-opencode\|OPENCHAMBER_OPENCODE_CWD\|resolveManagedOpenCodeCwd" packages/electron
```

Delete `OPENCHAMBER_OPENCODE_CWD` assignment in `main.mjs` (line ~1300) and its import of `./opencode-cwd.mjs`; the consumer was the P3-deleted OpenCode lifecycle. If `main.mjs` still reads the bundled OpenCode dir anywhere, remove it.

- [ ] **Step 4: Ensure the server can find the binary under Electron.** The server (Node) resolves via `resolveOmpCommand`, which reads `process.resourcesPath`. Confirm the server runs in the Electron main process (it does — `@openchamber/web` imported at `main.mjs:~1314`), so `process.resourcesPath` is available. No `main.mjs` change is needed unless a preview/dev path must set `OPENCHAMBER_OMP_PATH`.

- [ ] **Step 5: Gate** — `bun run --cwd packages/electron type-check` (`node --check` on entries) and `grep` returns no hits.
- [ ] **Step 6: Commit** — `build(electron): bundle omp and drop opencode bundling`.

---

### Task 4: Package and run

**Files:** none.

- [ ] **Step 1:** `bun run --cwd packages/electron package` — build succeeds and `resources/omp-cli/omp` is included.
- [ ] **Step 2:** Launch (`bun run --cwd packages/electron dev` or the packaged app), create a session, send a prompt. Expect the bundled `omp --mode rpc` to stream.
- [ ] **Step 3:** Confirm the resolved path is the bundled one (temporary debug log).
- [ ] **Step 4: Report** — build, session, resolved path. No commit.

---

## Self-Review

- **Spec coverage:** "prepare-omp-cli.mjs from GitHub releases", "extraResources
  resources/omp-cli", "binary resolution mirroring env-runtime.js", "remove
  prepare-opencode-cli / opencode-cwd / opencode-readiness" — Tasks 1–3.
- **Placeholder scan:** no TBD; tag/artifact uncertainty stated as a verify constraint.
- **Type consistency:** `resolveOmpCommand` exported + used; `omp-cli` `to` name matches `path.join(resourcesPath, "omp-cli")`; P1 no longer defines `resolveCommand`.
