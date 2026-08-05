"use client";
/* eslint-disable react-hooks/immutability -- R3F frame callbacks intentionally mutate Three.js scene objects. */

import {
  useRef,
  useEffect,
  useMemo,
  useCallback,
  Suspense,
  Component,
  ReactNode,
  MutableRefObject,
  RefObject,
} from "react";
import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { SkeletonUtils, FBXLoader, GLTFLoader } from "three-stdlib";
import {
  AVATAR_GESTURE_PATHS,
  assetUrl,
  ensureFreshAssetCache,
  getDeviceProfile,
  getOptimizedAvatarPath,
} from "../lib/avatarAssets";
import type {
  AvatarAnimationCommand,
  AvatarAnimationState,
} from "../lib/displaySync";
import {
  AVATAR_VISEMES,
  classifyViseme,
  type LipSyncFrame,
} from "../lib/lipSync";

const DEFAULT_AVATAR_URL = "/models/sandipani.glb";
const LIP_SYNC_OPEN_GAIN = 1.28;
const LIP_SYNC_CLOSURE_GAIN = 1.16;
const MAX_LIP_SYNC_INFLUENCE = 0.84;
const SPEECH_CHEEK_MORPH = "speech_CheekRaise";
const CHEEK_VISEME_GAIN: Record<(typeof AVATAR_VISEMES)[number], number> = {
  viseme_PP: 0,
  viseme_FF: 0.18,
  viseme_TH: 0.2,
  viseme_DD: 0.2,
  viseme_kk: 0.2,
  viseme_CH: 0.28,
  viseme_SS: 0.24,
  viseme_nn: 0.18,
  viseme_RR: 0.24,
  viseme_aa: 0.42,
  viseme_E: 0.46,
  viseme_I: 0.48,
  viseme_O: 0.3,
  viseme_U: 0.26,
};

type AvatarAnimState = AvatarAnimationState;

const FOLLOWER_LOOPING_STATES = new Set<AvatarAnimState>([
  "sitting",
  "walking_in",
  "walking_out",
  "turning_away",
  "turning_back",
  "idle_standing",
]);

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

type GestureClipKey = keyof typeof AVATAR_GESTURE_PATHS;

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
// Required ms of consistent face presence/absence before changing pose.
const FACE_DEBOUNCE_MS = 350;
// Never replay the same gesture too quickly, even if a narrower trigger
// cooldown would otherwise allow it.
const SAME_GESTURE_COOLDOWN_MS = 4_500;

/* ── Stage geometry ──
   Avatars keep 2.5% safe floor space below the feet and 10% clear space
   above the head. Both margins and scale are derived from the live camera
   frustum so feet/grass stay visible after resizing on both displays. */
const MODEL_NORMALIZED_HEIGHT = 2.45;
const GROUND_SAFE_MARGIN = 0.025;
// The semicircle recedes from the camera, so its visible front edge projects
// slightly above the mathematical viewport floor. Overscan the patch below
// the frame to keep grass flush with the physical screen edge at every ratio.
const GROUND_VIEWPORT_BLEED = 0.055;
const CLOSE_SCREEN_HEIGHT = 0.875;
const FAR_SCREEN_HEIGHT = 0.875;
// Sit dip — the Mixamo sit clip rotates the legs into a cross-leg position
// but we strip the Hips translation track (cm-scale problem), so without a
// small additional drop the seated pose looks like he's hovering.
const SIT_GROUND_OFFSET_Y = -0.55;
const BACK_Z = -2.0;
const FRONT_Z = 0;

function getVisibleHeightAtZ(camera: THREE.Camera, z: number): number {
  if (!(camera instanceof THREE.PerspectiveCamera)) return 3.7;
  const distance = Math.max(0.1, Math.abs(camera.position.z - z));
  return 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * distance;
}

function getGroundY(camera: THREE.Camera, z: number): number {
  const visibleHeight = getVisibleHeightAtZ(camera, z);
  return camera.position.y - visibleHeight / 2
    + visibleHeight * GROUND_SAFE_MARGIN;
}

function getViewportBottomY(camera: THREE.Camera, z: number): number {
  const visibleHeight = getVisibleHeightAtZ(camera, z);
  return camera.position.y - visibleHeight / 2
    - visibleHeight * GROUND_VIEWPORT_BLEED;
}

function getScaleForScreenHeight(
  camera: THREE.Camera,
  z: number,
  screenHeight: number,
  modelHeight = MODEL_NORMALIZED_HEIGHT,
): number {
  return (
    getVisibleHeightAtZ(camera, z)
    * screenHeight
    / Math.max(0.001, modelHeight)
  );
}

function getSceneLocalBounds(scene: THREE.Group): THREE.Box3 {
  scene.updateMatrixWorld(true);
  const worldToScene = scene.matrixWorld.clone().invert();
  const bounds = new THREE.Box3();

  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;

    let meshBounds: THREE.Box3 | null = null;
    const skinnedMesh = mesh as THREE.SkinnedMesh;
    if (skinnedMesh.isSkinnedMesh) {
      skinnedMesh.computeBoundingBox();
      meshBounds = skinnedMesh.boundingBox;
    } else {
      mesh.geometry.computeBoundingBox();
      meshBounds = mesh.geometry.boundingBox;
    }
    if (!meshBounds || meshBounds.isEmpty()) return;

    const meshToScene = worldToScene.clone().multiply(mesh.matrixWorld);
    bounds.union(meshBounds.clone().applyMatrix4(meshToScene));
  });

  return bounds;
}

function measurePosedModelHeight(
  scene: THREE.Group,
  group: THREE.Group,
): number {
  // SkinnedMesh bounding boxes are not updated automatically after the
  // mixer changes the skeleton. Refresh them once for the initial standing
  // pose, then remove the outer group's screen-space scale from the result.
  scene.traverse((object) => {
    const mesh = object as THREE.SkinnedMesh;
    if (mesh.isSkinnedMesh) mesh.computeBoundingBox();
  });
  group.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(scene);
  if (bounds.isEmpty()) return MODEL_NORMALIZED_HEIGHT;
  const worldHeight = bounds.max.y - bounds.min.y;
  const groupScale = Math.max(0.001, Math.abs(group.scale.y));
  const posedHeight = worldHeight / groupScale;
  return Number.isFinite(posedHeight) && posedHeight > 0.001
    ? posedHeight
    : MODEL_NORMALIZED_HEIGHT;
}

/**
 * Normalize from the evaluated animation pose, not the bind pose. Skinned
 * mesh bounds are pose-dependent; anchoring the bind box is what left some
 * characters more than a foot above the floor once their idle started.
 */
function normalizeEvaluatedPose(scene: THREE.Group): number {
  scene.position.set(0, 0, 0);
  scene.scale.set(1, 1, 1);
  scene.updateMatrixWorld(true);
  const posedBounds = getSceneLocalBounds(scene);
  if (posedBounds.isEmpty()) return MODEL_NORMALIZED_HEIGHT;

  const height = posedBounds.max.y - posedBounds.min.y;
  const modelScale = MODEL_NORMALIZED_HEIGHT / Math.max(0.001, height);
  const center = posedBounds.getCenter(new THREE.Vector3());
  scene.scale.setScalar(modelScale);
  scene.position.set(
    -center.x * modelScale,
    -posedBounds.min.y * modelScale,
    -center.z * modelScale,
  );
  scene.updateMatrixWorld(true);
  return MODEL_NORMALIZED_HEIGHT;
}

const STATE_TARGETS: Record<
  AvatarAnimState,
  { z: number; rotY: number; screenHeight: number; clipKey: ClipKey }
