"use client";

/**
 * Shared asset constants + sequential preloader for the 3D avatar.
 *
 * Why this module exists:
 *   - iOS Safari kills tabs that allocate too much memory at once. The
 *     17 avatar/animation assets used to be `Suspense`-thrown in parallel
 *     on first paint, which on an iPhone meant ~80 MB of FBX data being
 *     downloaded + parsed simultaneously. Safari would show
 *     "A problem repeatedly occurred" and refuse to load the page.
 *   - We now download every asset *sequentially* under user control, drop
 *     each `Response` into the same `Cache Storage` bucket that
 *     `Avatar3D.tsx` reads from at runtime, and report a single progress
 *     ratio so we can render a full-screen progress bar overlay.
 *   - `Avatar3D.tsx` then mounts only after this preload completes, so
 *     `Suspense` resolves instantly (every fetch hits the warmed cache).
 *
 * Cache key naming (`ASSET_CACHE_NAME`) MUST match the value baked into
 * `Avatar3D.tsx`. Bump both together when shipping new asset bundles.
 */

const RAW_ASSET_BASE_URL =
  (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_ASSET_BASE_URL) || "";

export const ASSET_BASE_URL = RAW_ASSET_BASE_URL.replace(/\/$/, "");
export const ASSET_CACHE_NAME = "rishi-avatar-fbx-v5";

let cachedRuntimeAssetCacheName: string | null = null;
let cachePrunePromise: Promise<void> | null = null;
let appSiteResetPromise: Promise<void> | null = null;

/** Best-effort reset of app-owned browser state. This cannot clear browser
 *  permission prompts / site settings, but it does remove service workers,
 *  Cache Storage, local/session storage, and IndexedDB for this origin. */
export async function resetAppSiteData(): Promise<void> {
  if (typeof window === "undefined") return;
  if (!appSiteResetPromise) {
    appSiteResetPromise = (async () => {
      try { window.localStorage.clear(); } catch {}
      try { window.sessionStorage.clear(); } catch {}

      if ("serviceWorker" in navigator) {
        try {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.unregister()));
        } catch {}
      }

      if (typeof caches !== "undefined") {
        try {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
        } catch {}
      }

      if (window.indexedDB && typeof indexedDB.databases === "function") {
        try {
          const dbs = await indexedDB.databases();
          dbs.forEach((db) => {
            if (db?.name) indexedDB.deleteDatabase(db.name);
          });
        } catch {}
      }
    })();
  }
  await appSiteResetPromise;
}

/** Build-scoped cache key so each Vercel deployment gets a fresh bucket.
 *  Falls back to the static cache name when build id isn't available. */
function getRuntimeAssetCacheName(): string {
  if (cachedRuntimeAssetCacheName) return cachedRuntimeAssetCacheName;
  if (typeof window === "undefined") {
    cachedRuntimeAssetCacheName = ASSET_CACHE_NAME;
    return cachedRuntimeAssetCacheName;
  }
  const nextData = (window as unknown as { __NEXT_DATA__?: { buildId?: string } }).__NEXT_DATA__;
  const rawBuildId = String(nextData?.buildId || "").trim();
  if (!rawBuildId) {
    cachedRuntimeAssetCacheName = ASSET_CACHE_NAME;
    return cachedRuntimeAssetCacheName;
  }
  const safeBuildId = rawBuildId.replace(/[^a-zA-Z0-9_-]/g, "_");
  cachedRuntimeAssetCacheName = `${ASSET_CACHE_NAME}-${safeBuildId}`;
  return cachedRuntimeAssetCacheName;
}

/** Ensure we only keep the active deployment's avatar cache. */
export async function ensureFreshAssetCache(): Promise<string> {
  const activeName = getRuntimeAssetCacheName();
  if (typeof caches === "undefined") return activeName;
  if (!cachePrunePromise) {
    cachePrunePromise = (async () => {
      try {
        const keys = await caches.keys();
        const stale = keys.filter(
          (k) => k === ASSET_CACHE_NAME || (k.startsWith(`${ASSET_CACHE_NAME}-`) && k !== activeName),
        );
        if (stale.length) {
          await Promise.all(stale.map((k) => caches.delete(k)));
        }
      } catch (err) {
        console.warn("[avatarAssets] stale-cache prune failed (non-fatal):", err);
      }
    })();
  }
  await cachePrunePromise;
  return activeName;
}

