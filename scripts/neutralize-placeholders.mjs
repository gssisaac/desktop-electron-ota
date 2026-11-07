#!/usr/bin/env node
/**
 * One-time helper when refreshing this boilerplate from a product repo. Replaces
 * product-specific strings with `__APP_*__` tokens. Not run in consumer projects — agents
 * replace the tokens there instead.
 *
 * Edit the pairs below to match the product you are copying from.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const SKIP = new Set(['neutralize-placeholders.mjs', 'pnpm-lock.yaml']);
const SKIP_DIRS = new Set(['node_modules', 'release', '.node-cache', '.git', '.ota', '.ota-staging']);
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.yml', '.yaml', '.html', '.css', '.md', '.sh',
  '.plist', '.example', '.gitignore', '.npmrc',
]);

const PLACEHOLDER_PUBLIC_KEY = '0'.repeat(64);

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

function transform(content, file) {
  let s = content;
  s = s.replace(/dev\.tablepad\.desktop/g, '__APP_IDENTIFIER__');
  s = s.replace(/https:\/\/bundles\.tablepad\.dev/g, 'https://bundles.__APP_DOMAIN__');
  s = s.replace(/bundles\.tablepad\.dev/g, 'bundles.__APP_DOMAIN__');
  s = s.replace(/tablepad-bundles/g, '__APP_SLUG__-bundles');
  s = s.replace(/tablepad\.dev/g, '__APP_DOMAIN__');
  s = s.replace(/TablePad/g, '__APP_NAME__');
  s = s.replace(/tablepad-/g, '__APP_SLUG__-');
  s = s.replace(/tablepad/g, '__APP_SLUG__');
  s = s.replace(/TABLEPAD/g, '__APP_SLUG_UPPER__');
  s = s.replace(/47147/g, '__APP_PORT_PROD__');
  s = s.replace(/47144/g, '__APP_PORT_DEV__');
  s = s.replace(
    /CLOUDFLARE_ACCOUNT_ID: process\.env\.CLOUDFLARE_ACCOUNT_ID \|\| '[^']+'/,
    'CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID',
  );
  if (file.endsWith('crypto.mjs')) {
    s = s.replace(/'[0-9a-f]{64}'/g, `'${PLACEHOLDER_PUBLIC_KEY}'`);
  }
  return s;
}

for (const file of walk(root)) {
  const base = basename(file);
  if (SKIP.has(base)) continue;
  if (!TEXT_EXT.has(extname(file)) && base !== 'package.json' && base !== '.gitignore') continue;
  const before = readFileSync(file, 'utf8');
  const after = transform(before, file);
  if (after !== before) writeFileSync(file, after);
}

console.log('[neutralize] done');
