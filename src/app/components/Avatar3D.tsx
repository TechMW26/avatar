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

const AVATAR_URL = "/avatar.fbx";

// User-provided FBX animation files (Mixamo rigs).
const ANIM_IDLE_URL = "/animations/breathing-idle.fbx";
const ANIM_SITTING_URL = "/animations/sitting-idle.fbx";
const ANIM_STANDING_URL = "/animations/standing.fbx";
const ANIM_STOPPING_URL = "/animations/stop-walking.fbx";
const ANIM_WALKING_URL = "/animations/walking.fbx";
const ANIM_WAVING_URL = "/animations/waving.fbx";
const ANIM_PRAYING_URL = "/animations/praying.fbx";
const ANIM_EXPLAINING_URL = "/animations/explaining.fbx";

const ALL_ANIM_URLS = [
  ANIM_IDLE_URL,
  ANIM_SITTING_URL,
  ANIM_STANDING_URL,
  ANIM_STOPPING_URL,
  ANIM_WALKING_URL,
  ANIM_WAVING_URL,
  ANIM_PRAYING_URL,
  ANIM_EXPLAINING_URL,
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
  | "explaining";

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
  | "explaining";

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
const BACK_SCALE = 0.65;
// Reduced from 1.0 → 0.95 (5% smaller close-up scale) so the avatar
// doesn't feel oversized when on the front mark.
const FRONT_SCALE = 0.95;

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

function remapClipToAvatarRig(
  clip: THREE.AnimationClip,
  /** Map of `strippedBoneName` → actual rig bone name (preserving the rig's
   *  prefix so the AnimationMixer can find the bone by name). */
  avatarBoneByStripped: Map<string, string>,
): THREE.AnimationClip | null {
  const tracks: THREE.KeyframeTrack[] = [];
  const skipped: string[] = [];

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
   clips (for animation packs whose mesh we don't want). */
const fbxSceneCache = new Map<string, THREE.Group>();
const fbxClipCache = new Map<string, THREE.AnimationClip[]>();
const fbxScenePromises = new Map<string, Promise<THREE.Group>>();
const fbxClipPromises = new Map<string, Promise<THREE.AnimationClip[]>>();

function loadFbxScene(url: string): Promise<THREE.Group> {
  let p = fbxScenePromises.get(url);
  if (!p) {
    const loader = new FBXLoader();
    p = loader
      .loadAsync(url)
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
    const loader = new FBXLoader();
    p = loader
      .loadAsync(url)
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
  const cached = fbxClipCache.get(url);
  if (cached) return cached;
  throw loadFbxClips(url);
}

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
  onAnimStateChangeRef,
  onReadyRef,
}: {
  gestureRef: MutableRefObject<GestureName>;
  faceDetectedRef: MutableRefObject<boolean>;
  isSpeakingRef: MutableRefObject<boolean>;
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
    }),
    [idleClips, sittingClips, standingClips, stoppingClips, walkingClips, wavingClips, prayingClips, explainingClips],
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
  });
  const currentActionRef = useRef<THREE.AnimationAction | null>(null);
  const animStateRef = useRef<AvatarAnimState>("sitting");

  // Face debouncing.
  const stableFaceRef = useRef(false);
  const lastFaceChangeRef = useRef<number>(0);
  const lastFaceRawRef = useRef(false);

  // Cooldowns.
  const noFaceSinceRef = useRef<number | null>(null);
  const lastWaveAtRef = useRef<number>(0);
  const lastPrayAtRef = useRef<number>(0);
  // Explaining is auto-fired while speaking; long cooldown so it stays
  // emphatic and doesn't turn into a tic.
  const lastExplainAtRef = useRef<number>(0);
  const nextExplainRollAtRef = useRef<number>(0);

  // Walking traversal: time-driven so the walking clip plays exactly once
  // over the trip from one stage mark to the other (no double-loop).
  const walkStartRef = useRef<number>(0);
  const walkFromZRef = useRef<number>(0);
  const walkToZRef = useRef<number>(0);
  // Total trip duration. Tuned so the walk is brisk but the cycle still
  // plays through enough to read as walking.
  const WALK_DURATION_MS = 1800;

  useEffect(() => {
    /* ── Material polish ──
       The Meshy FBX ships its own embedded textures, so we leave the maps
       alone and just tighten filtering + zero out the all-white emissive
       that bakes from FBX's Phong shading model. */
    const avatarBoneByStripped = new Map<string, string>();

    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
          (mesh as THREE.SkinnedMesh).normalizeSkinWeights();
        }
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach((mat) => {
          const m = mat as THREE.MeshStandardMaterial;
          if (m.map) {
            m.map.colorSpace = THREE.SRGBColorSpace;
            m.map.anisotropy = 16;
            m.map.minFilter = THREE.LinearMipmapLinearFilter;
            m.map.magFilter = THREE.LinearFilter;
            m.map.needsUpdate = true;
          }
          if (m.emissiveMap) {
            m.emissiveMap.dispose?.();
            m.emissiveMap = null;
          }
          m.emissive = new THREE.Color(0x000000);
          if (m.normalMap) {
            m.normalScale = new THREE.Vector2(1.2, 1.2);
            m.normalMap.anisotropy = 16;
            m.normalMap.needsUpdate = true;
          }
          m.roughness = Math.max(m.roughness ?? 0.5, 0.45);
          m.envMapIntensity = 0.4;
          m.side = THREE.DoubleSide;
          m.needsUpdate = true;
        });
        mesh.frustumCulled = false;
      }
      if ((obj as THREE.Bone).isBone) {
        avatarBoneByStripped.set(stripMixamoPrefix(obj.name), obj.name);
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
    const desiredHeight = 2.6;
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
    };

    (Object.keys(sourceClips) as ClipKey[]).forEach((key) => {
      const clip = sourceClips[key];
      if (!clip) return;
      const mapped = remapClipToAvatarRig(clip, avatarBoneByStripped);
      if (!mapped) return;
      const action = mixer.clipAction(mapped, scene);
      action.enabled = true;
      action.setEffectiveWeight(1);
      action.setEffectiveTimeScale(1);
      nextActions[key] = action;
    });

    actionsRef.current = nextActions;

    // Default pose with no one around is sitting; a face triggers the
    // stand-up → walk-in → idle sequence below.
    const initialState: AvatarAnimState =
      (nextActions.sitting && "sitting") ||
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
      };
    };
    // `notify` is stable (refs only); intentionally NOT a dep so we don't
    // tear down the mixer on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, sourceClips]);

  useFrame((_, delta) => {
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
      const yBias = state === "sitting" ? SIT_GROUND_OFFSET_Y : 0;
      const tgtY = GROUND_Y + yBias;

      grp.position.y += (tgtY - grp.position.y) * Math.min(1, delta * 3);

      if (isWalking) {
        const elapsed = performance.now() - walkStartRef.current;
        const t = Math.max(0, Math.min(1, elapsed / WALK_DURATION_MS));
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
      grp.scale.setScalar(derivedScale);

      onMark =
        Math.abs(target.z - grp.position.z) < 0.04 &&
        Math.abs(target.scale - grp.scale.x) < 0.008;
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

      // Time-bound the walking traversal and re-rate the walking clip so it
      // plays in lock-step with the trip rather than freely looping until
      // the avatar happens to arrive on-mark.
      if ((next === "walking_in" || next === "walking_out") && playing) {
        walkStartRef.current = performance.now();
        walkFromZRef.current = grp ? grp.position.z : STATE_TARGETS[next].z;
        walkToZRef.current = STATE_TARGETS[next].z;
        const walkAction = actions.walking;
        if (walkAction) {
          const clipDur = walkAction.getClip().duration;
          if (clipDur > 0.001) {
            walkAction.setEffectiveTimeScale(
              clipDur / (WALK_DURATION_MS / 1000),
            );
          }
        }
      } else if (actions.walking) {
        // Restore default rate when leaving a walking state.
        actions.walking.setEffectiveTimeScale(1);
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
          gestureRef.current === "Namaste" && now - lastPrayAtRef.current > 1200;
        const wantsWave =
          gestureRef.current === "Open_Palm" && now - lastWaveAtRef.current > 2500;
        if (wantsPray && actions.praying) {
          lastPrayAtRef.current = now;
          goTo("praying", THREE.LoopOnce, true, 0.4);
        } else if (wantsWave && actions.waving) {
          lastWaveAtRef.current = now;
          goTo("waving", THREE.LoopOnce, true, 0.4);
        } else if (
          // Auto-explain: while the AI is speaking, occasionally fire the
          // explaining gesture to give the delivery weight. Strong cooldown
          // (12s) so it stays an emphatic punctuation, not a nervous tic.
          // Roll once per ~700ms with ~35% chance, gated by the cooldown,
          // so the avatar lands a gesture roughly 1–2 sentences in.
          isSpeakingRef.current &&
          actions.explaining &&
          now - lastExplainAtRef.current > 12_000 &&
          now >= nextExplainRollAtRef.current
        ) {
          nextExplainRollAtRef.current = now + 700;
          if (Math.random() < 0.35) {
            lastExplainAtRef.current = now;
            goTo("explaining", THREE.LoopOnce, true, 0.35);
          }
        }
      } else {
        if (noFaceSinceRef.current == null) noFaceSinceRef.current = now;
        if (now - noFaceSinceRef.current > RETURN_TO_SIT_DELAY_MS) {
          noFaceSinceRef.current = null;
          // Begin the "go home" sequence: face away first.
          goTo("turning_away", THREE.LoopRepeat, false, 0.4);
        }
      }
    } else if (state === "sitting") {
      if (faceNow) {
        noFaceSinceRef.current = null;
        if (actions.standing_up) {
          goTo("standing_up", THREE.LoopOnce, true, 0.6);
        } else {
          goTo("walking_in", THREE.LoopRepeat, false, 0.5);
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
      // If the visitor leaves mid-walk, abort and turn around.
      if (!faceNow) {
        if (noFaceSinceRef.current == null) noFaceSinceRef.current = now;
      } else {
        noFaceSinceRef.current = null;
      }
      if (onMark) {
        // Hand off to the stop-walking clip for a soft ease-in to idle.
        if (actions.stopping) {
          goTo("stopping", THREE.LoopOnce, true, 0.25);
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
        goTo("sitting", THREE.LoopRepeat, false, 0.6);
      }
    } else if (state === "stopping") {
      const action = actions.stopping;
      const done = !action || action.time >= action.getClip().duration - 0.1;
      if (done) {
        goTo("idle_standing", THREE.LoopRepeat, false, 0.5);
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
  const { camera } = useThree();
  useFrame((_, delta) => {
    const target = targetZRef.current;
    // eslint-disable-next-line react-hooks/immutability
    camera.position.z += (target - camera.position.z) * Math.min(1, delta * 1.5);
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
  /** Fired once the avatar mesh + animations are loaded and the first idle
   *  frame is on screen. Use this to defer expensive work like the camera
   *  vision pipeline so the avatar always renders before face detection
   *  starts firing state-machine transitions. */
  onReady?: () => void;
}

export default function Avatar3D({ isSpeaking, gesture, faceDetected, onReady }: Avatar3DProps) {
  const gestureRef = useRef<GestureName>(null);
  const faceDetectedRef = useRef(faceDetected ?? false);
  const isSpeakingRef = useRef(isSpeaking);
  const cameraTargetRef = useRef(CAMERA_Z_NEAR);

  // Sync incoming props into refs so AvatarModel's per-frame loop can read
  // the latest values without re-rendering the Canvas tree.
  useEffect(() => {
    gestureRef.current = (gesture as GestureName) ?? null;
    faceDetectedRef.current = faceDetected ?? false;
    isSpeakingRef.current = isSpeaking;
  }, [gesture, faceDetected, isSpeaking]);

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

  return (
    <AvatarErrorBoundary fallback={(err) => <FallbackOrb isSpeaking={isSpeaking} error={err} />}>
      <Suspense fallback={<Loader />}>
        <div style={{ width: "100%", height: "100%", overflow: "hidden" }}>
          <Canvas
            camera={{ position: [0, 0.05, CAMERA_Z_NEAR], fov: 36 }}
            gl={{ alpha: true, antialias: true }}
            dpr={[1, 2]}
            shadows
            onCreated={({ gl }) => {
              gl.toneMapping = THREE.ACESFilmicToneMapping;
              gl.toneMappingExposure = 1.15;
              gl.outputColorSpace = THREE.SRGBColorSpace;
            }}
            style={{ background: "transparent", width: "100%", height: "100%" }}
          >
            <ambientLight intensity={0.7} />
            <directionalLight position={[2, 3, 3]} intensity={1.0} />
            <directionalLight position={[-1.5, 2, 1]} intensity={0.35} color="#ffeedd" />
            <directionalLight position={[-2, 1, -1]} intensity={0.15} color="#FF9933" />
            <pointLight position={[0, 0.3, 0.9]} intensity={0.3} color="#ffe4c9" />
            <CameraAnimator targetZRef={cameraTargetRef} />
            <Ground />
            <AvatarModel
              gestureRef={gestureRef}
              faceDetectedRef={faceDetectedRef}
              isSpeakingRef={isSpeakingRef}
              onAnimStateChangeRef={onAnimStateChangeRef}
              onReadyRef={onReadyRef}
            />
          </Canvas>
        </div>
      </Suspense>
    </AvatarErrorBoundary>
  );
}

// Warm the FBX caches so the avatar + animations are ready by the time the
// component mounts (avoids a Suspense fallback flicker after first paint).
if (typeof window !== "undefined") {
  void loadFbxScene(AVATAR_URL);
  ALL_ANIM_URLS.forEach((url) => {
    void loadFbxClips(url);
  });
}
