#!/usr/bin/env node
/**
 * macOS launcher release: build the signed, notarized DMG (Electron shell, packaged Node.js
 * runtime, and the current app bundle) and publish it to Cloudflare R2 under downloads/ plus
 * downloads/latest.json (read by __APP_DOMAIN__/download and /download/mac).
 *
 * The app bundle is staged by `desktop`'s prebuild (`scripts/stage-seed-bundle.mjs`) into
 * `desktop/resources/seed-bundle/` before electron-builder packages the DMG.
 *
 * Usage: pnpm release:desktop [--dry-run]
 * Signing: scripts/deploy/apple-signing.env (APPLE_SIGNING_IDENTITY), else the first
 * "Developer ID Application" identity in the keychain.
 * Notarization: electron-builder notarizes and staples the .app; scripts/deploy/notarize-dmg.sh
 * then notarizes and staples the DMG itself. Credentials are required (App Store Connect API
 * key, or Apple ID + app-specific password).
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
import { parseEnvFile } from './ota-credentials.mjs';
import { pnpmSpawn } from './pnpm.mjs';
import { findBundledSeedVersion } from './stage-seed-bundle.mjs';
import { r2BaseUrl, r2Put } from './r2.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');

/**
 * Sanity cap. The DMG carries Electron, the Node runtime, and the current app bundle (a zipped
 * Next.js standalone server), so it is well past a launcher-only budget.
 */
const MAX_DMG_BYTES = 500_000_000;

const desktopRoot = join(root, 'desktop');
const pkg = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8'));

/**
 * Read one scalar out of electron-builder.yml so the product name and minimum OS live in exactly
 * one place. Too small a need to pull in a YAML parser.
 */
const builderYml = readFileSync(join(desktopRoot, 'electron-builder.yml'), 'utf8');
function builderValue(key) {
  const match = builderYml.match(
    new RegExp(String.raw`^\s*${key}:[ \t]*(?:'([^']*)'|"([^"]*)"|([^#\n]+?))[ \t]*$`, 'm'),
  );
  if (!match) fail(`electron-builder.yml has no ${key}`);
  return match[1] ?? match[2] ?? match[3];
}

const productName = builderValue('productName');
const minimumSystemVersion = builderValue('minimumSystemVersion');
const version = pkg.version;
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const releaseDir = join(desktopRoot, 'release');
const appPath = join(releaseDir, arch === 'arm64' ? 'mac-arm64' : 'mac', `${productName}.app`);
const dmgName = `${productName}_${version}_${arch}.dmg`;
const dmgPath = join(releaseDir, dmgName);
const staging = join(root, '.desktop-staging');

function fail(message) {
  console.error(`[release-desktop] ${message}`);
  process.exit(1);
}

function run(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8' });
}

function expandEnvRefs(value) {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => process.env[name] ?? '');
}

/** Load gitignored scripts/deploy/apple-signing.env without overriding the shell. */
function loadAppleSigningEnv() {
  const file = join(root, 'scripts', 'deploy', 'apple-signing.env');
  if (!existsSync(file)) {
    fail(
      'missing scripts/deploy/apple-signing.env — copy scripts/deploy/apple-signing.env.example and fill in Developer ID + notarization credentials',
    );
  }
  const parsed = parseEnvFile(file);
  for (const [key, value] of Object.entries(parsed)) {
    if (!process.env[key]) process.env[key] = value;
  }
  for (const key of Object.keys(parsed)) {
    if (process.env[key]) process.env[key] = expandEnvRefs(process.env[key]);
  }
  // electron-builder and notarytool both want an absolute path to the .p8 key.
  const keyPath = process.env.APPLE_API_KEY?.trim();
  if (keyPath && !keyPath.startsWith('/')) {
    process.env.APPLE_API_KEY = join(dirname(file), keyPath);
  }
  console.log(`[release-desktop] loaded Apple signing env from ${file}`);
}

function hasNotaryAuth() {
  const keyPath = process.env.APPLE_API_KEY?.trim();
  if (keyPath && existsSync(keyPath) && process.env.APPLE_API_KEY_ID?.trim() && process.env.APPLE_API_ISSUER?.trim()) {
    return true;
  }
  if (process.env.NOTARYTOOL_PROFILE?.trim()) return true;
  return Boolean(
    process.env.APPLE_ID?.trim() &&
      process.env.APPLE_APP_SPECIFIC_PASSWORD?.trim() &&
      process.env.APPLE_TEAM_ID?.trim(),
  );
}

loadAppleSigningEnv();
if (!hasNotaryAuth()) {
  fail(
    'notarization credentials missing in scripts/deploy/apple-signing.env (API key, or Apple ID + app-specific password)',
  );
}

// electron-builder notarizes with the API key when all three vars are set. Drop Apple ID auth
// so it does not prefer an app-specific password over the key.
const buildEnv = { ...process.env };
if (buildEnv.APPLE_API_ISSUER && buildEnv.APPLE_API_KEY && buildEnv.APPLE_API_KEY_ID) {
  delete buildEnv.APPLE_ID;
  delete buildEnv.APPLE_PASSWORD;
  delete buildEnv.APPLE_APP_SPECIFIC_PASSWORD;
  delete buildEnv.NOTARYTOOL_PROFILE;
}

