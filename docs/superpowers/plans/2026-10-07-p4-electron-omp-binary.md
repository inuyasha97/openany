# Phase 4: Electron OMP binary + OpenCode bundling removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bundle the OMP standalone binary into the desktop app and spawn it via RPC, and remove the OpenCode CLI bundling and readiness code.

**Architecture:** Mirror the existing OpenCode handling: a `prepare-*.mjs` script stages a per-platform executable at build time into `resources/`, electron-builder ships it via `extraResources`, and the server resolves it (bundled resources path first, then env, then `PATH`). The OMP binary is a standalone executable (Bun embedded), so it runs under Node with no Bun install.

**Tech Stack:** Node `child_process`/`fetch`, electron-builder `extraResources`, the P1 RPC adapter.

**Spec:** `docs/superpowers/specs/2026-10-07-omp-only-runtime-design.md`

## Global Constraints

- Pinned OMP version: **18.1.11** (`OPENCHAMBER_OMP_CLI_VERSION` overrides).
- Verify the release tag and artifact naming against the real GitHub release before trusting the URLs in this plan (`can1357/oh-my-pi`).
- Desktop runs the OpenChamber server in-process under Node; the OMP binary is spawned as a child, never bundled into the JS bundle.
- Do not modify `../opencode`.

## File Structure

- `packages/electron/scripts/prepare-omp-cli.mjs` — create. Download + stage `omp`.
- `packages/electron/scripts/prepare-opencode-cli.mjs` — delete.
- `packages/electron/scripts/opencode-cli-version.mjs`, `verify-opencode-cli.mjs` — delete.
- `packages/electron/opencode-cwd.mjs`, `opencode-readiness.mjs` (+ tests) — delete.
- `packages/electron/package.json` — modify. Scripts + `extraResources` + drop `opencodeCli`.
- `packages/omp-adapter/src/rpc-host.ts` — modify. Bundle-path resolution.

---

### Task 1: `prepare-omp-cli.mjs`

**Files:**
- Create: `packages/electron/scripts/prepare-omp-cli.mjs`

**Interfaces:**
- Produces: an executable at `packages/electron/resources/omp-cli/<binary>` where `<binary>` is `omp` (POSIX) or `omp.exe` (Windows); prints the prepared version.

- [ ] **Step 1: Write the script**

Create `packages/electron/scripts/prepare-omp-cli.mjs`:

