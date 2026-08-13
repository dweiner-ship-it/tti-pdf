#!/usr/bin/env node
/**
 * Prune public/libreoffice-wasm from dist when remote R2 URL is configured.
 * Cloudflare Pages/Workers rejects files >25MB — soffice.wasm.gz is ~48MB.
 * When VITE_LIBREOFFICE_BASE_URL is set, dist copy is redundant and breaks deploy.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distLoff = path.resolve(__dirname, '../dist/libreoffice-wasm');
// Load .env.production if VITE_LIBREOFFICE_BASE_URL not already in env (Pages/CI sets it)
if (!process.env.VITE_LIBREOFFICE_BASE_URL) {
  const envPath = path.resolve(__dirname, '../.env.production');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*VITE_LIBREOFFICE_BASE_URL\s*=\s*(.*)\s*$/);
      if (m) {
        process.env.VITE_LIBREOFFICE_BASE_URL = m[1].trim();
        break;
      }
    }
  }
}
const remote = (process.env.VITE_LIBREOFFICE_BASE_URL || '').trim();

if (!remote) {
  console.log(
    '[prune-loff] VITE_LIBREOFFICE_BASE_URL not set — keeping dist/libreoffice-wasm for local fallback.'
  );
  process.exit(0);
}
if (!fs.existsSync(distLoff)) {
  console.log(
    '[prune-loff] dist/libreoffice-wasm not found — nothing to prune.'
  );
  process.exit(0);
}
const before = fs.readdirSync(distLoff);
let size = 0;
for (const f of before) {
  try {
    size += fs.statSync(path.join(distLoff, f)).size;
  } catch {}
}
fs.rmSync(distLoff, { recursive: true, force: true });
console.log(
  `[prune-loff] Removed dist/libreoffice-wasm (${before.length} files, ${(size / 1024 / 1024).toFixed(1)} MB) — will load from ${remote}`
);