export function assetUrl(path: string): string {
  if (!ASSET_BASE_URL) return path;
  return `${ASSET_BASE_URL}/${path.replace(/^\//, "")}`;
}

/**
 * Every asset the avatar pulls during boot. Order matters — we load the
 * largest blocking files first (the avatar mesh + idle clip) so the
 * `Avatar3D` component can render its first frame as early as possible
 * even if a later gesture clip is still streaming in.
 *
 * Estimated bytes are a fallback for progress when the server omits
 * `Content-Length` (rare, but happens behind some proxies). Keep them
 * roughly accurate so the bar doesn't overshoot or stall.
 */
export interface AvatarAssetSpec {
  path: string;
  /** Rough size in bytes, used only when the response has no Content-Length. */
  estBytes: number;
}

export const AVATAR_ASSETS: AvatarAssetSpec[] = [
  { path: "/avatar.fbx", estBytes: 74 * 1024 * 1024 },
  { path: "/animations/idle.fbx", estBytes: 780_000 },
  { path: "/animations/sitting-idle.clip.json", estBytes: 720_000 },
  { path: "/animations/standing.clip.json", estBytes: 360_000 },
  { path: "/animations/stop-walking.clip.json", estBytes: 390_000 },
  { path: "/animations/walking.fbx", estBytes: 390_000 },
  { path: "/animations/waving.clip.json", estBytes: 580_000 },
  { path: "/animations/praying.fbx", estBytes: 420_000 },
  { path: "/animations/explaining.fbx", estBytes: 640_000 },
  { path: "/animations/yelling.fbx", estBytes: 950_000 },
  { path: "/animations/dismissing.fbx", estBytes: 510_000 },
  { path: "/animations/shooting-arrow.fbx", estBytes: 650_000 },
  { path: "/animations/thoughtful.fbx", estBytes: 760_000 },
  { path: "/animations/climbing.fbx", estBytes: 630_000 },
  { path: "/animations/left-turn.fbx", estBytes: 370_000 },
  { path: "/animations/pointing.fbx", estBytes: 610_000 },
  { path: "/animations/sword-fight.fbx", estBytes: 780_000 },
  { path: "/animations/falling-to-landing.fbx", estBytes: 380_000 },
];

/**
 * URLs that are *optional* — they only ever play when the AI agent
 * triggers a gesture mid-conversation. On low-tier devices we skip
 * downloading them entirely; the runtime falls back to no-op (the
 * AvatarModel `pickClip` chain returns null and the gesture system
 * silently ignores the request, leaving the avatar in `idle_standing`).
 *
 * Keep `idle`, `sitting-idle`, `standing`, `stop-walking`,
 * `walking`, and `waving` mandatory — those drive the core
 * sit→stand→walk→wave kiosk loop and the avatar would T-pose without
 * them.
 */
const OPTIONAL_GESTURE_PATHS = new Set<string>([
  "/animations/praying.fbx",
  "/animations/explaining.fbx",
  "/animations/yelling.fbx",
  "/animations/dismissing.fbx",
  "/animations/shooting-arrow.fbx",
  "/animations/thoughtful.fbx",
  "/animations/climbing.fbx",
  "/animations/left-turn.fbx",
  "/animations/pointing.fbx",
  "/animations/sword-fight.fbx",
  // The falling clip is only used as the close-out for the climbing
  // attract sequence. Low-tier devices already skip climbing, so the
  // fall is wasted bandwidth on those phones.
  "/animations/falling-to-landing.fbx",
]);

export type DeviceTier = "low" | "mid" | "high";

