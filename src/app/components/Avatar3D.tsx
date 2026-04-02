"use client";

import { useRef, useEffect, useState, Suspense, Component, ReactNode, MutableRefObject } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { useFBX } from "@react-three/drei";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const AVATAR_URL = "/avatar.fbx";

/**
 * Map from RPM/Mixamo bone names (used in emote GLBs) to this FBX skeleton's names.
 * The new model uses a custom naming convention:
 *   Neck → neck, Spine1 → Spine01, Spine2 → Spine02, HeadTop_End → head_end
 * Most other names (Head, Hips, LeftArm, etc.) match directly.
 */
const BONE_NAME_MAP: Record<string, string> = {
  Neck: 'neck',
  Spine1: 'Spine01',
  Spine2: 'Spine02',
  HeadTop_End: 'head_end',
};

/**
 * Retarget animation clip track names from RPM emote GLBs to this FBX skeleton.
 */
function retargetClip(clip: THREE.AnimationClip, boneNames: Set<string>): THREE.AnimationClip {
  const retargeted = clip.clone();
  const kept: THREE.KeyframeTrack[] = [];
  const dropped: string[] = [];
  retargeted.tracks.forEach(track => {
    const dotIdx = track.name.indexOf('.');
    if (dotIdx === -1) { kept.push(track); return; }
    const boneName = track.name.substring(0, dotIdx);
    const prop = track.name.substring(dotIdx);
    // Direct match
    if (boneNames.has(boneName)) { kept.push(track); return; }
    // Try name mapping
    const mapped = BONE_NAME_MAP[boneName];
    if (mapped && boneNames.has(mapped)) {
      const newTrack = track.clone();
      newTrack.name = mapped + prop;
      kept.push(newTrack);
      return;
    }
    dropped.push(track.name);
  });
  retargeted.tracks = kept;
  if (dropped.length > 0) {
    console.log(`[Avatar] retarget "${clip.name}": ${kept.length} mapped, ${dropped.length} dropped`);
  }
  return retargeted;
}

/* ── Error boundary ── */
class AvatarErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

/*
 * ── Audio-reactive pose-cycling lip sync ──
 *
 * Production lip sync without phoneme data works by:
 * 1. Cycling through complete mouth POSES (not individual morph targets)
 * 2. Timing transitions to audio transients (syllable onsets)
 * 3. Modulating pose intensity by volume (loud = pronounced, quiet = subtle)
 * 4. Between syllables, blending toward a closed-mouth rest pose
 *
 * This mirrors how Synthesia / D-ID / Ready Player Me handle
 * real-time lip sync when no phoneme stream is available.
 */

// All viseme channel names we drive
const VISEME_KEYS = [
  "jawOpen", "viseme_aa", "viseme_E", "viseme_O", "viseme_U",
  "viseme_SS", "viseme_FF", "viseme_PP", "viseme_TH", "viseme_DD",
  "viseme_kk", "viseme_RR", "viseme_nn", "viseme_CH",
] as const;

type VisemeKey = (typeof VISEME_KEYS)[number];

// Complete mouth poses — each a distinct, recognizable mouth shape
const POSES: Partial<Record<VisemeKey, number>>[] = [
  // 0: Open vowel "ah" — wide open
  { jawOpen: 0.30, viseme_aa: 0.28 },
  // 1: Mid vowel "eh" — slightly open, spread
  { jawOpen: 0.14, viseme_E: 0.24 },
  // 2: Rounded "oh" — medium open, lips rounded
  { jawOpen: 0.20, viseme_O: 0.26 },
  // 3: Tight "oo" — nearly closed, lips pursed
  { jawOpen: 0.06, viseme_U: 0.20 },
  // 4: Bilabial "mm/pp" — lips pressed shut
  { jawOpen: 0.01, viseme_PP: 0.18 },
  // 5: Fricative "ff/vv" — lower lip to teeth
  { jawOpen: 0.04, viseme_FF: 0.20 },
  // 6: Sibilant "ss/sh" — teeth close, spread
  { jawOpen: 0.04, viseme_SS: 0.20, viseme_E: 0.06 },
  // 7: Dental/tap "th/d/t" — tongue forward
  { jawOpen: 0.10, viseme_TH: 0.16, viseme_DD: 0.08 },
  // 8: Open variant "ah" + liquid
  { jawOpen: 0.24, viseme_aa: 0.18, viseme_RR: 0.12 },
  // 9: Velar "k/g" — back tongue, mid open
  { jawOpen: 0.12, viseme_kk: 0.16, viseme_nn: 0.06 },
];