> = {
  sitting:       { z: BACK_Z,  rotY: 0,        screenHeight: FAR_SCREEN_HEIGHT,   clipKey: "sitting" },
  standing_up:   { z: BACK_Z,  rotY: 0,        screenHeight: FAR_SCREEN_HEIGHT,   clipKey: "standing_up" },
  walking_in:    { z: FRONT_Z, rotY: 0,        screenHeight: CLOSE_SCREEN_HEIGHT, clipKey: "walking" },
  idle_standing: { z: FRONT_Z, rotY: 0,        screenHeight: CLOSE_SCREEN_HEIGHT, clipKey: "idle_standing" },
  waving:        { z: FRONT_Z, rotY: 0,        screenHeight: CLOSE_SCREEN_HEIGHT, clipKey: "waving" },
  praying:       { z: FRONT_Z, rotY: 0,        screenHeight: CLOSE_SCREEN_HEIGHT, clipKey: "praying" },
  explaining:    { z: FRONT_Z, rotY: 0,        screenHeight: CLOSE_SCREEN_HEIGHT, clipKey: "explaining" },
  yelling:       { z: FRONT_Z, rotY: 0,        screenHeight: CLOSE_SCREEN_HEIGHT, clipKey: "yelling" },
  dismissing:    { z: FRONT_Z, rotY: 0,        screenHeight: CLOSE_SCREEN_HEIGHT, clipKey: "dismissing" },
  shooting_arrow:{ z: FRONT_Z, rotY: 0,        screenHeight: CLOSE_SCREEN_HEIGHT, clipKey: "shooting_arrow" },
  thoughtful:    { z: FRONT_Z, rotY: 0,        screenHeight: CLOSE_SCREEN_HEIGHT, clipKey: "thoughtful" },
  climbing:      { z: FRONT_Z, rotY: 0,        screenHeight: CLOSE_SCREEN_HEIGHT, clipKey: "climbing" },
  // `falling` reuses the climbing scale because the avatar drops back
  // down onto the front mark to close out the attract loop.
  falling:       { z: FRONT_Z, rotY: 0,        screenHeight: CLOSE_SCREEN_HEIGHT, clipKey: "falling" },
  left_turn:     { z: FRONT_Z, rotY: 0,        screenHeight: CLOSE_SCREEN_HEIGHT, clipKey: "left_turn" },
  pointing:      { z: FRONT_Z, rotY: 0,        screenHeight: CLOSE_SCREEN_HEIGHT, clipKey: "pointing" },
  sword_fight:   { z: FRONT_Z, rotY: 0,        screenHeight: CLOSE_SCREEN_HEIGHT, clipKey: "sword_fight" },
  turning_away:  { z: FRONT_Z, rotY: Math.PI,  screenHeight: CLOSE_SCREEN_HEIGHT, clipKey: "idle_standing" },
  walking_out:   { z: BACK_Z,  rotY: Math.PI,  screenHeight: FAR_SCREEN_HEIGHT,   clipKey: "walking" },
  turning_back:  { z: BACK_Z,  rotY: 0,        screenHeight: FAR_SCREEN_HEIGHT,   clipKey: "idle_standing" },
  stopping:      { z: FRONT_Z, rotY: 0,        screenHeight: CLOSE_SCREEN_HEIGHT, clipKey: "stopping" },
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
  avatarRestQuaternionByStripped: Map<string, THREE.Quaternion>,
  /** When true, drop all tracks targeting the lower body (UpLeg/Leg/Foot/Toe).
   *  Keep available for future upper-body-only idles. */
  lockLegs = false,
  protectGeneratedMesh = false,
  generatedLimbStrength = 0.45,
): THREE.AnimationClip | null {
  const tracks: THREE.KeyframeTrack[] = [];
  const skipped: string[] = [];

  const LEG_BONES = new Set([
    "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase", "LeftToe_End",
    "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase", "RightToe_End",
  ]);
  const GENERATED_LIMB_BONES = new Set([
    "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
    "RightShoulder", "RightArm", "RightForeArm", "RightHand",
  ]);
  const GENERATED_TORSO_BONES = new Set(["Spine", "Spine1", "Spine2", "Neck"]);
  const GENERATED_HEAD_BONES = new Set(["Head"]);

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
    if (
      protectGeneratedMesh
      && property === "quaternion"
      && cloned instanceof THREE.QuaternionKeyframeTrack
      && (
        GENERATED_LIMB_BONES.has(lookup)
        || GENERATED_TORSO_BONES.has(lookup)
        || GENERATED_HEAD_BONES.has(lookup)
      )
    ) {
      // Meshy characters are single-shell scans without production edge
      // loops around shoulders and wrists. Preserve the authored gesture
      // while limiting rotation away from its clean first-frame pose, which
      // prevents sleeves, palms, and torso cloth from opening at their seams.
      const strength = GENERATED_LIMB_BONES.has(lookup)
        ? generatedLimbStrength
        : GENERATED_HEAD_BONES.has(lookup)
          ? 0
          : 0.65;
      const base = (
        avatarRestQuaternionByStripped.get(lookup)
        ?? new THREE.Quaternion()
      ).clone().normalize();
      const sample = new THREE.Quaternion();
      const limited = new THREE.Quaternion();
      for (let offset = 0; offset < cloned.values.length; offset += 4) {
        sample.fromArray(cloned.values, offset).normalize();
        limited.copy(base).slerp(sample, strength).normalize();
        limited.toArray(cloned.values, offset);
      }
    }
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

/* ── Avatar cache (Suspense-friendly) ──
   Production characters keep their supplied embedded idle. Shared gestures
   are compact AnimationClip JSON files containing skeleton tracks only, so
   they add interaction without replacing or duplicating any character mesh. */

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
const gltfSceneCache = new Map<string, THREE.Group>();
const gltfClipCache = new Map<string, THREE.AnimationClip[]>();
const fbxScenePromises = new Map<string, Promise<THREE.Group>>();
const gltfScenePromises = new Map<string, Promise<THREE.Group>>();
let gestureClipCache: ReadonlyMap<GestureClipKey, THREE.AnimationClip> | null = null;
let gestureClipPromise: Promise<ReadonlyMap<GestureClipKey, THREE.AnimationClip>> | null = null;

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

function readFbxScene(url: string): THREE.Group {
  const cached = fbxSceneCache.get(url);
  if (cached) return cached;
  throw loadFbxScene(url);
}

function loadAvatarScene(url: string): Promise<THREE.Group> {
  if (!/\.gl(?:b|tf)($|\?)/i.test(url)) return loadFbxScene(url);
  let promise = gltfScenePromises.get(url);
  if (!promise) {
    const loader = new GLTFLoader();
    promise = fetchAssetCached(url)
      .then((buffer) => loader.parseAsync(buffer, ""))
      .then((gltf) => {
        const scene = gltf.scene as THREE.Group;
        gltfSceneCache.set(url, scene);
        gltfClipCache.set(
          url,
          gltf.animations.map((clip) => clip.clone()),
        );
        return scene;
      })
      .catch((error) => {
        console.error("[Avatar] GLB scene load failed:", url, error);
        gltfScenePromises.delete(url);
        throw error;
      });
    gltfScenePromises.set(url, promise);
  }
  return promise;
}

function readAvatarScene(url: string): THREE.Group {
  if (!/\.gl(?:b|tf)($|\?)/i.test(url)) return readFbxScene(url);
  const cached = gltfSceneCache.get(url);
  if (cached) return cached;
  throw loadAvatarScene(url);
}

function readEmbeddedAvatarClips(url: string): THREE.AnimationClip[] {
  if (!/\.gl(?:b|tf)($|\?)/i.test(url)) return EMPTY_CLIPS;
  const cached = gltfClipCache.get(url);
  if (cached) return cached;
  throw loadAvatarScene(url);
}

function loadGestureClipLibrary(): Promise<ReadonlyMap<GestureClipKey, THREE.AnimationClip>> {
  if (gestureClipPromise) return gestureClipPromise;
  gestureClipPromise = Promise.all(
    (Object.entries(AVATAR_GESTURE_PATHS) as Array<[GestureClipKey, string]>).map(
      async ([key, path]) => {
        const buffer = await fetchAssetCached(path);
        const raw = JSON.parse(new TextDecoder().decode(buffer)) as unknown;
        const serialized = Array.isArray(raw) ? raw : [raw];
        const clips = serialized.map((value) => THREE.AnimationClip.parse(
          value as Parameters<typeof THREE.AnimationClip.parse>[0],
        ));
        const clip = pickClip(clips);
        if (!clip) throw new Error(`Gesture clip has no animation: ${path}`);
        return [key, clip] as const;
      },
    ),
  )
    .then((entries) => {
      gestureClipCache = new Map(entries);
      return gestureClipCache;
    })
    .catch((error) => {
      gestureClipPromise = null;
      throw error;
    });
  return gestureClipPromise;
}

function readGestureClipLibrary(): ReadonlyMap<GestureClipKey, THREE.AnimationClip> {
  if (gestureClipCache) return gestureClipCache;
  throw loadGestureClipLibrary();
}

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
  avatarUrl,
  isSpeakingRef,
  getAudioDataRef,
  getLipSyncFrameRef,
  onLipSyncFrameRef,
  gestureRef,
  faceDetectedRef,
  aiGestureRef,
  onAnimStateChangeRef,
  onReadyRef,
  syncMode,
  syncedAnimationRef,
  viewMode,
}: {
  avatarUrl: string;
  isSpeakingRef: MutableRefObject<boolean>;
  getAudioDataRef: MutableRefObject<(() => Uint8Array | undefined) | undefined>;
  getLipSyncFrameRef: MutableRefObject<(() => LipSyncFrame | null) | undefined>;
  onLipSyncFrameRef: MutableRefObject<((frame: LipSyncFrame | null) => void) | undefined>;
  gestureRef: MutableRefObject<GestureName>;
  faceDetectedRef: MutableRefObject<boolean>;
  /** AI-triggered gesture (e.g. ElevenLabs clientTool fires it on a
   *  high-weight phrase). The avatar plays the named gesture once and
   *  then ignores subsequent ticks until the nonce changes again. */
  aiGestureRef: MutableRefObject<{ name: string; nonce: number } | null>;
  onAnimStateChangeRef: MutableRefObject<(state: AvatarAnimState) => void>;
  onReadyRef: MutableRefObject<(() => void) | undefined>;
  syncMode: "leader" | "follower";
  syncedAnimationRef: MutableRefObject<AvatarAnimationCommand | null>;
  viewMode: "front" | "rear";
}) {
  const { camera } = useThree();
  const groupRef = useRef<THREE.Group>(null);
  const groundRef = useRef<THREE.Group>(null);
  const notify = useCallback(
    (state: AvatarAnimState) => onAnimStateChangeRef.current?.(state),
    [onAnimStateChangeRef],
  );
  const baseFbx = readAvatarScene(avatarUrl);
  const usesEmbeddedAnimation = /\.gl(?:b|tf)($|\?)/i.test(avatarUrl);
  const hasSandipaniNeutralClosure = /(?:^|\/)sandipani(?:-lite)?\.glb(?:$|[?#])/i.test(
    avatarUrl,
  );
  const embeddedClips = readEmbeddedAvatarClips(avatarUrl);
  const gestureClips = readGestureClipLibrary();

  const scene = useMemo(() => SkeletonUtils.clone(baseFbx) as THREE.Group, [baseFbx]);

  const idleClip = useMemo(
    () => (
      embeddedClips.find((clip) => (
        /idle|mixamo|rigify_clip/i.test(clip.name)
      )) ?? pickClip(embeddedClips)
    )?.clone() ?? null,
    [embeddedClips],
  );

  const sourceClips = useMemo(
    () => ({
      idle_standing: idleClip,
      sitting: null,
      standing_up: null,
      stopping: null,
      walking: null,
      waving: gestureClips.get("waving")?.clone() ?? null,
      praying: gestureClips.get("praying")?.clone() ?? null,
      explaining: gestureClips.get("explaining")?.clone() ?? null,
      yelling: gestureClips.get("yelling")?.clone() ?? null,
      dismissing: gestureClips.get("dismissing")?.clone() ?? null,
      shooting_arrow: gestureClips.get("shooting_arrow")?.clone() ?? null,
      thoughtful: gestureClips.get("thoughtful")?.clone() ?? null,
      climbing: gestureClips.get("climbing")?.clone() ?? null,
      left_turn: gestureClips.get("left_turn")?.clone() ?? null,
      pointing: gestureClips.get("pointing")?.clone() ?? null,
      sword_fight: gestureClips.get("sword_fight")?.clone() ?? null,
      falling: gestureClips.get("falling")?.clone() ?? null,
    }),
    [gestureClips, idleClip],
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
  const lastSyncedSequenceRef = useRef<number>(-1);

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

  /* ── Foot bones for per-frame ground clamp.
     Mixamo idle/breathing clips routinely shift the Hips Y a few cm above
     the bind pose, which makes the avatar look like it's hovering. We grab
     the toe bones at mount and, each frame, snap the group's Y so the
     lower toe sits exactly on the viewport floor. */
  const footBonesRef = useRef<{ left: THREE.Object3D | null; right: THREE.Object3D | null }>({
    left: null,
    right: null,
  });
  // Persistent filtered distance between the animated planted foot and
  // the avatar root. It keeps the sole locked to the bottom edge while
  // smoothing small idle-animation variations.
  const footFloorOffsetRef = useRef(0);
  const footClampInitializedRef = useRef(false);
  const posedModelHeightRef = useRef(MODEL_NORMALIZED_HEIGHT);
  const lipSyncMeshesRef = useRef<THREE.Mesh[]>([]);
  const neutralLipSealMeshesRef = useRef<THREE.Mesh[]>([]);
  const mouthCavityMeshesRef = useRef<THREE.Mesh[]>([]);
  const runtimeNeutralSealRef = useRef<THREE.Group | null>(null);
  const runtimeNeutralSealHeadRef = useRef<THREE.Object3D | null>(null);
  const runtimeNeutralSealOffsetRef = useRef(new THREE.Matrix4());
  const activeVisemeRef = useRef<(typeof AVATAR_VISEMES)[number]>("viseme_PP");
  const activeVisemeSinceRef = useRef(0);
  const lastPublishedLipFrameRef = useRef(0);

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
    const avatarRestQuaternionByStripped = new Map<string, THREE.Quaternion>();
    const lipSyncMeshes: THREE.Mesh[] = [];
    const neutralLipSealMeshes: THREE.Mesh[] = [];
    const mouthCavityMeshes: THREE.Mesh[] = [];
    let runtimeNeutralSeal: THREE.Group | null = null;

    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        if (/SandipaniIdleLipSeal/i.test(mesh.name)) {
          neutralLipSealMeshes.push(mesh);
          mesh.visible = true;
          mesh.renderOrder = 100;
        }
        if (/SandipaniMouthCavity/i.test(mesh.name)) {
          mouthCavityMeshes.push(mesh);
          mesh.visible = false;
          mesh.renderOrder = 99;
        }
        if (
          mesh.morphTargetDictionary
          && mesh.morphTargetInfluences
          && AVATAR_VISEMES.some(
            (name) => mesh.morphTargetDictionary?.[name] !== undefined,
          )
        ) {
          lipSyncMeshes.push(mesh);
          for (const name of AVATAR_VISEMES) {
            const index = mesh.morphTargetDictionary[name];
            if (index !== undefined) {
              mesh.morphTargetInfluences[index] = (
                hasSandipaniNeutralClosure && name === "viseme_PP"
              ) ? 1 : 0;
            }
          }
          const cheekIndex = mesh.morphTargetDictionary[SPEECH_CHEEK_MORPH];
          if (cheekIndex !== undefined) {
            mesh.morphTargetInfluences[cheekIndex] = 0;
          }
        }
        if (
          (mesh as THREE.SkinnedMesh).isSkinnedMesh
          && !usesEmbeddedAnimation
        ) {
          (mesh as THREE.SkinnedMesh).normalizeSkinWeights();
        }
        const mats = Array.isArray(mesh.material) ? [...mesh.material] : [mesh.material];
        mats.forEach((mat, materialIndex) => {
          const source = mat as THREE.MeshStandardMaterial;
          const hasMorphTargets = Boolean((mesh as THREE.Mesh).morphTargetInfluences?.length);
          const common = {
            name: source.name,
            color: source.color?.clone?.() ?? new THREE.Color(0xffffff),
            map: source.map ?? null,
            transparent: source.transparent ?? false,
            opacity: source.opacity ?? 1,
            alphaTest: source.alphaTest ?? 0,
            // The facial seal is a paper-thin head-bound surface. Blender's
            // glTF axis conversion can reverse its apparent winding, so keep
            // both faces renderable; otherwise the neutral lips disappear in
            // Three.js even though they are present in the exported model.
            side: /Sandipani(?:IdleLipSeal|MouthCavity)/i.test(mesh.name)
              ? THREE.DoubleSide
              : source.side ?? THREE.FrontSide,
            fog: source.fog ?? true,
          };
          const m = matProfile.tier === "low"
            ? new THREE.MeshLambertMaterial({
                ...common,
                emissive: new THREE.Color(0x000000),
              })
            : matProfile.tier === "high"
            ? new THREE.MeshPhysicalMaterial({
                ...common,
                emissive: new THREE.Color(0x000000),
                metalness: 0,
                roughness: 0.44,
                clearcoat: 0.08,
                clearcoatRoughness: 0.72,
                ior: 1.4,
                specularIntensity: 0.42,
                // The baked albedo contains the model's real fine skin and
                // cloth detail. Reusing it as a very subtle height map adds
                // pores, creases and weave without another large texture.
                bumpMap: matProfile.enableNormalMap ? source.map ?? null : null,
                bumpScale: 0.032,
                normalMap: matProfile.enableNormalMap ? source.normalMap : null,
                normalScale: new THREE.Vector2(0.3, 0.3),
                envMapIntensity: matProfile.enableEnvReflections ? 0.26 : 0,
              })
            : new THREE.MeshStandardMaterial({
                ...common,
                emissive: new THREE.Color(0x000000),
                metalness: 0,
                roughness: 0.52,
                bumpMap: matProfile.enableNormalMap ? source.map ?? null : null,
                bumpScale: 0.016,
                normalMap: matProfile.enableNormalMap ? source.normalMap : null,
                normalScale: new THREE.Vector2(0.16, 0.16),
                envMapIntensity: matProfile.enableEnvReflections ? 0.14 : 0,
              });
          const fastMaterial = m as (THREE.MeshLambertMaterial | THREE.MeshStandardMaterial) & {
            skinning: boolean;
            morphTargets?: boolean;
          };
          fastMaterial.skinning = (mesh as THREE.SkinnedMesh).isSkinnedMesh;
          fastMaterial.morphTargets = hasMorphTargets;
          m.depthWrite = source.depthWrite;
          m.depthTest = source.depthTest;
          if (/Sandipani(?:IdleLipSeal|MouthCavity)/i.test(mesh.name)) {
            // These head-bound surfaces intentionally replace the authored
            // open-mouth pixels. Draw them over the source face instead of
            // allowing tiny exporter depth differences to hide them.
            m.depthTest = false;
            m.depthWrite = false;
            m.map = null;
            if (/IdleLipSealUpper/i.test(mesh.name)) {
              m.color.set(0x180504);
            } else if (/IdleLipSealLower/i.test(mesh.name)) {
              m.color.set(0x200605);
            } else if (/IdleLipSealSeam/i.test(mesh.name)) {
              m.color.set(0x120302);
            } else if (/MouthCavity/i.test(mesh.name)) {
              m.color.set(0x080101);
            }
          }
          m.vertexColors = source.vertexColors;
          m.toneMapped = source.toneMapped;
          if (m.map && matProfile.tier !== "low") {
            const textureBias = matProfile.tier === "high" ? "-0.42" : "-0.24";
            const contrast = matProfile.tier === "high" ? "1.11" : "1.07";
            const grain = matProfile.tier === "high" ? "0.026" : "0.014";
            m.onBeforeCompile = (shader) => {
              shader.fragmentShader = shader.fragmentShader.replace(
                "#include <map_fragment>",
                `
#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D(map, vMapUv, ${textureBias});
  float surfaceGrain = fract(
    sin(dot(floor(vMapUv * 2048.0), vec2(12.9898, 78.233))) * 43758.5453
  );
  sampledDiffuseColor.rgb = clamp(
    (sampledDiffuseColor.rgb - 0.5) * ${contrast} + 0.5
      + (surfaceGrain - 0.5) * ${grain},
    0.0,
    1.0
  );
  diffuseColor *= sampledDiffuseColor;
#endif
                `,
              );
            };
            m.customProgramCacheKey = () =>
              `avatar-surface-v2-${matProfile.tier}`;
          }
          mats[materialIndex] = m;
          source.dispose?.();

          if (m.map) {
            m.map.colorSpace = THREE.SRGBColorSpace;
            // Anisotropy used to be hardcoded at 16 — disastrous on mobile
            // GPUs whose max is often 4 or 8 anyway. Source from the
            // device profile so low/mid tiers get 1–2 instead.
            m.map.anisotropy = matProfile.anisotropy;
            m.map.generateMipmaps = matProfile.tier !== "low";
            m.map.minFilter = matProfile.tier === "low"
              ? THREE.LinearFilter
              : THREE.LinearMipmapLinearFilter;
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
          // Meshy clothing is a thin, single-shell surface. Large shoulder
          // poses can expose its reverse side even with correct skinning,
          // so keep GLB character materials double-sided.
          m.side = /Sandipani(?:IdleLipSeal|MouthCavity)/i.test(mesh.name)
            || matProfile.doubleSide
            ? THREE.DoubleSide
            : THREE.FrontSide;
          m.needsUpdate = true;
        });
        mesh.material = Array.isArray(mesh.material) ? mats : mats[0];
        mesh.frustumCulled = false;
      }
      if ((obj as THREE.Bone).isBone) {
        const stripped = stripMixamoPrefix(obj.name);
        avatarBoneByStripped.set(stripped, obj.name);
        avatarRestQuaternionByStripped.set(
          stripped,
          (obj as THREE.Bone).quaternion.clone(),
        );
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
    lipSyncMeshesRef.current = lipSyncMeshes;
    neutralLipSealMeshesRef.current = neutralLipSealMeshes;
    mouthCavityMeshesRef.current = mouthCavityMeshes;

    /* ── Scale + ground the avatar ──
       Anchor the avatar's feet at scene-local y = 0 so the parent group's
       world Y becomes the literal floor line. Because feet sit at 0 in
       local space, scaling the group never lifts the feet off the floor
       — essential for the "walk closer = grow" stage trick below. */
    scene.position.set(0, 0, 0);
    scene.scale.set(1, 1, 1);
    const rawBox = getSceneLocalBounds(scene);
    const modelHeight = rawBox.max.y - rawBox.min.y;
    const desiredHeight = MODEL_NORMALIZED_HEIGHT;
    let modelScale = 1;
    if (modelHeight > 0.001) {
      modelScale = desiredHeight / modelHeight;
      scene.scale.setScalar(modelScale);
    }
    const center = new THREE.Vector3();
    rawBox.getCenter(center);
    scene.position.set(
      -center.x * modelScale,
      -rawBox.min.y * modelScale,
      -center.z * modelScale,
    );
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
      // Preserve the supplied idle exactly. Gesture clips contain only
      // Mixamo skeleton tracks and are remapped onto the current character.
      const mapped = usesEmbeddedAnimation && key === "idle_standing"
        ? clip.clone()
        : remapClipToAvatarRig(
            clip,
            avatarBoneByStripped,
            avatarRestQuaternionByStripped,
          );
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
        .setLoop(THREE.LoopRepeat, Infinity)
        .play();
      initialAction.setEffectiveWeight(1);
      currentActionRef.current = initialAction;
      animStateRef.current = initialState;

      // Snap the group to the initial state's stage marks so the very first
      // frame is already on-mark (no slide-in from the origin).
      const grp = groupRef.current;
      if (grp) {
        const t = STATE_TARGETS[initialState];
        grp.position.set(0, getGroundY(camera, t.z), t.z);
        grp.rotation.y = t.rotY;
        grp.scale.setScalar(
          getScaleForScreenHeight(camera, t.z, t.screenHeight),
        );
      }

      mixer.update(0);
      posedModelHeightRef.current = normalizeEvaluatedPose(scene);
      if (grp) {
        const target = STATE_TARGETS[initialState];
        grp.scale.setScalar(
          getScaleForScreenHeight(
            camera,
            target.z,
            target.screenHeight,
            posedModelHeightRef.current,
          ),
        );
        grp.updateMatrixWorld(true);
      }
      const ground = groundRef.current;
      if (grp && ground) {
        ground.position.set(0, getViewportBottomY(camera, grp.position.z), grp.position.z);
        ground.scale.copy(grp.scale);
      }
      notify(initialState);
      // Tell the host the avatar is on screen so it can spin up the camera
      // pipeline now — we deliberately defer onReady to the next frame so
      // React commits the Canvas before MediaPipe starts hammering the GPU.
      requestAnimationFrame(() => onReadyRef.current?.());
    } else {
      // Static/morph-only replacement models have no compatible skeleton.
      // They still need the same stage placement, grounding, ready signal,
      // rear-view rotation and audio-driven facial animation.
      animStateRef.current = initialState;
      const grp = groupRef.current;
      if (grp) {
        const target = STATE_TARGETS[initialState];
        grp.position.set(0, getGroundY(camera, target.z), target.z);
        grp.rotation.y = target.rotY;
        grp.scale.setScalar(
          getScaleForScreenHeight(camera, target.z, target.screenHeight),
        );
      }
      mixer.update(0);
      if (grp) {
        posedModelHeightRef.current = measurePosedModelHeight(scene, grp);
        const target = STATE_TARGETS[initialState];
        grp.scale.setScalar(
          getScaleForScreenHeight(
            camera,
            target.z,
            target.screenHeight,
            posedModelHeightRef.current,
          ),
        );
        grp.updateMatrixWorld(true);
      }
      const ground = groundRef.current;
      if (grp && ground) {
        ground.position.set(0, getViewportBottomY(camera, grp.position.z), grp.position.z);
        ground.scale.copy(grp.scale);
      }
      notify(initialState);
      requestAnimationFrame(() => onReadyRef.current?.());
    }

    const avatarHeadBoneName = avatarBoneByStripped.get("Head");
    const avatarHeadBone = avatarHeadBoneName
      ? scene.getObjectByName(avatarHeadBoneName)
      : null;
    if (hasSandipaniNeutralClosure && avatarHeadBone) {
      // The supplied scan has an authored round opening and no jaw bone.
      // A tiny head-bound neutral layer covers that opening only while the
      // avatar is silent; speech hides it and exposes the viseme surface.
      // Keeping this separate from the body mesh avoids touching skinning,
      // bones, or the embedded Mixamo animation.
      const seal = new THREE.Group();
      seal.name = "SandipaniRuntimeNeutralMouth";
      const addLayer = (
        name: string,
        color: number,
        width: number,
        height: number,
        y: number,
        z: number,
      ) => {
        const geometry = new THREE.CircleGeometry(0.5, 32);
        const material = /MouthMask/i.test(name)
          ? new THREE.ShaderMaterial({
              transparent: true,
              depthTest: false,
              depthWrite: false,
              side: THREE.DoubleSide,
              toneMapped: false,
              vertexShader: `
                varying vec2 vUv;
                void main() {
                  vUv = uv;
                  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
              `,
              fragmentShader: `
                varying vec2 vUv;
                float hash(vec2 p) {
                  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
                }
                void main() {
                  vec2 centered = (vUv - 0.5) * 2.0;
                  float alpha = 1.0 - smoothstep(0.24, 1.0, length(centered));
                  float grain = (hash(floor(vUv * 52.0)) - 0.5) * 0.10;
                  float strand = sin(vUv.x * 96.0 + vUv.y * 13.0) * 0.018;
                  vec3 beard = vec3(0.42, 0.39, 0.34) + grain + strand;
                  gl_FragColor = vec4(beard, alpha);
                }
              `,
            })
          : new THREE.MeshBasicMaterial({
              color,
              depthTest: false,
              depthWrite: false,
              transparent: true,
              opacity: 1,
              side: THREE.DoubleSide,
              toneMapped: false,
            });
        const layer = new THREE.Mesh(geometry, material);
        layer.name = name;
        layer.position.set(0, y, z);
        layer.scale.set(width, height, 1);
        layer.renderOrder = 110;
        layer.frustumCulled = false;
        seal.add(layer);
        neutralLipSealMeshes.push(layer);
      };
      addLayer("SandipaniRuntimeMouthMask", 0x6e6759, 0.106, 0.064, 0, 0);
      addLayer("SandipaniRuntimeUpperLip", 0x5a1814, 0.068, 0.010, 0.003, 0.002);
      addLayer("SandipaniRuntimeLowerLip", 0x67201a, 0.067, 0.009, -0.005, 0.003);
      addLayer("SandipaniRuntimeLipSeam", 0x120302, 0.064, 0.002, -0.001, 0.004);
      scene.add(seal);
      // `scene` normalizes a meter-scale FBX by applying a large root scale.
      // Convert the desired normalized mouth point back into that local
      // coordinate system before binding the layer to the head motion.
      seal.position.copy(
        new THREE.Vector3(0, 1.985, 0.32)
          .sub(scene.position)
          .divide(scene.scale),
      );
      seal.scale.set(
        1 / scene.scale.x,
        1 / scene.scale.y,
        1 / scene.scale.z,
      );
      scene.updateMatrixWorld(true);
      seal.updateMatrixWorld(true);
      runtimeNeutralSealOffsetRef.current.copy(
        avatarHeadBone.matrixWorld.clone().invert().multiply(seal.matrixWorld),
      );
      runtimeNeutralSealRef.current = seal;
      runtimeNeutralSealHeadRef.current = avatarHeadBone;
      runtimeNeutralSeal = seal;
      neutralLipSealMeshesRef.current = neutralLipSealMeshes;
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
      lipSyncMeshesRef.current = [];
      neutralLipSealMeshesRef.current = [];
      mouthCavityMeshesRef.current = [];
      runtimeNeutralSealRef.current = null;
      runtimeNeutralSealHeadRef.current = null;
      if (runtimeNeutralSeal) {
        runtimeNeutralSeal.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.geometry.dispose();
          (mesh.material as THREE.Material).dispose();
        });
        runtimeNeutralSeal.removeFromParent();
      }
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
  }, [camera, hasSandipaniNeutralClosure, scene, sourceClips, usesEmbeddedAnimation]);

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
  useFrame((_, delta) => {
    const baseFrameMs = targetFrameMs;
    const maxFrameMs = 1000 / 15;
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

    /* ── Timed speech animation ──
       ElevenLabs character alignment drives phoneme-like visemes; spectrum
       classification is only the bounded fallback. The rear consumes the
       same timestamped frame. Vowel/consonant-specific cheek activation adds
       co-articulation while every target still returns to the neutral Basis. */
    const lipNow = performance.now();
    const remoteFrame = getLipSyncFrameRef.current?.() ?? null;
    const classified = remoteFrame
      ? remoteFrame
      : isSpeakingRef.current
        ? classifyViseme(
            getAudioDataRef.current?.(),
          )
        : null;
    if (
      classified
      && (
        classified.viseme === activeVisemeRef.current
        || classified.viseme === "viseme_PP"
        || lipNow - activeVisemeSinceRef.current >= 55
      )
    ) {
      if (classified.viseme !== activeVisemeRef.current) {
        activeVisemeRef.current = classified.viseme;
        activeVisemeSinceRef.current = lipNow;
      }
    }
    const mouthOpen = Boolean(
      isSpeakingRef.current
      && classified
      && (!remoteFrame || Date.now() - remoteFrame.sentAt < 250),
    );
    const activeViseme = activeVisemeRef.current;
    const sourceIntensity = classified?.intensity ?? 0;
    const gain =
      activeViseme === "viseme_PP"
        ? LIP_SYNC_CLOSURE_GAIN
        : LIP_SYNC_OPEN_GAIN;
    const activeIntensity = mouthOpen
      ? syncMode === "follower"
        ? sourceIntensity
        : Math.min(MAX_LIP_SYNC_INFLUENCE, sourceIntensity * gain)
      : 0;
    const closingLips = !mouthOpen || activeViseme === "viseme_PP";
    const mouthBlend = 1 - Math.exp(-delta * (closingLips ? 42 : 18));
    const cheekTarget = mouthOpen
      ? Math.min(0.38, activeIntensity * CHEEK_VISEME_GAIN[activeViseme])
      : 0;
    const cheekBlend = 1 - Math.exp(-delta * (mouthOpen ? 12 : 24));
    for (const mesh of lipSyncMeshesRef.current) {
      const dictionary = mesh.morphTargetDictionary;
      const influences = mesh.morphTargetInfluences;
      if (!dictionary || !influences) continue;
      for (const viseme of AVATAR_VISEMES) {
        const index = dictionary[viseme];
        if (index === undefined) continue;
        const targetInfluence = mouthOpen
          ? viseme === activeViseme
            ? viseme === "viseme_PP"
              ? 1
              : activeIntensity
            : 0
          : hasSandipaniNeutralClosure && viseme === "viseme_PP"
            ? 1
            : 0;
        influences[index] += (targetInfluence - influences[index]) * mouthBlend;
      }
      const cheekIndex = dictionary[SPEECH_CHEEK_MORPH];
      if (cheekIndex !== undefined) {
        influences[cheekIndex] += (
          cheekTarget - influences[cheekIndex]
        ) * cheekBlend;
      }
    }
    for (const seal of neutralLipSealMeshesRef.current) {
      seal.visible = closingLips && viewMode === "front";
    }
    for (const cavity of mouthCavityMeshesRef.current) {
      cavity.visible = !closingLips && viewMode === "front";
    }
    if (onLipSyncFrameRef.current && lipNow - lastPublishedLipFrameRef.current >= 33) {
      lastPublishedLipFrameRef.current = lipNow;
      onLipSyncFrameRef.current(
        mouthOpen
          ? { viseme: activeViseme, intensity: activeIntensity, sentAt: Date.now() }
          : null,
      );
    }

    const mixer = mixerRef.current;
    const actions = actionsRef.current;
    if (mixer) {
      // Play the sole supplied Mixamo idle forward at its authored speed.
      // Embedded character clips are not retargeted or rewritten.
      mixer.update(Math.min(delta, 0.05));
    }
    const runtimeSeal = runtimeNeutralSealRef.current;
    const runtimeSealHead = runtimeNeutralSealHeadRef.current;
    if (runtimeSeal && runtimeSealHead) {
      scene.updateMatrixWorld(true);
      const sealMatrix = scene.matrixWorld.clone().invert()
        .multiply(runtimeSealHead.matrixWorld)
        .multiply(runtimeNeutralSealOffsetRef.current);
      sealMatrix.decompose(
        runtimeSeal.position,
        runtimeSeal.quaternion,
        runtimeSeal.scale,
      );
    }

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
      const floorY = getGroundY(camera, grp.position.z);
      const tgtY = floorY + yBias - footFloorOffsetRef.current;

      // Snappier follow during climb / fall so the lift+drop tracks the
      // curve closely. Climb needs to commit instantly when entering;
      // fall needs to track gravity tightly so the landing beat reads.
      const yLerp = (state === "climbing" || state === "falling")
        ? Math.min(1, delta * 12)
        : Math.min(1, delta * 3);
      grp.position.y += (tgtY - grp.position.y) * yLerp;

      /* ── Foot-to-floor clamp (low-pass filtered) ──
         Mixamo's breathing-idle clip lifts the Hips a few cm above the
         bind pose. Without correction the toes float above the viewport
         floor. We
         sample whichever toe is currently lower and update a persistent
         `footFloorOffsetRef` with an immediate initial correction followed
         by a short exponential filter. The offset is then applied to
         `tgtY` above on the NEXT frame, which means the
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
            // Update from the moving/scaling outer group so foot world
            // positions include the transform applied earlier this frame.
            grp.updateMatrixWorld(true);
            let minFootY = Infinity;
            const v = new THREE.Vector3();
            if (lf) { lf.getWorldPosition(v); minFootY = Math.min(minFootY, v.y); }
            if (rf) { rf.getWorldPosition(v); minFootY = Math.min(minFootY, v.y); }
            if (Number.isFinite(minFootY)) {
              // Measure the animated foot height relative to the avatar
              // root, not relative to the already-corrected floor. Using
              // the floor here creates feedback and only removes half the
              // offset, which is why the avatar appeared to float.
              const measuredOffset = minFootY - grp.position.y;
              if (!footClampInitializedRef.current) {
                footFloorOffsetRef.current = measuredOffset;
                footClampInitializedRef.current = true;
              } else {
                // Settle quickly enough to keep the planted foot stable,
                // while still smoothing small breathing-idle variations.
                footFloorOffsetRef.current +=
                  (measuredOffset - footFloorOffsetRef.current) * 0.2;
              }
            }
          }
        }
      } else {
        // Decay the offset back to zero whenever we're in a state that
        // doesn't use the clamp, so re-entering idle doesn't snap.
        footFloorOffsetRef.current *= 0.92;
        footClampInitializedRef.current = false;
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

      // Derive scale from the live camera frustum and the initial posed
      // bounds. Every state occupies exactly 90% of the screen height,
      // leaving a strict 10% gap above the head.
      const zProgress =
        (grp.position.z - BACK_Z) / (FRONT_Z - BACK_Z);
      const t = Math.max(0, Math.min(1, zProgress));
      const screenHeight =
        FAR_SCREEN_HEIGHT
        + (CLOSE_SCREEN_HEIGHT - FAR_SCREEN_HEIGHT) * t;
      grp.scale.setScalar(
        getScaleForScreenHeight(
          camera,
          grp.position.z,
          screenHeight,
          posedModelHeightRef.current,
        ),
      );
      const ground = groundRef.current;
      if (ground) {
        ground.position.set(0, getViewportBottomY(camera, grp.position.z), grp.position.z);
        ground.scale.copy(grp.scale);
      }

      const targetScale =
        getScaleForScreenHeight(
          camera,
          target.z,
          target.screenHeight,
          posedModelHeightRef.current,
        );

      onMark =
        Math.abs(target.z - grp.position.z) < 0.04 &&
        Math.abs(targetScale - grp.scale.x) < 0.012;
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

    // Supplied character GLBs currently contain only their authored idle.
    // Keep that clip running and ignore body-state/gesture requests until a
    // matching pre-animated GLB clip is provided for the requested action.
    if (usesEmbeddedAnimation) return;

    if (syncMode === "follower") {
      const command = syncedAnimationRef.current;
      if (command && command.sequence !== lastSyncedSequenceRef.current) {
        lastSyncedSequenceRef.current = command.sequence;
        const looping = FOLLOWER_LOOPING_STATES.has(command.state);
        goTo(
          command.state,
          looping ? THREE.LoopRepeat : THREE.LoopOnce,
          !looping,
          0.12,
        );

        const elapsedSeconds = Math.max(0, (Date.now() - command.startedAt) / 1000);
        const action = actions[STATE_TARGETS[command.state].clipKey];
        if (action) {
          const duration = action.getClip().duration;
          if (duration > 0.001) {
            const playbackRate = action.getEffectiveTimeScale();
            const initialOffset = command.state === "falling" ? duration * 0.22 : 0;
            const seekTime = initialOffset + elapsedSeconds * playbackRate;
            action.time = looping
              ? seekTime % duration
              : Math.min(seekTime, Math.max(0, duration - 0.001));
          }
        }
        if (command.state === "walking_in" || command.state === "walking_out") {
          walkFromZRef.current = command.state === "walking_in" ? BACK_Z : FRONT_Z;
          walkToZRef.current = command.state === "walking_in" ? FRONT_Z : BACK_Z;
          walkStartRef.current = performance.now() - elapsedSeconds * 1000;
        }
      }
      return;
    }

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
    <>
      <group ref={groundRef}>
        <GroundPatch />
      </group>
      <group ref={groupRef}>
      <group
        rotation={[0, viewMode === "rear" ? Math.PI : 0, 0]}
      >
        <primitive object={scene} />
      </group>
      </group>
    </>
  );
}

// FluffyGrass source geometry, blade alpha and Perlin wind approach:
// https://github.com/thebenezer/FluffyGrass (MIT, license shipped with assets).
const FLUFFY_GRASS_VERTEX_SHADER = /* glsl */ `
  uniform sampler2D uNoiseTexture;
  uniform float uTime;
  uniform float uPatchRadius;
  varying vec2 vUv;
  varying vec2 vGlobalUv;

  void main() {
    vec4 instancePosition = instanceMatrix * vec4(position, 1.0);
    vGlobalUv = (instancePosition.xz + vec2(uPatchRadius))
      / max(0.001, 2.0 * uPatchRadius);
    vec4 noise = texture2D(
      uNoiseTexture,
      vGlobalUv * 1.5 + vec2(uTime * 0.001, uTime * 0.0007)
    );

    vec2 windDirection = normalize(vec2(1.0, 0.78));
    float tipFlex = 1.0 - uv.y;
    float mainWave = sin(
      42.0 * dot(windDirection, vGlobalUv)
      + noise.g * 5.5
      + uTime * 1.25
    );
    float detailWave = sin(
      79.0 * dot(vec2(-0.45, 1.0), vGlobalUv)
      + noise.b * 3.5
      + uTime * 2.1
    );
    float gust = 0.68 + 0.32 * sin(uTime * 0.34 + noise.r * 6.283);
    float displacement = (mainWave * 0.75 + detailWave * 0.25)
      * 0.012 * gust * tipFlex * tipFlex;

    instancePosition.xz += windDirection * displacement;
    instancePosition.y += noise.r * 0.003 * tipFlex;
    vUv = vec2(uv.x, 1.0 - uv.y);
    gl_Position = projectionMatrix * modelViewMatrix * instancePosition;
  }
`;

const FLUFFY_GRASS_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uGrassAlphaTexture;
  uniform sampler2D uNoiseTexture;
  uniform vec3 uBaseColor;
  uniform vec3 uTipColor1;
  uniform vec3 uTipColor2;
  varying vec2 vUv;
  varying vec2 vGlobalUv;

  void main() {
    float blade = texture2D(uGrassAlphaTexture, vUv).r;
    if (blade < 0.1) discard;
    float variation = texture2D(uNoiseTexture, vGlobalUv * 1.5).r;
    vec3 tipColor = mix(uTipColor1, uTipColor2, variation);
    vec3 grassColor = mix(uBaseColor, tipColor, vUv.y);
    grassColor *= 0.88 + blade * 0.32;
    gl_FragColor = vec4(grassColor, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function GroundPatch() {
  const patchRef = useRef<THREE.Group>(null);
  const groundDiscRef = useRef<THREE.Mesh>(null);
  const grassRef = useRef<THREE.InstancedMesh>(null);
  const grassMaterialRef = useRef<THREE.ShaderMaterial>(null);
  const lastPatchRadiusRef = useRef(0);
  const patchWorldPositionRef = useRef(new THREE.Vector3());
  const patchWorldScaleRef = useRef(new THREE.Vector3(1, 1, 1));
  const profile = useMemo(() => getDeviceProfile(), []);
  const clumpCount =
    profile.tier === "high" ? 1200 : profile.tier === "mid" ? 700 : 360;
  const fluffyGrassScene = readAvatarScene("/grass/grassLODs.glb");
  const grassAlphaTexture = useLoader(
    THREE.TextureLoader,
    assetUrl("/grass/grass.jpeg"),
  );
  const noiseTexture = useLoader(
    THREE.TextureLoader,
    assetUrl("/grass/perlinnoise.webp"),
  );
  const groundTexture = useMemo(() => {
    const size = 128;
    const data = new Uint8Array(size * size * 4);
    let seed = 0x51a7;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const nx = (x + 0.5 - size / 2) / (size / 2);
        const ny = (y + 0.5 - size / 2) / (size / 2);
        const radius = Math.sqrt(nx * nx + ny * ny);
        const edge = 1 - THREE.MathUtils.smoothstep(radius, 0.72, 1);
        const noise = random();
        const green = THREE.MathUtils.clamp(
          0.28 + (noise - 0.5) * 0.32,
          0.15,
          0.5,
        );
        const offset = (y * size + x) * 4;
        data[offset] = Math.round(THREE.MathUtils.lerp(70, 46, green));
        data[offset + 1] = Math.round(THREE.MathUtils.lerp(53, 69, green));
        data[offset + 2] = Math.round(THREE.MathUtils.lerp(28, 30, green));
        data[offset + 3] = Math.round(225 * edge);
      }
    }

    const texture = new THREE.DataTexture(
      data,
      size,
      size,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
  }, []);
  const contactShadowTexture = useMemo(() => {
    const size = 96;
    const data = new Uint8Array(size * size * 4);

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const nx = (x + 0.5 - size / 2) / (size / 2);
        const ny = (y + 0.5 - size / 2) / (size / 2);
        const radius = Math.sqrt(nx * nx + ny * ny);
        const falloff = 1 - THREE.MathUtils.smoothstep(radius, 0.08, 1);
        const offset = (y * size + x) * 4;
        data[offset] = 0;
        data[offset + 1] = 0;
        data[offset + 2] = 0;
        data[offset + 3] = Math.round(158 * Math.pow(falloff, 1.55));
      }
    }

    const texture = new THREE.DataTexture(
      data,
      size,
      size,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
  }, []);
  const grassGeometry = useMemo(() => {
    let sourceGeometry: THREE.BufferGeometry | null = null;
    fluffyGrassScene.traverse((object) => {
      if (
        !sourceGeometry
        && (object as THREE.Mesh).isMesh
        && object.name.includes("LOD00")
      ) {
        sourceGeometry = (object as THREE.Mesh).geometry;
      }
    });
    if (!sourceGeometry) {
      throw new Error("FluffyGrass LOD00 geometry is missing.");
    }
    const geometry = (sourceGeometry as THREE.BufferGeometry).clone();
    geometry.scale(0.35, 0.35, 0.35);
    return geometry;
  }, [fluffyGrassScene]);
  const grassUniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uPatchRadius: { value: 1 },
      uGrassAlphaTexture: { value: grassAlphaTexture },
      uNoiseTexture: { value: noiseTexture },
      uBaseColor: { value: new THREE.Color("#313f1b") },
      uTipColor1: { value: new THREE.Color("#9bd38d") },
      uTipColor2: { value: new THREE.Color("#1f352a") },
    }),
    [grassAlphaTexture, noiseTexture],
  );
  const normalizedClumps = useMemo(() => {
    let seed = 0x9e3779b9;
    const random = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 0xffffffff;
    };

    return Array.from({ length: clumpCount }, () => {
      const angle = random() * Math.PI;
      const radius = Math.sqrt(random()) * 0.97;
      return {
        x: Math.cos(angle) * radius,
        z: -Math.sin(angle) * radius,
        rotation: random() * Math.PI * 2,
        scale: 0.78 + random() * 0.48,
      };
    });
  }, [clumpCount]);

  useEffect(() => {
    noiseTexture.wrapS = THREE.RepeatWrapping;
    noiseTexture.wrapT = THREE.RepeatWrapping;
    noiseTexture.needsUpdate = true;
    grassAlphaTexture.colorSpace = THREE.NoColorSpace;
    grassAlphaTexture.needsUpdate = true;
  }, [grassAlphaTexture, noiseTexture]);

  useEffect(() => {
    const grass = grassRef.current;
    if (!grass) return;
    grass.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }, []);

  const updateGrassLayout = useCallback((patchRadius: number) => {
    const grass = grassRef.current;
    if (!grass) return;
    const transform = new THREE.Object3D();
    normalizedClumps.forEach((clump, index) => {
      const rootX = clump.x * patchRadius;
      let rootZ = clump.z * patchRadius;
      const nearLeftFoot =
        Math.abs(rootX + 0.14) < 0.105 && Math.abs(rootZ) < 0.12;
      const nearRightFoot =
        Math.abs(rootX - 0.14) < 0.105 && Math.abs(rootZ) < 0.12;
      if (nearLeftFoot || nearRightFoot) rootZ = -0.14;
      transform.position.set(rootX, 0, rootZ);
      transform.rotation.set(0, clump.rotation, 0);
      transform.scale.setScalar(clump.scale);
      transform.updateMatrix();
      grass.setMatrixAt(index, transform.matrix);
    });
    grass.instanceMatrix.needsUpdate = true;
  }, [normalizedClumps]);

  useEffect(() => {
    updateGrassLayout(1);
  }, [updateGrassLayout]);

  useFrame(({ camera, clock, size }) => {
    if (grassMaterialRef.current) {
      grassMaterialRef.current.uniforms.uTime.value = clock.elapsedTime;
    }

    const patch = patchRef.current;
    if (!patch || size.height <= 0) return;
    patch.getWorldPosition(patchWorldPositionRef.current);
    patch.getWorldScale(patchWorldScaleRef.current);
    const screenAspect = size.width / size.height;
    const worldRadius =
      getVisibleHeightAtZ(camera, patchWorldPositionRef.current.z)
      * screenAspect
      * 0.5;
    const localRadius = worldRadius / Math.max(0.001, patchWorldScaleRef.current.x);

    if (Math.abs(localRadius - lastPatchRadiusRef.current) > 0.005) {
      lastPatchRadiusRef.current = localRadius;
      groundDiscRef.current?.scale.set(localRadius, localRadius, 1);
      if (grassMaterialRef.current) {
        grassMaterialRef.current.uniforms.uPatchRadius.value = localRadius;
      }
      updateGrassLayout(localRadius);
    }
  });

  useEffect(
    () => () => {
      groundTexture.dispose();
      contactShadowTexture.dispose();
      grassGeometry.dispose();
    },
    [contactShadowTexture, grassGeometry, groundTexture],
  );

  return (
    <group ref={patchRef} position={[0, -0.004, 0]}>
      <mesh
        ref={groundDiscRef}
        rotation={[-Math.PI / 2, 0, 0]}
        renderOrder={-1}
      >
        {/* The diameter lies along the screen bottom and the arc extends
            behind the avatar. Runtime scaling keeps it exactly viewport-wide. */}
        <circleGeometry args={[1, 96, 0, Math.PI]} />
        <meshStandardMaterial
          map={groundTexture}
          transparent
          opacity={0.94}
          alphaTest={0.025}
          depthWrite={false}
          roughness={1}
          metalness={0}
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh
        position={[0, 0.0015, -0.025]}
        rotation={[-Math.PI / 2, 0, 0]}
        scale={[0.48, 0.19, 1]}
        renderOrder={0}
      >
        <circleGeometry args={[1, 64]} />
        <meshBasicMaterial
          map={contactShadowTexture}
          transparent
          opacity={0.78}
          alphaTest={0.01}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <instancedMesh
        ref={grassRef}
        args={[grassGeometry, undefined, clumpCount]}
        frustumCulled={false}
      >
        <shaderMaterial
          ref={grassMaterialRef}
          uniforms={grassUniforms}
          vertexShader={FLUFFY_GRASS_VERTEX_SHADER}
          fragmentShader={FLUFFY_GRASS_FRAGMENT_SHADER}
          side={THREE.DoubleSide}
          transparent
          alphaTest={0.1}
        />
      </instancedMesh>
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
    camera.position.z += (target - camera.position.z) * Math.min(1, delta * 1.5);
  });
  return null;
}

