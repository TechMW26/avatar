"use client";

import { useRef, useEffect, Suspense, Component, ReactNode, MutableRefObject } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { Lipsync, VISEMES } from "wawa-lipsync";

const AVATAR_URL = "/avatar.glb";

// FBX2glTF numbers blendshapes as plain integers "0".."14" (sometimes
// "m0".."m14"); remap to the viseme names the lipsync code targets. Order
// is taken from the source FBX morph list.
const MORPH_NAME_REMAP: Record<string, string> = {
  "0": "viseme_sil",
  "1": "viseme_PP",
  "2": "viseme_FF",
  "3": "viseme_TH",
  "4": "viseme_DD",
  "5": "viseme_kk",
  "6": "viseme_CH",
  "7": "viseme_SS",
  "8": "viseme_nn",
  "9": "viseme_RR",
  "10": "viseme_aa",
  "11": "viseme_E",
  "12": "viseme_I",
  "13": "viseme_O",
  "14": "viseme_U",
  m0: "viseme_sil",
  m1: "viseme_PP",
  m2: "viseme_FF",
  m3: "viseme_TH",
  m4: "viseme_DD",
  m5: "viseme_kk",
  m6: "viseme_CH",
  m7: "viseme_SS",
  m8: "viseme_nn",
  m9: "viseme_RR",
  m10: "viseme_aa",
  m11: "viseme_E",
  m12: "viseme_I",
  m13: "viseme_O",
  m14: "viseme_U",
};

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
  private current: Record<string, number>;
  private wawa: Lipsync;
  private wawaReady = false;
  private vowelCycleIdx = 0;
  private vowelCycleTimer = 0;
  private prevVolume = 0;
  private static VOWEL_CYCLE: string[] = [
    VISEMES.aa,
    VISEMES.O,
    VISEMES.E,
    VISEMES.aa,
    VISEMES.U,
    VISEMES.I,
    VISEMES.O,
    VISEMES.aa,
  ];

  constructor() {
    this.current = {};
    for (const v of Object.values(VISEMES)) this.current[v] = 0;
    this.current["jawOpen"] = 0;
    // wawa-lipsync uses its own AudioContext just for the analyser node; we
    // bypass the internal audio routing and feed it byte-frequency data
    // captured by the ElevenLabs SDK each frame.
    try {
      this.wawa = new Lipsync({ fftSize: 2048, historySize: 10 });
      this.wawaReady = true;
    } catch (e) {
      console.warn("[Avatar] wawa-lipsync init failed:", e);
      this.wawa = null as unknown as Lipsync;
    }
  }

  update(
    freqData: Uint8Array | undefined | null,
    volume: number,
    speaking: boolean,
  ): Record<string, number> {
    const result: Record<string, number> = {};

    // ── Not speaking: gentle decay ──
    if (!speaking || !freqData || freqData.length < 16 || !this.wawaReady) {
      for (const k of Object.keys(this.current)) {
        this.current[k] *= 0.55;
        if (this.current[k] < 0.002) this.current[k] = 0;
        result[k] = this.current[k];
      }
      return result;
    }

    // Push the externally-captured spectrum into wawa-lipsync's internal
    // dataArray, then bypass its analyser by overriding getByteFrequencyData.
    const w = this.wawa as unknown as {
      dataArray: Uint8Array;
      analyser: AnalyserNode;
      processAudio: () => void;
      viseme: string;
    };
    const len = Math.min(w.dataArray.length, freqData.length);
    for (let i = 0; i < len; i++) w.dataArray[i] = freqData[i];
    // Stub the analyser fetch; data is already populated.
    w.analyser.getByteFrequencyData = (buf: Uint8Array) => {
      const n = Math.min(buf.length, w.dataArray.length);
      for (let i = 0; i < n; i++) buf[i] = w.dataArray[i];
    };
    w.processAudio();

    // Compute audio amplitude from RMS of the spectrum (more reliable than
    // the SDK's volume which can hover near zero for soft TTS).
    let sumSq = 0;
    const lo = Math.max(1, Math.floor(len * 0.005));
    const hi = Math.min(len - 1, Math.floor(len * 0.18));
    for (let i = lo; i <= hi; i++) {
      const v = freqData[i] / 255;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, hi - lo + 1));
    const volEst = Math.max(volume, rms * 1.4);
    const amplitude = Math.min(1, volEst * 1.8);

    // Advance vowel cycle when speaking; rate scales with audio energy.
    const transient = Math.max(0, rms - this.prevVolume);
    this.prevVolume = rms;
    this.vowelCycleTimer += 0.06 + amplitude * 0.10 + transient * 1.2;
    if (this.vowelCycleTimer >= 1.0) {
      this.vowelCycleTimer = 0;
      this.vowelCycleIdx = (this.vowelCycleIdx + 1) % AudioLipSync.VOWEL_CYCLE.length;
    }

    let dominant = w.viseme || VISEMES.sil;
    // wawa returns sil whenever band energies fall below its threshold; if
    // we still have audible speech, fall back to a cycling vowel so the
    // mouth keeps moving instead of staying closed.
    if ((dominant === VISEMES.sil) && amplitude > 0.05) {
      dominant = AudioLipSync.VOWEL_CYCLE[this.vowelCycleIdx];
    }

    // Amplify so morphs reach visible range. The TTS volume hovers
    // around 0.05-0.2, which produced barely-perceptible mouth motion.
    // Use a strong floor when speech is detected so the mouth always opens.
    const speakBoost = 0.55 + amplitude * 1.6; // 0.55 .. ~1.0
    const visemeStrength = Math.min(1, speakBoost);
    const jawStrength = Math.min(1, 0.4 + amplitude * 1.8);

    for (const k of Object.keys(this.current)) {
      let target = 0;
      if (k !== VISEMES.sil && k === dominant) {
        target = visemeStrength;
      } else if (k === "jawOpen") {
        if (
          dominant === VISEMES.aa ||
          dominant === VISEMES.E ||
          dominant === VISEMES.I ||
          dominant === VISEMES.O ||
          dominant === VISEMES.U
        ) {
          target = jawStrength;
        } else {
          // Even on consonants, crack the jaw a touch so the mouth isn't
          // glued shut between vowels.
          target = jawStrength * 0.35;
        }
      }
      const prev = this.current[k];
      const a = target > prev ? 0.55 : 0.28;
      this.current[k] = prev + (target - prev) * a;
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

type ConcreteGestureName = Exclude<GestureName, null>;
type BoneAxisOffset = Partial<Record<"x" | "y" | "z", number>>;
type BonePose = Partial<Record<string, BoneAxisOffset>>;
type RelaxedAimBoneName = "LeftShoulder" | "RightShoulder" | "LeftArm" | "RightArm" | "LeftForeArm" | "RightForeArm";
type RelaxedAimSpec = {
  direction: THREE.Vector3;
  influence: number;
};

const GESTURE_BLEND_IN = 0.22;
const GESTURE_BLEND_OUT = 0.32;

// Reuse scratch objects so per-frame posing stays allocation-free.
const poseEuler = new THREE.Euler();
const poseQuat = new THREE.Quaternion();
const poseVec = new THREE.Vector3();
const poseVec2 = new THREE.Vector3();
const poseQuat2 = new THREE.Quaternion();
const slerpQuat = new THREE.Quaternion();
const aimChildWorld = new THREE.Vector3();
const aimBoneWorld = new THREE.Vector3();
const aimCurrentDir = new THREE.Vector3();
const aimTargetDir = new THREE.Vector3();
const aimDeltaQuat = new THREE.Quaternion();
const aimCurrentWorldQuat = new THREE.Quaternion();
const aimParentWorldQuat = new THREE.Quaternion();
const aimTargetWorldQuat = new THREE.Quaternion();

// Bring the arms down from T/A-pose to a relaxed hang. Both arm bones
// share the same parent (Spine02) so a local Z rotation rotates them in
// the same world direction — to mirror, we use OPPOSITE-SIGN Z values.
// The forearm Y roll IS mirrored by same-sign because the bind-pose
// forearm Y is already negated between sides.
const RELAXED_BODY_POSE: BonePose = {
  Spine: { x: 0.03 },
  Spine01: { x: 0.04 },
  Spine02: { x: 0.02 },
  LeftArm: { z: 0.55 },
  RightArm: { z: -0.65 },
};

// Roll the forearms around their long axis so the palms face inward
// toward the thighs. Same-sign delta on both sides produces a mirrored
// roll because the bind-pose forearm Y rotations are already negated
// between left and right (Mixamo-style mirror).
const RELAXED_HAND_POSE: BonePose = {
  LeftForeArm: { y: 0.6 },
  RightForeArm: { y: 0.6 },
};

const GESTURE_BODY_POSES: Partial<Record<ConcreteGestureName, BonePose>> = {
  Open_Palm: {
    Spine01: { y: 0.025 },
    Spine02: { y: 0.035 },
  },
  Thumb_Up: {
    Spine01: { y: 0.02 },
    Spine02: { x: 0.015, y: 0.03 },
  },
  Thumb_Down: {
    Spine01: { y: -0.02 },
    Spine02: { x: -0.015, y: -0.03 },
  },
  Victory: {
    Spine01: { y: 0.03 },
    Spine02: { x: 0.01 },
  },
  ILoveYou: {
    Spine01: { y: 0.025 },
    Spine02: { x: 0.02, y: 0.02 },
  },
  Closed_Fist: {
    Spine01: { x: 0.015 },
    Spine02: { x: 0.02 },
  },
  Pointing_Up: {
    Spine01: { y: 0.035 },
    Spine02: { x: 0.015, y: 0.04 },
  },
  Namaste: {
    Spine01: { x: 0.02 },
    Spine02: { x: 0.03 },
  },
  Photo_Pose: {
    Spine01: { y: 0.015 },
    Spine02: { x: 0.01, y: 0.015 },
  },
};

const ARM_CHAIN_BONE_NAMES = [
  "LeftShoulder",
  "LeftArm",
  "LeftForeArm",
  "LeftHand",
  "RightShoulder",
  "RightArm",
  "RightForeArm",
  "RightHand",
] as const;

// Per-frame WORLD-SPACE arm chain aim. Each frame, after the base pose is
// applied, we rotate each bone so its child points in the desired world
// direction. Because we recompute against the parent's *already-rotated*
// world matrix, chaining shoulder → arm → forearm does not compound and
// fold. This is bind-pose-agnostic and adapts to the model's local axes.
type WorldAimSpec = { childBone: string; worldDir: THREE.Vector3 };
// World-space arm chain aim has been removed. The Mixamo-style rig has
// a perfectly mirrored bind-pose, so simple symmetric local-Euler
// offsets in RELAXED_BODY_POSE / RELAXED_HAND_POSE drive both arms
// without any runtime aim or mirror logic — which avoids the elbow
// deformation that aiming the upper arm at a world direction caused.
const ARM_CHAIN_WORLD_AIMS: Array<{ name: RelaxedAimBoneName } & WorldAimSpec> = [];

// Kept for type compatibility with the rest of the file; populated empty
// because the chain is now driven by ARM_CHAIN_WORLD_AIMS at runtime.
const RELAXED_ARM_AIMS: Record<RelaxedAimBoneName, RelaxedAimSpec> = {} as Record<RelaxedAimBoneName, RelaxedAimSpec>;

const DRIVEN_BONE_NAMES = Array.from(
  new Set([
    "Head",
    "neck",
    ...ARM_CHAIN_BONE_NAMES,
    ...Object.keys(RELAXED_HAND_POSE),
    ...Object.keys(RELAXED_BODY_POSE),
    ...Object.values(GESTURE_BODY_POSES).flatMap((pose) => (pose ? Object.keys(pose) : [])),
  ]),
);

function addBoneOffset(
  target: Record<string, BoneAxisOffset>,
  boneName: string,
  axis: keyof BoneAxisOffset,
  amount: number,
) {
  if (amount === 0) {
    return;
  }
  const entry = target[boneName] ?? (target[boneName] = {});
  entry[axis] = (entry[axis] ?? 0) + amount;
}

function mergeBonePose(
  target: Record<string, BoneAxisOffset>,
  pose: BonePose | undefined,
  weight = 1,
) {
  if (!pose || weight <= 0) {
    return;
  }
  Object.entries(pose).forEach(([boneName, axes]) => {
    if (!axes) {
      return;
    }
    if (axes.x !== undefined) {
      addBoneOffset(target, boneName, "x", axes.x * weight);
    }
    if (axes.y !== undefined) {
      addBoneOffset(target, boneName, "y", axes.y * weight);
    }
    if (axes.z !== undefined) {
      addBoneOffset(target, boneName, "z", axes.z * weight);
    }
  });
}

function applyBoneOffsetFromRest(
  bone: THREE.Bone,
  restQuat: THREE.Quaternion,
  offset: BoneAxisOffset | undefined,
) {
  bone.quaternion.copy(restQuat);
  if (!offset) {
    return;
  }
  poseEuler.set(offset.x ?? 0, offset.y ?? 0, offset.z ?? 0, "XYZ");
  poseQuat.setFromEuler(poseEuler);
  bone.quaternion.multiply(poseQuat);
}

function findFirstBoneChild(bone: THREE.Bone): THREE.Bone | null {
  for (const child of bone.children) {
    if ((child as THREE.Bone).isBone) {
      return child as THREE.Bone;
    }
  }
  return null;
}

function createAimPoseQuaternion(
  bone: THREE.Bone,
  restQuat: THREE.Quaternion,
  targetDirectionInParentSpace: THREE.Vector3,
): THREE.Quaternion | null {
  const childBone = findFirstBoneChild(bone);
  if (!childBone || childBone.position.lengthSq() < 1e-6) {
    return null;
  }

  const sourceDirLocal = poseVec.copy(childBone.position).normalize();
  const targetDirLocal = poseVec2
    .copy(targetDirectionInParentSpace)
    .normalize()
    .applyQuaternion(poseQuat2.copy(restQuat).invert())
    .normalize();

  if (sourceDirLocal.lengthSq() < 1e-6 || targetDirLocal.lengthSq() < 1e-6) {
    return null;
  }

  const delta = new THREE.Quaternion().setFromUnitVectors(sourceDirLocal, targetDirLocal);
  return restQuat.clone().multiply(delta);
}

/**
 * Gestures are applied as curated local-bone offsets from this model's own
 * bind pose. This is less flashy than cross-skeleton retargeting, but it is
 * stable and avoids the body deformation seen with foreign mocap clips.
 */

// How long to keep gesture active after last MediaPipe detection (seconds)
const GESTURE_HOLD_TIME = 1.5;

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
  const gltf = useGLTF(AVATAR_URL);
  const fbx = gltf;
  const scene = gltf.scene;
  const morphMeshes = useRef<THREE.Mesh[]>([]);
  const lipSync = useRef(new AudioLipSync());
  // Rest-pose quaternions for all driven bones.
  const boneRestQuats = useRef<Record<string, THREE.Quaternion>>({});
  const aimedBoneTargets = useRef<Partial<Record<RelaxedAimBoneName, THREE.Quaternion>>>({});

  // ── Gesture pose system ──
  const gesturePoseBlend = useRef(0);
  const activeGesture = useRef<GestureName>(null);
  // Gesture hold: keep gesture active for GESTURE_HOLD_TIME after last detection
  const gestureHoldName = useRef<GestureName>(null);
  const gestureLastSeen = useRef(0);
  // Smoothed gesture expression blend for face
  const gestureExprBlend = useRef(0);
  // Manual delta time tracking (clock.getDelta() is unreliable with getElapsedTime())
  const lastFrameTime = useRef(0);
  // Smoothed audio envelope (slow attack, slower release) used to drive
  // visible head nods during speech since the model has no jaw bone and
  // the bushy beard occludes mouth morph deformation.
  const speechEnv = useRef(0);
  const speechPulse = useRef(0);
  const speechPulseDecay = useRef(0);
  // All bones by name for procedural posing.
  const allBones = useRef<Record<string, THREE.Bone>>({});

  useEffect(() => {
    const meshes: THREE.Mesh[] = [];
    allBones.current = {};
    boneRestQuats.current = {};
    aimedBoneTargets.current = {};

    // Load the base color texture extracted from the source FBX (FBX2glTF
    // can't embed it because the lipsync FBX strips images).
    const texLoader = new THREE.TextureLoader();
    const baseColorTex = texLoader.load("/avatar-base.png");
    baseColorTex.colorSpace = THREE.SRGBColorSpace;
    baseColorTex.flipY = false; // glTF convention
    baseColorTex.anisotropy = 16;
    baseColorTex.wrapS = THREE.RepeatWrapping;
    baseColorTex.wrapT = THREE.RepeatWrapping;

    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
          const skinnedMesh = mesh as THREE.SkinnedMesh;
          skinnedMesh.normalizeSkinWeights();
        }
        // Enhance skin textures
        if (mesh.material) {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          mats.forEach((mat) => {
            const m = mat as THREE.MeshStandardMaterial;
            // FBX2glTF emits a 1x1 stub for baseColorTexture because it can't
            // find the embedded image. Replace it with the real texture we
            // extracted from the source FBX.
            const mapImg = m.map?.image as { width?: number } | undefined;
            const stubMap = !!m.map && !!mapImg && (mapImg.width ?? 0) <= 4;
            if (!m.map || stubMap) {
              if (m.map) m.map.dispose?.();
              m.map = baseColorTex;
              m.color = new THREE.Color(0xffffff);
            }
            // Kill the all-white emissive that bakes from FBX Phong shading model.
            if (m.emissiveMap) {
              m.emissiveMap.dispose?.();
              m.emissiveMap = null;
            }
            m.emissive = new THREE.Color(0x000000);
            // Drop any stub normalMap (1×1 placeholder from FBX2glTF) which
            // triggers "Texture marked for update but no image data found".
            const normalImg = m.normalMap?.image as { width?: number } | undefined;
            if (m.normalMap && normalImg && (normalImg.width ?? 0) <= 4) {
              m.normalMap.dispose?.();
              m.normalMap = null;
            }
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
          // Re-key morphTargetDictionary so the lipsync code can find
          // viseme_aa, viseme_O, etc. by name (FBX2glTF strips target names).
          const oldDict = mesh.morphTargetDictionary;
          const newDict: Record<string, number> = {};
          for (const [key, idx] of Object.entries(oldDict)) {
            const remapped = MORPH_NAME_REMAP[key] ?? key;
            newDict[remapped] = idx as number;
          }
          mesh.morphTargetDictionary = newDict;
          // GLB defaults all viseme weights to 1 (mouth wide open in every
          // shape simultaneously); reset to 0 so lipsync controls them.
          for (let i = 0; i < mesh.morphTargetInfluences.length; i++) {
            mesh.morphTargetInfluences[i] = 0;
          }
          console.log('[Avatar] morph dict remapped:', Object.keys(newDict));
          meshes.push(mesh);
        }
      }
      if ((obj as THREE.Bone).isBone) {
        allBones.current[obj.name] = obj as THREE.Bone;
        boneRestQuats.current[obj.name] = (obj as THREE.Bone).quaternion.clone();
      }
    });
    morphMeshes.current = meshes;

    // ── Fixed scale + position ──
    // The model is ~170 units tall (cm). FBXLoader may or may not apply unit conversion.
    // Reset transforms first so React Strict Mode re-runs measure raw model.
    scene.position.set(0, 0, 0);
    scene.scale.set(1, 1, 1);
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene);
    const modelHeight = box.max.y - box.min.y;
    console.log("[Avatar] FBX raw bounding box:", {
      min: [box.min.x.toFixed(2), box.min.y.toFixed(2), box.min.z.toFixed(2)],
      max: [box.max.x.toFixed(2), box.max.y.toFixed(2), box.max.z.toFixed(2)],
      height: modelHeight.toFixed(2),
      bones: Object.keys(allBones.current).join(", "),
      animations: (fbx.animations || []).map(a => a.name),
    });

    // Force the model to be a little shorter than full viewport height so
    // conversational head motion and hair stay inside frame.
    const desiredHeight = 2.6;
    if (modelHeight > 0.001) {
      const s = desiredHeight / modelHeight;
      scene.scale.set(s, s, s);
      console.log("[Avatar] Applied scale:", s.toFixed(6), "modelHeight:", modelHeight.toFixed(2));
    } else {
      // Fallback: assume 170cm model that FBXLoader didn't scale
      scene.scale.set(0.0106, 0.0106, 0.0106);
      console.log("[Avatar] Fallback scale applied (model height was 0)");
    }

    // Recompute after scaling and center the avatar in frame.
    scene.updateMatrixWorld(true);
    const scaledBox = new THREE.Box3().setFromObject(scene);
    const scaledCenter = new THREE.Vector3();
    scaledBox.getCenter(scaledCenter);
    const framingBiasY = 0;
    const xOffset = -scaledCenter.x;
    const yOffset = -scaledCenter.y + framingBiasY;
    const zOffset = -scaledCenter.z;
    console.log("[Avatar] After scale:", {
      centerX: scaledCenter.x.toFixed(3),
      min: scaledBox.min.y.toFixed(3),
      max: scaledBox.max.y.toFixed(3),
      center: scaledCenter.y.toFixed(3),
      xOffset: xOffset.toFixed(3),
      yOffset: yOffset.toFixed(3),
      zOffset: zOffset.toFixed(3),
    });
    scene.position.set(xOffset, yOffset, zOffset);
    // Expose for live tuning from devtools.
    (window as unknown as { __sage?: unknown }).__sage = { scene, scaledBox, scaledCenter, modelHeight };
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

    const curGesture = gestureRef.current;
    // Manual delta: clock.getDelta() is unreliable when getElapsedTime() is also used
    const now = t;
    const dt = lastFrameTime.current > 0 ? Math.min(now - lastFrameTime.current, 0.05) : 0.016;
    lastFrameTime.current = now;

    // Sticky gesture: hold detected gesture active for GESTURE_HOLD_TIME
    if (curGesture) {
      gestureHoldName.current = curGesture;
      gestureLastSeen.current = now;
    }
    const heldGesture = gestureHoldName.current;
    const gestureFresh = heldGesture && (now - gestureLastSeen.current) < GESTURE_HOLD_TIME;

    if (gestureFresh && heldGesture) {
      if (activeGesture.current !== heldGesture) {
        activeGesture.current = heldGesture;
      }
      gesturePoseBlend.current = Math.min(1, gesturePoseBlend.current + dt / GESTURE_BLEND_IN);
      gestureExprBlend.current = Math.min(1, gestureExprBlend.current + dt / (GESTURE_BLEND_IN * 1.2));
    } else {
      gesturePoseBlend.current = Math.max(0, gesturePoseBlend.current - dt / GESTURE_BLEND_OUT);
      gestureExprBlend.current = Math.max(0, gestureExprBlend.current - dt / (GESTURE_BLEND_OUT * 1.5));
      if (gesturePoseBlend.current <= 0.001) {
        activeGesture.current = null;
        gestureHoldName.current = null;
      }
    }

    const gesture = activeGesture.current;
    const gestureBlend = gesturePoseBlend.current;
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

    // ── Stable procedural body posing ──
    // Every driven bone is rebuilt from its original bind-pose quaternion each
    // frame. That prevents the additive drift that was deforming the body.
    const poseOffsets: Record<string, BoneAxisOffset> = {};
    mergeBonePose(poseOffsets, RELAXED_BODY_POSE, 1);
    mergeBonePose(poseOffsets, RELAXED_HAND_POSE, 1);
    if (gesture && gestureBlend > 0.001) {
      mergeBonePose(poseOffsets, GESTURE_BODY_POSES[gesture as ConcreteGestureName], gestureBlend);
    }

    const neck = allBones.current["neck"];

    if (isSpeaking) {
      const rawV = Math.min(1, vol * 2.5);
      const jawOpen = lsTargets["jawOpen"] ?? 0;
      const vowelOpen = lsTargets["viseme_aa"] ?? 0;
      const jawAmount = Math.min(1, (jawOpen + vowelOpen) * 1.5);

      // Smoothed envelope: fast attack, slow release. Each loud syllable
      // pumps the envelope up; quiet gaps let it fall. Drives a visible
      // amplitude-reactive head nod — the universal "I'm talking" cue
      // when the mouth itself is hidden under the beard.
      const drive = Math.max(rawV, jawAmount * 0.8);
      if (drive > speechEnv.current) {
        speechEnv.current += (drive - speechEnv.current) * 0.45; // attack
      } else {
        speechEnv.current += (drive - speechEnv.current) * 0.08; // release
      }
      // Per-syllable pulse: rising edge of the envelope triggers a nod.
      const env = speechEnv.current;
      if (drive > 0.35 && drive > speechPulse.current * 0.95) {
        speechPulse.current = drive;
        speechPulseDecay.current = 1;
      } else {
        speechPulseDecay.current *= 0.88;
      }
      const pulse = speechPulse.current * speechPulseDecay.current;

      // Big amplitude-driven head nod (down on loud syllables) +
      // continuous gentle sway so the beard wags even between syllables.
      const nodDown = env * 0.18 + pulse * 0.10;
      addBoneOffset(poseOffsets, "Head", "x", nodDown);
      addBoneOffset(poseOffsets, "Head", "x", Math.sin(t * 6.0) * 0.035 * (0.4 + env));
      addBoneOffset(poseOffsets, "Head", "y", Math.sin(t * 1.3 + 0.5) * 0.05 * (0.3 + env));
      addBoneOffset(poseOffsets, "Head", "z", Math.sin(t * 0.9 + 1.0) * 0.025 * env);
      if (neck) {
        addBoneOffset(poseOffsets, "neck", "x", nodDown * -0.35);
        addBoneOffset(poseOffsets, "neck", "x", Math.sin(t * 6.0 + 0.4) * 0.02 * (0.4 + env));
        addBoneOffset(poseOffsets, "neck", "y", Math.sin(t * 1.0 + 1.2) * 0.025 * (0.3 + env));
      }
      addBoneOffset(poseOffsets, "Spine02", "x", nodDown * -0.12);
      addBoneOffset(poseOffsets, "Spine02", "x", Math.sin(t * 0.8 + 0.7) * 0.014 * (0.2 + env * 0.4));
      addBoneOffset(poseOffsets, "Spine02", "y", Math.sin(t * 0.6 + 2.0) * 0.016 * (0.2 + env * 0.4));
      addBoneOffset(poseOffsets, "LeftShoulder", "z", Math.sin(t * 1.8 + 0.5) * 0.008 * env);
      addBoneOffset(poseOffsets, "RightShoulder", "z", Math.sin(t * 1.8 + 1.5) * 0.008 * env);
    } else {
      // Decay speech envelope when not speaking.
      speechEnv.current *= 0.85;
      speechPulseDecay.current *= 0.85;
      addBoneOffset(poseOffsets, "Head", "x", Math.sin(t * 0.3 + 0.5) * 0.002);
      addBoneOffset(poseOffsets, "Head", "y", Math.sin(t * 0.2 + 1.0) * 0.003);
      if (neck) {
        addBoneOffset(poseOffsets, "neck", "x", Math.sin(t * 0.25) * 0.002);
      }
      addBoneOffset(poseOffsets, "Spine02", "x", Math.sin(t * 0.4) * 0.003);
    }

    if (gesture && gestureBlend > 0.001) {
      addBoneOffset(poseOffsets, "Spine01", "y", Math.sin(t * 1.6) * 0.01 * gestureBlend);
    }

    DRIVEN_BONE_NAMES.forEach((boneName) => {
      const bone = allBones.current[boneName];
      const restQuat = boneRestQuats.current[boneName];
      if (!bone || !restQuat) {
        return;
      }
      applyBoneOffsetFromRest(bone, restQuat, poseOffsets[boneName]);
    });

    // ── World-space arm chain aim ──
    // Recompute each bone's local rotation against its parent's *current*
    // world matrix so the chain does not fold. Order matters: parent first,
    // child after, with updateMatrixWorld between them.
    for (const aim of ARM_CHAIN_WORLD_AIMS) {
      const bone = allBones.current[aim.name];
      const childBone = allBones.current[aim.childBone];
      if (!bone || !childBone || !bone.parent) continue;

      bone.parent.updateMatrixWorld(true);
      bone.updateMatrixWorld(true);
      childBone.updateMatrixWorld(true);

      bone.getWorldPosition(aimBoneWorld);
      childBone.getWorldPosition(aimChildWorld);
      aimCurrentDir.copy(aimChildWorld).sub(aimBoneWorld);
      if (aimCurrentDir.lengthSq() < 1e-8) continue;
      aimCurrentDir.normalize();
      aimTargetDir.copy(aim.worldDir).normalize();

      aimDeltaQuat.setFromUnitVectors(aimCurrentDir, aimTargetDir);
      bone.getWorldQuaternion(aimCurrentWorldQuat);
      aimTargetWorldQuat.copy(aimDeltaQuat).multiply(aimCurrentWorldQuat);
      bone.parent.getWorldQuaternion(aimParentWorldQuat).invert();
      bone.quaternion.copy(aimParentWorldQuat).multiply(aimTargetWorldQuat);
      bone.updateMatrixWorld(true);
    }

  });

  // Position model via scene.position in the effect above.
  return <primitive object={scene} />;
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

  useEffect(() => {
    audioDataRef.current = getAudioData;
    volumeRef.current = getVolume;
    gestureRef.current = (gesture as GestureName) ?? null;
    userSmileRef.current = userSmile ?? 0;
  }, [getAudioData, getVolume, gesture, userSmile]);

  return (
    <AvatarErrorBoundary fallback={<FallbackOrb isSpeaking={isSpeaking} />}>
      <Suspense fallback={<Loader />}>
        <div style={{ width: "100%", height: "100%", overflow: "hidden" }}>
          <Canvas
            camera={{ position: [0, 0.05, 5.7], fov: 36 }}
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

