"use client";

/**
 * Shared asset constants + sequential preloader for the 3D avatar.
 *
 * Why this module exists:
 *   - iOS Safari kills tabs that allocate too much memory at once. The
 *     character bundles are therefore downloaded sequentially rather than
 *     being `Suspense`-thrown in parallel on first paint.
 *   - We now download every asset *sequentially* under user control, drop
 *     each `Response` into the same `Cache Storage` bucket that
 *     `Avatar3D.tsx` reads from at runtime, and report a single progress
 *     ratio so we can render a full-screen progress bar overlay.
 *   - `Avatar3D.tsx` then mounts only after this preload completes, so
 *     `Suspense` resolves instantly (every fetch hits the warmed cache).
 *
 * Bump `ASSET_CACHE_NAME` whenever shipping new character bundles.
 */

const RAW_ASSET_BASE_URL =
  (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_ASSET_BASE_URL) || "";

export const ASSET_BASE_URL = RAW_ASSET_BASE_URL.replace(/\/$/, "");
export const ASSET_CACHE_NAME = "rishi-avatar-fbx-v63";
const ASSET_CACHE_PREFIX = "rishi-avatar-fbx-v";

let cachedRuntimeAssetCacheName: string | null = null;
let cachePrunePromise: Promise<void> | null = null;

/** Legacy hook kept for compatibility. Asset caching is now intentionally
 *  persistent across visits, so this function is a no-op. */
