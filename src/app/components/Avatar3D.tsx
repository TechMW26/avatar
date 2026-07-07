"use client";

import {
  useRef,
  useEffect,
  useMemo,
  useCallback,
  Suspense,
  Component,
  ReactNode,
  MutableRefObject,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { SkeletonUtils, FBXLoader } from "three-stdlib";
import {
  ASSET_BASE_URL,
  ASSET_CACHE_NAME,
  assetUrl,
  ensureFreshAssetCache,
  getDeviceProfile,
  isAssetEnabled,
  isAssetMissing,
} from "../lib/avatarAssets";

const AVATAR_URL = "/avatar.fbx";

// User-provided FBX animation files (Mixamo rigs).
// The five "full body" idle/walking/waving Mixamo exports were ~74 MB each
// because they re-embedded the skinned mesh + 6 MB texture. We pre-extract
// just their AnimationClips into compact JSON via
// `scripts/extract-clips.mjs` so mobile Safari does not have to download
// and FBX-parse ~370 MB of dead weight before the first frame can render.
// Smaller gesture FBX files (<1 MB) stay as-is — converting them is churn.
const ANIM_IDLE_URL = "/animations/neutral-idle.fbx";
const ANIM_SITTING_URL = "/animations/sitting-idle.clip.json";
const ANIM_STANDING_URL = "/animations/standing.clip.json";
const ANIM_STOPPING_URL = "/animations/stop-walking.clip.json";
const ANIM_WALKING_URL = "/animations/walking.fbx";
const ANIM_WAVING_URL = "/animations/waving.clip.json";
const ANIM_PRAYING_URL = "/animations/praying.fbx";
const ANIM_EXPLAINING_URL = "/animations/explaining.fbx";
const ANIM_YELLING_URL = "/animations/yelling.fbx";
const ANIM_DISMISSING_URL = "/animations/dismissing.fbx";
const ANIM_SHOOTING_ARROW_URL = "/animations/shooting-arrow.fbx";
const ANIM_THOUGHTFUL_URL = "/animations/thoughtful.fbx";
const ANIM_CLIMBING_URL = "/animations/climbing.fbx";
const ANIM_LEFT_TURN_URL = "/animations/left-turn.fbx";
const ANIM_POINTING_URL = "/animations/pointing.fbx";
const ANIM_SWORD_FIGHT_URL = "/animations/sword-fight.fbx";
const ANIM_FALLING_URL = "/animations/falling-to-landing.fbx";

const ALL_ANIM_URLS = [
  ANIM_IDLE_URL,
  ANIM_SITTING_URL,
  ANIM_STANDING_URL,
  ANIM_STOPPING_URL,
  ANIM_WALKING_URL,
  ANIM_WAVING_URL,
  ANIM_PRAYING_URL,
  ANIM_EXPLAINING_URL,
  ANIM_YELLING_URL,
  ANIM_DISMISSING_URL,
  ANIM_SHOOTING_ARROW_URL,
  ANIM_THOUGHTFUL_URL,
  ANIM_CLIMBING_URL,
  ANIM_LEFT_TURN_URL,
  ANIM_POINTING_URL,
  ANIM_SWORD_FIGHT_URL,
  ANIM_FALLING_URL,
] as const;

type AvatarAnimState =
  | "sitting"
  | "standing_up"
  | "walking_in"
  | "walking_out"
  | "turning_away"
  | "turning_back"
  | "stopping"
  | "idle_standing"
  | "waving"
  | "praying"
  | "explaining"
  | "yelling"
  | "dismissing"
  | "shooting_arrow"
  | "thoughtful"
  | "climbing"
  | "falling"
  | "left_turn"
  | "pointing"
  | "sword_fight";

/** The underlying animation clips we actually loaded. Multiple states can
 *  reuse the same clip (walking_in/out share `walking`, the turn states
 *  reuse `idle_standing`). */
type ClipKey =
  | "sitting"
  | "standing_up"
  | "walking"
  | "stopping"
  | "idle_standing"
  | "waving"
  | "praying"
  | "explaining"
  | "yelling"
  | "dismissing"
  | "shooting_arrow"
  | "thoughtful"
  | "climbing"
  | "falling"
  | "left_turn"
  | "pointing"
  | "sword_fight";

type GestureName =
  | "Open_Palm"
  | "Thumb_Up"
  | "Thumb_Down"
  | "Victory"
  | "ILoveYou"
  | "Closed_Fist"
  | "Pointing_Up"
  | "Namaste"
  | "Photo_Pose"
  | null;

const CAMERA_Z_FAR = 9.5;
const CAMERA_Z_NEAR = 5.7;
// Time without a face before we sit back down. Long enough that the avatar
// doesn't oscillate when MediaPipe drops a frame or two, but short enough
// that the kiosk feels responsive when visitors leave.
const RETURN_TO_SIT_DELAY_MS = 3_000;
// Required ms of consistent face presence/absence before changing pose.
const FACE_DEBOUNCE_MS = 350;
// Never replay the same gesture too quickly, even if a narrower trigger
// cooldown would otherwise allow it.
const SAME_GESTURE_COOLDOWN_MS = 4_500;

/* ── Stage geometry ──
   The avatar's feet are anchored at y = 0 inside the local scene, so the
   group's world Y becomes the floor line. Walking just lerps Z (and uniform
   scale, to fake distance) between two stage marks. */
const GROUND_Y = -1.3;
// Sit dip — the Mixamo sit clip rotates the legs into a cross-leg position
// but we strip the Hips translation track (cm-scale problem), so without a
// small additional drop the seated pose looks like he's hovering.
const SIT_GROUND_OFFSET_Y = -0.55;
const BACK_Z = -2.0;
const FRONT_Z = 0;
const DYNAMIC_SCALE_MULT = 1.15;
const BACK_SCALE = 0.65 * DYNAMIC_SCALE_MULT;
// Keep the close mark visually present but avoid edge clipping on
// narrow portrait screens.
const FRONT_SCALE = 0.9 * DYNAMIC_SCALE_MULT;

const STATE_TARGETS: Record<
  AvatarAnimState,
  { z: number; rotY: number; scale: number; clipKey: ClipKey }
> = {
  sitting:       { z: BACK_Z,  rotY: 0,        scale: BACK_SCALE,  clipKey: "sitting" },
  standing_up:   { z: BACK_Z,  rotY: 0,        scale: BACK_SCALE,  clipKey: "standing_up" },
  walking_in:    { z: FRONT_Z, rotY: 0,        scale: FRONT_SCALE, clipKey: "walking" },
  idle_standing: { z: FRONT_Z, rotY: 0,        scale: FRONT_SCALE, clipKey: "idle_standing" },
  waving:        { z: FRONT_Z, rotY: 0,        scale: FRONT_SCALE, clipKey: "waving" },
  praying:       { z: FRONT_Z, rotY: 0,        scale: FRONT_SCALE, clipKey: "praying" },
  explaining:    { z: FRONT_Z, rotY: 0,        scale: FRONT_SCALE, clipKey: "explaining" },
  yelling:       { z: FRONT_Z, rotY: 0,        scale: FRONT_SCALE, clipKey: "yelling" },
  dismissing:    { z: FRONT_Z, rotY: 0,        scale: FRONT_SCALE, clipKey: "dismissing" },
  shooting_arrow:{ z: FRONT_Z, rotY: 0,        scale: FRONT_SCALE, clipKey: "shooting_arrow" },
  thoughtful:    { z: FRONT_Z, rotY: 0,        scale: FRONT_SCALE, clipKey: "thoughtful" },
  climbing:      { z: FRONT_Z, rotY: 0,        scale: FRONT_SCALE, clipKey: "climbing" },
  // `falling` reuses the climbing scale because the avatar drops back
  // down onto the front mark to close out the attract loop.
  falling:       { z: FRONT_Z, rotY: 0,        scale: FRONT_SCALE, clipKey: "falling" },
  left_turn:     { z: FRONT_Z, rotY: 0,        scale: FRONT_SCALE, clipKey: "left_turn" },
  pointing:      { z: FRONT_Z, rotY: 0,        scale: FRONT_SCALE, clipKey: "pointing" },
  sword_fight:   { z: FRONT_Z, rotY: 0,        scale: FRONT_SCALE, clipKey: "sword_fight" },
  turning_away:  { z: FRONT_Z, rotY: Math.PI,  scale: FRONT_SCALE, clipKey: "idle_standing" },
  walking_out:   { z: BACK_Z,  rotY: Math.PI,  scale: BACK_SCALE,  clipKey: "walking" },
  turning_back:  { z: BACK_Z,  rotY: 0,        scale: BACK_SCALE,  clipKey: "idle_standing" },
  stopping:      { z: FRONT_Z, rotY: 0,        scale: FRONT_SCALE, clipKey: "stopping" },
};

// Mixamo bone names → avatar rig bone names. The current avatar uses the
// stock Mixamo names (mixamorigHips, mixamorigSpine, …), so this is empty
// and only kept around in case a future rig diverges.
const TRACK_BONE_REMAP: Record<string, string> = {};

function stripMixamoPrefix(name: string): string {
  // FBXLoader strips ':' from bone names so the same source bone can ship as
  // "mixamorig:Hips", "mixamorigHips", "mixamorig_Hips", or "mixamorig1Hips"
  // (Mixamo bumps the index for re-uploaded rigs). Strip any of those.
  const m = name.match(/^mixamorig[0-9]*[:_]?(.+)$/i);
  return m ? m[1] : name;
}

function pickClip(
  animations: THREE.AnimationClip[] | undefined,
): THREE.AnimationClip | null {
  if (!animations || animations.length === 0) return null;
  const nonZero = animations.find((clip) => clip.duration > 0);
  return nonZero ?? animations[0] ?? null;
}

/**
 * If a texture's source bitmap is larger than `maxSize`, blit it down to
 * a maxSize-clamped canvas in place. Saves GPU memory and per-frag
 * sampling cost on mobile devices that load high-res Meshy skin maps.
 *
 * Mutates the texture's `image` property and uses `needsUpdate = true`
 * so three.js re-uploads it on next render. Skipped silently for
 * cross-origin images (canvas tainting) or for textures whose source
 * isn't a CanvasImageSource.
 */
function maybeDownsampleTexture(tex: THREE.Texture, maxSize: number): void {
  if (!tex || maxSize <= 0) return;
  // `image` can be HTMLImageElement, ImageBitmap, HTMLCanvasElement, or
  // a video — only the first three are safe to draw to a 2D canvas.
  const img = tex.image as
    | (HTMLImageElement & { width: number; height: number })
    | (ImageBitmap & { width: number; height: number })
    | (HTMLCanvasElement & { width: number; height: number })
    | undefined;
  if (!img || typeof img.width !== "number" || typeof img.height !== "number") return;
  const w = img.width;
  const h = img.height;
  const longest = Math.max(w, h);
  if (longest <= maxSize) return;
  const scale = maxSize / longest;
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  // High-quality scaling so the downsampled skin doesn't look chunky.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img as CanvasImageSource, 0, 0, tw, th);
  tex.image = canvas;
  tex.needsUpdate = true;
}

function remapClipToAvatarRig(
  clip: THREE.AnimationClip,
  /** Map of `strippedBoneName` → actual rig bone name (preserving the rig's
   *  prefix so the AnimationMixer can find the bone by name). */
  avatarBoneByStripped: Map<string, string>,
  /** When true, drop all tracks targeting the lower body (UpLeg/Leg/Foot/Toe).
   *  Keep available for future upper-body-only idles. */
  lockLegs = false,
): THREE.AnimationClip | null {
  const tracks: THREE.KeyframeTrack[] = [];
  const skipped: string[] = [];

  const LEG_BONES = new Set([
    "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase", "LeftToe_End",
    "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase", "RightToe_End",
  ]);

  for (const track of clip.tracks) {
    const dot = track.name.indexOf(".");
    if (dot <= 0) continue;

    const rawBone = stripMixamoPrefix(track.name.slice(0, dot));
    const property = track.name.slice(dot + 1);
    const lookup = TRACK_BONE_REMAP[rawBone] ?? rawBone;
    const actualBoneName = avatarBoneByStripped.get(lookup);

    if (!actualBoneName) {
      skipped.push(`${rawBone} (sought ${lookup})`);
      continue;
    }

    // Mixamo Hips position tracks ship in centimeters; applying them to a
    // meter-scale rig flings the avatar off-screen. Keep it in place.
    if (
      lookup === "Hips" &&
      (property === "position" || property.startsWith("position["))
    ) {
      continue;
    }

    if (lockLegs && LEG_BONES.has(lookup)) {
      continue;
    }

    const cloned = track.clone();
    cloned.name = `${actualBoneName}.${property}`;
    tracks.push(cloned);
  }

  if (tracks.length === 0) {
    console.warn("[Avatar] clip produced 0 mapped tracks", clip.name, {
      sampleSourceTracks: clip.tracks.slice(0, 6).map((t) => t.name),
      skippedSample: skipped.slice(0, 8),
    });
    return null;
  }

  if (skipped.length) {
    console.log(
      `[Avatar] clip ${clip.name}: ${tracks.length} tracks mapped, ${skipped.length} skipped (e.g. ${skipped.slice(0, 4).join(", ")})`,
    );
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

/* ── FBX cache (Suspense-friendly) ──
   We cache both the parsed FBX scene (for the avatar) and the extracted
   clips (for animation packs whose mesh we don't want).

   Asset hosting strategy:
   - In dev (`NEXT_PUBLIC_ASSET_BASE_URL` unset) we serve straight from
     `/public/animations/*.fbx` for fast local iteration.
   - In production we host the FBXs on Vercel Blob (or any CDN) and set
     `NEXT_PUBLIC_ASSET_BASE_URL=https://<hash>.public.blob.vercel-storage.com`
     so the giant FBX files don't have to ship through git or the
     Next.js build output (which has a 100MB hard limit per asset on
     Vercel's serverless deployments).
   - On the device we wrap fetch with the browser's Cache Storage API so
     the FBX files are only downloaded once per device and subsequent
     loads come from local disk \u2014 the kiosk is responsive even on flaky
     connections.

   Set the cache name + bump the version when shipping new asset bundles.

   Both `ASSET_BASE_URL` and `ASSET_CACHE_NAME` are now defined in
   `src/app/lib/avatarAssets.ts` so the pre-mount preloader and the
   runtime loader read from the exact same Cache Storage bucket. */
// Re-export aliases so the rest of this file can keep its existing
// references untouched. These are the same constants the preloader uses;
// changing one without the other will silently re-download every asset.
void ASSET_BASE_URL;
void ASSET_CACHE_NAME;

/** Fetch through Cache Storage so the second visit is instant.
 *  Falls back to a plain fetch when Cache Storage is unavailable
 *  (SSR, private mode, etc.). Returns an ArrayBuffer ready for FBXLoader.parse. */
async function fetchAssetCached(path: string): Promise<ArrayBuffer> {
  const url = assetUrl(path);
  if (typeof caches !== "undefined") {
    try {
      const activeCacheName = await ensureFreshAssetCache();
      const cache = await caches.open(activeCacheName);
      const hit = await cache.match(url);
      if (hit) return await hit.arrayBuffer();
      const resp = await fetch(url, { credentials: "omit" });
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText} for ${url}`);
      // Clone before consuming so the cache gets a fresh copy.
      cache.put(url, resp.clone()).catch((e) => {
        console.warn("[Avatar] cache.put failed (non-fatal):", e);
      });
      return await resp.arrayBuffer();
    } catch (e) {
      console.warn("[Avatar] cache fetch fallback for", url, e);
    }
  }
  const resp = await fetch(url, { credentials: "omit" });
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText} for ${url}`);
  return await resp.arrayBuffer();
}

const fbxSceneCache = new Map<string, THREE.Group>();
const fbxClipCache = new Map<string, THREE.AnimationClip[]>();
const fbxScenePromises = new Map<string, Promise<THREE.Group>>();
const fbxClipPromises = new Map<string, Promise<THREE.AnimationClip[]>>();

function loadFbxScene(url: string): Promise<THREE.Group> {
  let p = fbxScenePromises.get(url);
  if (!p) {
    const loader = new FBXLoader();
    p = fetchAssetCached(url)
      .then((buf) => loader.parse(buf, ""))
      .then((group) => {
        fbxSceneCache.set(url, group as THREE.Group);
        return group as THREE.Group;
      })
      .catch((err) => {
        console.error("[Avatar] FBX scene load failed:", url, err);
        fbxScenePromises.delete(url);
        throw err;
      });
    fbxScenePromises.set(url, p);
  }
  return p;
}

function useFbxScene(url: string): THREE.Group {
  const cached = fbxSceneCache.get(url);
  if (cached) return cached;
  throw loadFbxScene(url);
}

function loadFbxClips(url: string): Promise<THREE.AnimationClip[]> {
  let p = fbxClipPromises.get(url);
  if (!p) {
    // `.clip.json` payloads are pre-extracted AnimationClip JSON written by
    // `scripts/extract-clips.mjs`. They skip the entire FBX download/parse
    // path (which is what was killing the kiosk on mobile Safari).
    if (/\.clip\.json($|\?)/i.test(url)) {
      p = fetchAssetCached(url)
        .then((buf) => {
          const text = new TextDecoder().decode(buf);
          const raw = JSON.parse(text) as unknown;
          const arr = Array.isArray(raw) ? raw : [raw];
          const clips = arr.map((j) =>
            THREE.AnimationClip.parse(j as Parameters<typeof THREE.AnimationClip.parse>[0]),
          );
          fbxClipCache.set(url, clips);
          return clips;
        })
        .catch((err) => {
          console.error("[Avatar] clip JSON load failed:", url, err);
          fbxClipPromises.delete(url);
          throw err;
        });
      fbxClipPromises.set(url, p);
      return p;
    }

    const loader = new FBXLoader();
    p = fetchAssetCached(url)
      .then((buf) => loader.parse(buf, ""))
      .then((group) => {
        const clips = (group.animations || []).map((c) => c.clone());
        // Drop the heavy mesh data — we only ever needed the AnimationClips.
        group.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (mesh.isMesh) {
            mesh.geometry?.dispose?.();
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            mats.forEach((m) => (m as THREE.Material | undefined)?.dispose?.());
          }
        });
        fbxClipCache.set(url, clips);
        return clips;
      })
      .catch((err) => {
        console.error("[Avatar] FBX load failed:", url, err);
        fbxClipPromises.delete(url);
        throw err;
      });
    fbxClipPromises.set(url, p);
  }
  return p;
}

function useFbxClips(url: string): THREE.AnimationClip[] {
  // Low-tier devices skip optional gesture animations entirely. Returning
  // an empty clip array makes `pickClip()` resolve to `null`, which
  // downstream code already treats as "this gesture is unavailable" and
  // simply leaves the avatar in `idle_standing`. Keeps low-end phones
  // from spending RAM/CPU on animations they will never play.
  const profile = getDeviceProfile();
  if (!isAssetEnabled(url, profile)) return EMPTY_CLIPS;
  // If the preloader 404'd this asset (stale blob bucket, typo in path,
  // etc.) treat it as unavailable rather than throwing a Suspense fetch
  // that would loop forever. Same downstream contract as the low-tier
  // skip path above.
  const pathOnly = url.replace(ASSET_BASE_URL, "") || url;
  if (isAssetMissing(pathOnly)) return EMPTY_CLIPS;
  const cached = fbxClipCache.get(url);
  if (cached) return cached;
  throw loadFbxClips(url);
}

// Shared empty-array sentinel so React's `useMemo` dependency comparison
// stays stable across renders for skipped optional clips.
const EMPTY_CLIPS: THREE.AnimationClip[] = [];

/* ── Error boundary ── */
class AvatarErrorBoundary extends Component<
  { children: ReactNode; fallback: (err: Error | null) => ReactNode },
  { hasError: boolean; error: Error | null }
> {
  state = { hasError: false, error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, info: { componentStack?: string }) {
    console.error("[Avatar] error boundary caught:", error, info);
  }
  render() {
    return this.state.hasError ? this.props.fallback(this.state.error) : this.props.children;
  }
}

function AvatarModel({
  gestureRef,
  faceDetectedRef,
  isSpeakingRef,
  aiGestureRef,
  onAnimStateChangeRef,
  onReadyRef,
}: {
  gestureRef: MutableRefObject<GestureName>;
  faceDetectedRef: MutableRefObject<boolean>;
  isSpeakingRef: MutableRefObject<boolean>;
  /** AI-triggered gesture (e.g. ElevenLabs clientTool fires it on a
   *  high-weight phrase). The avatar plays the named gesture once and
   *  then ignores subsequent ticks until the nonce changes again. */
  aiGestureRef: MutableRefObject<{ name: string; nonce: number } | null>;
  onAnimStateChangeRef: MutableRefObject<(state: AvatarAnimState) => void>;
  onReadyRef: MutableRefObject<(() => void) | undefined>;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const notify = useCallback(
    (state: AvatarAnimState) => onAnimStateChangeRef.current?.(state),
    [onAnimStateChangeRef],
  );
  const baseFbx = useFbxScene(AVATAR_URL);

  const idleClips = useFbxClips(ANIM_IDLE_URL);
  const sittingClips = useFbxClips(ANIM_SITTING_URL);
  const standingClips = useFbxClips(ANIM_STANDING_URL);
  const stoppingClips = useFbxClips(ANIM_STOPPING_URL);
  const walkingClips = useFbxClips(ANIM_WALKING_URL);
  const wavingClips = useFbxClips(ANIM_WAVING_URL);
  const prayingClips = useFbxClips(ANIM_PRAYING_URL);
  const explainingClips = useFbxClips(ANIM_EXPLAINING_URL);
  const yellingClips = useFbxClips(ANIM_YELLING_URL);
  const dismissingClips = useFbxClips(ANIM_DISMISSING_URL);
  const shootingArrowClips = useFbxClips(ANIM_SHOOTING_ARROW_URL);
  const thoughtfulClips = useFbxClips(ANIM_THOUGHTFUL_URL);
  const climbingClips = useFbxClips(ANIM_CLIMBING_URL);
  const leftTurnClips = useFbxClips(ANIM_LEFT_TURN_URL);
  const pointingClips = useFbxClips(ANIM_POINTING_URL);
  const swordFightClips = useFbxClips(ANIM_SWORD_FIGHT_URL);
  const fallingClips = useFbxClips(ANIM_FALLING_URL);

  const scene = useMemo(() => SkeletonUtils.clone(baseFbx) as THREE.Group, [baseFbx]);

  const sourceClips = useMemo(
    () => ({
      idle_standing: pickClip(idleClips),
      sitting: pickClip(sittingClips),
      standing_up: pickClip(standingClips),
      stopping: pickClip(stoppingClips),
      walking: pickClip(walkingClips),
      waving: pickClip(wavingClips),
      praying: pickClip(prayingClips),
      explaining: pickClip(explainingClips),
      yelling: pickClip(yellingClips),
      dismissing: pickClip(dismissingClips),
      shooting_arrow: pickClip(shootingArrowClips),
      thoughtful: pickClip(thoughtfulClips),
      climbing: pickClip(climbingClips),
      left_turn: pickClip(leftTurnClips),
      pointing: pickClip(pointingClips),
      sword_fight: pickClip(swordFightClips),
      falling: pickClip(fallingClips),
    }),
    [idleClips, sittingClips, standingClips, stoppingClips, walkingClips, wavingClips, prayingClips, explainingClips, yellingClips, dismissingClips, shootingArrowClips, thoughtfulClips, climbingClips, leftTurnClips, pointingClips, swordFightClips, fallingClips],
  );

  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const actionsRef = useRef<Record<ClipKey, THREE.AnimationAction | undefined>>({
    sitting: undefined,
    standing_up: undefined,
    walking: undefined,
    stopping: undefined,
    idle_standing: undefined,
    waving: undefined,
    praying: undefined,
    explaining: undefined,
    yelling: undefined,
    dismissing: undefined,
    shooting_arrow: undefined,
    thoughtful: undefined,
    climbing: undefined,
    left_turn: undefined,
    pointing: undefined,
    sword_fight: undefined,
    falling: undefined,
  });
  const currentActionRef = useRef<THREE.AnimationAction | null>(null);
  const animStateRef = useRef<AvatarAnimState>("idle_standing");

  // Face debouncing.
  const stableFaceRef = useRef(false);
  const lastFaceChangeRef = useRef<number>(0);
  const lastFaceRawRef = useRef(false);

  // Cooldowns.
  const noFaceSinceRef = useRef<number | null>(null);
  const lastWaveAtRef = useRef<number>(0);
  const lastPrayAtRef = useRef<number>(0);
  // Last explicit AI-triggered explain firing. Long cooldown so even if
  // the AI sends rapid triggers we space them out.
  const lastExplainAtRef = useRef<number>(0);
  // Yelling is a rare "shoo away" gesture — even longer cooldown.
  const lastYellAtRef = useRef<number>(0);
  // Per-gesture cooldowns for AI-triggered cues.
  const lastDismissAtRef = useRef<number>(0);
  const lastShootAtRef = useRef<number>(0);
  const lastThoughtfulAtRef = useRef<number>(0);
  const lastClimbAtRef = useRef<number>(0);
  const lastLeftTurnAtRef = useRef<number>(0);
  const lastPointAtRef = useRef<number>(0);
  const lastSwordAtRef = useRef<number>(0);
  const lastAiNonceRef = useRef<number>(-1);

  /* ── Attract mode ──
     If the sage sits with no visitor for a long random interval, he
     spontaneously stands up, walks toward the screen (zoomed in 20%
     beyond the normal close mark), performs the `climbing` gesture, then
     walks back and sits down. Designed to draw passers-by toward the
     kiosk. The ATTRACT_DELAY is re-rolled each time the avatar enters
     the sitting state. */
  const attractModeRef = useRef(false);
  const sittingSinceRef = useRef<number>(0);
  const nextAttractAtRef = useRef<number>(0);
  const ATTRACT_MIN_IDLE_MS = 60_000;   // 1 min
  const ATTRACT_MAX_IDLE_MS = 180_000;  // 3 min
  const ATTRACT_SCALE_MULT = 1.2;       // 20% larger than normal close-up

  /* ── Foot bones for per-frame ground clamp.
     Mixamo idle/breathing clips routinely shift the Hips Y a few cm above
     the bind pose, which makes the avatar look like it's hovering. We grab
     the toe bones at mount and, each frame, snap the group's Y so the
     lower toe sits exactly on GROUND_Y. */
  const footBonesRef = useRef<{ left: THREE.Object3D | null; right: THREE.Object3D | null }>({
    left: null,
    right: null,
  });

  // Walking traversal: time-driven so the walking clip plays a whole
  // number of cycles (no half-step landing). Trip duration is computed
  // from the clip's natural length × WALK_CYCLES on entry, so the clip
  // is never sped up or slowed down — it always plays at its authored
  // pace and the avatar arrives exactly at the end of a full step.
  const walkStartRef = useRef<number>(0);
  const walkFromZRef = useRef<number>(0);
  const walkToZRef = useRef<number>(0);
  const walkDurationMsRef = useRef<number>(2000);
  // Number of full clip cycles per BACK_Z↔FRONT_Z trip. The Standard
  // Walk clip is ~1s and covers ~1m of forward locomotion at natural
  // pace, which feels right over the 2m stage trip in two cycles.
  const WALK_CYCLES = 2;

  useEffect(() => {
    /* ── Material polish ──
       The Meshy FBX ships its own embedded textures, so we leave the maps
       alone and just tighten filtering + zero out the all-white emissive
       that bakes from FBX's Phong shading model. */
    // Resolve once per mount so material setup mirrors the renderer
    // settings picked by `<DeviceTunedCanvas>`.
    const matProfile = getDeviceProfile();
    const avatarBoneByStripped = new Map<string, string>();

    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
          (mesh as THREE.SkinnedMesh).normalizeSkinWeights();
        }
        const mats = Array.isArray(mesh.material) ? [...mesh.material] : [mesh.material];
        mats.forEach((mat, materialIndex) => {
          const source = mat as THREE.MeshStandardMaterial;
          const hasMorphTargets = Boolean((mesh as THREE.Mesh).morphTargetInfluences?.length);
          const m = new THREE.MeshLambertMaterial({
            name: source.name,
            color: source.color?.clone?.() ?? new THREE.Color(0xffffff),
            map: source.map ?? null,
            emissive: new THREE.Color(0x000000),
            transparent: source.transparent ?? false,
            opacity: source.opacity ?? 1,
            alphaTest: source.alphaTest ?? 0,
            side: source.side ?? THREE.FrontSide,
            fog: source.fog ?? true,
          });
          const fastMaterial = m as THREE.MeshLambertMaterial & {
            skinning: boolean;
            morphTargets?: boolean;
          };
          fastMaterial.skinning = (mesh as THREE.SkinnedMesh).isSkinnedMesh;
          fastMaterial.morphTargets = hasMorphTargets;
          m.depthWrite = source.depthWrite;
          m.depthTest = source.depthTest;
          m.vertexColors = source.vertexColors;
          m.toneMapped = source.toneMapped;
          mats[materialIndex] = m;
          source.dispose?.();

          if (m.map) {
            m.map.colorSpace = THREE.SRGBColorSpace;
            // Anisotropy used to be hardcoded at 16 — disastrous on mobile
            // GPUs whose max is often 4 or 8 anyway. Source from the
            // device profile so low/mid tiers get 1–2 instead.
            m.map.anisotropy = matProfile.anisotropy;
            m.map.generateMipmaps = false;
            m.map.minFilter = THREE.LinearFilter;
            m.map.magFilter = THREE.LinearFilter;
            // Downsample oversized diffuse textures on mobile. The
            // Meshy-baked skin maps ship as 2048² or 4096² which is
            // wasted on a webcam-distance avatar and is the #1 cause
            // of GPU memory pressure on Android tablets / older iOS.
            try {
              maybeDownsampleTexture(m.map, matProfile.maxTextureSize);
            } catch {
              // Cross-origin image data can throw on .getImageData; the
              // texture stays at its native size in that case.
            }
            m.map.needsUpdate = true;
          }
          if (m.emissiveMap) {
            m.emissiveMap.dispose?.();
            m.emissiveMap = null;
          }
          m.emissive = new THREE.Color(0x000000);
          // Avatar is a closed mesh — back-faces are never visible. Use
          // FrontSide on mid/low to roughly halve fragment shader work.
          m.side = matProfile.doubleSide ? THREE.DoubleSide : THREE.FrontSide;
          m.needsUpdate = true;
        });
        mesh.material = Array.isArray(mesh.material) ? mats : mats[0];
        mesh.frustumCulled = false;
      }
      if ((obj as THREE.Bone).isBone) {
        const stripped = stripMixamoPrefix(obj.name);
        avatarBoneByStripped.set(stripped, obj.name);
        if (stripped === "LeftToeBase" || stripped === "LeftFoot") {
          // Prefer the toe (lowest), but fall back to foot if the rig has no toe.
          if (!footBonesRef.current.left || stripped === "LeftToeBase") {
            footBonesRef.current.left = obj;
          }
        } else if (stripped === "RightToeBase" || stripped === "RightFoot") {
          if (!footBonesRef.current.right || stripped === "RightToeBase") {
            footBonesRef.current.right = obj;
          }
        }
      }
    });

    /* ── Scale + ground the avatar ──
       Anchor the avatar's feet at scene-local y = 0 so the parent group's
       world Y becomes the literal floor line. Because feet sit at 0 in
       local space, scaling the group never lifts the feet off the floor
       — essential for the "walk closer = grow" stage trick below. */
    scene.position.set(0, 0, 0);
    scene.scale.set(1, 1, 1);
    scene.updateMatrixWorld(true);
    const rawBox = new THREE.Box3().setFromObject(scene);
    const modelHeight = rawBox.max.y - rawBox.min.y;
    const desiredHeight = 2.45;
    if (modelHeight > 0.001) {
      const s = desiredHeight / modelHeight;
      scene.scale.setScalar(s);
    }
    scene.updateMatrixWorld(true);
    const scaledBox = new THREE.Box3().setFromObject(scene);
    const center = new THREE.Vector3();
    scaledBox.getCenter(center);
    scene.position.set(-center.x, -scaledBox.min.y, -center.z);
    scene.updateMatrixWorld(true);

    /* ── Build mixer + actions ── */
    const mixer = new THREE.AnimationMixer(scene);
    mixerRef.current = mixer;

    const nextActions: Record<ClipKey, THREE.AnimationAction | undefined> = {
      sitting: undefined,
      standing_up: undefined,
      walking: undefined,
      stopping: undefined,
      idle_standing: undefined,
      waving: undefined,
      praying: undefined,
      explaining: undefined,
      yelling: undefined,
      dismissing: undefined,
      shooting_arrow: undefined,
      thoughtful: undefined,
      climbing: undefined,
      left_turn: undefined,
      pointing: undefined,
      sword_fight: undefined,
      falling: undefined,
    };

    (Object.keys(sourceClips) as ClipKey[]).forEach((key) => {
      const clip = sourceClips[key];
      if (!clip) return;
      // The custom standing idle should play as-authored.
      const lockLegs = false;
      const mapped = remapClipToAvatarRig(clip, avatarBoneByStripped, lockLegs);
      if (!mapped) return;
      const action = mixer.clipAction(mapped, scene);
      action.enabled = true;
      action.setEffectiveWeight(1);
      action.setEffectiveTimeScale(1);
      nextActions[key] = action;
    });

    actionsRef.current = nextActions;

    // Default pose is standing idle — the avatar never sits.
    const initialState: AvatarAnimState =
      (nextActions.idle_standing && "idle_standing") ||
      "idle_standing";

    const initialClip = STATE_TARGETS[initialState].clipKey;
    const initialAction = nextActions[initialClip];
    if (initialAction) {
      initialAction
        .reset()
        .setLoop(
          initialState === "idle_standing" || initialState === "sitting"
            ? THREE.LoopRepeat
            : THREE.LoopOnce,
          Infinity,
        )
        .play();
      initialAction.setEffectiveWeight(1);
      currentActionRef.current = initialAction;
      animStateRef.current = initialState;

      // Snap the group to the initial state's stage marks so the very first
      // frame is already on-mark (no slide-in from the origin).
      const grp = groupRef.current;
      if (grp) {
        const t = STATE_TARGETS[initialState];
        grp.position.set(0, GROUND_Y + (initialState === "sitting" ? SIT_GROUND_OFFSET_Y : 0), t.z);
        grp.rotation.y = t.rotY;
        grp.scale.setScalar(t.scale);
      }

      mixer.update(0);
      notify(initialState);
      // Tell the host the avatar is on screen so it can spin up the camera
      // pipeline now — we deliberately defer onReady to the next frame so
      // React commits the Canvas before MediaPipe starts hammering the GPU.
      requestAnimationFrame(() => onReadyRef.current?.());
    }

    console.log("[Avatar] ready", {
      bones: avatarBoneByStripped.size,
      actions: Object.entries(nextActions)
        .filter(([, a]) => !!a)
        .map(([n]) => n),
      initialState,
    });

    return () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(scene);
      mixerRef.current = null;
      currentActionRef.current = null;
      actionsRef.current = {
        sitting: undefined,
        standing_up: undefined,
        walking: undefined,
        stopping: undefined,
        idle_standing: undefined,
        waving: undefined,
        praying: undefined,
        explaining: undefined,
        yelling: undefined,
        dismissing: undefined,
        shooting_arrow: undefined,
        thoughtful: undefined,
        climbing: undefined,
        left_turn: undefined,
        pointing: undefined,
        sword_fight: undefined,
        falling: undefined,
      };
    };
    // `notify` is stable (refs only); intentionally NOT a dep so we don't
    // tear down the mixer on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, sourceClips]);

  // Frame-rate cap. We accumulate `delta` and only run the heavy
  // per-frame work (mixer.update + foot clamp + transform lerps) when
  // we've crossed `targetFrameMs`. This roughly halves GPU + CPU load
  // on phones (mid: 30fps, low: 24fps) without re-architecting the
  // animation timing — the residual delta is fed into mixer.update so
  // playback stays at the correct wall-clock speed.
  const frameProfile = useMemo(() => getDeviceProfile(), []);
  const targetFrameMs = useMemo(
    () => 1000 / Math.max(15, frameProfile.targetFps),
    [frameProfile.targetFps],
  );
  const frameAccumRef = useRef(0);
  // Adaptive frame budget: start from the configured target and gently
  // widen on sustained overload (e.g. low-end phones with active vision),
  // then recover back when headroom returns. Keeps motion smooth by
  // avoiding repeated over-budget spikes.
  const adaptiveFrameMsRef = useRef(targetFrameMs);
  const overBudgetStreakRef = useRef(0);
  const underBudgetStreakRef = useRef(0);
  // Throttle the foot-clamp `updateMatrixWorld()` traversal — it walks
  // the entire skeleton and is the most expensive part of the loop.
  // Running it every other tick is imperceptible at 30fps but cuts
  // CPU markedly on iPhones.
  const footClampTickRef = useRef(0);
  // Persistent low-pass-filtered floor offset. Holds the slow-moving
  // "how high above the ground does the breathing-idle clip park the
  // hips" correction so we don't fight the per-frame yLerp. Without
  // this, modifying grp.position.y from the foot clamp every frame
  // produces visible vertical bob on lower-fps Android tablets where
  // the breathing oscillation aliases against the lerp.
  const footFloorOffsetRef = useRef(0);

  useFrame((_, delta) => {
    const baseFrameMs = targetFrameMs;
    const maxFrameMs = 1000 / 30; // never drop below 30fps pacing
    const observedMs = delta * 1000;
    if (observedMs > adaptiveFrameMsRef.current * 1.6) {
      overBudgetStreakRef.current += 1;
      underBudgetStreakRef.current = 0;
      if (overBudgetStreakRef.current >= 12) {
        adaptiveFrameMsRef.current = Math.min(maxFrameMs, adaptiveFrameMsRef.current + 2);
        overBudgetStreakRef.current = 0;
      }
    } else if (observedMs < adaptiveFrameMsRef.current * 0.9) {
      underBudgetStreakRef.current += 1;
      overBudgetStreakRef.current = 0;
      if (underBudgetStreakRef.current >= 60) {
        adaptiveFrameMsRef.current = Math.max(baseFrameMs, adaptiveFrameMsRef.current - 1);
        underBudgetStreakRef.current = 0;
      }
    }

    // Frame-rate cap (mid: 30fps, low: 24fps, high: 60fps). Skip
    // entirely when we haven't crossed the target frame budget.
    frameAccumRef.current += delta;
    if (frameAccumRef.current * 1000 < adaptiveFrameMsRef.current) return;
    const stepDelta = frameAccumRef.current;
    frameAccumRef.current = 0;
    delta = stepDelta;

    const mixer = mixerRef.current;
    const actions = actionsRef.current;
    if (mixer) mixer.update(Math.min(delta, 0.05));

    /* ── Smoothly drive group transform toward the current state's marks ── */
    const grp = groupRef.current;
    const state = animStateRef.current;
    const target = STATE_TARGETS[state];
    let onMark = true;
    let facingTarget = true;
    if (grp) {
      // Two traversal modes:
      //   1. Walking states: linear, time-driven so it ends exactly when
      //      the walking clip has played for WALK_DURATION_MS. The clip's
      //      timeScale is set on entry so its playback length matches.
      //   2. Everything else: exponential ease for snappy snap-to-mark.
      const isWalking = state === "walking_in" || state === "walking_out";
      const rotLerp = Math.min(1, delta * 3.5);   // ~0.3s to turn

      // Sit pose needs a small extra dip because we strip Hips translation.
      // Climbing should visibly travel upward — Mixamo's clip is in-place,
      // so we drive a synthetic lift curve based on the action's progress.
      // Falling is the inverse: the avatar spawns above the visible
      // viewport and descends back to ground over the clip's duration.
      let yBias = 0;
      if (state === "sitting") {
        yBias = SIT_GROUND_OFFSET_Y;
      } else if (state === "climbing") {
        const ca = actions.climbing;
        if (ca) {
          const dur = ca.getClip().duration || 1;
          const p = Math.max(0, Math.min(1, ca.time / dur));
          // Smoothstep helper.
          const ss = (a: number, b: number, x: number) => {
            const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
            return t * t * (3 - 2 * t);
          };
          // Lift HIGH enough that the avatar fully exits the top of the
          // viewport on a portrait phone screen. With camera at z≈5.7
          // and fov 36°, the visible vertical extent at z=0 is roughly
          // 2 * tan(18°) * 5.7 ≈ 3.7 units. Avatar height is ~1.7u, so
          // a 4u lift puts the toes well above the top edge. Then HOLD
          // off-screen for the last ~25% of the clip so the climb beat
          // lands before the falling state takes over.
          const CLIMB_LIFT_MAX = 4.0;
          // Reach the off-screen top slightly later so the ascent reads
          // less abruptly on handhelds.
          yBias = CLIMB_LIFT_MAX * ss(0, 0.55, p);
        }
      } else if (state === "falling") {
        const fa = actions.falling;
        if (fa) {
          const dur = fa.getClip().duration || 1;
          const p = Math.max(0, Math.min(1, fa.time / dur));
          const FALL_FROM = 4.0;
          // Start this clip only once the character is already meaningfully
          // into the descent, then accelerate downward like gravity.
          const gravityStart = 0.22;
          const gravityEnd = 0.62;
          const t = Math.max(0, Math.min(1, (p - gravityStart) / (gravityEnd - gravityStart)));
          const dropProgress = t * t;
          yBias = FALL_FROM * (1 - dropProgress);
        }
      }
      const tgtY = GROUND_Y + yBias - footFloorOffsetRef.current;

      // Snappier follow during climb / fall so the lift+drop tracks the
      // curve closely. Climb needs to commit instantly when entering;
      // fall needs to track gravity tightly so the landing beat reads.
      const yLerp = (state === "climbing" || state === "falling")
        ? Math.min(1, delta * 12)
        : Math.min(1, delta * 3);
      grp.position.y += (tgtY - grp.position.y) * yLerp;

      /* ── Foot-to-floor clamp (low-pass filtered) ──
         Mixamo's breathing-idle clip lifts the Hips a few cm above the
         bind pose. Without correction the toes float above GROUND_Y. We
         sample whichever toe is currently lower and update a persistent
         `footFloorOffsetRef` with a SLOW exponential filter (~3 s time
         constant) so we capture the long-term hip-lift offset without
         tracking the breathing oscillation itself. The offset is then
         applied to `tgtY` above on the NEXT frame, which means the
         correction never fights the yLerp on the same frame — eliminating
         the visible vertical bob on capped-fps mobile devices. Skipped
         during walking (already time-driven), sitting (cross-leg pose
         has its own offset), and climbing/falling (synthetic Y curves). */
      if (
        frameProfile.enableFootClamp &&
        !isWalking &&
        state !== "sitting" &&
        state !== "climbing" &&
        state !== "falling"
      ) {
        const lf = footBonesRef.current.left;
        const rf = footBonesRef.current.right;
        if (lf || rf) {
          // updateMatrixWorld traverses the full skeleton — expensive on
          // mobile. Run it every 4th tick (~7 fps on mid, ~6 fps on low)
          // since the floor offset is sub-pixel anyway.
          footClampTickRef.current = (footClampTickRef.current + 1) & 3;
          if (footClampTickRef.current === 0) {
            // Make sure transforms are up to date for the new mixer pose.
            scene.updateMatrixWorld();
            let minFootY = Infinity;
            const v = new THREE.Vector3();
            if (lf) { lf.getWorldPosition(v); minFootY = Math.min(minFootY, v.y); }
            if (rf) { rf.getWorldPosition(v); minFootY = Math.min(minFootY, v.y); }
            if (Number.isFinite(minFootY)) {
              // Drift from the desired floor line at this exact frame —
              // includes both the long-term hip lift AND the instantaneous
              // breathing oscillation. We only want the long-term part.
              const measuredOffset = minFootY - GROUND_Y;
              // ~3 s time constant (assuming clamp ticks at ~7 Hz this is
              // alpha ≈ 0.045 per sample). Slow enough to ignore the 0.5
              // Hz breathing wobble entirely.
              footFloorOffsetRef.current +=
                (measuredOffset - footFloorOffsetRef.current) * 0.05;
            }
          }
        }
      } else {
        // Decay the offset back to zero whenever we're in a state that
        // doesn't use the clamp, so re-entering idle doesn't snap.
        footFloorOffsetRef.current *= 0.92;
      }

      if (isWalking) {
        const elapsed = performance.now() - walkStartRef.current;
        const t = Math.max(0, Math.min(1, elapsed / walkDurationMsRef.current));
        // Smoothstep so foot pacing reads naturally at start and stop.
        const ease = t * t * (3 - 2 * t);
        grp.position.z = walkFromZRef.current
          + (walkToZRef.current - walkFromZRef.current) * ease;
      } else {
        const posLerp = Math.min(1, delta * 4);
        grp.position.z += (target.z - grp.position.z) * posLerp;
      }

      // Shortest-path rotation lerp on Y.
      let drot = target.rotY - grp.rotation.y;
      while (drot > Math.PI) drot -= Math.PI * 2;
      while (drot < -Math.PI) drot += Math.PI * 2;
      grp.rotation.y += drot * rotLerp;

      // Lock scale to z-progress so the zoom-in happens *during* the walk
      // rather than after, and resolves exactly when z does. Clamped to
      // the BACK_Z..FRONT_Z range so off-mark states still pick a sane
      // value.
      const zProgress =
        (grp.position.z - BACK_Z) / (FRONT_Z - BACK_Z);
      const t = Math.max(0, Math.min(1, zProgress));
      const derivedScale = BACK_SCALE + (FRONT_SCALE - BACK_SCALE) * t;
      // Attract mode zooms 20% beyond the normal front-mark scale so the
      // climbing gesture really commands attention.
      const scaleMult = attractModeRef.current ? ATTRACT_SCALE_MULT : 1;
      grp.scale.setScalar(derivedScale * scaleMult);

      onMark =
        Math.abs(target.z - grp.position.z) < 0.04 &&
        Math.abs(target.scale * scaleMult - grp.scale.x) < 0.012;
      facingTarget = Math.abs(drot) < 0.05;
    }

    const fadeToClip = (
      clipKey: ClipKey,
      loop: THREE.AnimationActionLoopStyles,
      once = false,
      fade = 0.5,
    ) => {
      const next = actions[clipKey];
      if (!next) return false;

      next.reset().setLoop(loop, once ? 1 : Infinity);
      next.clampWhenFinished = once;
      next.enabled = true;
      next.setEffectiveWeight(1);

      const prev = currentActionRef.current;
      if (prev && prev !== next) {
        prev.crossFadeTo(next, fade, false);
      } else {
        next.fadeIn(fade);
      }

      next.play();
      currentActionRef.current = next;
      return true;
    };

    const goTo = (
      next: AvatarAnimState,
      loop: THREE.AnimationActionLoopStyles = THREE.LoopRepeat,
      once = false,
      fade = 0.5,
    ) => {
      animStateRef.current = next;
      notify(next);
      const playing = fadeToClip(STATE_TARGETS[next].clipKey, loop, once, fade);

      if (next === "climbing") {
        const climbingAction = actions.climbing;
        if (climbingAction) {
          climbingAction.setEffectiveTimeScale(0.9);
        }
      }

      if (next === "falling") {
        const fallingAction = actions.falling;
        if (fallingAction) {
          fallingAction.setEffectiveTimeScale(1.35);
          const clip = fallingAction.getClip();
          if (clip.duration > 0.001) {
            // Skip the earliest portion so the falling body motion starts
            // once the character is already lower in the air.
            fallingAction.time = clip.duration * 0.22;
          }
        }
      }

      // Time-bound the walking traversal so it ends exactly on a full
      // clip cycle (no half-step landing). The clip itself plays at its
      // authored rate — we never speed it up or slow it down.
      if ((next === "walking_in" || next === "walking_out") && playing) {
        walkStartRef.current = performance.now();
        walkFromZRef.current = grp ? grp.position.z : STATE_TARGETS[next].z;
        walkToZRef.current = STATE_TARGETS[next].z;
        const walkAction = actions.walking;
        if (walkAction) {
          walkAction.setEffectiveTimeScale(1);
          const clipDur = walkAction.getClip().duration;
          if (clipDur > 0.001) {
            walkDurationMsRef.current = clipDur * WALK_CYCLES * 1000;
          }
        }
      }
    };

    /* ── Debounce face presence/absence ── */
    const now = performance.now();
    const rawFace = faceDetectedRef.current;
    if (rawFace !== lastFaceRawRef.current) {
      lastFaceRawRef.current = rawFace;
      lastFaceChangeRef.current = now;
    }
    if (
      rawFace !== stableFaceRef.current &&
      now - lastFaceChangeRef.current >= FACE_DEBOUNCE_MS
    ) {
      stableFaceRef.current = rawFace;
    }
    const faceNow = stableFaceRef.current;

    /* ── State machine ──
       sitting ─face→ standing_up ─done→ walking_in ─arrived→ idle_standing
       idle_standing ─no face 3s→ turning_away ─faced→ walking_out
                       ─arrived→ turning_back ─faced→ sitting
       Open_Palm in idle_standing → waving (one-shot) → idle_standing      */
    if (state === "idle_standing") {
      if (faceNow) {
        noFaceSinceRef.current = null;
        const wantsPray =
          gestureRef.current === "Namaste" &&
          now - lastPrayAtRef.current > Math.max(1200, SAME_GESTURE_COOLDOWN_MS);
        const wantsWave =
          gestureRef.current === "Open_Palm" &&
          now - lastWaveAtRef.current > Math.max(2500, SAME_GESTURE_COOLDOWN_MS);
        if (wantsPray && actions.praying) {
          lastPrayAtRef.current = now;
          goTo("praying", THREE.LoopOnce, true, 0.4);
        } else if (wantsWave && actions.waving) {
          lastWaveAtRef.current = now;
          goTo("waving", THREE.LoopOnce, true, 0.4);
        } else {
          // Explicit AI-driven gestures (e.g. ElevenLabs clientTool fires
          // an `aiGesture` with a fresh nonce on a high-weight phrase).
          // No random firing — the agent decides when it matters.
          const ai = aiGestureRef.current;
          if (
            ai &&
            ai.nonce !== lastAiNonceRef.current &&
            ai.name === "explaining" &&
            actions.explaining &&
            now - lastExplainAtRef.current > Math.max(3_500, SAME_GESTURE_COOLDOWN_MS)
          ) {
            lastAiNonceRef.current = ai.nonce;
            lastExplainAtRef.current = now;
            goTo("explaining", THREE.LoopOnce, true, 0.35);
          } else if (
            ai &&
            ai.nonce !== lastAiNonceRef.current &&
            ai.name === "yelling" &&
            actions.yelling &&
            now - lastYellAtRef.current > Math.max(20_000, SAME_GESTURE_COOLDOWN_MS)
          ) {
            // Rare "shoo them away" gesture. Snap-in (short fade) so the
            // motion lands aggressively, then return to idle.
            lastAiNonceRef.current = ai.nonce;
            lastYellAtRef.current = now;
            goTo("yelling", THREE.LoopOnce, true, 0.2);
          } else if (
            ai &&
            ai.nonce !== lastAiNonceRef.current &&
            ai.name === "shooting_arrow" &&
            actions.shooting_arrow &&
            now - lastShootAtRef.current > Math.max(6_000, SAME_GESTURE_COOLDOWN_MS)
          ) {
            // Bow-and-arrow / Dhanurveda / Arjuna references.
            lastAiNonceRef.current = ai.nonce;
            lastShootAtRef.current = now;
            goTo("shooting_arrow", THREE.LoopOnce, true, 0.35);
          } else if (
            ai &&
            ai.nonce !== lastAiNonceRef.current &&
            ai.name === "dismissing" &&
            actions.dismissing &&
            now - lastDismissAtRef.current > Math.max(5_000, SAME_GESTURE_COOLDOWN_MS)
          ) {
            // Refusing / letting go / brushing aside doubts.
            lastAiNonceRef.current = ai.nonce;
            lastDismissAtRef.current = now;
            goTo("dismissing", THREE.LoopOnce, true, 0.35);
          } else if (
            ai &&
            ai.nonce !== lastAiNonceRef.current &&
            ai.name === "thoughtful" &&
            actions.thoughtful &&
            now - lastThoughtfulAtRef.current > Math.max(5_000, SAME_GESTURE_COOLDOWN_MS)
          ) {
            // Deep contemplation / pondering / reflective questions.
            lastAiNonceRef.current = ai.nonce;
            lastThoughtfulAtRef.current = now;
            goTo("thoughtful", THREE.LoopOnce, true, 0.4);
          } else if (
            ai &&
            ai.nonce !== lastAiNonceRef.current &&
            ai.name === "pointing" &&
            actions.pointing &&
            now - lastPointAtRef.current > Math.max(4_000, SAME_GESTURE_COOLDOWN_MS)
          ) {
            // Calling out / directing attention / "look there".
            lastAiNonceRef.current = ai.nonce;
            lastPointAtRef.current = now;
            goTo("pointing", THREE.LoopOnce, true, 0.35);
          } else if (
            ai &&
            ai.nonce !== lastAiNonceRef.current &&
            ai.name === "sword_fight" &&
            actions.sword_fight &&
            now - lastSwordAtRef.current > Math.max(8_000, SAME_GESTURE_COOLDOWN_MS)
          ) {
            // Mahabharata war / Kshatriya valor / sword imagery.
            lastAiNonceRef.current = ai.nonce;
            lastSwordAtRef.current = now;
            goTo("sword_fight", THREE.LoopOnce, true, 0.35);
          } else if (
            ai &&
            ai.nonce !== lastAiNonceRef.current &&
            ai.name === "climbing"
          ) {
            // `climbing` is reserved exclusively for attract-mode (no
            // visitor in front of the camera). Consume the nonce so the
            // gesture never fires mid-conversation, regardless of how
            // the AI was triggered.
            lastAiNonceRef.current = ai.nonce;
          } else if (
            ai &&
            ai.nonce !== lastAiNonceRef.current &&
            ai.name === "left_turn" &&
            actions.left_turn &&
            now - lastLeftTurnAtRef.current > Math.max(6_000, SAME_GESTURE_COOLDOWN_MS)
          ) {
            // Looking aside / changing topic / glancing toward an idea.
            lastAiNonceRef.current = ai.nonce;
            lastLeftTurnAtRef.current = now;
            goTo("left_turn", THREE.LoopOnce, true, 0.4);
          } else if (ai && ai.nonce !== lastAiNonceRef.current) {
            // Consume the nonce even if we couldn't play (cooldown / unknown
            // gesture name) so we don't fire it later when the cooldown ends.
            lastAiNonceRef.current = ai.nonce;
          }
        }
      } else {
        // No face: stay standing idle. The avatar never walks away or sits.
        noFaceSinceRef.current = null;
      }
    } else if (state === "sitting") {
      if (faceNow) {
        noFaceSinceRef.current = null;
        sittingSinceRef.current = 0;
        nextAttractAtRef.current = 0;
        if (actions.standing_up) {
          goTo("standing_up", THREE.LoopOnce, true, 0.6);
        } else {
          goTo("walking_in", THREE.LoopRepeat, false, 0.5);
        }
      } else {
        // Schedule a random attract window the first frame we sit idle.
        if (sittingSinceRef.current === 0) {
          sittingSinceRef.current = now;
          nextAttractAtRef.current = now
            + ATTRACT_MIN_IDLE_MS
            + Math.random() * (ATTRACT_MAX_IDLE_MS - ATTRACT_MIN_IDLE_MS);
        }
        if (
          !attractModeRef.current
          && now >= nextAttractAtRef.current
          && actions.standing_up
          && actions.climbing
        ) {
          attractModeRef.current = true;
          sittingSinceRef.current = 0;
          goTo("standing_up", THREE.LoopOnce, true, 0.6);
        }
      }
    } else if (state === "standing_up") {
      const action = actions.standing_up;
      const done = !action || action.time >= action.getClip().duration - 0.1;
      if (done) {
        // Walk forward toward the camera.
        if (actions.walking) {
          goTo("walking_in", THREE.LoopRepeat, false, 0.4);
        } else {
          goTo("idle_standing", THREE.LoopRepeat, false, 0.5);
        }
      }
    } else if (state === "walking_in") {
      // If the visitor leaves mid-walk, abort and turn around — unless we
      // are in attract mode (no visitor expected; the sage is performing).
      if (!faceNow && !attractModeRef.current) {
        if (noFaceSinceRef.current == null) noFaceSinceRef.current = now;
      } else {
        noFaceSinceRef.current = null;
      }
      if (onMark) {
        // Hand off to the stop-walking clip for a soft ease-in to idle.
        if (actions.stopping) {
          goTo("stopping", THREE.LoopOnce, true, 0.25);
        } else if (attractModeRef.current && actions.climbing) {
          lastClimbAtRef.current = now;
          goTo("climbing", THREE.LoopOnce, true, 0.4);
        } else {
          goTo("idle_standing", THREE.LoopRepeat, false, 0.5);
        }
      }
    } else if (state === "turning_away") {
      // If the visitor comes back before he finishes turning, abort.
      if (faceNow) {
        noFaceSinceRef.current = null;
        goTo("idle_standing", THREE.LoopRepeat, false, 0.4);
      } else if (facingTarget) {
        goTo("walking_out", THREE.LoopRepeat, false, 0.4);
      }
    } else if (state === "walking_out") {
      if (faceNow) {
        noFaceSinceRef.current = null;
        // Visitor returned mid-walk-out: turn back toward camera & re-engage.
        goTo("walking_in", THREE.LoopRepeat, false, 0.4);
      } else if (onMark) {
        goTo("turning_back", THREE.LoopRepeat, false, 0.4);
      }
    } else if (state === "turning_back") {
      if (facingTarget) {
        // Clear attract mode on arrival home so future sit cycles can re-roll.
        attractModeRef.current = false;
        sittingSinceRef.current = 0;
        nextAttractAtRef.current = 0;
        goTo("sitting", THREE.LoopRepeat, false, 0.6);
      }
    } else if (state === "stopping") {
      const action = actions.stopping;
      const done = !action || action.time >= action.getClip().duration - 0.1;
      if (done) {
        if (attractModeRef.current && actions.climbing) {
          lastClimbAtRef.current = now;
          goTo("climbing", THREE.LoopOnce, true, 0.4);
        } else {
          goTo("idle_standing", THREE.LoopRepeat, false, 0.5);
        }
      }
    } else if (state === "waving") {
      const action = actions.waving;
      const done = !action || action.time >= action.getClip().duration - 0.1;
      if (done) {
        goTo("idle_standing", THREE.LoopRepeat, false, 0.5);
      }
    } else if (state === "praying") {
      const action = actions.praying;
      const done = !action || action.time >= action.getClip().duration - 0.1;
      if (done) {
        goTo("idle_standing", THREE.LoopRepeat, false, 0.5);
      }
    } else if (state === "explaining") {
      const action = actions.explaining;
      const done = !action || action.time >= action.getClip().duration - 0.1;
      if (done) {
        goTo("idle_standing", THREE.LoopRepeat, false, 0.4);
      }
    } else if (state === "yelling") {
      const action = actions.yelling;
      const done = !action || action.time >= action.getClip().duration - 0.1;
      if (done) {
        goTo("idle_standing", THREE.LoopRepeat, false, 0.5);
      }
    } else if (state === "dismissing") {
      const action = actions.dismissing;
      const done = !action || action.time >= action.getClip().duration - 0.1;
      if (done) {
        goTo("idle_standing", THREE.LoopRepeat, false, 0.4);
      }
    } else if (state === "shooting_arrow") {
      const action = actions.shooting_arrow;
      const done = !action || action.time >= action.getClip().duration - 0.1;
      if (done) {
        goTo("idle_standing", THREE.LoopRepeat, false, 0.4);
      }
    } else if (state === "thoughtful") {
      const action = actions.thoughtful;
      const done = !action || action.time >= action.getClip().duration - 0.1;
      if (done) {
        goTo("idle_standing", THREE.LoopRepeat, false, 0.5);
      }
    } else if (state === "pointing") {
      const action = actions.pointing;
      const done = !action || action.time >= action.getClip().duration - 0.1;
      if (done) {
        goTo("idle_standing", THREE.LoopRepeat, false, 0.4);
      }
    } else if (state === "sword_fight") {
      const action = actions.sword_fight;
      const done = !action || action.time >= action.getClip().duration - 0.1;
      if (done) {
        goTo("idle_standing", THREE.LoopRepeat, false, 0.4);
      }
    } else if (state === "climbing") {
      const action = actions.climbing;
      const done = !action || action.time / Math.max(0.001, action.getClip().duration) >= 0.98;
      if (done) {
        // The sage finished climbing fully out of frame — drop straight
        // into the falling-to-landing clip so he descends back onto the
        // ground rather than just popping back into view.
        if (actions.falling) {
          // Small non-zero cross-fade aligns the visual handoff better
          // than a hard 0s cut on variable frame-time devices.
          goTo("falling", THREE.LoopOnce, true, 0.12);
        } else if (attractModeRef.current) {
          // Falling clip never loaded (low-tier device skipped it) —
          // fall back to the original close-out so we don't strand him
          // off-screen.
          goTo("turning_away", THREE.LoopRepeat, false, 0.4);
        } else {
          goTo("idle_standing", THREE.LoopRepeat, false, 0.5);
        }
      }
    } else if (state === "falling") {
      const action = actions.falling;
      const done = !action || action.time / Math.max(0.001, action.getClip().duration) >= 0.9;
      if (done) {
        if (attractModeRef.current) {
          // Continue the attract close-out (turn → walk back → sit).
          goTo("turning_away", THREE.LoopRepeat, false, 0.4);
        } else {
          goTo("idle_standing", THREE.LoopRepeat, false, 0.5);
        }
      }
    } else if (state === "left_turn") {
      const action = actions.left_turn;
      const done = !action || action.time >= action.getClip().duration - 0.1;
      if (done) {
        goTo("idle_standing", THREE.LoopRepeat, false, 0.5);
      }
    }
  });

  return (
    <group ref={groupRef}>
      <primitive object={scene} />
    </group>
  );
}

