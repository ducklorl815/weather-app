/**
 * [Important]
 * 對照 runtime loadFile / HTML 靜態資源，檢查是否都有被 electron-builder files 打包。
 * 用法：node scripts/verify-pack-files.js
 *       npm run verify:pack
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const fileGlobs = pkg.build?.files || [];

/** electron-builder 預設會帶入 package.json */
const ALWAYS_PACKAGED = new Set(['package.json']);

function isPackaged(relPosix) {
  const rel = relPosix.replace(/\\/g, '/');
  if (ALWAYS_PACKAGED.has(rel)) return true;
  return fileGlobs.some((g) => {
    const glob = String(g).replace(/\\/g, '/');
    if (glob === rel) return true;
    if (glob.endsWith('/**/*')) {
      const prefix = glob.slice(0, -'/**/*'.length);
      return rel === prefix || rel.startsWith(prefix + '/');
    }
    if (glob.endsWith('/*')) {
      const prefix = glob.slice(0, -'/*'.length);
      return rel.startsWith(prefix + '/') && !rel.slice(prefix.length + 1).includes('/');
    }
    return false;
  });
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === '.git' || ent.name === '.refactor-backup') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function normalizeAsset(raw) {
  let rel = String(raw || '').trim().split('?')[0].split('#')[0].replace(/\\/g, '/');
  if (!rel || rel.includes('${') || rel.includes('://') || rel.startsWith('/') || rel.startsWith('data:')) return null;
  // require('update-config') → update-config.js
  if (!path.extname(rel) && fs.existsSync(path.join(ROOT, rel + '.js'))) rel += '.js';
  return rel;
}

const required = new Set();

const mainFiles = walk(path.join(ROOT, 'main')).concat([path.join(ROOT, 'main.js')]);
const loadRe = /(?:loadFile|require)\(\s*path\.join\(\s*APP_ROOT\s*,\s*['"]([^'"]+)['"]/g;
for (const file of mainFiles) {
  if (!file.endsWith('.js')) continue;
  const text = fs.readFileSync(file, 'utf8');
  let m;
  while ((m = loadRe.exec(text))) {
    const rel = normalizeAsset(m[1]);
    if (rel) required.add(rel);
  }
}

const htmlRoots = [
  'index.html',
  'gchat-toast.html',
  'gchat-reply-pop.html',
  'gchat-reply-bar.html',
  'gchat-quick-search-pop.html',
  'sites-dept-org.html'
];
const assetRe = /(?:src|href)=["'](?!https?:|data:|chrome:|#|mailto:)([^"']+)["']/gi;
for (const rel of htmlRoots) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) {
    console.error(`MISSING ON DISK: ${rel}`);
    continue;
  }
  required.add(rel);
  const text = fs.readFileSync(full, 'utf8');
  let m;
  while ((m = assetRe.exec(text))) {
    const asset = normalizeAsset(m[1]);
    if (asset) required.add(asset);
  }
}

[
  'gchat-emoji-catalog.js',
  'gchat-emoji-picker.js',
  'preload.js',
  'update-config.js',
  'dist-features.json',
  'icon.png',
  'package.json'
].forEach((f) => {
  if (fs.existsSync(path.join(ROOT, f))) required.add(f);
});

const missing = [...required]
  .filter((rel) => fs.existsSync(path.join(ROOT, rel)))
  .filter((rel) => !isPackaged(rel))
  .sort();

const missingOnDisk = [...required]
  .filter((rel) => !fs.existsSync(path.join(ROOT, rel)))
  .sort();

console.log(`Checked ${required.size} runtime assets against build.files (${fileGlobs.length} globs).`);
if (missingOnDisk.length) {
  console.log('\nReferenced but not on disk:');
  missingOnDisk.forEach((f) => console.log('  -', f));
}
if (missing.length) {
  console.log('\nOn disk but NOT in package.json build.files:');
  missing.forEach((f) => console.log('  -', f));
  process.exitCode = 1;
} else if (missingOnDisk.length) {
  process.exitCode = 1;
} else {
  console.log('\nOK: all discovered runtime assets are covered by build.files.');
}
