/**
 * Extract AnimationClips from heavy FBX files into compact JSON.
 *
 * Why: The "full body" Mixamo animation FBX files we ship under
 * `public/animations/` (breathing-idle, sitting-idle, standing,
 * stop-walking, waving) are ~74 MB each because each one re-embeds the
 * full skinned mesh and 6 MB base-color texture. The avatar runtime
 * (`Avatar3D.tsx`) only ever uses the AnimationClips from those files —
 * the mesh is immediately disposed inside `loadFbxClips()`. That means
 * the device still has to download and FBX-parse ~370 MB of dead weight
 * before the first frame can render, which on iOS Safari pushes total
 * tab memory past the kill threshold and the page just dies.
 *
 * This script does the parse once, offline, and writes each clip as a
 * `THREE.AnimationClip.toJSON()` payload (a few hundred KB per file).
 * The runtime then loads the JSON and rehydrates with
 * `AnimationClip.parse()` — same in-memory representation, no FBX
 * parsing, ~99% smaller download.
 *
 * Run:
 *   node scripts/extract-clips.mjs
 *   node scripts/extract-clips.mjs <input.fbx> <output.clip.json> [...]
 *
 * Output: `public/animations/<name>.clip.json` next to each source FBX.
 *
 * Re-run whenever a heavy source FBX is updated, then bump
 * `ASSET_CACHE_NAME` inside `Avatar3D.tsx` (and re-upload via
 * `scripts/upload-fbx-to-blob.mjs` if you host assets on Vercel Blob).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ── Polyfills so three-stdlib's FBXLoader runs under Node. ──
// FBXLoader touches `window`, `document`, `Image`, `URL`, etc. while
// trying to wire up texture decoders. We don't need textures, so stub
// them with no-ops.
function makeImg() {
  return {
    addEventListener() {}, removeEventListener() {},
    set src(_) {}, get src() { return ''; },
    crossOrigin: '',
  };
}
globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.document = {
  createElement: (tag) => (tag === 'img' ? makeImg() : { getContext: () => null }),
  createElementNS: (_ns, tag) => (tag === 'img' ? makeImg() : makeImg()),
};
globalThis.Image = function () { return makeImg(); };
globalThis.Blob = class FakeBlob {};
// Force-replace Node's `URL` (which validates Blob arguments) with a stub
// — FBXLoader only calls `createObjectURL` for embedded textures we do
// not need. Shadow it on globalThis so the loader's lookup hits the stub.
globalThis.URL = { createObjectURL: () => '', revokeObjectURL: () => {} };
globalThis.HTMLCanvasElement = class {};
globalThis.HTMLImageElement = class {};
globalThis.OffscreenCanvas = class {};

const THREE = require('three');
const { FBXLoader } = require('three-stdlib');

const ROOT = path.resolve(process.cwd(), 'public');

// Files larger than ~10 MB benefit from clip extraction; smaller
// gesture FBX files (~500 KB each) are already light enough that
// converting them is just churn.
const SOURCES = [
  'animations/breathing-idle.fbx',
  'animations/sitting-idle.fbx',
  'animations/standing.fbx',
  'animations/stop-walking.fbx',
  'animations/waving.fbx',
];

async function extract(inputPath, outputPath) {
  const abs = path.isAbsolute(inputPath) ? inputPath : path.resolve(inputPath);
  const buf = await fs.readFile(abs);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const loader = new FBXLoader();
  const group = loader.parse(ab, '');
  const clips = group.animations || [];
  if (clips.length === 0) {
    console.warn(`  ⚠ ${inputPath}: no animations found`);
    return null;
  }
  // Keep all clips so callers that pick by name continue to work.
  const json = clips.map((c) => THREE.AnimationClip.toJSON(c));
  const outAbs = path.isAbsolute(outputPath) ? outputPath : path.resolve(outputPath);
  await fs.mkdir(path.dirname(outAbs), { recursive: true });
  await fs.writeFile(outAbs, JSON.stringify(json));
  const srcMb = (buf.length / 1024 / 1024).toFixed(2);
  const dstKb = ((await fs.stat(outAbs)).size / 1024).toFixed(1);
  console.log(`  ✓ ${inputPath} (${srcMb} MB) → ${outputPath} (${dstKb} KB)  [${clips.length} clip${clips.length === 1 ? '' : 's'}]`);
  return outputPath;
}

console.log('Extracting AnimationClips from heavy FBX files…\n');
const cliArgs = process.argv.slice(2);
if (cliArgs.length % 2 !== 0) {
  throw new Error('CLI arguments must be <input.fbx> <output.clip.json> pairs');
}
const jobs = cliArgs.length
  ? Array.from({ length: cliArgs.length / 2 }, (_, index) => ({
      input: cliArgs[index * 2],
      output: cliArgs[index * 2 + 1],
    }))
  : SOURCES.map((rel) => ({
      input: path.join(ROOT, rel),
      output: path.join(ROOT, rel.replace(/\.fbx$/i, '.clip.json')),
    }));

for (const job of jobs) {
  try {
    await extract(job.input, job.output);
  } catch (err) {
    console.error(`  ✗ ${job.input}:`, err?.message || err);
    process.exitCode = 1;
  }
}
console.log('\nDone. Next steps:');
console.log('  1. Update Avatar3D.tsx to load `*.clip.json` for these animations.');
console.log('  2. Bump ASSET_CACHE_NAME in Avatar3D.tsx so old caches are invalidated.');
console.log('  3. (Optional) Re-run scripts/upload-fbx-to-blob.mjs to push the new files.');