function Loader() {
  return (
    <div
      className="flex flex-col items-center justify-center"
      style={{ width: "100%", height: "100%", gap: 12 }}
    >
      <div
        className="pulse-dot rounded-full"
        style={{ width: 14, height: 14, background: "#FF9933" }}
      />
      <span style={{ fontSize: 13, color: "var(--text-3)" }}>Loading avatar...</span>
    </div>
  );
}

function FallbackOrb({ isSpeaking, error }: { isSpeaking: boolean; error?: Error | null }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
      }}
    >
      <div
        className={`rounded-full flex items-center justify-center ${
          isSpeaking ? "orb-speaking" : "orb-idle"
        }`}
        style={{
          width: 200,
          height: 200,
          background: "radial-gradient(circle at 30% 30%, #3a2a1a, #1f170d, #120d08)",
          border: "2px solid rgba(255,153,51,0.25)",
          boxShadow: isSpeaking
            ? "0 0 80px rgba(255,153,51,0.2)"
            : "0 0 40px rgba(255,153,51,0.08)",
        }}
      >
        <span style={{ fontSize: 64 }}>🙏</span>
      </div>
      {error ? (
        <pre
          style={{
            maxWidth: 600,
            fontSize: 11,
            color: "#ff8a8a",
            whiteSpace: "pre-wrap",
            textAlign: "center",
            padding: 8,
            background: "rgba(0,0,0,0.4)",
            borderRadius: 8,
          }}
        >
          {error.name}: {error.message}
          {error.stack ? "\n\n" + error.stack.split("\n").slice(0, 6).join("\n") : ""}
        </pre>
      ) : null}
    </div>
  );
}