/**
 * Light setup tuned per device tier. Each extra light adds a per-fragment
 * lighting calculation, so on phones we collapse the 3-light cinematic
 * setup down to 1 (low) or 2 (mid) lights and bump ambient to compensate
 * for the lost fill. The high tier keeps a warm rim to separate hair and
 * facial contours from the live camera background while low tiers cut
 * shader work substantially on tile-based mobile GPUs.
 */
function SceneLights({
  cameraVideoRef,
}: {
  cameraVideoRef?: RefObject<HTMLVideoElement | null>;
}) {
  const profile = useMemo(() => getDeviceProfile(), []);
  const max = profile.maxLights;
  const baseAmbient = max >= 3 ? 0.52 : max >= 2 ? 0.68 : 0.86;
  const ambientRef = useRef<THREE.AmbientLight>(null);
  const keyRef = useRef<THREE.DirectionalLight>(null);
  const fillRef = useRef<THREE.DirectionalLight>(null);
  const rimRef = useRef<THREE.DirectionalLight>(null);
  const pointRef = useRef<THREE.PointLight>(null);
  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const nextSampleAtRef = useRef(0);
  const targetRef = useRef({
    ambient: baseAmbient,
    key: 1.1,
    fill: 0.3,
    rim: 0.22,
    point: 0.3,
    keyX: 2,
    color: new THREE.Color(1, 0.94, 0.87),
  });

  useFrame(({ clock }, delta) => {
    const video = cameraVideoRef?.current;
    const now = clock.elapsedTime;

    if (
      video &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      video.videoWidth > 0 &&
      now >= nextSampleAtRef.current
    ) {
      nextSampleAtRef.current = now + 0.75;
      const canvas =
        sampleCanvasRef.current ??
        (sampleCanvasRef.current = document.createElement("canvas"));
      canvas.width = 24;
      canvas.height = 14;
      const context = canvas.getContext("2d", { willReadFrequently: true });

      if (context) {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        ).data;
        let red = 0;
        let green = 0;
        let blue = 0;
        let luminance = 0;
        let rawLeft = 0;
        let rawRight = 0;
        let samples = 0;

        for (let index = 0; index < pixels.length; index += 4) {
          const r = pixels[index] / 255;
          const g = pixels[index + 1] / 255;
          const b = pixels[index + 2] / 255;
          const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          red += r;
          green += g;
          blue += b;
          luminance += luma;
          const pixelIndex = index / 4;
          if (pixelIndex % canvas.width < canvas.width / 2) {
            rawLeft += luma;
          } else {
            rawRight += luma;
          }
          samples += 1;
        }

        const averageLuminance = luminance / Math.max(1, samples);
        const exposure = THREE.MathUtils.clamp(
          (averageLuminance - 0.08) / 0.7,
          0,
          1,
        );
        const average = (red + green + blue) / Math.max(1, samples * 3);
        const target = targetRef.current;
        target.ambient = baseAmbient * (0.62 + exposure * 0.55);
        target.key = 0.72 + exposure * 1.05;
        target.fill = 0.18 + exposure * 0.28;
        target.rim = 0.14 + exposure * 0.2;
        target.point = 0.14 + exposure * 0.3;

        // Camera feeds use true direction, so the sampled bright side maps
        // directly to the matching side of the avatar.
        const displayedLeft = rawLeft;
        const displayedRight = rawRight;
        const balance =
          (displayedRight - displayedLeft) /
          Math.max(0.001, displayedRight + displayedLeft);
        target.keyX = THREE.MathUtils.clamp(balance * 7, -3.5, 3.5);

        target.color.setRGB(
          THREE.MathUtils.clamp(red / Math.max(0.001, samples * average), 0.72, 1.12),
          THREE.MathUtils.clamp(green / Math.max(0.001, samples * average), 0.72, 1.12),
          THREE.MathUtils.clamp(blue / Math.max(0.001, samples * average), 0.72, 1.12),
        );
      }
    }

    const target = targetRef.current;
    const blend = Math.min(1, delta * 2.2);
    if (ambientRef.current) {
      ambientRef.current.intensity +=
        (target.ambient - ambientRef.current.intensity) * blend;
      ambientRef.current.color.lerp(target.color, blend * 0.35);
    }
    if (keyRef.current) {
      keyRef.current.intensity +=
        (target.key - keyRef.current.intensity) * blend;
      keyRef.current.position.x +=
        (target.keyX - keyRef.current.position.x) * blend;
      keyRef.current.color.lerp(target.color, blend);
    }
    if (fillRef.current) {
      fillRef.current.intensity +=
        (target.fill - fillRef.current.intensity) * blend;
      fillRef.current.color.lerp(target.color, blend * 0.5);
    }
    if (rimRef.current) {
      rimRef.current.intensity +=
        (target.rim - rimRef.current.intensity) * blend;
    }
    if (pointRef.current) {
      pointRef.current.intensity +=
        (target.point - pointRef.current.intensity) * blend;
      pointRef.current.color.lerp(target.color, blend);
    }
  });

  return (
    <>
      <ambientLight ref={ambientRef} intensity={baseAmbient} />
      {/* Key light — always on. */}
      <directionalLight ref={keyRef} position={[2.8, 3.4, 3.6]} intensity={1.1} />
      {max >= 2 && (
        <directionalLight
          ref={fillRef}
          position={[-2.2, 1.7, 2.4]}
          intensity={0.3}
          color="#ffeedd"
        />
      )}
      {max >= 3 && (
        <directionalLight
          ref={rimRef}
          position={[-2.4, 2.2, -2.2]}
          intensity={0.22}
          color="#FFB469"
        />
      )}
      {max >= 4 && (
          <pointLight
            ref={pointRef}
            position={[0, 0.3, 0.9]}
            intensity={0.3}
            color="#ffe4c9"
          />
      )}
    </>
  );
}