// Pre-built pose sequences that feel like natural syllable patterns
const POSE_SEQUENCES = [
  [0, 7, 1, 4, 2, 6, 0, 5],
  [1, 0, 9, 4, 8, 6, 3],
  [2, 5, 0, 1, 7, 3, 6, 0],
  [0, 6, 8, 4, 1, 0, 7, 5],
  [3, 0, 7, 2, 4, 1, 9, 0],
  [8, 1, 5, 0, 3, 7, 2, 4],
];

class AudioLipSync {
  private current: Record<VisemeKey, number>;

  // Audio envelope
  private volumeFast = 0;   // smoothed follower
  private volumeSlow = 0;   // slower follower for blend
  private prevRms = 0;

  // Pose cycling
  private seqIdx = 0;
  private poseIdx = 0;
  private poseTimer = 0;
  private rng = 42;

  constructor() {
    this.current = {} as Record<VisemeKey, number>;
    for (const k of VISEME_KEYS) this.current[k] = 0;
  }

  private rand() {
    this.rng = (this.rng * 16807 + 7) % 2147483647;
    return (this.rng % 1000) / 1000;
  }

  /** Compute speech-band RMS from FFT data, or fall back to volume */
  private getRms(freqData: Uint8Array | undefined | null, fallbackVol: number): number {
    if (freqData && freqData.length > 16) {
      const lo = Math.max(1, Math.floor(freqData.length * 0.005));
      const hi = Math.min(freqData.length - 1, Math.floor(freqData.length * 0.18));
      let sumSq = 0;
      for (let i = lo; i <= hi; i++) {
        const v = freqData[i] / 255;
        sumSq += v * v;
      }
      return Math.sqrt(sumSq / (hi - lo + 1));
    }
    return fallbackVol;
  }

  update(
    freqData: Uint8Array | undefined | null,
    volume: number,
    speaking: boolean,
  ): Record<string, number> {
    const result: Record<string, number> = {};

    // ── Not speaking: gentle decay ──
    if (!speaking) {
      for (const k of VISEME_KEYS) {
        this.current[k] *= 0.55;          // softer falloff so mouth closes smoothly
        if (this.current[k] < 0.002) this.current[k] = 0;
        result[k] = this.current[k];
      }
      this.volumeFast = 0;
      this.volumeSlow = 0;
      this.prevRms = 0;
      return result;
    }

    // ── 1. Get audio level ──
    const rms = this.getRms(freqData, volume);

    // ── 2. Smoothed envelope followers ──
    this.volumeFast += (rms - this.volumeFast) * 0.25;
    this.volumeSlow += (rms - this.volumeSlow) * 0.12;

    // ── 3. Amplitude from blended volume ──
    // Blend fast + slow followers for smooth but responsive amplitude.
    const blendedVol = this.volumeFast * 0.6 + this.volumeSlow * 0.4;
    const gated = Math.max(0, blendedVol - 0.02);
    const amplitude = gated > 0 ? Math.sqrt(Math.min(1, gated * 3.5)) : 0;

    // ── 4. Transient detection (for pose advancement speed) ──
    const transient = Math.max(0, rms - this.prevRms);
    this.prevRms = rms;

    // ── 5. Advance pose sequence ──
    // Base rate keeps poses moving during any speech; transients speed it up (gentler)
    const rate = amplitude > 0.1 ? (0.06 + amplitude * 0.04 + transient * 0.8) : 0;
    this.poseTimer += rate;

    if (this.poseTimer >= 1.0) {
      this.poseTimer = 0;
      const seq = POSE_SEQUENCES[this.seqIdx];
      this.poseIdx = (this.poseIdx + 1) % seq.length;
      if (this.poseIdx === 0) {
        this.seqIdx = Math.floor(this.rand() * POSE_SEQUENCES.length);
      }
    }

    // ── 6. Build targets from current pose × amplitude ──
    const seq = POSE_SEQUENCES[this.seqIdx];
    const pose = POSES[seq[this.poseIdx]];

    for (const k of VISEME_KEYS) {
      const poseWeight = pose[k] || 0;
      const target = poseWeight * amplitude;
      const prev = this.current[k];
      // Gentle lerp: rise slower (0.18) so lips don't snap open,
      // fall even softer (0.10) so they glide shut
      if (target > prev) {
        this.current[k] = prev + (target - prev) * 0.18;
      } else {
        this.current[k] = prev + (target - prev) * 0.10;
      }
      if (this.current[k] < 0.002) this.current[k] = 0;
      result[k] = this.current[k];
    }

    return result;
  }
}

/* ── Gesture animation types ── */
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

// No arm-down correction needed — Avaturn models include a built-in idle
// animation that naturally positions the arms.