function CameraAnimator({ targetZRef }: { targetZRef: MutableRefObject<number> }) {
  const { camera, size } = useThree();
  useFrame((_, delta) => {
    const aspect = size.width > 0 && size.height > 0 ? size.width / size.height : 1;
    // Portrait screens need extra camera distance to keep the full body in-frame.
    const portraitBoost = aspect < 0.62 ? Math.min(1.2, ((0.62 - aspect) / 0.62) * 1.2) : 0;
    const target = targetZRef.current + portraitBoost;
    // eslint-disable-next-line react-hooks/immutability
    camera.position.z += (target - camera.position.z) * Math.min(1, delta * 1.5);
  });
  return null;
}

/**
 * Light setup tuned per device tier. Each extra light adds a per-fragment
 * lighting calculation, so on phones we collapse the 5-light cinematic
 * setup down to 1 (low) or 2 (mid) lights and bump ambient to compensate
 * for the lost fill. Visually almost identical for a talking-head shot,
 * but cuts shader work substantially on tile-based mobile GPUs.
 */
function SceneLights() {
  const profile = useMemo(() => getDeviceProfile(), []);
  const max = profile.maxLights;
  // Boost ambient when we drop the warm fills so the avatar's shadow
  // side doesn't read as dead-black.
  const ambient = max >= 5 ? 0.7 : max >= 2 ? 0.85 : 1.0;
  return (
    <>
      <ambientLight intensity={ambient} />
      {/* Key light — always on. */}
      <directionalLight position={[2, 3, 3]} intensity={1.0} />
      {max >= 2 && (
        <directionalLight position={[-1.5, 2, 1]} intensity={0.35} color="#ffeedd" />
      )}
      {max >= 5 && (
        <>
          <directionalLight position={[-2, 1, -1]} intensity={0.15} color="#FF9933" />
          <pointLight position={[0, 0.3, 0.9]} intensity={0.3} color="#ffe4c9" />
        </>
      )}
    </>
  );
}