export interface DeviceProfile {
  tier: DeviceTier;
  /** WebGL `dpr` cap passed to `<Canvas>` — e.g. `[1, 1.5]` on iOS. */
  maxDpr: number;
  /** Whether MSAA can be enabled on the WebGL context. */
  antialias: boolean;
  /** Whether the renderer should compute shadow maps. */
  shadows: boolean;
  /** Texture anisotropy cap; clamped to GPU max at runtime. */
  anisotropy: number;
  /** WebGL `powerPreference` hint. */
  powerPreference: "low-power" | "high-performance" | "default";
  /** When true, optional AI gesture FBXs are downloaded + bound. When
   *  false, those animations are skipped entirely so we save ~6 MB +
   *  ~10 GPU skeleton bindings on low-end devices. */
  loadOptionalGestures: boolean;
  /** Cap on `THREE.WebGLRenderer.toneMappingExposure` adjustments
   *  (set so future code can dim further on low-end without a magic
   *  number elsewhere). */
  toneMappingExposure: number;
  /** When true, mesh materials keep `side: THREE.DoubleSide`. On mid/low
   *  we flip to `FrontSide` because back-face shading roughly doubles
   *  the per-pixel fragment cost — the avatar is solid so back-faces
   *  are never visible anyway. */
  doubleSide: boolean;
  /** When true, mesh materials keep their PBR `normalMap`. Sampling +
   *  TBN math is one of the most expensive per-fragment operations on
   *  mobile GPUs, and the avatar still looks correct without it because
   *  the lighting is mostly directional + ambient. */
  enableNormalMap: boolean;
  /** Number of directional/point lights to render. Each light adds a
   *  uniform fetch + lighting calc per fragment, so dropping from 5 to 2
   *  on mid and 1 on low gives a measurable mobile-GPU win. */
  maxLights: number;
  /** Render frame cap. 60 fps on high, 30 fps on mid, 24 fps on low.
   *  Implemented as a frame-skip in the per-frame loop — cheaper than
   *  throttling react-three-fiber's render scheduler and avoids tearing
   *  apart the existing animation timing. */
  targetFps: number;
  /** When false, `envMapIntensity` is forced to 0 on every material so
   *  the renderer skips the environment-reflection sample entirely.
   *  PBR reflections are one of the costlier per-fragment ops on mobile
   *  GPUs and the avatar reads fine without them. */
  enableEnvReflections: boolean;
  /** When false, the soft circular shadow disc beneath the avatar is
   *  not rendered. Saves a transparent draw call + 256² canvas texture
   *  upload on memory-tight phones. */
  enableGroundShadow: boolean;
  /** Hard cap on diffuse texture max(width,height). Anything larger is
   *  downsampled at material-setup time with a 2D canvas blit so the
   *  GPU never uploads a 4K skin texture on a 2 GB Android tablet. */
  maxTextureSize: number;
  /** Fragment precision to use for WebGL context creation. */
  shaderPrecision: "highp" | "mediump";
}

let cachedProfile: DeviceProfile | null = null;

/**
 * Returns a single, fixed render profile used for **every** device.
 *
 * Rationale:
 *   We previously bucketed devices into low / mid / high based on
 *   `deviceMemory`, GPU vendor strings, iOS UA sniffs, etc. The
 *   bucketing was unreliable (Mali-G5x, Adreno 6xx, iPad Pros all
 *   ended up downgraded) and produced visibly different quality on
 *   identical hardware. Worse, every "lower the quality" lever (DPR,
 *   texture downsample, anisotropy=1) made the avatar look pixelated
 *   on retina screens *without* materially improving frame rate —
 *   because the bottleneck on this scene is per-fragment cost, not
 *   pixel count.
 *
 *   The profile below picks the cheapest *per-fragment* settings
 *   (no MSAA, no shadows, no env reflections, no normal map, fewer
 *   lights, no ground shadow disc, FrontSide only) while keeping
 *   *visual* quality high (DPR up to 2, anisotropy 4, full-resolution
 *   diffuse textures, ACES tone mapping, sRGB output). This runs
 *   smoothly on a 2-year-old budget Android *and* looks crisp on an
 *   iPhone Pro at retina DPR.
 */