function DynamicDprController({ minDpr, maxDpr }: { minDpr: number; maxDpr: number }) {
  const { setDpr } = useThree();
  const emaFrameMsRef = useRef(16.7);
  const overMsRef = useRef(0);
  const underMsRef = useRef(0);
  const lowQualityRef = useRef(false);

  useEffect(() => {
    const deviceDpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const initial = Math.max(minDpr, Math.min(maxDpr, deviceDpr));
    setDpr(initial);
  }, [minDpr, maxDpr, setDpr]);

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
        setDpr(minDpr);
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
      const restored = Math.max(minDpr, Math.min(maxDpr, deviceDpr));
      lowQualityRef.current = false;
      overMsRef.current = 0;
      underMsRef.current = 0;
      setDpr(restored);
    }
  });

  return null;
}

export interface Avatar3DProps {
  /** Character mesh. All three profiles currently share the Sandipani
   * model; this path can be replaced per profile when new FBX files arrive. */
  avatarUrl?: string;
  isSpeaking: boolean;
  getAudioData?: () => Uint8Array | undefined;
  /** Rear display reads the leader's already-classified mouth pose. */
  getLipSyncFrame?: () => LipSyncFrame | null;
  /** Leader publishes its real-time mouth pose to the rear display. */
  onLipSyncFrame?: (frame: LipSyncFrame | null) => void;
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
  /** Leader publishes its state changes; follower consumes timestamped
   * commands and does not run an independent animation state machine. */
  syncMode?: "leader" | "follower";
  syncedAnimation?: AvatarAnimationCommand | null;
  onAnimationStateChange?: (state: AvatarAnimationState) => void;
  /** Rear mode keeps the stage position unchanged and renders the model
   * from the opposite side. */
  viewMode?: "front" | "rear";
  /** Live background camera used to match avatar exposure, light colour,
   * and the dominant left/right light direction. */
  cameraVideoRef?: RefObject<HTMLVideoElement | null>;
}