```js
#!/usr/bin/env node
/**
 * Stage the OMP standalone binary for the desktop build.
 *
 * OMP ships prebuilt, Bun-embedded executables per platform on GitHub
 * releases. This mirrors `prepare-opencode-cli.mjs`: download the matching
 * artifact, verify it runs, stage it under resources/omp-cli, and ship it via
 * extraResources. The server spawns it with `--mode rpc`.
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

const artifactForPlatform = (platform, arch) => {
  if (platform === 'win32') return { name: `omp-windows-${arch}.exe`, binary: 'omp.exe' };
  const suffix = platform === 'darwin' ? 'darwin' : 'linux';
  return { name: `omp-${suffix}-${arch}`, binary: 'omp' };
};

const targetArch = () => {
  const arch = resolveTargetArchitecture().opencode; // 'arm64' | 'x64'
  return arch;
};

const readVersion = (binaryPath) => {
  if (!fs.existsSync(binaryPath)) return null;
  const result = spawnSync(binaryPath, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, windowsHide: true });
  if (result.status !== 0) return null;
  return String(result.stdout).trim() || null;
};

const main = async () => {
  if (!/^\d+\.\d+\.\d+/.test(OMP_CLI_VERSION)) throw new Error(`Invalid OMP CLI version: ${OMP_CLI_VERSION}`);
  const artifact = artifactForPlatform(process.platform, targetArch());
  const outputBinary = path.join(outputDir, artifact.binary);
  const versionTag = OMP_CLI_VERSION.startsWith('v') ? OMP_CLI_VERSION : `v${OMP_CLI_VERSION}`;
  const cacheDir = path.join(cacheRoot, OMP_CLI_VERSION, `${process.platform}-${targetArch()}`);
  const archivePath = path.join(cacheDir, artifact.name);
  const url = `https://github.com/can1357/oh-my-pi/releases/download/${versionTag}/${artifact.name}`;

  fs.mkdirSync(cacheDir, { recursive: true });
  if (!fs.existsSync(archivePath)) {
    console.log(`[electron] downloading OMP CLI ${OMP_CLI_VERSION}: ${artifact.name}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
    fs.writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
  }

  fs.mkdirSync(outputDir, { recursive: true });
  fs.copyFileSync(archivePath, outputBinary);
  if (process.platform !== 'win32') fs.chmodSync(outputBinary, 0o755);

  const prepared = readVersion(outputBinary);
  console.log(`[electron] prepared OMP CLI ${OMP_CLI_VERSION}: ${outputBinary} (${prepared || 'version unknown'})`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
```

- [ ] **Step 2: Run it (requires network)**

Run: `node ./scripts/prepare-omp-cli.mjs` (workdir `packages/electron`)
Expected: downloads and stages `resources/omp-cli/omp`, prints a version.

- [ ] **Step 3: Verify the binary starts**

Run: `packages/electron/resources/omp-cli/omp --version`
Expected: a version string.

- [ ] **Step 4: Commit**

```bash
git add packages/electron/scripts/prepare-omp-cli.mjs
git commit -m "build(electron): stage the omp standalone binary"
```

---

### Task 2: Resolve the bundled OMP binary in the adapter

**Files:**
- Modify: `packages/omp-adapter/src/rpc-host.ts`
- Test: `packages/omp-adapter/src/rpc-host.test.ts`

**Interfaces:**
- Consumes: `resolveCommand` (P1).
- Produces: `resolveCommand` order becomes `OPENCHAMBER_OMP_PATH` -> `OPENCHAMBER_OMP_BIN` -> `OMP_BINARY` -> bundled `OPENCHAMBER_BUNDLED_OMP_CLI_DIR/omp` -> `process.resourcesPath/omp-cli/omp` -> `"omp"`.

- [ ] **Step 1: Write the failing test**

Add to `packages/omp-adapter/src/rpc-host.test.ts`:

```ts
import { resolveOmpCommand } from "./rpc-host"

describe("resolveOmpCommand", () => {
  test("prefers an explicit env path", () => {
    expect(resolveOmpCommand({ env: { OPENCHAMBER_OMP_PATH: "/opt/omp" }, resourcesPath: "/res", exists: () => true })).toBe("/opt/omp")
  })
  test("falls back to the bundled binary under resourcesPath", () => {
    expect(resolveOmpCommand({ env: {}, resourcesPath: "/res", exists: (p) => p === "/res/omp-cli/omp" })).toBe("/res/omp-cli/omp")
  })
  test("falls back to PATH lookup name", () => {
    expect(resolveOmpCommand({ env: {}, resourcesPath: null, exists: () => false })).toBe("omp")
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/rpc-host.test.ts`
Expected: FAIL — `resolveOmpCommand` not exported.

- [ ] **Step 3: Implement it**

In `packages/omp-adapter/src/rpc-host.ts`:

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
  const resourcesPath = options.resourcesPath === undefined ? (process as { resourcesPath?: string }).resourcesPath ?? null : options.resourcesPath
  const binaryName = process.platform === "win32" ? "omp.exe" : "omp"
  const bundledRoots = [env.OPENCHAMBER_BUNDLED_OMP_CLI_DIR, resourcesPath ? path.join(resourcesPath, "omp-cli") : null]
  for (const root of bundledRoots) {
    if (!root) continue
    const candidate = path.join(root, binaryName)
    if (exists(candidate)) return candidate
  }
  return explicit[0] ?? "omp"
}
```

Replace `resolveCommand` usage in `createOmpHost` with `resolveOmpCommand({ env: options.env })`.

- [ ] **Step 4: Run tests**

Run: `bun test && bun run type-check` (workdir `packages/omp-adapter`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/omp-adapter/src/rpc-host.ts packages/omp-adapter/src/rpc-host.test.ts
git commit -m "feat(omp): resolve the bundled omp binary for desktop"
```

---

### Task 3: Package the binary, drop OpenCode bundling

**Files:**
- Modify: `packages/electron/package.json`
- Delete: `packages/electron/scripts/prepare-opencode-cli.mjs`, `packages/electron/scripts/opencode-cli-version.mjs`, `packages/electron/scripts/verify-opencode-cli.mjs`, `packages/electron/scripts/verify-opencode-cli.test.mjs`, `packages/electron/opencode-cwd.mjs`, `packages/electron/opencode-cwd.test.mjs`, `packages/electron/opencode-readiness.mjs`, `packages/electron/opencode-readiness.test.mjs`

**Interfaces:**
- Produces: `package` script stages OMP, not OpenCode; `extraResources` ships `resources/omp-cli`.

- [ ] **Step 1: Update `package.json`**

- Remove the `"opencodeCli": { "version": "2.0.18" }` block.
- Replace scripts:
  - `"prepare:opencode-cli"` -> `"prepare:omp-cli": "node ./scripts/prepare-omp-cli.mjs"`.
  - Delete `"verify:opencode-cli"` and `"verify:opencode-cli:packaged"`.
- In `"package"`, replace `bun run prepare:opencode-cli` with `bun run prepare:omp-cli`.
- In `"extraResources"`, replace `{ "from": "resources/opencode-cli", "to": "opencode-cli" }` with `{ "from": "resources/omp-cli", "to": "omp-cli" }`.
- Update `test:architecture` to drop the deleted `verify-opencode-cli.test.mjs` if it is listed.

- [ ] **Step 2: Delete the OpenCode-only files**

```bash
git rm packages/electron/scripts/prepare-opencode-cli.mjs \
  packages/electron/scripts/opencode-cli-version.mjs \
  packages/electron/scripts/verify-opencode-cli.mjs \
  packages/electron/scripts/verify-opencode-cli.test.mjs \
  packages/electron/opencode-cwd.mjs packages/electron/opencode-cwd.test.mjs \
  packages/electron/opencode-readiness.mjs packages/electron/opencode-readiness.test.mjs
```

- [ ] **Step 3: Find remaining references and remove them**

```bash
grep -rn "opencode-cli\|opencodeCli\|prepare-opencode\|opencode-cwd\|opencode-readiness\|opencode-cli-version\|verify-opencode" packages/electron
```

Repoint every hit to the OMP equivalent or delete it. `main.mjs` sets `OPENCHAMBER_OPENCODE_CWD`; if the removal of the OpenCode spawn path (P3 sub-phase B) already dropped its consumer, delete that line too.

- [ ] **Step 4: Syntax-check the main bundle sources**

Run: `bun run --cwd packages/electron type-check`
Expected: PASS (`node --check` on the four entry files).

- [ ] **Step 5: Commit**

```bash
git add packages/electron/package.json packages/electron/main.mjs packages/electron/scripts
git commit -m "build(electron): bundle omp and drop opencode bundling"
```

---

### Task 4: Package and run the desktop build

**Files:** none (verification task).

- [ ] **Step 1: Build the app**

Run: `bun run --cwd packages/electron package`
Expected: build succeeds; `resources/omp-cli/omp` is staged and included.

- [ ] **Step 2: Launch and run a session**

Start the packaged app (or `bun run --cwd packages/electron dev`), create a session, send a prompt.
Expected: the desktop boots the server under Node, spawns the bundled `omp --mode rpc`, and the message streams.

- [ ] **Step 3: Confirm the resolution path**

Log the resolved command at debug level (or temporarily) and confirm it is the bundled path, not the system `omp`.

- [ ] **Step 4: Report**

Record build result, session result, and the resolved binary path. No commit.

---

## Self-Review

- **Spec coverage:** "prepare-omp-cli.mjs from GitHub releases", "extraResources
  add resources/omp-cli", "binary resolution mirroring env-runtime.js", "remove
  prepare-opencode-cli / opencode-cwd / opencode-readiness" — Tasks 1–3.
- **Placeholder scan:** no TBD; the release-tag/artifact-name uncertainty is
  called out as a verify-before-trust constraint.
- **Type consistency:** `resolveOmpCommand` is exported and tested; `createOmpHost`
  calls it; the extraResources `to` name (`omp-cli`) matches the resolution
  `path.join(resourcesPath, "omp-cli")`.
