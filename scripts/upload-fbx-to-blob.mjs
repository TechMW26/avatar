/**
 * Upload all FBX assets in `public/` to Vercel Blob and print env line.
 *
 * One-time setup:
 *   1. Vercel dashboard → Storage → Create Blob store, copy the read/write
 *      token into `.env.local` as `BLOB_READ_WRITE_TOKEN=…`
 *   2. `npm install @vercel/blob`
 *   3. `node scripts/upload-fbx-to-blob.mjs`
 *
 * The script:
 *   - Walks `public/avatar.fbx` and `public/animations/*.fbx`.
 *   - Uploads each as `avatar.fbx` / `animations/<name>.fbx` to Blob with
 *     `addRandomSuffix: false` so the URLs are stable across re-uploads.
 *   - At the end, prints a single `NEXT_PUBLIC_ASSET_BASE_URL=…` line you
 *     can paste into Vercel project env (Production, Preview, Development).
 *
 * Re-run any time you swap an animation file.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { put } from '@vercel/blob';

const ROOT = path.resolve(process.cwd(), 'public');
const ASSETS = [
  'avatar.fbx',
  'animations/breathing-idle.fbx',
  'animations/sitting-idle.fbx',
  'animations/standing.fbx',
  'animations/stop-walking.fbx',
  'animations/walking.fbx',
  'animations/waving.fbx',
  'animations/praying.fbx',
  'animations/explaining.fbx',
  'animations/yelling.fbx',
  'animations/dismissing.fbx',
  'animations/shooting-arrow.fbx',
  'animations/thoughtful.fbx',
];

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error('Missing BLOB_READ_WRITE_TOKEN. Add it to .env.local first.');
  process.exit(1);
}

let firstUrl = null;
for (const rel of ASSETS) {
  const abs = path.join(ROOT, rel);
  try {
    const buf = await fs.readFile(abs);
    const result = await put(rel, buf, {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/octet-stream',
      // Cache for a year — bump ASSET_CACHE_NAME in Avatar3D.tsx to invalidate.
      cacheControlMaxAge: 60 * 60 * 24 * 365,
      allowOverwrite: true,
    });
    const sizeMb = (buf.length / 1024 / 1024).toFixed(2);
    console.log(`  ✓ ${rel}  (${sizeMb} MB)  →  ${result.url}`);
    if (!firstUrl) firstUrl = result.url;
  } catch (err) {
    if (err?.code === 'ENOENT') {
      console.warn(`  ⏭  skip (missing): ${rel}`);
      continue;
    }
    console.error(`  ✗ ${rel}:`, err?.message || err);
  }
}

if (firstUrl) {
  // Vercel Blob URLs are `https://<storeId>.public.blob.vercel-storage.com/<pathname>`.
  // Strip the pathname to derive the base URL we expose to the client.
  const u = new URL(firstUrl);
  console.log('\nDone. Set this in Vercel → Project → Settings → Environment Variables:');
  console.log(`\n  NEXT_PUBLIC_ASSET_BASE_URL=${u.origin}\n`);
  console.log('Then redeploy. The kiosk fetches FBXs from Blob and caches them in');
  console.log('the browser\'s Cache Storage so subsequent loads come off local disk.');
}