export function getDeviceProfile(): DeviceProfile {
  if (cachedProfile) return cachedProfile;

  const profile: DeviceProfile = {
    // Tier is pinned to "high" so the few `tier === "high"` checks
    // sprinkled in the renderer (e.g. shader precision = "highp",
    // stencil buffer enabled) preserve visual quality. The actual
    // performance levers below are what matters.
    tier: "high",
    // Cap DPR at 1.5 so fragment workload stays bounded on mobile GPUs.
    maxDpr: 1.5,
    // No MSAA — biggest single mobile-GPU memory tax. We rely on
    // high DPR for edge crispness instead (1px at 2x ≈ 0.5px,
    // visually equivalent to 2x MSAA at 1x DPR).
    antialias: false,
    // No shadow maps — they require an extra render pass, depth
    // texture upload, and per-fragment shadow sample. Avatar reads
    // fine with the soft ground disc removed.
    shadows: false,
    // Anisotropy 4 keeps the beard/skin diffuse map crisp at
    // oblique angles. Clamped to GPU max in onCreated.
    anisotropy: 2,
    // High-performance hint — picks discrete GPU on laptops, and the
    // perf-cluster on mobile SoCs.
    powerPreference: "high-performance",
    // Always load every gesture FBX so the experience is consistent.
    loadOptionalGestures: true,
    toneMappingExposure: 1.1,
    // FrontSide only — avatar is a closed mesh, back-faces are never
    // visible. Cuts per-pixel fragment work roughly in half on the
    // skinned mesh.
    doubleSide: false,
    // No normal map — TBN matrix + normal-map sample is one of the
    // priciest per-fragment ops. Lighting still reads correctly with
    // diffuse + ambient + a single directional.
    enableNormalMap: false,
    // Single directional + ambient keeps skin readable while minimizing
    // per-fragment lighting cost.
    maxLights: 1,
    // 45 fps target gives smoother perception than hard-30 while reducing
    // sustained thermal pressure vs 60.
    targetFps: 45,
    // No environment reflections — PBR cubemap sampling is expensive
    // and the avatar's robe/skin are matte enough that reflections
    // add nothing visible.
    enableEnvReflections: false,
    // No ground shadow disc — extra transparent draw call + 256²
    // canvas texture upload, and the user explicitly asked to remove
    // shadowing entirely.
    enableGroundShadow: false,
    // 2K cap avoids uploading oversized maps and keeps memory pressure low.
    maxTextureSize: 2048,
    // mediump materially reduces shader ALU pressure on budget phones.
    shaderPrecision: "mediump",
  };

  cachedProfile = profile;
  if (typeof console !== "undefined") {
    console.log("[avatarAssets] using uniform render profile:", profile);
  }
  return profile;
}

/** Build the asset queue for a given device profile. Mandatory assets
 *  are always included; optional gesture FBXs are dropped on low-tier
 *  devices. Use this to decide what to preload AND to test at runtime
 *  whether a given URL should be fetched at all. */
export function getAssetQueueForProfile(profile: DeviceProfile): AvatarAssetSpec[] {
  if (profile.loadOptionalGestures) return AVATAR_ASSETS;
  return AVATAR_ASSETS.filter((a) => !OPTIONAL_GESTURE_PATHS.has(a.path));
}

/** Whether a given asset path is allowed to be fetched on this profile. */
export function isAssetEnabled(path: string, profile: DeviceProfile): boolean {
  if (profile.loadOptionalGestures) return true;
  return !OPTIONAL_GESTURE_PATHS.has(path);
}

/**
 * Paths that returned a 4xx during preload. The runtime FBX/clip loader
 * checks this set and short-circuits to an empty clip array so a stale
 * deployment (e.g. blob bucket missing one file) never blocks the boot
 * gate or T-poses the avatar — the gesture system already tolerates
 * missing optional clips, and the mandatory idle clips degrade to
 * "avatar holds last pose" rather than infinite spinner.
 *
 * Populated by `preloadAvatarAssets`. Use `isAssetMissing(path)` from
 * runtime code; never mutate this set directly.
 */
const MISSING_ASSETS = new Set<string>();

export function isAssetMissing(path: string): boolean {
  return MISSING_ASSETS.has(path);
}

export interface PreloadProgress {
  /** 0..1 ratio of total bytes downloaded across all assets. */
  ratio: number;
  /** Index of the asset currently downloading (0-based). */
  currentIndex: number;
  /** Total number of assets in the queue. */
  totalAssets: number;
  /** Path of the asset currently downloading. */
  currentPath: string;
  /** Total bytes downloaded so far across all assets. */
  loadedBytes: number;
  /** Estimated total bytes (sum of Content-Length / estBytes). */
  totalBytes: number;
}