// 1. Signing identity.
let identity = process.env.APPLE_SIGNING_IDENTITY?.trim();
if (!identity) {
  const found = run('security', ['find-identity', '-v', '-p', 'codesigning']).stdout ?? '';
  identity = found.match(/"(Developer ID Application: [^"]+)"/)?.[1];
}
if (!identity) fail('no "Developer ID Application" signing identity found in the keychain');
console.log(`[release-desktop] signing as ${identity}`);
buildEnv.CSC_NAME = identity;
buildEnv.APPLE_SIGNING_IDENTITY = identity;

// 2. Stage the Node.js runtime, then build the .app + .dmg (desktop prebuild stages the seed).
try {
  await stageNodeRuntime(hostTargetTriple());
} catch (err) {
  fail(`Node.js runtime: ${err instanceof Error ? err.message : err}`);
}
rmSync(dmgPath, { force: true });
const build = spawnSync(...pnpmSpawn(['--dir', desktopRoot, 'run', 'build', '--', `--${arch}`]), {
  cwd: root,
  stdio: 'inherit',
  env: buildEnv,
});
if (build.status !== 0) fail('electron-builder failed');
if (!existsSync(dmgPath)) fail(`expected ${dmgPath}`);
if (!existsSync(appPath)) fail(`expected ${appPath}`);

const resources = join(appPath, 'Contents', 'Resources');
const seeded = findBundledSeedVersion([resources, appPath]);
if (!seeded) {
  fail('DMG is missing the seeded app bundle (Resources/seed-bundle/version + bundle.zip)');
}
console.log(
  `[release-desktop] installer includes app bundle v${seeded.version} (${(statSync(seeded.zip).size / 1_048_576).toFixed(1)} MB)`,
);

// 3. Signature, and the signed runtime still runs (hardened runtime + JIT).
const verify = run('codesign', ['--verify', '--deep', '--strict', appPath]);
if (verify.status !== 0) fail(`codesign verification failed:\n${verify.stderr}`);
const nodePath = join(resources, 'node');
if (!existsSync(nodePath)) fail(`packaged Node.js runtime missing at ${nodePath}`);
const nodeSigned = run('codesign', ['--verify', '--strict', nodePath]);
if (nodeSigned.status !== 0) {
  fail(`the packaged Node.js runtime is not signed:\n${nodeSigned.stderr}`);
}
const runtime = run(nodePath, ['-p', 'process.versions.node + " " + process.versions.modules']);
if (runtime.stdout?.trim() !== `${NODE_VERSION} ${NODE_MODULE_VERSION}`) {
  fail(
    `packaged Node.js runtime check failed: ${runtime.error?.message ?? (runtime.stderr || runtime.stdout)}`,
  );
}
console.log(`[release-desktop] packaged Node v${NODE_VERSION} (ABI ${NODE_MODULE_VERSION}) runs`);

// 4. electron-builder notarizes and staples the .app. The DMG needs its own submit + staple.
if (run('xcrun', ['stapler', 'validate', dmgPath]).status !== 0) {
  const notarize = spawnSync('bash', [join(root, 'scripts', 'deploy', 'notarize-dmg.sh')], {
    cwd: root,
    stdio: 'inherit',
    env: buildEnv,
  });
  if (notarize.status !== 0) fail('DMG notarization failed');
}

// 5. Size budget.
const size = statSync(dmgPath).size;
console.log(`[release-desktop] ${dmgName}: ${(size / 1_000_000).toFixed(2)} MB`);
if (size > MAX_DMG_BYTES) {
  fail(`DMG is ${(size / 1_000_000).toFixed(2)} MB — over the ${MAX_DMG_BYTES / 1_000_000} MB budget`);
}

// 6. Gatekeeper must see a notarized Developer ID before anything is published.
const assessment = run('spctl', ['--assess', '--type', 'execute', '-vv', appPath]);
const dmgAssessment = run('spctl', ['-a', '-vv', '-t', 'install', dmgPath]);
const notarized = /source=Notarized Developer ID/.test(
  `${assessment.stdout}${assessment.stderr}${dmgAssessment.stdout}${dmgAssessment.stderr}`,
);
console.log(`[release-desktop] signature ok · notarized: ${notarized}`);
if (!notarized) {
  fail(
    `Gatekeeper does not see a notarized Developer ID.\napp: ${assessment.stderr || assessment.stdout}\ndmg: ${dmgAssessment.stderr || dmgAssessment.stdout}`,
  );
}

// 7. Publish under the DMG's own file name. A name is one file, so there is no hash folder.
const dmgBytes = readFileSync(dmgPath);
const sha256 = createHash('sha256').update(dmgBytes).digest('hex');
const key = `downloads/${dmgName}`;
const latest = {
  version,
  arch,
  minimumSystemVersion,
  url: `${r2BaseUrl}/${key}`,
  size,
  sha256,
  notarized,
  bundleVersion: seeded.version,
  releaseDate: new Date().toISOString(),
};

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
const latestPath = join(staging, 'latest.json');
writeFileSync(latestPath, `${JSON.stringify(latest, null, 2)}\n`);
console.log('[release-desktop] latest.json:', latest);

if (dryRun) {
  console.log('[release-desktop] --dry-run: skipping upload');
  process.exit(0);
}

if (
  !r2Put(key, dmgPath, 'application/x-apple-diskimage', 'public, max-age=31536000, immutable', {
    contentDisposition: `attachment; filename="${dmgName}"`,
  })
) {
  fail('DMG upload failed. Fix auth (.env or wrangler login) and retry.');
}
if (!r2Put('downloads/latest.json', latestPath, 'application/json', 'no-cache')) {
  fail('latest.json upload failed after the DMG was uploaded; rerun to publish it.');
}

console.log('[release-desktop] done →', latest.url);