/**
 * Emote animation system using motion-captured GLB clips from the
 * Ready Player Me Animation Library (CC-BY-4.0).
 * Each gesture detection maps to a full-body emote animation loaded via
 * THREE.AnimationMixer, giving natural motion-captured body movement.
 */
const EMOTE_ANIMATIONS: Record<string, string> = {
  Open_Palm:   "/animations/M_Standing_Expressions_013.glb", // wave / greeting
  Thumb_Up:    "/animations/M_Standing_Expressions_012.glb", // thumbs up
  Thumb_Down:  "/animations/M_Standing_Expressions_014.glb", // head shake / disagree
  Victory:     "/animations/M_Standing_Expressions_005.glb", // celebration / expressive
  ILoveYou:    "/animations/M_Standing_Expressions_007.glb", // heartfelt / appreciative
  Closed_Fist: "/animations/M_Standing_Expressions_008.glb", // fist pump / strong
  Pointing_Up: "/animations/M_Standing_Expressions_010.glb", // pointing / presenting
  Namaste:     "/animations/M_Standing_Expressions_011.glb", // hand to chest / respectful bow
  Photo_Pose:  "/animations/M_Standing_Expressions_015.glb", // friendly pose for photo
};

// How long to keep gesture active after last MediaPipe detection (seconds)
const GESTURE_HOLD_TIME = 1.5;
// Blend duration for crossfading into and out of emotes (seconds)
const EMOTE_BLEND_IN = 0.3;
const EMOTE_BLEND_OUT = 0.5;

