/**
 * Upload the runtime 3D assets in `public/` to Vercel Blob and print the
 * public asset-base environment variable.
 *
 * One-time setup:
 *   1. Vercel dashboard → Storage → Create Blob store, copy the read/write
 *      token into `.env.local` as `BLOB_READ_WRITE_TOKEN=…`
 *   2. `npm install @vercel/blob`
 *   3. `node scripts/upload-fbx-to-blob.mjs`
 *
 * The script:
 *   - Uploads the three active character models, FluffyGrass assets, and
 *     compact shared gesture clips.
 *   - Keeps their paths stable in Blob with
 *     `addRandomSuffix: false` so the URLs are stable across re-uploads.
 *   - At the end, prints a single `NEXT_PUBLIC_ASSET_BASE_URL=…` line you
 *     can paste into Vercel project env (Production, Preview, Development).
 *
 * Re-run any time a character model or grass asset changes.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { put } from '@vercel/blob';

const ROOT = path.resolve(process.cwd(), 'public');
const KNOWN_ASSETS = [
  'models/sandipani.glb',
  'models/rani-laxmi-bai.glb',
  'models/shivaji-maharaj.glb',
  'grass/grassLODs.glb',
  'grass/grass.jpeg',
  'grass/perlinnoise.webp',
  'animations/waving.clip.json',
  'animations/praying.clip.json',
  'animations/explaining.clip.json',
  'animations/yelling.clip.json',
  'animations/dismissing.clip.json',
  'animations/shooting-arrow.clip.json',
  'animations/thoughtful.clip.json',
  'animations/climbing.clip.json',
  'animations/left-turn.clip.json',
  'animations/pointing.clip.json',
  'animations/sword-fight.clip.json',
  'animations/falling-to-landing.clip.json',
];
const requestedAssets = process.argv.slice(2);
const ASSETS = requestedAssets.length ? requestedAssets : KNOWN_ASSETS;
const unknownAssets = ASSETS.filter((asset) => !KNOWN_ASSETS.includes(asset));
if (unknownAssets.length) {
  console.error(`Unknown runtime assets: ${unknownAssets.join(', ')}`);
  process.exit(1);
}

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error('Missing BLOB_READ_WRITE_TOKEN. Add it to .env.local first.');
  process.exit(1);
}

function contentTypeFor(rel) {
  if (rel.endsWith('.jpeg') || rel.endsWith('.jpg')) return 'image/jpeg';
  if (rel.endsWith('.webp')) return 'image/webp';
  if (rel.endsWith('.glb')) return 'model/gltf-binary';
  if (rel.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

let firstUrl = null;
for (const rel of ASSETS) {
  const abs = path.join(ROOT, rel);
  try {
    const buf = await fs.readFile(abs);
    const result = await put(rel, buf, {
      access: 'public',
      addRandomSuffix: false,
      contentType: contentTypeFor(rel),
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