export async function resetAppSiteData(): Promise<void> {
  // Intentional no-op: we persist downloaded assets on device so repeated
  // visits do not re-download heavy FBX files.
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
          (key) => key.startsWith(ASSET_CACHE_PREFIX) && key !== activeName,
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
  if (/^https?:\/\//i.test(path)) return path;

  // Character bundles ship with the deployment. Keeping these same-origin
  // prevents a stale Blob object from silently serving an older avatar after
  // a model correction. Grass and gesture assets can still use the CDN base.
  const resolved = ASSET_BASE_URL && !AVATAR_MODEL_PATHS.has(path)
    ? `${ASSET_BASE_URL}/${path.replace(/^\//, "")}`
    : path;
  return AVATAR_MODEL_PATHS.has(path)
    || path.startsWith("/animations/")
    || path.startsWith("/grass/")
    ? `${resolved}?v=${encodeURIComponent(ASSET_CACHE_NAME)}`
    : resolved;
}

/**
 * Pre-animated character bundles pulled during boot. Each GLB contains its
 * supplied skeleton, skin, idle animation, and facial visemes. Compact
 * skeleton-only gesture clips are shared by all three compatible Mixamo rigs.
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

export const AVATAR_GESTURE_PATHS = {
  waving: "/animations/waving.clip.json",
  praying: "/animations/praying.clip.json",
  explaining: "/animations/explaining.clip.json",
  yelling: "/animations/yelling.clip.json",
  dismissing: "/animations/dismissing.clip.json",
  shooting_arrow: "/animations/shooting-arrow.clip.json",
  thoughtful: "/animations/thoughtful.clip.json",
  climbing: "/animations/climbing.clip.json",
  left_turn: "/animations/left-turn.clip.json",
  pointing: "/animations/pointing.clip.json",
  sword_fight: "/animations/sword-fight.clip.json",
  falling: "/animations/falling-to-landing.clip.json",
} as const;

export const AVATAR_ASSETS: AvatarAssetSpec[] = [
  { path: "/models/sandipani.glb", estBytes: 10 * 1024 * 1024 },
  { path: "/models/rani-laxmi-bai.glb", estBytes: 49 * 1024 * 1024 },
  { path: "/models/shivaji-maharaj.glb", estBytes: 57 * 1024 * 1024 },
  { path: "/models/sandipani-lite.glb", estBytes: 8 * 1024 * 1024 },
  { path: "/models/rani-laxmi-bai-lite.glb", estBytes: 11 * 1024 * 1024 },
  { path: "/models/shivaji-maharaj-lite.glb", estBytes: 13 * 1024 * 1024 },
  { path: AVATAR_GESTURE_PATHS.waving, estBytes: 572 * 1024 },
  { path: AVATAR_GESTURE_PATHS.praying, estBytes: 97 * 1024 },
  { path: AVATAR_GESTURE_PATHS.explaining, estBytes: 534 * 1024 },
  { path: AVATAR_GESTURE_PATHS.yelling, estBytes: 1210 * 1024 },
  { path: AVATAR_GESTURE_PATHS.dismissing, estBytes: 354 * 1024 },
  { path: AVATAR_GESTURE_PATHS.shooting_arrow, estBytes: 555 * 1024 },
  { path: AVATAR_GESTURE_PATHS.thoughtful, estBytes: 860 * 1024 },
  { path: AVATAR_GESTURE_PATHS.climbing, estBytes: 418 * 1024 },
  { path: AVATAR_GESTURE_PATHS.left_turn, estBytes: 152 * 1024 },
  { path: AVATAR_GESTURE_PATHS.pointing, estBytes: 394 * 1024 },
  { path: AVATAR_GESTURE_PATHS.sword_fight, estBytes: 547 * 1024 },
  { path: AVATAR_GESTURE_PATHS.falling, estBytes: 132 * 1024 },
];

const AVATAR_MODEL_PATHS = new Set([
  "/models/sandipani.glb",
  "/models/rani-laxmi-bai.glb",
  "/models/shivaji-maharaj.glb",
  "/models/sandipani-lite.glb",
  "/models/rani-laxmi-bai-lite.glb",
  "/models/shivaji-maharaj-lite.glb",
]);

function hashString(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Asset-manifest scoped cache key. Downloads are reused across sessions and
 * refreshed only when the asset manifest changes (new file or changed spec).
 */
function getRuntimeAssetCacheName(): string {
  if (cachedRuntimeAssetCacheName) return cachedRuntimeAssetCacheName;
  const manifestSignature = JSON.stringify({
    base: ASSET_BASE_URL,
    assets: AVATAR_ASSETS.map((a) => [a.path, a.estBytes]),
  });
  const manifestHash = hashString(manifestSignature);
  cachedRuntimeAssetCacheName = `${ASSET_CACHE_NAME}-${manifestHash}`;
  return cachedRuntimeAssetCacheName;
}

export type DeviceTier = "low" | "mid" | "high";

export interface DeviceProfile {
  tier: DeviceTier;
  /** WebGL `dpr` cap passed to `<Canvas>` — e.g. `[1, 1.5]` on iOS. */
  maxDpr: number;
  /** Lowest DPR selected by the sustained-load controller. */
  minDpr: number;
  /** Whether MSAA can be enabled on the WebGL context. */
  antialias: boolean;
  /** Whether the renderer should compute shadow maps. */
  shadows: boolean;
  /** Texture anisotropy cap; clamped to GPU max at runtime. */
  anisotropy: number;
  /** WebGL `powerPreference` hint. */
  powerPreference: "low-power" | "high-performance" | "default";
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
   *  uniform fetch + lighting calc per fragment, so dropping from 3 to 2
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
  /** Hard cap on diffuse texture max(width,height). Anything larger is
   *  downsampled at material-setup time with a 2D canvas blit so the
   *  GPU never uploads a 4K skin texture on a 2 GB Android tablet. */
  maxTextureSize: number;
  /** Fragment precision to use for WebGL context creation. */
  shaderPrecision: "highp" | "mediump";
  /** When false, skip the idle foot-clamp skeleton traversal. */
  enableFootClamp: boolean;
}

let cachedProfile: DeviceProfile | null = null;

function isHandheldDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  const maxTouchPoints = navigator.maxTouchPoints || 0;
  const isiPadOsPretendingMac = platform === "MacIntel" && maxTouchPoints > 1;
  return isiPadOsPretendingMac || /android|iphone|ipad|ipod|mobile|tablet/i.test(ua);
}

