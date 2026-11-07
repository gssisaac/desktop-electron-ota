#!/usr/bin/env node
/**
 * Windows launcher release: build the NSIS installer (Electron shell, packaged node.exe, and the
 * current app bundle) and publish it to Cloudflare R2 under downloads/ plus
 * downloads/latest-windows.json (read by __APP_DOMAIN__/download and /download/windows).
 *
 * The app bundle is staged by `desktop`'s prebuild (`scripts/stage-seed-bundle.mjs`).
 *
 * Usage: pnpm release:desktop:windows [--dry-run]   (on Windows x64)
 * The installer is not Authenticode-signed yet (`notarized: false`), so the download page shows
 * a SmartScreen hint. The launcher installs engines from manifest-windows-x64.json, which
 * `pnpm release:ota <version>` publishes when run on Windows.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NODE_MODULE_VERSION,
  NODE_VERSION,
  hostTargetTriple,
  stageNodeRuntime,
} from './prepare-node-runtime.mjs';
import { pnpmSpawn } from './pnpm.mjs';
import { findBundledSeedVersion } from './stage-seed-bundle.mjs';
import { r2BaseUrl, r2Put } from './r2.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');

/** Electron + the Node runtime + the zipped app bundle. */
const MAX_INSTALLER_BYTES = 500_000_000;

const desktopRoot = join(root, 'desktop');
const pkg = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8'));

function fail(message) {
  console.error(`[release-desktop-windows] ${message}`);
  process.exit(1);
}

/** Read one scalar out of electron-builder.yml (same helper as the macOS release script). */
const builderYml = readFileSync(join(desktopRoot, 'electron-builder.yml'), 'utf8');
function builderValue(key) {
  const match = builderYml.match(
    new RegExp(String.raw`^\s*${key}:[ \t]*(?:'([^']*)'|"([^"]*)"|([^#\n]+?))[ \t]*$`, 'm'),
  );
  if (!match) fail(`electron-builder.yml has no ${key}`);
  return match[1] ?? match[2] ?? match[3];
}

const productName = builderValue('productName');
const version = pkg.version;
const arch = 'x64';
const releaseDir = join(desktopRoot, 'release');
const unpackedDir = join(releaseDir, 'win-unpacked');
const installerName = `${productName}_${version}_${arch}-setup.exe`;
const installerPath = join(releaseDir, installerName);
const staging = join(root, '.desktop-staging');

if (process.platform !== 'win32' || process.arch !== 'x64') {
  fail(`run this on Windows x64 (this is ${process.platform}-${process.arch})`);
}

// 1. Stage the Node.js runtime, then build the NSIS installer (desktop prebuild stages the seed).
try {
  await stageNodeRuntime(hostTargetTriple());
} catch (err) {
  fail(`Node.js runtime: ${err instanceof Error ? err.message : err}`);
}
rmSync(installerPath, { force: true });
const build = spawnSync(...pnpmSpawn(['--dir', desktopRoot, 'run', 'build', '--', '--x64']), {
  cwd: root,
  stdio: 'inherit',
});
if (build.status !== 0) fail('electron-builder failed');
if (!existsSync(installerPath)) fail(`expected ${installerPath}`);

const resources = join(unpackedDir, 'resources');
const seeded = findBundledSeedVersion([resources, unpackedDir]);
if (!seeded) {
  fail('installer is missing the seeded app bundle (resources/seed-bundle/version + bundle.zip)');
}
console.log(
  `[release-desktop-windows] installer includes app bundle v${seeded.version} (${(statSync(seeded.zip).size / 1_048_576).toFixed(1)} MB)`,
);

// 2. Size budget.
const size = statSync(installerPath).size;
console.log(`[release-desktop-windows] ${installerName}: ${(size / 1_000_000).toFixed(2)} MB`);
if (size > MAX_INSTALLER_BYTES) {
  fail(
    `installer is ${(size / 1_000_000).toFixed(2)} MB — over the ${MAX_INSTALLER_BYTES / 1_000_000} MB budget`,
  );
}

// 3. The runtime packaged beside __APP_NAME__.exe still runs.
const nodePath = join(resources, 'node.exe');
if (!existsSync(nodePath)) fail(`packaged Node.js runtime missing at ${nodePath}`);
const runtime = spawnSync(nodePath, ['-p', 'process.versions.node + " " + process.versions.modules'], {
  encoding: 'utf8',
});
if (runtime.stdout?.trim() !== `${NODE_VERSION} ${NODE_MODULE_VERSION}`) {
  fail(
    `packaged Node.js runtime check failed: ${runtime.error?.message ?? (runtime.stderr || runtime.stdout)}`,
  );
}
console.log(
  `[release-desktop-windows] packaged Node v${NODE_VERSION} (ABI ${NODE_MODULE_VERSION}) runs`,
);

// 4. Publish under the installer's own file name. A name is one file, so there is no hash folder.
const installerBytes = readFileSync(installerPath);
const sha256 = createHash('sha256').update(installerBytes).digest('hex');
const key = `downloads/${installerName}`;
const latest = {
  version,
  arch,
  minimumSystemVersion: '10',
  url: `${r2BaseUrl}/${key}`,
  size,
  sha256,
  notarized: false,
  bundleVersion: seeded.version,
  releaseDate: new Date().toISOString(),
};

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
const latestPath = join(staging, 'latest-windows.json');
writeFileSync(latestPath, `${JSON.stringify(latest, null, 2)}\n`);
console.log('[release-desktop-windows] latest-windows.json:', latest);

if (dryRun) {
  console.log('[release-desktop-windows] --dry-run: skipping upload');
  process.exit(0);
}

if (
  !r2Put(
    key,
    installerPath,
    'application/vnd.microsoft.portable-executable',
    'public, max-age=31536000, immutable',
    { contentDisposition: `attachment; filename="${installerName}"` },
  )
) {
  fail('installer upload failed. Fix auth (.env or wrangler login) and retry.');
}
if (!r2Put('downloads/latest-windows.json', latestPath, 'application/json', 'no-cache')) {
  fail('latest-windows.json upload failed after the installer was uploaded; rerun to publish it.');
}

console.log('[release-desktop-windows] done →', latest.url);