function DynamicDprController({ maxDpr }: { maxDpr: number }) {
  const { setDpr } = useThree();
  const emaFrameMsRef = useRef(16.7);
  const overMsRef = useRef(0);
  const underMsRef = useRef(0);
  const lowQualityRef = useRef(false);

  useEffect(() => {
    const deviceDpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const initial = Math.max(1, Math.min(maxDpr, deviceDpr));
    setDpr(initial);
  }, [maxDpr, setDpr]);

  useFrame((_, delta) => {
    const frameMs = Math.max(1, Math.min(200, delta * 1000));
    // EMA smooths spike noise so quality changes only on sustained load.
    emaFrameMsRef.current += (frameMs - emaFrameMsRef.current) * 0.12;
    const ema = emaFrameMsRef.current;

    const OVERLOAD_MS_THRESHOLD = 40; // roughly worse than 25fps
    const RECOVERY_MS_THRESHOLD = 30; // at/above ~33fps sustained
    const OVERLOAD_HOLD_MS = 2200;
    const RECOVERY_HOLD_MS = 7000;

    if (!lowQualityRef.current) {
      if (ema > OVERLOAD_MS_THRESHOLD) {
        overMsRef.current += frameMs;
      } else {
        overMsRef.current = Math.max(0, overMsRef.current - frameMs * 0.5);
      }
      if (overMsRef.current >= OVERLOAD_HOLD_MS) {
        lowQualityRef.current = true;
        overMsRef.current = 0;
        underMsRef.current = 0;
        setDpr(1);
      }
      return;
    }

    if (ema < RECOVERY_MS_THRESHOLD) {
      underMsRef.current += frameMs;
    } else {
      underMsRef.current = Math.max(0, underMsRef.current - frameMs * 0.5);
    }
    if (underMsRef.current >= RECOVERY_HOLD_MS) {
      const deviceDpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      const restored = Math.max(1, Math.min(maxDpr, deviceDpr));
      lowQualityRef.current = false;
      overMsRef.current = 0;
      underMsRef.current = 0;
      setDpr(restored);
    }
  });

  return null;
}