async function streamIntoCache(
  spec: AvatarAssetSpec,
  cache: Cache | null,
  onChunk: (deltaBytes: number, totalForThisAsset: number) => void,
): Promise<void> {
  const url = assetUrl(spec.path);

  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      // Already cached — read it through so the byte counter still
      // advances and the UI doesn't "skip" assets visibly.
      const buf = await hit.arrayBuffer();
      onChunk(buf.byteLength, buf.byteLength);
      return;
    }
  }

  const resp = await fetch(url, { credentials: "omit" });
  if (!resp.ok) {
    // 4xx → asset is genuinely absent (typo in path, blob bucket out
    // of sync with the deployed code, etc). Mark it missing so the
    // runtime loader can short-circuit, advance the byte counter by
    // the estimated size so the progress bar still completes, and
    // continue with the next asset instead of blocking boot.
    if (resp.status >= 400 && resp.status < 500) {
      console.warn(`[avatarAssets] skipping missing asset ${spec.path}: ${resp.status}`);
      MISSING_ASSETS.add(spec.path);
      onChunk(spec.estBytes, spec.estBytes);
      return;
    }
    // 5xx / network → genuine failure, surface it so the user sees Retry.
    throw new Error(`Failed to load ${spec.path}: ${resp.status} ${resp.statusText}`);
  }

  const lengthHeader = resp.headers.get("Content-Length");
  const totalForThisAsset = lengthHeader ? Number(lengthHeader) : spec.estBytes;

  // If we can stream, do so and report deltas. Otherwise fall back to
  // a single arrayBuffer() read (Safari occasionally hands us a body
  // without a usable reader for cross-origin resources).
  const reader = resp.body?.getReader?.();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let received = 0;
    // Read until done. We accumulate so we can build a fresh Response
    // for `cache.put` (the original body has already been consumed).
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength;
        onChunk(value.byteLength, totalForThisAsset);
      }
    }
    if (cache) {
      const merged = new Blob(chunks as BlobPart[], {
        type: resp.headers.get("Content-Type") || "application/octet-stream",
      });
      // Build a synthetic response so cache hydration is identical to
      // a normal fetch-then-cache.put cycle.
      const cacheResp = new Response(merged, {
        status: 200,
        headers: { "Content-Length": String(received) },
      });
      try {
        await cache.put(url, cacheResp);
      } catch (err) {
        console.warn("[avatarAssets] cache.put failed (non-fatal):", err);
      }
    }
    return;
  }

  // Fallback path: no streaming reader available.
  const buf = await resp.arrayBuffer();
  onChunk(buf.byteLength, buf.byteLength || totalForThisAsset);
  if (cache) {
    try {
      await cache.put(
        url,
        new Response(buf, {
          status: 200,
          headers: { "Content-Length": String(buf.byteLength) },
        }),
      );
    } catch (err) {
      console.warn("[avatarAssets] cache.put failed (non-fatal):", err);
    }
  }
}

/**
 * Sequentially download (and cache) every avatar asset, calling
 * `onProgress` as bytes arrive. Resolves once every asset is cached;
 * rejects on the first network failure.
 *
 * `Avatar3D.tsx` should only be mounted after this resolves so its
 * Suspense-driven loaders find every URL warm in `caches.match`.
 */
