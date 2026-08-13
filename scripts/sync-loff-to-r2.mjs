#!/usr/bin/env node
/**
 * Sync public/libreoffice-wasm/* -> Cloudflare R2 bucket
 * Usage:
 *   node scripts/sync-loff-to-r2.mjs --bucket tti-pdf-loff
 *   node scripts/sync-loff-to-r2.mjs --bucket tti-pdf-loff --prefix libreoffice-wasm --dry-run
 * Requires: wrangler logged in (npx wrangler login) or CLOUDFLARE_API_TOKEN env
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'public', 'libreoffice-wasm');

const args = process.argv.slice(2);
function arg(name, def = undefined) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  return args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
}

const BUCKET = arg('bucket', 'tti-pdf-loff');
const PREFIX = (arg('prefix', 'libreoffice-wasm') || '').replace(
  /^\/|\/$/g,
  ''
);
const DRY_RUN = args.includes('--dry-run');

if (!fs.existsSync(SRC_DIR)) {
  console.error(`[sync-loff] Missing ${SRC_DIR}`);
  process.exit(1);
}
const files = fs.readdirSync(SRC_DIR).filter((f) => !f.startsWith('.'));
if (files.length === 0) {
  console.error(`[sync-loff] No files in ${SRC_DIR}`);
  process.exit(1);
}

console.log(
  `[sync-loff] Bucket: ${BUCKET}  Prefix: ${PREFIX || '(root)'}  Files: ${files.length}${DRY_RUN ? ' (dry-run)' : ''}`
);
for (const f of files) {
  const localPath = path.join(SRC_DIR, f);
  const stat = fs.statSync(localPath);
  const key = PREFIX ? `${PREFIX}/${f}` : f;
  const contentType =
    f.endsWith('.wasm.gz') || f.endsWith('.data.gz')
      ? 'application/octet-stream'
      : f.endsWith('.js')
        ? 'text/javascript'
        : 'application/octet-stream';
  console.log(
    `  -> ${f} (${(stat.size / 1024 / 1024).toFixed(2)} MB) => r2://${BUCKET}/${key}`
  );
  if (DRY_RUN) continue;
  const wrangler = spawnSync(
    'npx',
    [
      'wrangler',
      'r2',
      'object',
      'put',
      `${BUCKET}/${key}`,
      '--file',
      localPath,
      '--content-type',
      contentType,
      '--remote',
    ],
    { cwd: ROOT, stdio: 'inherit', shell: true }
  );
  if (wrangler.status !== 0) {
    console.error(`[sync-loff] Failed for ${f}`);
    process.exit(wrangler.status || 1);
  }
}
if (DRY_RUN) {
  console.log(
    '[sync-loff] Dry run complete. Re-run without --dry-run to upload.'
  );
} else {
  console.log(`[sync-loff] Done. Enable public access if needed:`);
  console.log(
    `  npx wrangler r2 bucket update ${BUCKET} --public   (or attach custom domain in dashboard)`
  );
  console.log(
    `  Then set VITE_LIBREOFFICE_BASE_URL=https://pub-${BUCKET}.r2.dev/${PREFIX}/`
  );
}