/* ── Ground ──
   A soft circular shadow disc beneath the avatar so the feet have something
   to stand on visually. Rendered with a procedural radial-fade canvas so it
   blends into any background without needing an asset. */
function Ground() {
  const texture = useMemo(() => {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const grad = ctx.createRadialGradient(
      size / 2,
      size / 2,
      size * 0.05,
      size / 2,
      size / 2,
      size * 0.5,
    );
    grad.addColorStop(0, "rgba(0, 0, 0, 0.55)");
    grad.addColorStop(0.55, "rgba(0, 0, 0, 0.18)");
    grad.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }, []);

  // Slightly above GROUND_Y so it sits on top of the floor plane (avoids
  // z-fighting with the avatar's foot soles).
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, GROUND_Y + 0.001, -0.6]}
      renderOrder={-1}
    >
      <planeGeometry args={[6, 6]} />
      <meshBasicMaterial
        map={texture}
        transparent
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}

export interface Avatar3DProps {
  isSpeaking: boolean;
  getAudioData?: () => Uint8Array | undefined;
  getVolume?: () => number;
  gesture?: string | null;
  userSmile?: number;
  faceDetected?: boolean;
  /** Imperative trigger for AI-decided gestures. Pass `{ name: "explaining",
   *  nonce: <unique-per-trigger> }` and the avatar will play it once when
   *  it next reaches `idle_standing` (subject to the gesture's cooldown).
   *  Reuse the same nonce to avoid re-firing. Examples of valid names:
   *  `"explaining"`, `"yelling"`. More to come. */
  aiGesture?: { name: string; nonce: number } | null;
  /** Fired once the avatar mesh + animations are loaded and the first idle
   *  frame is on screen. Use this to defer expensive work like the camera
   *  vision pipeline so the avatar always renders before face detection
   *  starts firing state-machine transitions. */
  onReady?: () => void;
}