export async function preloadAvatarAssets(
  onProgress: (p: PreloadProgress) => void,
  signal?: AbortSignal,
  profile: DeviceProfile = getDeviceProfile(),
): Promise<void> {
  await resetAppSiteData();
  // Resolve the cache once. If unavailable (private mode, very old
  // browsers), we still complete the downloads — they go straight to
  // the browser HTTP cache so the runtime fetch hits warm.
  let cache: Cache | null = null;
  if (typeof caches !== "undefined") {
    try {
      const activeCacheName = await ensureFreshAssetCache();
      cache = await caches.open(activeCacheName);
    } catch (err) {
      console.warn("[avatarAssets] caches.open failed (non-fatal):", err);
    }
  }

  const queue = getAssetQueueForProfile(profile);

  // Pre-compute the total byte budget so the progress ratio is stable
  // even before the first Content-Length header lands.
  let totalBytes = queue.reduce((sum, s) => sum + s.estBytes, 0);
  let loadedBytes = 0;

  for (let i = 0; i < queue.length; i++) {
    if (signal?.aborted) throw new DOMException("Preload aborted", "AbortError");
    const spec = queue[i];

    // Emit a "starting this asset" frame so the label updates promptly.
    onProgress({
      ratio: totalBytes > 0 ? loadedBytes / totalBytes : 0,
      currentIndex: i,
      totalAssets: queue.length,
      currentPath: spec.path,
      loadedBytes,
      totalBytes,
    });

    let assetLoadedSoFar = 0;
    await streamIntoCache(spec, cache, (delta, totalForThisAsset) => {
      assetLoadedSoFar += delta;
      loadedBytes += delta;

      // If the real Content-Length differs from our estimate, adjust
      // the running total so the bar stays monotonic.
      const drift = totalForThisAsset - spec.estBytes;
      if (drift !== 0 && assetLoadedSoFar === delta) {
        // First chunk for this asset — apply the drift exactly once.
        totalBytes += drift;
      }

      onProgress({
        ratio: totalBytes > 0 ? Math.min(1, loadedBytes / totalBytes) : 0,
        currentIndex: i,
        totalAssets: queue.length,
        currentPath: spec.path,
        loadedBytes,
        totalBytes,
      });
    });

    // Yield to the event loop between heavy assets so the UI can
    // repaint and Safari has a chance to release transient buffers.
    await new Promise((r) => setTimeout(r, 0));
  }

  onProgress({
    ratio: 1,
    currentIndex: queue.length,
    totalAssets: queue.length,
    currentPath: "",
    loadedBytes,
    totalBytes,
  });
}

/**
 * Request camera + microphone permission inside a user-gesture handler.
 * iOS Safari refuses to grant either without an explicit tap, and won't
 * surface a usable error if the page tries on mount, so we centralise
 * the request here and immediately stop the test stream.
 *
 * Returns `{ ok: true }` on grant, or `{ ok: false, error }` otherwise.
 * Either branch is safe to ignore for the rest of the flow — MediaPipe
 * and ElevenLabs will still try their own `getUserMedia` later and
 * surface their own errors if the user denies.
 */
export async function requestAvatarPermissions(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return { ok: false, error: "Camera and microphone are not available in this browser." };
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { facingMode: "user" },
    });
    // Release immediately — MediaPipe and ElevenLabs will reacquire under
    // their own settings now that the OS-level prompt has been answered.
    stream.getTracks().forEach((t) => {
      try { t.stop(); } catch { /* noop */ }
    });
    return { ok: true };
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : "Permission denied";
    return { ok: false, error: msg };
  }
}

/**
 * iOS Safari (every iPhone, every iPad on iPadOS, plus desktop Safari
 * impersonating mobile) needs the renderer dialled down to survive the
 * combined memory load of the avatar mesh + MediaPipe vision + WebRTC
 * audio. We use this from `Avatar3D.tsx` to decide on DPR / shadow /
 * antialias settings.
 */
export function isIOSLikeBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  // iPhone / iPod always announce themselves; iPadOS 13+ pretends to be
  // macOS so we additionally check for touch + Apple vendor.
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  const isMacWebKit = /Macintosh/.test(ua) && /AppleWebKit/.test(ua) && !/Chrome|CriOS|FxiOS/.test(ua);
  const hasTouch = (navigator.maxTouchPoints || 0) > 1;
  return isMacWebKit && hasTouch;
}

/** Any phone- or tablet-class browser (iOS, Android, mobile Firefox, etc.).
 *  Used to apply mobile-specific GPU/asset cuts that desktop browsers do
 *  not need even on low-end hardware. */
export function isMobileBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile Safari/i.test(ua)) {
    return true;
  }
  // iPadOS-as-macOS fallback.
  const isMacWebKit = /Macintosh/.test(ua) && /AppleWebKit/.test(ua) && !/Chrome|CriOS|FxiOS/.test(ua);
  const hasTouch = (navigator.maxTouchPoints || 0) > 1;
  return isMacWebKit && hasTouch;
}

/** Android-only detection, mainly to clip mid-tier Android tablets where
 *  the GPU/SoC ratio is much weaker than an iPad of similar memory. */
export function isAndroidBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android/i.test(navigator.userAgent || "");
}
