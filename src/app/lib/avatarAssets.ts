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
  { path: "/animations/breathing-idle.clip.json", estBytes: 1_900_000 },
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
 * Keep `breathing-idle`, `sitting-idle`, `standing`, `stop-walking`,
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
}

let cachedProfile: DeviceProfile | null = null;

/**
 * Inspect the device's capabilities once and bucket it into a tier.
 * Cached for the lifetime of the page — the inputs (UA, deviceMemory,
 * GPU vendor) cannot change without a reload.
 *
 * Heuristics, in order of weight:
 *   - `navigator.deviceMemory` (when present): <=2 GB → low, <=4 GB → mid.
 *   - `navigator.hardwareConcurrency`: <=4 cores nudges down a tier.
 *   - `isIOSLikeBrowser()`: forces tier to no higher than `mid` because
 *     even an iPhone 17 Pro can OOM on the unlimited-memory path.
 *   - WebGL2 / `WEBGL_debug_renderer_info`: detects software rasterizer
 *     ("SwiftShader", "Apple Software Renderer") and forces `low`.
 */
export function getDeviceProfile(): DeviceProfile {
  if (cachedProfile) return cachedProfile;

  // SSR safety: fall back to a conservative mid-tier profile until we
  // re-evaluate on the client.
  if (typeof navigator === "undefined" || typeof window === "undefined") {
    return {
      tier: "mid",
      maxDpr: 2,
      antialias: true,
      shadows: false,
      anisotropy: 4,
      powerPreference: "default",
      loadOptionalGestures: true,
      toneMappingExposure: 1.15,
      doubleSide: true,
      enableNormalMap: true,
      maxLights: 5,
      targetFps: 60,
      enableEnvReflections: true,
      enableGroundShadow: true,
      maxTextureSize: 2048,
    };
  }

  const nav = navigator as Navigator & {
    deviceMemory?: number;
    hardwareConcurrency?: number;
  };
  const deviceMemory = typeof nav.deviceMemory === "number" ? nav.deviceMemory : 4;
  const cores = typeof nav.hardwareConcurrency === "number" ? nav.hardwareConcurrency : 4;
  const isIOS = isIOSLikeBrowser();
  const isAndroid = isAndroidBrowser();
  const isMobile = isMobileBrowser();

  // Probe the GPU for software rasterizers — those cannot run the
  // shadow + MSAA path at any tier.
  let softwareRasterizer = false;
  let gpuRendererName = "";
  try {
    const canvas = document.createElement("canvas");
    const gl =
      (canvas.getContext("webgl2") as WebGL2RenderingContext | null) ||
      (canvas.getContext("webgl") as WebGLRenderingContext | null);
    if (gl) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      if (ext) {
        const renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || "").toLowerCase();
        gpuRendererName = renderer;
        if (
          renderer.includes("swiftshader") ||
          renderer.includes("software") ||
          renderer.includes("llvmpipe")
        ) {
          softwareRasterizer = true;
        }
      }
      // Release the probe context so we don't burn a WebGL slot.
      const lose = gl.getExtension("WEBGL_lose_context");
      lose?.loseContext?.();
    }
  } catch {
    // Probe failures are non-fatal; assume hardware GPU.
  }

  // Mobile GPUs that we know are weak — Mali-G5x, Adreno 6xx, PowerVR.
  // These devices ship in mid-range Android phones/tablets that report
  // 4–8 GB of RAM (so the deviceMemory probe says "mid"), but their
  // GPU/SoC ratio is closer to a low-tier iPhone. Pin them to `low`.
  const weakMobileGpu =
    isMobile &&
    /(mali-g5|mali-g3|mali-t|adreno \(?6[0-3]|adreno \(?5|powervr|videocore)/i.test(
      gpuRendererName,
    );

  let tier: DeviceTier;
  if (
    softwareRasterizer ||
    deviceMemory <= 2 ||
    cores <= 2 ||
    weakMobileGpu ||
    // Any iOS device with ≤4 GB RAM (iPhone XR / 11 / SE3 etc.) is now
    // pinned to low — those phones thermal-throttle within ~30 s on
    // the previous mid profile.
    (isIOS && deviceMemory <= 4) ||
    // Mid-range Android tablets (4 GB / 4 cores) used to land in `mid`
    // but the GPUs are usually Mali-G5x and the previous profile was
    // still too rich for them.
    (isAndroid && deviceMemory <= 4 && cores <= 6)
  ) {
    tier = "low";
  } else if (deviceMemory <= 4 || cores <= 4 || isIOS || isAndroid) {
    // All remaining mobile devices land in `mid` regardless of the RAM
    // probe — even a 12 GB Galaxy S24 cannot reliably hold the `high`
    // PBR pipeline at 60 fps without overheating.
    tier = "mid";
  } else {
    tier = "high";
  }

  const profile: DeviceProfile = {
    tier,
    // iPhone retina renders 3x logical pixels even at dpr=1.5 — cap
    // mobile mid to 1.0 (was 1.25) and low to 0.85 so we draw far
    // fewer fragments than before. Desktop low/mid keep the previous
    // caps because they're not GPU-bound.
    maxDpr:
      tier === "low"
        ? isMobile
          ? 0.85
          : 1
        : tier === "mid"
        ? isMobile
          ? 1.0
          : 1.5
        : 2,
    // MSAA is the single biggest mobile-GPU memory tax. Disable on
    // anything below high, and on every mobile device regardless of tier.
    antialias: tier === "high" && !isMobile,
    shadows: tier === "high" && !isMobile,
    anisotropy: tier === "low" ? 1 : tier === "mid" ? (isMobile ? 1 : 2) : 8,
    powerPreference: tier === "low" ? "low-power" : tier === "high" ? "high-performance" : "default",
    loadOptionalGestures: tier !== "low",
    // Slightly cooler exposure on mobile so the avatar reads without
    // pumping ambient light — saves us a fragment-shader add per frag.
    toneMappingExposure: isMobile ? 1.05 : 1.15,
    // Avatar is a closed mesh — back-faces are never visible. Only keep
    // DoubleSide on high tier where the cost is irrelevant.
    doubleSide: tier === "high",
    // Normal-map sampling is one of the priciest per-fragment ops on
    // mobile. Avatar still reads well without it because the lighting
    // is mostly diffuse + ambient.
    enableNormalMap: tier === "high",
    // Lights: low gets a single ambient-only "no light" setup on mobile
    // (the avatar is fully lit by the diffuse map already). Mid mobile
    // collapses to 1 directional light + ambient.
    maxLights:
      tier === "low" ? (isMobile ? 1 : 1) : tier === "mid" ? (isMobile ? 1 : 2) : 5,
    // Cap frame rate. 30 fps on mid, 24 fps on low. iOS especially
    // thermal-throttles after a few minutes at 60 fps, so even high
    // tier is capped to 50 fps on mobile.
    targetFps:
      tier === "low" ? 22 : tier === "mid" ? (isMobile ? 26 : 30) : isMobile ? 45 : 60,
    // Reflections: completely disabled on every mobile device and on
    // desktop low. They're a ~10–15% per-fragment cost for a visual
    // change most users will never notice on a webcam-distance avatar.
    enableEnvReflections: tier === "high" && !isMobile,
    // Ground shadow disc: skip on low tier and on mobile mid. The disc
    // is an extra transparent draw call + a 256² canvas texture.
    enableGroundShadow: tier === "high" || (tier === "mid" && !isMobile),
    // Texture upload caps — diffuse maps larger than this get blitted
    // down to this resolution at material-setup time. iOS/Android low
    // get 512², mid mobile 1024², desktop mid 2048².
    maxTextureSize:
      tier === "low" ? 512 : tier === "mid" ? (isMobile ? 1024 : 2048) : 4096,
  };

  cachedProfile = profile;
  console.log("[avatarAssets] device profile:", {
    tier,
    deviceMemory,
    cores,
    isIOS,
    isAndroid,
    isMobile,
    softwareRasterizer,
    gpuRendererName,
    weakMobileGpu,
    profile,
  });
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
  // Resolve the cache once. If unavailable (private mode, very old
  // browsers), we still complete the downloads — they go straight to
  // the browser HTTP cache so the runtime fetch hits warm.
  let cache: Cache | null = null;
  if (typeof caches !== "undefined") {
    try {
      cache = await caches.open(ASSET_CACHE_NAME);
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