/* ── 3D Model ── */
function AvatarModel({
  isSpeaking,
  audioDataRef,
  volumeRef,
  gestureRef,
  userSmileRef,
}: {
  isSpeaking: boolean;
  audioDataRef: MutableRefObject<(() => Uint8Array | undefined) | undefined>;
  volumeRef: MutableRefObject<(() => number) | undefined>;
  gestureRef: MutableRefObject<GestureName>;
  userSmileRef: MutableRefObject<number>;
}) {
  const fbx = useFBX(AVATAR_URL);
  const scene = fbx;
  const morphMeshes = useRef<THREE.Mesh[]>([]);
  const headBone = useRef<THREE.Object3D | null>(null);
  const lipSync = useRef(new AudioLipSync());
  // Auto-computed Y offset from bounding box (state to trigger re-render)
  const [modelYOffset, setModelYOffset] = useState(0);
  // Store the Hips bone's original position to lock root motion (all axes)
  const hipsOrigPos = useRef<THREE.Vector3 | null>(null);
  const hipsBone = useRef<THREE.Bone | null>(null);

  // Built-in idle animation action ref
  const idleAction = useRef<THREE.AnimationAction | null>(null);
  // Set of all bone names in this skeleton (for retargeting emote clips)
  const skeletonBoneNames = useRef<Set<string>>(new Set());

  // ── Emote animation system ──
  const mixer = useRef<THREE.AnimationMixer | null>(null);
  const emoteActions = useRef<Record<string, THREE.AnimationAction>>({});
  const currentEmoteAction = useRef<THREE.AnimationAction | null>(null);
  // Smoothed emote blend (0 = rest pose, 1 = full animation)
  const emoteBlend = useRef(0);
  const activeGesture = useRef<GestureName>(null);
  // Gesture hold: keep gesture active for GESTURE_HOLD_TIME after last detection
  const gestureHoldName = useRef<GestureName>(null);
  const gestureLastSeen = useRef(0);
  // Smoothed gesture expression blend for face
  const gestureExprBlend = useRef(0);
  // Manual delta time tracking (clock.getDelta() is unreliable with getElapsedTime())
  const lastFrameTime = useRef(0);
  // All bones (not just arm bones) for animation blending
  const allBones = useRef<Record<string, THREE.Bone>>({});

  useEffect(() => {
    const meshes: THREE.Mesh[] = [];
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        // Enhance skin textures
        if (mesh.material) {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          mats.forEach((mat) => {
            const m = mat as THREE.MeshStandardMaterial;
            if (m.map) {
              m.map.anisotropy = 16;
              m.map.minFilter = THREE.LinearMipmapLinearFilter;
              m.map.magFilter = THREE.LinearFilter;
              m.map.needsUpdate = true;
            }
            if (m.normalMap) {
              m.normalScale = new THREE.Vector2(1.2, 1.2);
              m.normalMap.anisotropy = 16;
              m.normalMap.needsUpdate = true;
            }
            // Skin-like roughness
            m.roughness = Math.max(m.roughness ?? 0.5, 0.45);
            m.envMapIntensity = 0.4;
            // Ensure model is visible: render both sides
            m.side = THREE.DoubleSide;
            m.needsUpdate = true;
          });
          console.log(`[Avatar] Mesh "${mesh.name}": ${mats.length} material(s), hasMap=${!!(mats[0] as THREE.MeshStandardMaterial).map}, color=#${((mats[0] as THREE.MeshStandardMaterial).color || new THREE.Color()).getHexString()}`);
        }
        // Prevent frustum-culling artifacts on large skinned mesh
        mesh.frustumCulled = false;
        if (mesh.morphTargetDictionary && mesh.morphTargetInfluences) {
          meshes.push(mesh);
        }
      }
      if (obj.name === "Head") headBone.current = obj;
      if (obj.name === "Hips") hipsBone.current = obj as THREE.Bone;
      // Collect ALL bones for animation blending
      if ((obj as THREE.Bone).isBone) {
        allBones.current[obj.name] = obj as THREE.Bone;
        skeletonBoneNames.current.add(obj.name);
      }
    });
    morphMeshes.current = meshes;

    // ── Fixed scale + position ──
    // The model is ~170 units tall (cm). FBXLoader may or may not apply unit conversion.
    // Reset scale first so React Strict Mode re-runs measure raw model height.
    scene.scale.set(1, 1, 1);
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene);
    const modelHeight = box.max.y - box.min.y;
    console.log("[Avatar] FBX raw bounding box:", {
      min: [box.min.x.toFixed(2), box.min.y.toFixed(2), box.min.z.toFixed(2)],
      max: [box.max.x.toFixed(2), box.max.y.toFixed(2), box.max.z.toFixed(2)],
      height: modelHeight.toFixed(2),
      bones: [...skeletonBoneNames.current].join(", "),
      animations: (fbx.animations || []).map(a => a.name),
    });

    // Force the model to be exactly 1.8 world units tall
    const desiredHeight = 1.8;
    if (modelHeight > 0.001) {
      const s = desiredHeight / modelHeight;
      scene.scale.set(s, s, s);
      console.log("[Avatar] Applied scale:", s.toFixed(6), "modelHeight:", modelHeight.toFixed(2));
    } else {
      // Fallback: assume 170cm model that FBXLoader didn't scale
      scene.scale.set(0.0106, 0.0106, 0.0106);
      console.log("[Avatar] Fallback scale applied (model height was 0)");
    }

    // Recompute after scaling and center vertically
    scene.updateMatrixWorld(true);
    const scaledBox = new THREE.Box3().setFromObject(scene);
    const scaledCenter = new THREE.Vector3();
    scaledBox.getCenter(scaledCenter);
    // Place feet at bottom of view: shift so model bottom is at y = -desiredHeight/2
    const yOffset = -scaledBox.min.y - desiredHeight * 0.45;
    console.log("[Avatar] After scale:", {
      min: scaledBox.min.y.toFixed(3),
      max: scaledBox.max.y.toFixed(3),
      center: scaledCenter.y.toFixed(3),
      yOffset: yOffset.toFixed(3),
    });
    setModelYOffset(yOffset);

    // ── Create AnimationMixer ──
    mixer.current = new THREE.AnimationMixer(scene);

    // Record the Hips bone rest position (all axes) to lock it each frame
    if (hipsBone.current) {
      hipsOrigPos.current = hipsBone.current.position.clone();
    }

    // Listen for animation end to clean up
    mixer.current.addEventListener("finished", () => {
      // Animation completed its play-through; we'll blend out via emoteBlend
    });

    // ── Use the model's own built-in animation as idle ──
    // The FBX ships with "Armature|Armature|clip0|baselayer" which is a proper
    // idle for this specific skeleton. Using emote-derived idle causes distortion
    // because the RPM emote quaternions don't match this model's rest pose.
    if (fbx.animations && fbx.animations.length > 0 && mixer.current) {
      const builtInClip = fbx.animations[0];
      const action = mixer.current.clipAction(builtInClip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.setEffectiveWeight(1);
      action.play();
      idleAction.current = action;
      console.log(`[Avatar] Using built-in idle animation: "${builtInClip.name}" (${builtInClip.tracks.length} tracks, ${builtInClip.duration.toFixed(2)}s)`);
    }

    // Load all emote animations (gesture overlays only — no idle override).
    const loader = new GLTFLoader();

    const loadPromises = Object.entries(EMOTE_ANIMATIONS)
      .map(
        ([gestureName, url]) =>
          new Promise<void>((resolve) => {
            loader.load(
              url,
              (emoteGltf) => {
                if (emoteGltf.animations.length > 0 && mixer.current) {
                  const rawClip = emoteGltf.animations[0];
                  const retargeted = retargetClip(rawClip, skeletonBoneNames.current);
                  // Strip position tracks to prevent root motion
                  retargeted.tracks = retargeted.tracks.filter(t => !t.name.endsWith('.position'));
                  retargeted.name = gestureName;
                  console.log(`[Avatar] Emote "${gestureName}": ${retargeted.tracks.length} tracks → ${retargeted.tracks.map(t => t.name.split('.')[0]).slice(0, 5).join(', ')}...`);

                  const action = mixer.current.clipAction(retargeted);
                  action.setLoop(THREE.LoopOnce, 1);
                  action.clampWhenFinished = true;
                  action.setEffectiveWeight(0);
                  emoteActions.current[gestureName] = action;
                }
                resolve();
              },
              undefined,
              () => resolve(),
            );
          }),
      );
    Promise.all(loadPromises);

    return () => {
      mixer.current?.stopAllAction();
      mixer.current = null;
    };
  }, [scene, fbx.animations]);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();

    // Get real-time audio data from ElevenLabs
    const freqData = audioDataRef.current?.() ?? undefined;
    const vol = volumeRef.current?.() ?? 0;

    // Audio-driven lip sync — compute viseme weights
    const lsTargets = lipSync.current.update(freqData, vol, isSpeaking);

    // NOTE: Speech bone motion is applied AFTER mixer.update() below so that
    // the mixer sets the base pose first, then we add small deltas on top.

    morphMeshes.current.forEach((mesh) => {
      const d = mesh.morphTargetDictionary!;
      const inf = mesh.morphTargetInfluences!;

      // Blinking (~every 3-4s with slight variation)
      const blinkCycle = 3.2 + Math.sin(t * 0.13) * 0.8;
      const blinkPhase = (t % blinkCycle) / blinkCycle;
      const blinkVal =
        blinkPhase > 0.96 ? 1 : blinkPhase > 0.94 ? (blinkPhase - 0.94) * 50 : 0;
      if (d.eyeBlinkLeft !== undefined) inf[d.eyeBlinkLeft] = blinkVal;
      if (d.eyeBlinkRight !== undefined) inf[d.eyeBlinkRight] = blinkVal;

      // Apply lip-sync morph targets
      for (const [name, weight] of Object.entries(lsTargets)) {
        if (d[name] !== undefined) {
          inf[d[name]] = weight;
        }
      }

      if (isSpeaking) {
        // Micro-expressions that accompany speech
        if (d.mouthSmileLeft !== undefined)
          inf[d.mouthSmileLeft] = 0.04 + Math.sin(t * 0.9) * 0.03;
        if (d.mouthSmileRight !== undefined)
          inf[d.mouthSmileRight] = 0.04 + Math.sin(t * 0.9 + 0.3) * 0.03;
        if (d.browInnerUp !== undefined)
          inf[d.browInnerUp] = Math.max(0, Math.sin(t * 1.5) * 0.08);
        if (d.browOuterUpLeft !== undefined)
          inf[d.browOuterUpLeft] = Math.max(0, Math.sin(t * 1.1 + 1.0) * 0.04);
        if (d.browOuterUpRight !== undefined)
          inf[d.browOuterUpRight] = Math.max(0, Math.sin(t * 1.1 + 1.2) * 0.04);
        if (d.cheekSquintLeft !== undefined)
          inf[d.cheekSquintLeft] = Math.max(0, Math.sin(t * 1.3) * 0.04);
        if (d.cheekSquintRight !== undefined)
          inf[d.cheekSquintRight] = Math.max(0, Math.sin(t * 1.3 + 0.15) * 0.04);
        if (d.noseSneerLeft !== undefined)
          inf[d.noseSneerLeft] = Math.max(0, Math.sin(t * 2.3) * 0.02);
        if (d.noseSneerRight !== undefined)
          inf[d.noseSneerRight] = Math.max(0, Math.sin(t * 2.3 + 0.1) * 0.02);
      } else {
        // Idle — gentle resting expression
        const idleTargets = [
          "mouthSmileLeft", "mouthSmileRight", "browInnerUp",
          "browOuterUpLeft", "browOuterUpRight",
          "cheekSquintLeft", "cheekSquintRight",
          "noseSneerLeft", "noseSneerRight",
        ];
        idleTargets.forEach((name) => {
          if (d[name] !== undefined && inf[d[name]] > 0.001) {
            inf[d[name]] *= 0.9;
          }
        });
      }

      // ── Smile mirroring: when user smiles, avatar smiles back ──
      const smile = userSmileRef.current;
      if (smile > 0.05) {
        const s = Math.min(smile * 1.2, 1); // slightly amplify
        if (d.mouthSmileLeft !== undefined)
          inf[d.mouthSmileLeft] = Math.max(inf[d.mouthSmileLeft], s * 0.55);
        if (d.mouthSmileRight !== undefined)
          inf[d.mouthSmileRight] = Math.max(inf[d.mouthSmileRight], s * 0.55);
        if (d.cheekSquintLeft !== undefined)
          inf[d.cheekSquintLeft] = Math.max(inf[d.cheekSquintLeft], s * 0.25);
        if (d.cheekSquintRight !== undefined)
          inf[d.cheekSquintRight] = Math.max(inf[d.cheekSquintRight], s * 0.25);
        if (d.browOuterUpLeft !== undefined)
          inf[d.browOuterUpLeft] = Math.max(inf[d.browOuterUpLeft], s * 0.08);
        if (d.browOuterUpRight !== undefined)
          inf[d.browOuterUpRight] = Math.max(inf[d.browOuterUpRight], s * 0.08);
      }
    });

    // ── Emote animation system ──
    const curGesture = gestureRef.current;
    // Manual delta: clock.getDelta() is unreliable when getElapsedTime() is also used
    const now = t;
    const dt = lastFrameTime.current > 0 ? Math.min(now - lastFrameTime.current, 0.05) : 0.016;
    lastFrameTime.current = now;

    // Sticky gesture: hold detected gesture active for GESTURE_HOLD_TIME
    if (curGesture && emoteActions.current[curGesture]) {
      gestureHoldName.current = curGesture;
      gestureLastSeen.current = now;
    }
    const heldGesture = gestureHoldName.current;
    const gestureFresh = heldGesture && (now - gestureLastSeen.current) < GESTURE_HOLD_TIME;

    if (gestureFresh && heldGesture) {
      // Start or continue emote
      if (activeGesture.current !== heldGesture) {
        // Cross-fade: old emote/idle → new emote
        const action = emoteActions.current[heldGesture];
        if (action) {
          // Stop any previous emote cleanly
          if (currentEmoteAction.current && currentEmoteAction.current !== idleAction.current) {
            currentEmoteAction.current.fadeOut(EMOTE_BLEND_IN);
          }
          action.reset();
          action.setEffectiveWeight(1);
          action.setEffectiveTimeScale(1);
          action.play();
          // Cross-fade from idle to emote (idle fades out as emote fades in)
          if (idleAction.current) {
            action.crossFadeFrom(idleAction.current, EMOTE_BLEND_IN, true);
          } else {
            action.fadeIn(EMOTE_BLEND_IN);
          }
          currentEmoteAction.current = action;
        }
        activeGesture.current = heldGesture;
      }
      emoteBlend.current = Math.min(1, emoteBlend.current + dt / EMOTE_BLEND_IN);
      gestureExprBlend.current = Math.min(1, gestureExprBlend.current + dt / (EMOTE_BLEND_IN * 1.2));
    } else {
      // Blend out emote → back to idle
      emoteBlend.current = Math.max(0, emoteBlend.current - dt / EMOTE_BLEND_OUT);
      gestureExprBlend.current = Math.max(0, gestureExprBlend.current - dt / (EMOTE_BLEND_OUT * 1.5));
      if (activeGesture.current && emoteBlend.current <= 0) {
        // Cross-fade from emote back to idle
        if (idleAction.current) {
          idleAction.current.reset();
          idleAction.current.setEffectiveWeight(1);
          idleAction.current.setEffectiveTimeScale(1);
          idleAction.current.play();
          if (currentEmoteAction.current) {
            idleAction.current.crossFadeFrom(currentEmoteAction.current, EMOTE_BLEND_OUT, true);
          } else {
            idleAction.current.fadeIn(EMOTE_BLEND_OUT);
          }
        } else if (currentEmoteAction.current) {
          currentEmoteAction.current.fadeOut(EMOTE_BLEND_OUT);
        }
        currentEmoteAction.current = null;
        activeGesture.current = null;
        gestureHoldName.current = null;
      }
    }

    const blend = emoteBlend.current;
    const gesture = activeGesture.current;
    const exprBlend = gestureExprBlend.current;

    // ── Gesture-triggered facial expressions ──
    if (exprBlend > 0.001) {
      morphMeshes.current.forEach((mesh) => {
        const d = mesh.morphTargetDictionary!;
        const inf = mesh.morphTargetInfluences!;

        const smileAmount = exprBlend * 0.35;
        if (d.mouthSmileLeft !== undefined)
          inf[d.mouthSmileLeft] = Math.max(inf[d.mouthSmileLeft], smileAmount);
        if (d.mouthSmileRight !== undefined)
          inf[d.mouthSmileRight] = Math.max(inf[d.mouthSmileRight], smileAmount);
        if (d.cheekSquintLeft !== undefined)
          inf[d.cheekSquintLeft] = Math.max(inf[d.cheekSquintLeft], exprBlend * 0.2);
        if (d.cheekSquintRight !== undefined)
          inf[d.cheekSquintRight] = Math.max(inf[d.cheekSquintRight], exprBlend * 0.2);

        if (gesture === "Thumb_Up") {
          if (d.mouthSmileLeft !== undefined) inf[d.mouthSmileLeft] = exprBlend * 0.5;
          if (d.mouthSmileRight !== undefined) inf[d.mouthSmileRight] = exprBlend * 0.5;
          if (d.browInnerUp !== undefined) inf[d.browInnerUp] = exprBlend * 0.15;
          if (d.browOuterUpLeft !== undefined) inf[d.browOuterUpLeft] = exprBlend * 0.12;
          if (d.browOuterUpRight !== undefined) inf[d.browOuterUpRight] = exprBlend * 0.12;
        } else if (gesture === "Open_Palm") {
          if (d.mouthSmileLeft !== undefined) inf[d.mouthSmileLeft] = exprBlend * 0.4;
          if (d.mouthSmileRight !== undefined) inf[d.mouthSmileRight] = exprBlend * 0.4;
          if (d.browOuterUpLeft !== undefined) inf[d.browOuterUpLeft] = exprBlend * 0.1;
          if (d.browOuterUpRight !== undefined) inf[d.browOuterUpRight] = exprBlend * 0.1;
        } else if (gesture === "Victory" || gesture === "ILoveYou") {
          if (d.mouthSmileLeft !== undefined) inf[d.mouthSmileLeft] = exprBlend * 0.45;
          if (d.mouthSmileRight !== undefined) inf[d.mouthSmileRight] = exprBlend * 0.45;
          if (d.browInnerUp !== undefined) inf[d.browInnerUp] = exprBlend * 0.1;
        } else if (gesture === "Thumb_Down") {
          if (d.mouthSmileLeft !== undefined) inf[d.mouthSmileLeft] = 0;
          if (d.mouthSmileRight !== undefined) inf[d.mouthSmileRight] = 0;
          if (d.browInnerUp !== undefined) inf[d.browInnerUp] = exprBlend * 0.2;
          if (d.mouthFrownLeft !== undefined) inf[d.mouthFrownLeft] = exprBlend * 0.15;
          if (d.mouthFrownRight !== undefined) inf[d.mouthFrownRight] = exprBlend * 0.15;
        } else if (gesture === "Namaste") {
          if (d.mouthSmileLeft !== undefined) inf[d.mouthSmileLeft] = exprBlend * 0.35;
          if (d.mouthSmileRight !== undefined) inf[d.mouthSmileRight] = exprBlend * 0.35;
          if (d.browInnerUp !== undefined) inf[d.browInnerUp] = exprBlend * 0.12;
          if (d.cheekSquintLeft !== undefined) inf[d.cheekSquintLeft] = exprBlend * 0.15;
          if (d.cheekSquintRight !== undefined) inf[d.cheekSquintRight] = exprBlend * 0.15;
        } else if (gesture === "Photo_Pose") {
          if (d.mouthSmileLeft !== undefined) inf[d.mouthSmileLeft] = exprBlend * 0.6;
          if (d.mouthSmileRight !== undefined) inf[d.mouthSmileRight] = exprBlend * 0.6;
          if (d.cheekSquintLeft !== undefined) inf[d.cheekSquintLeft] = exprBlend * 0.3;
          if (d.cheekSquintRight !== undefined) inf[d.cheekSquintRight] = exprBlend * 0.3;
          if (d.browOuterUpLeft !== undefined) inf[d.browOuterUpLeft] = exprBlend * 0.12;
          if (d.browOuterUpRight !== undefined) inf[d.browOuterUpRight] = exprBlend * 0.12;
        }
      });
    }

    // ── Emote bone blending ──
    // The built-in idle animation runs via the mixer. Emote gestures
    // crossfade in/out using AnimationAction weight, handled by the mixer.
    // Just update the mixer each frame.
    if (mixer.current) {
      mixer.current.update(dt);
    }

    // ── Lock Hips position to prevent root-motion drift from any animation ──
    if (hipsBone.current && hipsOrigPos.current) {
      hipsBone.current.position.copy(hipsOrigPos.current);
    }

    // ── Bone-based lip sync + speech body motion ──
    // This model has NO morph targets, so all lip sync is bone-driven.
    // Applied AFTER mixer.update() so the mixer sets the base pose first,
    // then we add small additive deltas.
    if (isSpeaking && idleAction.current) {
      const v = Math.min(1, vol * 2.5);
      const jawOpen = lsTargets["jawOpen"] ?? 0;
      const vowelOpen = lsTargets["viseme_aa"] ?? 0;
      const jawAmount = Math.min(1, (jawOpen + vowelOpen) * 2.5);

      if (headBone.current) {
        // Jaw simulation: tilt head forward when "mouth opens" (no jaw bone)
        headBone.current.rotation.x += jawAmount * 0.06;
        // Conversational head nod + tilt synced to speech rhythm
        headBone.current.rotation.x += Math.sin(t * 2.0) * 0.015 * (0.3 + v);
        headBone.current.rotation.y += Math.sin(t * 1.3 + 0.5) * 0.02 * (0.3 + v);
        headBone.current.rotation.z += Math.sin(t * 0.9 + 1.0) * 0.008 * v;
      }
      // Neck: counter-rotate slightly against jaw for realism
      const neck = allBones.current["neck"];
      if (neck) {
        neck.rotation.x += jawAmount * -0.02;
        neck.rotation.x += Math.sin(t * 1.5 + 0.3) * 0.01 * (0.3 + v);
        neck.rotation.y += Math.sin(t * 1.0 + 1.2) * 0.012 * (0.3 + v);
      }
      // Spine02 (upper torso) sway for conversational emphasis
      const spine02 = allBones.current["Spine02"];
      if (spine02) {
        spine02.rotation.x += Math.sin(t * 0.8 + 0.7) * 0.008 * (0.2 + v * 0.3);
        spine02.rotation.y += Math.sin(t * 0.6 + 2.0) * 0.01 * (0.2 + v * 0.3);
      }
      // Shoulder micro-motion for breathing/emphasis
      const lShoulder = allBones.current["LeftShoulder"];
      const rShoulder = allBones.current["RightShoulder"];
      if (lShoulder) {
        lShoulder.rotation.z += Math.sin(t * 1.8 + 0.5) * 0.006 * v;
      }
      if (rShoulder) {
        rShoulder.rotation.z += Math.sin(t * 1.8 + 1.5) * 0.006 * v;
      }
    } else if (idleAction.current) {
      // Idle breathing: subtle spine/shoulder motion even when not speaking
      const spine02 = allBones.current["Spine02"];
      if (spine02) {
        spine02.rotation.x += Math.sin(t * 0.4) * 0.003;
      }
      if (headBone.current) {
        headBone.current.rotation.x += Math.sin(t * 0.3 + 0.5) * 0.002;
        headBone.current.rotation.y += Math.sin(t * 0.2 + 1.0) * 0.003;
      }
    }
  });

  // Position model: auto-computed Y offset, rotate 180° to face camera (model faces -Z)
  return <primitive object={scene} position={[0, modelYOffset, 0]} rotation={[0, Math.PI, 0]} />;
}