export default function Avatar3D({ isSpeaking, gesture, faceDetected, aiGesture, onReady }: Avatar3DProps) {
  const gestureRef = useRef<GestureName>(null);
  const faceDetectedRef = useRef(faceDetected ?? false);
  const isSpeakingRef = useRef(isSpeaking);
  const aiGestureRef = useRef<{ name: string; nonce: number } | null>(aiGesture ?? null);
  const cameraTargetRef = useRef(CAMERA_Z_NEAR);

  // Sync incoming props into refs so AvatarModel's per-frame loop can read
  // the latest values without re-rendering the Canvas tree.
  useEffect(() => {
    gestureRef.current = (gesture as GestureName) ?? null;
    faceDetectedRef.current = faceDetected ?? false;
    isSpeakingRef.current = isSpeaking;
    aiGestureRef.current = aiGesture ?? null;
  }, [gesture, faceDetected, isSpeaking, aiGesture]);

  // Stable callback so AvatarModel's useEffect (which wires up the mixer)
  // doesn't tear down on every parent re-render.
  const handleAnimStateChange = useCallback((state: AvatarAnimState) => {
    if (state === "sitting") {
      cameraTargetRef.current = CAMERA_Z_FAR;
    } else if (
      state === "idle_standing" ||
      state === "waving" ||
      state === "praying" ||
      state === "explaining" ||
      state === "yelling" ||
      state === "dismissing" ||
      state === "shooting_arrow" ||
      state === "thoughtful" ||
      state === "climbing" ||
      state === "falling" ||
      state === "left_turn" ||
      state === "pointing" ||
      state === "sword_fight" ||
      state === "stopping"
    ) {
      // Keep the camera locked on the close mark for any in-place
      // gesture or arrival ease-in so we never zoom out mid-pose.
      cameraTargetRef.current = CAMERA_Z_NEAR;
    } else {
      cameraTargetRef.current = (CAMERA_Z_FAR + CAMERA_Z_NEAR) / 2;
    }
  }, []);

  const onAnimStateChangeRef = useRef(handleAnimStateChange);
  useEffect(() => {
    onAnimStateChangeRef.current = handleAnimStateChange;
  }, [handleAnimStateChange]);

  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  // Skip the soft shadow disc on phones / low-tier — it's a transparent
  // draw call + a 256² canvas texture upload that those devices don't
  // need under the avatar (the user can't see the floor anyway).
  const showGroundShadow = useMemo(
    () => getDeviceProfile().enableGroundShadow,
    [],
  );

  return (
    <AvatarErrorBoundary fallback={(err) => <FallbackOrb isSpeaking={isSpeaking} error={err} />}>
      <Suspense fallback={<Loader />}>
        <div style={{ width: "100%", height: "100%", overflow: "hidden" }}>
          <DeviceTunedCanvas isSpeaking={isSpeaking}>
            <SceneLights />
            <CameraAnimator targetZRef={cameraTargetRef} />
            {showGroundShadow && <Ground />}
            <AvatarModel
              gestureRef={gestureRef}
              faceDetectedRef={faceDetectedRef}
              isSpeakingRef={isSpeakingRef}
              aiGestureRef={aiGestureRef}
              onAnimStateChangeRef={onAnimStateChangeRef}
              onReadyRef={onReadyRef}
            />
          </DeviceTunedCanvas>
        </div>
      </Suspense>
    </AvatarErrorBoundary>
  );
}