export function getDeviceProfile(): DeviceProfile {
  if (cachedProfile) return cachedProfile;

  const handheld = isHandheldDevice();
  const runtimeNavigator = typeof navigator !== "undefined" ? navigator : null;
  const memory = (
    runtimeNavigator as (Navigator & { deviceMemory?: number }) | null
  )?.deviceMemory;
  const cores = runtimeNavigator?.hardwareConcurrency || (handheld ? 4 : 8);
  const tier: DeviceTier = (memory !== undefined && memory <= 2) || cores <= 2
    ? "low"
    : handheld || (memory !== undefined && memory <= 4) || cores <= 4
      ? "mid"
      : "high";

  const profile: DeviceProfile = {
    tier,
    minDpr: tier === "low" ? 0.65 : tier === "mid" ? 0.85 : 1,
    maxDpr: tier === "low" ? 0.85 : tier === "mid" ? 1.1 : 1.5,
    antialias: tier === "high",
    shadows: false,
    anisotropy: tier === "low" ? 1 : tier === "mid" ? 2 : 4,
    // Prefer the discrete/high-performance adapter on every tier. The DPR,
    // material and frame caps below still protect weak GPUs, while this hint
    // avoids an integrated/software adapter becoming the bottleneck.
    powerPreference: "high-performance",
    toneMappingExposure: tier === "high" ? 1.02 : 1.06,
    doubleSide: tier === "high",
    enableNormalMap: tier !== "low",
    maxLights: tier === "low" ? 1 : tier === "mid" ? 2 : 4,
    targetFps: tier === "low" ? 24 : tier === "mid" ? 30 : 60,
    enableEnvReflections: tier === "high",
    maxTextureSize: tier === "low" ? 512 : tier === "mid" ? 1024 : 2048,
    shaderPrecision: tier === "high" ? "highp" : "mediump",
    enableFootClamp: true,
  };

  cachedProfile = profile;
  if (typeof console !== "undefined") {
    console.log("[avatarAssets] using adaptive render profile:", profile);
  }
  return profile;
}

const LOW_END_AVATARS: Record<string, string> = {
  "/models/sandipani.glb": "/models/sandipani-lite.glb",
  "/models/rani-laxmi-bai.glb": "/models/rani-laxmi-bai-lite.glb",
  "/models/shivaji-maharaj.glb": "/models/shivaji-maharaj-lite.glb",
};

export function getOptimizedAvatarPath(
  avatarPath: string,
  profile: DeviceProfile = getDeviceProfile(),
): string {
  return profile.tier !== "high"
    ? LOW_END_AVATARS[avatarPath] ?? avatarPath
    : avatarPath;
}

/** Build the asset queue for the selected pre-animated character. */
export function getAssetQueueForProfile(
  profile: DeviceProfile,
  avatarPath = "/models/sandipani.glb",
): AvatarAssetSpec[] {
  const resolvedAvatarPath = getOptimizedAvatarPath(avatarPath, profile);
  return AVATAR_ASSETS.filter(
    (asset) => !AVATAR_MODEL_PATHS.has(asset.path) || asset.path === resolvedAvatarPath,
  );
}

/**
 * Paths that returned a 4xx during preload. Runtime loaders check this set
 * so a stale deployment never blocks the boot gate indefinitely.
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
async function preloadAvatarAssetsUnlocked(
  onProgress: (p: PreloadProgress) => void,
  signal?: AbortSignal,
  profile: DeviceProfile = getDeviceProfile(),
  avatarPath = "/avatar.fbx",
): Promise<void> {
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

  const queue = getAssetQueueForProfile(profile, avatarPath);

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

/** Serialize preload work across the front and rear browser windows. Both
 * windows share Cache Storage, so the follower waits for the leader and
 * then reads the warmed cache instead of downloading the 80 MB bundle a
 * second time. */
export async function preloadAvatarAssets(
  onProgress: (p: PreloadProgress) => void,
  signal?: AbortSignal,
  profile: DeviceProfile = getDeviceProfile(),
  avatarPath = "/models/sandipani.glb",
): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.locks?.request) {
    await navigator.locks.request("rishi-avatar-preload", async () => {
      await preloadAvatarAssetsUnlocked(onProgress, signal, profile, avatarPath);
    });
    return;
  }
  await preloadAvatarAssetsUnlocked(onProgress, signal, profile, avatarPath);
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