/* ── Loading placeholder ── */
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
      <span style={{ fontSize: 13, color: "var(--text-3)" }}>Loading avatar…</span>
    </div>
  );
}

/* ── Fallback orb if FBX fails ── */
function FallbackOrb({ isSpeaking }: { isSpeaking: boolean }) {
  return (
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
  );
}

/* ── Public component ── */
export interface Avatar3DProps {
  isSpeaking: boolean;
  getAudioData?: () => Uint8Array | undefined;
  getVolume?: () => number;
  gesture?: string | null;
  userSmile?: number;
}

export default function Avatar3D({ isSpeaking, getAudioData, getVolume, gesture, userSmile }: Avatar3DProps) {
  // Stable refs so we don't re-render the Canvas when callbacks change
  const audioDataRef = useRef(getAudioData);
  const volumeRef = useRef(getVolume);
  const gestureRef = useRef<GestureName>(null);
  const userSmileRef = useRef(0);
  audioDataRef.current = getAudioData;
  volumeRef.current = getVolume;
  gestureRef.current = (gesture as GestureName) ?? null;
  userSmileRef.current = userSmile ?? 0;

  return (
    <AvatarErrorBoundary fallback={<FallbackOrb isSpeaking={isSpeaking} />}>
      <Suspense fallback={<Loader />}>
        <div style={{ width: "100%", height: "100%", overflow: "hidden" }}>
          <Canvas
            camera={{ position: [0, 0.5, 5], fov: 30 }}
            gl={{ alpha: true, antialias: true }}
            dpr={[1, 2]}
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
            <AvatarModel isSpeaking={isSpeaking} audioDataRef={audioDataRef} volumeRef={volumeRef} gestureRef={gestureRef} userSmileRef={userSmileRef} />
          </Canvas>
        </div>
      </Suspense>
    </AvatarErrorBoundary>
  );
}