/**
 * Resolve the device profile once at mount and feed its caps into
 * `<Canvas>`. Splitting this out keeps the Canvas children stable
 * (lights / camera / model) while letting us swap renderer settings
 * per-tier without re-creating the GL context on every parent render.
 *
 * Profile dimensions used here:
 *   - `maxDpr` → `dpr={[1, profile.maxDpr]}` so retina displays still
 *     get an upgrade where the GPU can afford it.
 *   - `antialias` → only enabled on `high` tier non-iOS devices; MSAA
 *     is the single biggest cause of mobile-Safari OOM.
 *   - `shadows` → likewise off everywhere except `high`. We have no
 *     `castShadow` props in the scene so this only affects the
 *     internal shadow-map allocation — still worth saving on low-end.
 *   - `powerPreference` → hint to the browser for GPU selection on
 *     dual-GPU machines and battery-friendly schedulers on mobile.
 *   - `anisotropy` → clamped to GPU max and applied to all textures
 *     after the renderer is created.
 */
function DeviceTunedCanvas({
  isSpeaking: _isSpeaking,
  children,
}: {
  isSpeaking: boolean;
  children: ReactNode;
}) {
  void _isSpeaking;
  // Resolved once — the inputs (UA / GPU / RAM) cannot change without a
  // page reload, so re-evaluating per render would just churn caches.
  const profile = useMemo(() => getDeviceProfile(), []);
  return (
    <Canvas
      camera={{ position: [0, 0.05, CAMERA_Z_NEAR], fov: 36, near: 0.1, far: 50 }}
      gl={{
        alpha: true,
        antialias: profile.antialias,
        powerPreference: profile.powerPreference,
        // Stencil + depth flags help the WebGL implementation pick a
        // smaller framebuffer on tile-based mobile GPUs.
        stencil: false,
        depth: true,
        // `desynchronized` lets the canvas present without waiting for
        // the compositor on browsers that support it (Chrome, Edge).
        // For a continuously-animating avatar this is a measurable
        // latency + smoothness win.
        // @ts-expect-error not in older lib.dom.d.ts
        desynchronized: true,
        // Force GPU-backed canvas — Safari occasionally falls back to
        // software for tiny canvases unless we hint it.
        preserveDrawingBuffer: false,
        // `failIfMajorPerformanceCaveat` would normally reject the
        // context on software rasterizers; we already detect those in
        // `getDeviceProfile()` and pin to low tier, so leave this off.
        failIfMajorPerformanceCaveat: false,
        precision: profile.shaderPrecision,
      }}
      dpr={[1, profile.maxDpr]}
      shadows={profile.shadows}
      // Skip object sorting — the scene has only the avatar + ground;
      // the GPU's depth test handles correct occlusion. Sorting costs
      // a per-frame O(n log n) on the CPU side.
      onCreated={({ gl, scene: glScene }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = profile.toneMappingExposure;
        gl.outputColorSpace = THREE.SRGBColorSpace;
        gl.sortObjects = false;
        // Auto-update is on by default; we drive `scene.updateMatrixWorld`
        // ourselves only inside the foot-clamp tick so disabling the
        // automatic per-frame walk saves one full traversal.
        glScene.matrixWorldAutoUpdate = true; // keep on — children opt out
        // Clamp texture anisotropy to whatever the GPU actually supports
        // so the requested cap from the profile never exceeds hardware.
        const gpuMaxAniso = gl.capabilities?.getMaxAnisotropy?.() ?? 1;
        const targetAniso = Math.min(profile.anisotropy, gpuMaxAniso);
        (gl as unknown as { __maxAnisotropy?: number }).__maxAnisotropy = targetAniso;
      }}
      style={{ background: "transparent", width: "100%", height: "100%" }}
    >
      <DynamicDprController maxDpr={profile.maxDpr} />
      {children}
    </Canvas>
  );
}

// Warm the FBX caches so the avatar + animations are ready by the time the
// component mounts (avoids a Suspense fallback flicker after first paint).
// On low-tier devices we skip the optional gesture FBXs so we don't burn
// memory + bandwidth on animations that will never play.
if (typeof window !== "undefined") {
  void loadFbxScene(AVATAR_URL);
  const profile = getDeviceProfile();
  ALL_ANIM_URLS.forEach((url) => {
    if (!isAssetEnabled(url, profile)) return;
    void loadFbxClips(url);
  });
}
