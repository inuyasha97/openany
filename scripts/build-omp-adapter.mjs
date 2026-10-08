/**
 * Compile the OMP adapter to plain JavaScript.
 *
 * The adapter is TypeScript with extensionless relative imports, which only Bun
 * can load. The web server imports it at runtime, and on Electron the server
 * runs inside the same Node process — Node's ESM loader rejects both the
 * extensionless specifiers and (outside its experimental type stripping) the
 * `.ts` entry, so the desktop answered every `/api/agents/omp/*` request with
 * ERR_MODULE_NOT_FOUND.
 *
 * Bundling the package to `dist/index.js` removes the whole problem: one ESM
 * file, no relative specifiers left to resolve, no TypeScript to strip. Bun
 * still runs `src/index.ts` directly in development, but the runtime entry
 * point every surface imports is the built file.
 *
 * The adapter's type-only imports of the canonical UI types are erased by the
 * build, so the bundle carries no cross-package import at runtime.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const packageRoot = path.join(root, 'packages', 'omp-adapter');
const outdir = path.join(packageRoot, 'dist');

// Bun.build is the only bundler in this repo's toolchain that reads the
// adapter's `.ts` sources without a separate config; `package.json` scripts run
// this file through Bun.
const result = await Bun.build({
  entrypoints: [path.join(packageRoot, 'src', 'index.ts')],
  outdir,
  target: 'node',
  format: 'esm',
  minify: false,
  sourcemap: 'none',
  naming: '[name].js',
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
});

if (!result.success) {
  for (const message of result.logs) console.error(message);
  process.exit(1);
}

const entry = path.join(outdir, 'index.js');
if (!fs.existsSync(entry)) {
  console.error(`[omp-adapter] build produced no ${entry}`);
  process.exit(1);
}

console.log(`[omp-adapter] bundled -> ${path.relative(root, entry)}`);