export default function Avatar3D({
  avatarUrl = DEFAULT_AVATAR_URL,
  isSpeaking,
  getAudioData,
  getLipSyncFrame,
  onLipSyncFrame,
  gesture,
  faceDetected,
  aiGesture,
  onReady,
  syncMode = "leader",
  syncedAnimation = null,
  onAnimationStateChange,
  viewMode = "front",
  cameraVideoRef,
}: Avatar3DProps) {
  const runtimeAvatarUrl = useMemo(
    () => getOptimizedAvatarPath(avatarUrl, getDeviceProfile()),
    [avatarUrl],
  );
  const gestureRef = useRef<GestureName>(null);
  const isSpeakingRef = useRef(isSpeaking);
  const getAudioDataRef = useRef(getAudioData);
  const getLipSyncFrameRef = useRef(getLipSyncFrame);
  const onLipSyncFrameRef = useRef(onLipSyncFrame);
  const faceDetectedRef = useRef(faceDetected ?? false);
  const aiGestureRef = useRef<{ name: string; nonce: number } | null>(aiGesture ?? null);
  const syncedAnimationRef = useRef<AvatarAnimationCommand | null>(syncedAnimation);
  const cameraTargetRef = useRef(CAMERA_Z_NEAR);

  // Sync incoming props into refs so AvatarModel's per-frame loop can read
  // the latest values without re-rendering the Canvas tree.
  useEffect(() => {
    isSpeakingRef.current = isSpeaking;
    getAudioDataRef.current = getAudioData;
    getLipSyncFrameRef.current = getLipSyncFrame;
    onLipSyncFrameRef.current = onLipSyncFrame;
    gestureRef.current = (gesture as GestureName) ?? null;
    faceDetectedRef.current = faceDetected ?? false;
    aiGestureRef.current = aiGesture ?? null;
    syncedAnimationRef.current = syncedAnimation;
  }, [
    isSpeaking,
    getAudioData,
    getLipSyncFrame,
    onLipSyncFrame,
    gesture,
    faceDetected,
    aiGesture,
    syncedAnimation,
  ]);

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
    onAnimationStateChange?.(state);
  }, [onAnimationStateChange]);

  const onAnimStateChangeRef = useRef(handleAnimStateChange);
  useEffect(() => {
    onAnimStateChangeRef.current = handleAnimStateChange;
  }, [handleAnimStateChange]);

  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  return (
    <AvatarErrorBoundary fallback={(err) => <FallbackOrb isSpeaking={isSpeaking} error={err} />}>
      <Suspense fallback={<Loader />}>
        <div
          style={{
            width: "100%",
            height: "100%",
            overflow: "hidden",
            position: "relative",
          }}
        >
          <DeviceTunedCanvas isSpeaking={isSpeaking}>
            <SceneLights cameraVideoRef={cameraVideoRef} />
            <CameraAnimator targetZRef={cameraTargetRef} />
            <AvatarModel
              avatarUrl={runtimeAvatarUrl}
              isSpeakingRef={isSpeakingRef}
              getAudioDataRef={getAudioDataRef}
              getLipSyncFrameRef={getLipSyncFrameRef}
              onLipSyncFrameRef={onLipSyncFrameRef}
              gestureRef={gestureRef}
              faceDetectedRef={faceDetectedRef}
              aiGestureRef={aiGestureRef}
              onAnimStateChangeRef={onAnimStateChangeRef}
              onReadyRef={onReadyRef}
              syncMode={syncMode}
              syncedAnimationRef={syncedAnimationRef}
              viewMode={viewMode}
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
 *   - `minDpr` / `maxDpr` bound resolution scaling so retina displays get
 *     detail where affordable while weak GPUs can fall below native DPR.
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
      dpr={[profile.minDpr, profile.maxDpr]}
      shadows={profile.shadows}
      // Skip object sorting — the scene has only the avatar;
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
      style={{
        background: "transparent",
        width: "100%",
        height: "100%",
        position: "relative",
        zIndex: 1,
      }}
    >
      <DynamicDprController minDpr={profile.minDpr} maxDpr={profile.maxDpr} />
      {children}
    </Canvas>
  );
}

// Warm only the default avatar. Every production GLB already contains its
// one supplied Mixamo idle, so no secondary animation pack is fetched.
if (typeof window !== "undefined") {
  void loadAvatarScene(getOptimizedAvatarPath(DEFAULT_AVATAR_URL));
}
