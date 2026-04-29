"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  FaceDetector,
  FaceLandmarker,
  GestureRecognizer,
  ObjectDetector,
  FilesetResolver,
  type FaceDetectorResult,
  type GestureRecognizerResult,
} from "@mediapipe/tasks-vision";

/* ── Gesture name mapping for natural language ── */
const GESTURE_LABELS: Record<string, string> = {
  Open_Palm: "waving hello",
  Closed_Fist: "making a fist",
  Pointing_Up: "pointing up",
  Thumb_Up: "giving a thumbs up",
  Thumb_Down: "giving a thumbs down",
  Victory: "making a peace sign",
  ILoveYou: "making an I-love-you sign",
  Namaste: "doing namaste",
  Photo_Pose: "taking a photo",
};

export interface GestureInfo {
  name: string;
  label: string;
  confidence: number;
  timestamp: number;
}

export interface VisionState {
  /** Whether at least one face is currently detected */
  faceDetected: boolean;
  /** How long a face has been continuously present (ms) */
  facePresenceDurationMs: number;
  /** Number of faces currently visible */
  faceCount: number;
  /** Currently detected gestures (this frame) */
  currentGestures: GestureInfo[];
  /** Recent gesture history (last 30 seconds, deduplicated) */
  gestureHistory: GestureInfo[];
  /** User smile intensity (0-1, from face landmarks) */
  userSmile: number;
  /** Whether a phone/cell phone is detected in the frame */
  phoneDetected: boolean;
  /** Detected gender of the user ("male" | "female" | "unknown") */
  userGender: "male" | "female" | "unknown";
  /** Ref to attach to a <video> element */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Whether MediaPipe models are loaded and camera is ready */
  isReady: boolean;
  /** Any error that occurred during setup */
  error: string | null;
  /** Imperatively stop camera, detection, and release all resources */
  cleanup: () => void;
}

const VISION_CDN =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm";
const GESTURE_HISTORY_TTL = 30_000; // keep gestures for 30s
const GESTURE_DEDUP_MS = 2_000; // don't re-add same gesture within 2s
const DETECTION_INTERVAL_MS = 100; // run detection every 100ms (~10fps detection)
const DETECTION_INTERVAL_MOBILE_MS = 120; // lighter cadence on phones
const FACE_UI_UPDATE_INTERVAL_MS = 120; // throttle React updates for counters
const SMILE_UI_UPDATE_INTERVAL_MS = 160;
const LANDMARK_INTERVAL_MS = 140;
const LANDMARK_INTERVAL_MOBILE_MS = 220;
const OBJECT_DETECT_INTERVAL_MS = 333;
const OBJECT_DETECT_INTERVAL_MOBILE_MS = 900;
const FACE_ACQUIRE_FRAMES = 2; // require 2 consecutive hits before face=true
const FACE_LOSS_FRAMES = 4; // require multiple misses before face=false
const FACE_LOSS_GRACE_MS = 700; // short grace window smooths mobile jitter

function dedupeFrameGestures(gestures: GestureInfo[]): GestureInfo[] {
  const byName = new Map<string, GestureInfo>();
  gestures.forEach((gesture) => {
    const existing = byName.get(gesture.name);
    if (!existing || gesture.confidence > existing.confidence) {
      byName.set(gesture.name, gesture);
    }
  });
  return Array.from(byName.values()).sort((left, right) => right.confidence - left.confidence);
}

export function useVisionDetection(options?: { enabled?: boolean }): VisionState {
  const enabled = options?.enabled ?? true;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const faceDetectorRef = useRef<FaceDetector | null>(null);
  const faceLandmarkerRef = useRef<FaceLandmarker | null>(null);
  const gestureRecognizerRef = useRef<GestureRecognizer | null>(null);
  const objectDetectorRef = useRef<ObjectDetector | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const lastDetectionTimeRef = useRef<number>(0);
  // Run heavy detectors (object detection) at a slower rate
  const lastHeavyDetectionRef = useRef<number>(0);

  // Face tracking
  const faceStartRef = useRef<number | null>(null);
  const [faceDetected, setFaceDetected] = useState(false);
  const [facePresenceDurationMs, setFacePresenceDurationMs] = useState(0);
  const [faceCount, setFaceCount] = useState(0);
  const stableFaceDetectedRef = useRef(false);
  const faceSeenStreakRef = useRef(0);
  const faceMissStreakRef = useRef(0);
  const lastFaceSeenAtRef = useRef(0);
  const lastVideoTimestampRef = useRef(0);
  const lastFaceUiUpdateAtRef = useRef(0);
  const lastSmileUiUpdateAtRef = useRef(0);
  const lastLandmarkDetectionRef = useRef(0);
  const isMobileRef = useRef(false);
  const lastGestureStateKeyRef = useRef("");

  // Smile tracking (from face landmarks)
  const [userSmile, setUserSmile] = useState(0);
  const smoothedSmileRef = useRef(0);

  // Phone detection
  const [phoneDetected, setPhoneDetected] = useState(false);

  // Gender detection (from face landmarks geometry)
  const [userGender, setUserGender] = useState<"male" | "female" | "unknown">("unknown");
  const genderVotesRef = useRef<number[]>([]); // history of votes: +1=male, -1=female
  const genderLockedRef = useRef(false); // once confident, lock the result

  // Gesture tracking
  const [currentGestures, setCurrentGestures] = useState<GestureInfo[]>([]);
  const gestureHistoryRef = useRef<GestureInfo[]>([]);
  const [gestureHistory, setGestureHistory] = useState<GestureInfo[]>([]);

  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialize MediaPipe models and camera
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    // Suppress noisy TensorFlow Lite INFO messages that MediaPipe logs via console.error
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].includes("Created TensorFlow Lite")) return;
      origError.apply(console, args);
    };

    async function init() {
      try {
        // 1) Warm camera and 2) load MediaPipe models concurrently so
        // startup doesn't pay both latencies serially on mobile.
        const streamTask = (async (): Promise<MediaStream> => {
          let stream: MediaStream | null = null;
          const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
          const isMobile = /android|iphone|ipad|ipod/i.test(ua);
          isMobileRef.current = isMobile;
          const constraints: MediaStreamConstraints[] = [
            {
              video: {
                facingMode: "user",
                width: { ideal: isMobile ? 640 : 960 },
                height: { ideal: isMobile ? 480 : 540 },
                frameRate: { ideal: 24, max: 30 },
              },
              audio: false,
            },
            {
              video: {
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 24, max: 30 },
              },
              audio: false,
            },
            { video: true, audio: false },
          ];

          for (const c of constraints) {
            try {
              stream = await navigator.mediaDevices.getUserMedia(c);
              break;
            } catch {
              // try next constraint set
            }
          }

          if (!stream) {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoDevice = devices.find((d) => d.kind === "videoinput");
            if (videoDevice) {
              stream = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { exact: videoDevice.deviceId } },
                audio: false,
              });
            }
          }

          if (!stream) {
            throw new Error("No camera found. Please connect a camera and grant permission.");
          }

          if (cancelled) {
            stream.getTracks().forEach((t) => t.stop());
            throw new Error("Vision init cancelled");
          }

          streamRef.current = stream;
          const video = videoRef.current;
          if (video) {
            video.srcObject = stream;
            video.setAttribute("playsinline", "true");
            video.muted = true;
            try {
              await video.play();
            } catch {
              await new Promise((r) => setTimeout(r, 300));
              await video.play().catch(() => {
                console.warn("Video play() failed — detection may not start until user interaction.");
              });
            }
          }
          return stream;
        })();

        const modelTask = (async () => {
          const vision = await FilesetResolver.forVisionTasks(VISION_CDN);
          if (cancelled) throw new Error("Vision init cancelled");

          async function createWithFallback<T>(
            factory: (v: typeof vision, delegate: "GPU" | "CPU") => Promise<T>,
          ): Promise<T> {
            try {
              return await factory(vision, "GPU");
            } catch {
              return await factory(vision, "CPU");
            }
          }

          const [faceDetector, gestureRecognizer] = await Promise.all([
            createWithFallback((v, d) =>
              FaceDetector.createFromOptions(v, {
                baseOptions: {
                  modelAssetPath:
                    "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
                  delegate: d,
                },
                runningMode: "VIDEO",
                minDetectionConfidence: 0.5,
              }),
            ),
            createWithFallback((v, d) =>
              GestureRecognizer.createFromOptions(v, {
                baseOptions: {
                  modelAssetPath:
                    "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
                  delegate: d,
                },
                runningMode: "VIDEO",
                numHands: 2,
                minHandDetectionConfidence: 0.3,
                minHandPresenceConfidence: 0.3,
                minTrackingConfidence: 0.3,
              }),
            ),
          ]);
          return { vision, createWithFallback, faceDetector, gestureRecognizer };
        })();

        const [stream, modelBundle] = await Promise.all([streamTask, modelTask]);
        const { vision, createWithFallback, faceDetector, gestureRecognizer } = modelBundle;

        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          faceDetector.close();
          gestureRecognizer.close();
          return;
        }

        faceDetectorRef.current = faceDetector;
        gestureRecognizerRef.current = gestureRecognizer;

        // ── Mark ready NOW so camera + face/gesture detection starts immediately ──
        setIsReady(true);

        // 5. Load FaceLandmarker + ObjectDetector lazily in background (optional, non-blocking)
        Promise.all([
          createWithFallback((v, d) =>
            FaceLandmarker.createFromOptions(v, {
              baseOptions: {
                modelAssetPath:
                  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
                delegate: d,
              },
              runningMode: "VIDEO",
              numFaces: 1,
              outputFaceBlendshapes: true,
            }),
          ).catch((err) => {
            console.warn("FaceLandmarker init failed (smile detection disabled):", err);
            return null;
          }),
          createWithFallback((v, d) =>
            ObjectDetector.createFromOptions(v, {
              baseOptions: {
                modelAssetPath:
                  "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite",
                delegate: d,
              },
              runningMode: "VIDEO",
              maxResults: 5,
              scoreThreshold: 0.4,
              categoryAllowlist: ["cell phone"],
            }),
          ).catch((err) => {
            console.warn("ObjectDetector init failed (phone detection disabled):", err);
            return null;
          }),
        ]).then(([faceLandmarker, objectDetector]) => {
          if (cancelled) {
            faceLandmarker?.close();
            objectDetector?.close();
            return;
          }
          faceLandmarkerRef.current = faceLandmarker;
          objectDetectorRef.current = objectDetector;
        });
      } catch (err) {
        if (!cancelled) {
          console.error("Vision detection init error:", err);
          setIsReady(false);
          setError(
            err instanceof Error ? err.message : "Failed to initialize vision"
          );
        }
      }
    }

    init();

    return () => {
      cancelled = true;
      // Cleanup
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      faceDetectorRef.current?.close();
      gestureRecognizerRef.current?.close();
      faceLandmarkerRef.current?.close();
      objectDetectorRef.current?.close();
      console.error = origError;
    };
  }, [enabled]);

  // Detection loop — runs at DETECTION_INTERVAL_MS via rAF
  const detect = useCallback(() => {
    const video = videoRef.current;
    const faceDetector = faceDetectorRef.current;
    const gestureRecognizer = gestureRecognizerRef.current;
    const faceLandmarker = faceLandmarkerRef.current;
    const objectDetector = objectDetectorRef.current;

    if (
      !video ||
      !faceDetector ||
      !gestureRecognizer ||
      video.readyState < 2
    ) {
      rafRef.current = requestAnimationFrame(detect);
      return;
    }

    // MediaPipe VIDEO mode is happiest with media timestamps. On mobile,
    // `performance.now()` + camera buffering can cause occasional
    // non-monotonic frame timing and transient misses.
    const mediaTs = video.currentTime * 1000;
    const now = Number.isFinite(mediaTs) && mediaTs > 0 ? mediaTs : performance.now();
    const safeNow = Math.max(now, lastVideoTimestampRef.current + 1);
    lastVideoTimestampRef.current = safeNow;

    // Throttle detection to ~10fps for performance
    const detectionInterval = isMobileRef.current
      ? DETECTION_INTERVAL_MOBILE_MS
      : DETECTION_INTERVAL_MS;
    if (now - lastDetectionTimeRef.current < detectionInterval) {
      rafRef.current = requestAnimationFrame(detect);
      return;
    }
    lastDetectionTimeRef.current = now;

    // ── Face Detection ──
    let faceResult: FaceDetectorResult | null = null;
    try {
      faceResult = faceDetector.detectForVideo(video, safeNow);
    } catch {
      // MediaPipe can throw on timestamp issues; skip frame
    }

    const faces = faceResult?.detections?.length ?? 0;
    const hasFaceRaw = faces > 0;
    if (hasFaceRaw) {
      faceSeenStreakRef.current += 1;
      faceMissStreakRef.current = 0;
      lastFaceSeenAtRef.current = safeNow;
    } else {
      faceSeenStreakRef.current = 0;
      faceMissStreakRef.current += 1;
    }

    let hasFace = stableFaceDetectedRef.current;
    if (!hasFace) {
      if (faceSeenStreakRef.current >= FACE_ACQUIRE_FRAMES) {
        hasFace = true;
      }
    } else {
      const withinGrace = safeNow - lastFaceSeenAtRef.current <= FACE_LOSS_GRACE_MS;
      if (!withinGrace && faceMissStreakRef.current >= FACE_LOSS_FRAMES) {
        hasFace = false;
      }
    }

    if (hasFace !== stableFaceDetectedRef.current) {
      stableFaceDetectedRef.current = hasFace;
      setFaceDetected(hasFace);
      lastFaceUiUpdateAtRef.current = safeNow;
    }
    const nextFaceCount = hasFace ? Math.max(1, faces) : 0;
    setFaceCount((prev) => (prev === nextFaceCount ? prev : nextFaceCount));

    if (hasFace) {
      if (faceStartRef.current === null) {
        faceStartRef.current = safeNow;
        lastFaceUiUpdateAtRef.current = 0;
      }
      if (safeNow - lastFaceUiUpdateAtRef.current >= FACE_UI_UPDATE_INTERVAL_MS) {
        lastFaceUiUpdateAtRef.current = safeNow;
        setFacePresenceDurationMs(safeNow - faceStartRef.current);
      }
    } else {
      faceStartRef.current = null;
      if (facePresenceDurationMs !== 0) {
        setFacePresenceDurationMs(0);
      }
    }

    // ── Smile Detection + Gender Detection (FaceLandmarker blendshapes + landmarks) ──
    const landmarkInterval = isMobileRef.current
      ? LANDMARK_INTERVAL_MOBILE_MS
      : LANDMARK_INTERVAL_MS;
    if (faceLandmarker && hasFace && safeNow - lastLandmarkDetectionRef.current >= landmarkInterval) {
      lastLandmarkDetectionRef.current = safeNow;
      try {
        const landmarkResult = faceLandmarker.detectForVideo(video, safeNow);
        if (landmarkResult?.faceBlendshapes?.[0]?.categories) {
          const cats = landmarkResult.faceBlendshapes[0].categories;
          // Average of left and right mouth smile blendshapes
          const smileL = cats.find(c => c.categoryName === "mouthSmileLeft")?.score ?? 0;
          const smileR = cats.find(c => c.categoryName === "mouthSmileRight")?.score ?? 0;
          const rawSmile = (smileL + smileR) / 2;
          // Smooth to avoid jitter
          smoothedSmileRef.current += (rawSmile - smoothedSmileRef.current) * 0.3;
          if (
            safeNow - lastSmileUiUpdateAtRef.current >= SMILE_UI_UPDATE_INTERVAL_MS
          ) {
            lastSmileUiUpdateAtRef.current = safeNow;
            setUserSmile(smoothedSmileRef.current);
          }
        }

        // ── Gender estimation from face landmark geometry ──
        // Uses jaw width/face height ratio and brow thickness heuristics.
        // Male faces tend to have wider jaws relative to face height, more prominent brows.
        if (!genderLockedRef.current && landmarkResult?.faceLandmarks?.[0]) {
          const lm = landmarkResult.faceLandmarks[0];
          // Key landmarks (MediaPipe face mesh 468 points):
          // 10 = forehead top, 152 = chin bottom
          // 234 = left jaw, 454 = right jaw  
          // 21 = left inner brow, 251 = right inner brow
          // 70 = left brow ridge, 300 = right brow ridge
          if (lm.length > 454) {
            const forehead = lm[10];
            const chin = lm[152];
            const leftJaw = lm[234];
            const rightJaw = lm[454];
            const leftBrow = lm[70];
            const rightBrow = lm[300];
            const leftInnerBrow = lm[21];
            const rightInnerBrow = lm[251];

            const faceHeight = Math.abs(chin.y - forehead.y);
            const jawWidth = Math.abs(rightJaw.x - leftJaw.x);

            if (faceHeight > 0.01) {
              // Jaw-to-face ratio: males typically > 0.78, females < 0.75
              const jawRatio = jawWidth / faceHeight;
              // Brow prominence: distance of brow ridge below forehead line
              const browDrop = ((leftBrow.y - forehead.y) + (rightBrow.y - forehead.y)) / 2;
              const browRatio = browDrop / faceHeight;
              // Inter-brow distance relative to jaw (males have wider-set brows)
              const browSpan = Math.abs(rightInnerBrow.x - leftInnerBrow.x);
              const browRelative = browSpan / jawWidth;

              // Score: positive = male leaning, negative = female leaning
              let score = 0;
              if (jawRatio > 0.78) score += 1;
              else if (jawRatio < 0.72) score -= 1;
              if (browRatio > 0.12) score += 1;
              else if (browRatio < 0.08) score -= 1;
              if (browRelative > 0.3) score += 0.5;
              else if (browRelative < 0.22) score -= 0.5;

              const vote = score >= 0.5 ? 1 : score <= -0.5 ? -1 : 0;
              if (vote !== 0) {
                genderVotesRef.current.push(vote);
                // Keep last 30 votes
                if (genderVotesRef.current.length > 30) {
                  genderVotesRef.current = genderVotesRef.current.slice(-30);
                }
                // Need at least 10 votes to decide
                if (genderVotesRef.current.length >= 10) {
                  const sum = genderVotesRef.current.reduce((a, b) => a + b, 0);
                  const ratio = sum / genderVotesRef.current.length;
                  if (ratio > 0.3) {
                    setUserGender("male");
                    genderLockedRef.current = true;
                  } else if (ratio < -0.3) {
                    setUserGender("female");
                    genderLockedRef.current = true;
                  }
                }
              }
            }
          }
        }
      } catch {
        // skip frame
      }
    } else if (!hasFace) {
      smoothedSmileRef.current *= 0.85;
      if (safeNow - lastSmileUiUpdateAtRef.current >= SMILE_UI_UPDATE_INTERVAL_MS) {
        lastSmileUiUpdateAtRef.current = safeNow;
        setUserSmile(smoothedSmileRef.current);
      }
    }

    // ── Gesture Recognition ──
    let gestureResult: GestureRecognizerResult | null = null;
    try {
      gestureResult = gestureRecognizer.recognizeForVideo(video, safeNow);
    } catch {
      // skip frame
    }

    // ── Namaste Detection from hand landmarks ──
    // Aggressive heuristic: any of the following counts as a namaste so the
    // sage reliably reciprocates from a webcam at varying distances.
    //   (A) Two hands tracked, wrists "close" and both pointing up; or
    //   (B) Two hands tracked, fingertips clustered (palms touching) even if
    //       MediaPipe couldn't keep both wrists separated; or
    //   (C) Two hands tracked, both pointing up and roughly horizontally
    //       aligned (similar y), even if the depth of the hands varies; or
    //   (D) Single-hand fallback — kiosk users often show only one hand
    //       to the camera (the other hand is hidden behind it). Accept a
    //       centered, upright hand with extended fingers as namaste so the
    //       interaction never feels broken.
    let namasteDetected = false;
    if (gestureResult?.landmarks && gestureResult.landmarks.length >= 2) {
      const hand0 = gestureResult.landmarks[0];
      const hand1 = gestureResult.landmarks[1];
      const wrist0 = hand0[0];
      const wrist1 = hand1[0];
      const mid0 = hand0[12];
      const mid1 = hand1[12];
      const wristDist = Math.sqrt((wrist0.x - wrist1.x) ** 2 + (wrist0.y - wrist1.y) ** 2);
      const tipDist = Math.sqrt((mid0.x - mid1.x) ** 2 + (mid0.y - mid1.y) ** 2);
      // Pointing up = middle fingertip y noticeably above wrist (y axis is
      // inverted in normalized image coords).
      const fingersUp0 = mid0.y < wrist0.y;
      const fingersUp1 = mid1.y < wrist1.y;
      const wristsAligned = Math.abs(wrist0.y - wrist1.y) < 0.30;

      // Widened thresholds (was 0.45 / 0.30 / 0.55) — palm-together
      // namaste is hard to land precisely from a kiosk distance.
      const caseA = wristDist < 0.60 && fingersUp0 && fingersUp1;
      const caseB = tipDist < 0.45 && fingersUp0 && fingersUp1;
      const caseC = wristsAligned && fingersUp0 && fingersUp1 && wristDist < 0.75;
      if (caseA || caseB || caseC) {
        namasteDetected = true;
      }
    } else if (gestureResult?.landmarks && gestureResult.landmarks.length === 1) {
      // Case D: single-hand namaste fallback. INTENTIONALLY STRICT — a
      // permissive single-hand check would gobble every Open_Palm /
      // Pointing_Up / ILoveYou frame because we suppress all other
      // gestures whenever Namaste is set. Require:
      //   * The hand to be centered horizontally,
      //   * All four non-thumb fingertips tightly aligned vertically
      //     (i.e. flat palm pointing straight up, not splayed),
      //   * All those tips meaningfully above the wrist,
      //   * The MediaPipe gesture classifier to NOT have already labelled
      //     this hand as a different known gesture (Open_Palm, Victory,
      //     Pointing_Up, Thumb_Up/Down, ILoveYou, Closed_Fist).
      const topCat = gestureResult.gestures?.[0]?.[0];
      const claimedByOther =
        topCat &&
        topCat.score > 0.5 &&
        topCat.categoryName !== "None" &&
        topCat.categoryName !== "Namaste";
      if (!claimedByOther) {
        const hand = gestureResult.landmarks[0];
        const wrist = hand[0];
        const indexTip = hand[8];
        const midTip = hand[12];
        const ringTip = hand[16];
        const pinkyTip = hand[20];
        const centered = wrist.x > 0.25 && wrist.x < 0.75;
        const tipsXs = [indexTip.x, midTip.x, ringTip.x, pinkyTip.x];
        const tipsXSpread = Math.max(...tipsXs) - Math.min(...tipsXs);
        const tipsAligned = tipsXSpread < 0.06; // narrow, parallel fingers
        const allAboveWrist =
          wrist.y - indexTip.y > 0.18 &&
          wrist.y - midTip.y > 0.20 &&
          wrist.y - ringTip.y > 0.18 &&
          wrist.y - pinkyTip.y > 0.14;
        if (centered && tipsAligned && allAboveWrist) {
          namasteDetected = true;
        }
      }
    }

    const frameGestures: GestureInfo[] = [];

    // Add Namaste as a synthetic gesture (highest priority)
    if (namasteDetected) {
      const namasteInfo: GestureInfo = {
        name: "Namaste",
        label: GESTURE_LABELS["Namaste"],
        confidence: 0.9,
        timestamp: Date.now(),
      };
      frameGestures.push(namasteInfo);
      const history = gestureHistoryRef.current;
      const isDup = history.some(g => g.name === "Namaste" && Date.now() - g.timestamp < GESTURE_DEDUP_MS);
      if (!isDup) {
        gestureHistoryRef.current = [
          ...history.filter(g => Date.now() - g.timestamp < GESTURE_HISTORY_TTL),
          namasteInfo,
        ];
        setGestureHistory([...gestureHistoryRef.current]);
      }
    }

    if (gestureResult?.gestures) {
      for (let i = 0; i < gestureResult.gestures.length; i++) {
        const gesture = gestureResult.gestures[i];
        if (gesture.length > 0) {
          const top = gesture[0];
          if (top.categoryName !== "None" && top.score > 0.4) {
            // Skip individual hand gestures if Namaste is detected (both hands together)
            if (namasteDetected) continue;
            const info: GestureInfo = {
              name: top.categoryName,
              label:
                GESTURE_LABELS[top.categoryName] || top.categoryName,
              confidence: top.score,
              timestamp: Date.now(),
            };
            frameGestures.push(info);

            // Add to history if not duplicate
            const history = gestureHistoryRef.current;
            const isDuplicate = history.some(
              (g) =>
                g.name === info.name &&
                info.timestamp - g.timestamp < GESTURE_DEDUP_MS
            );
            if (!isDuplicate) {
              gestureHistoryRef.current = [
                ...history.filter(
                  (g) => Date.now() - g.timestamp < GESTURE_HISTORY_TTL
                ),
                info,
              ];
              setGestureHistory([...gestureHistoryRef.current]);
            }
          }
        }
      }
    }

    // ── Phone Detection (run at slower rate ~3fps to save CPU) ──
    const HEAVY_INTERVAL = isMobileRef.current
      ? OBJECT_DETECT_INTERVAL_MOBILE_MS
      : OBJECT_DETECT_INTERVAL_MS;
    if (objectDetector && now - lastHeavyDetectionRef.current > HEAVY_INTERVAL) {
      lastHeavyDetectionRef.current = now;
      try {
        const objResult = objectDetector.detectForVideo(video, safeNow);
        const hasPhone = objResult?.detections?.some(
          d => d.categories?.some(c => c.categoryName === "cell phone" && c.score > 0.4)
        ) ?? false;
        setPhoneDetected(hasPhone);

        // If phone detected, add Photo_Pose as synthetic gesture
        if (hasPhone) {
          const existsPhoto = frameGestures.some(g => g.name === "Photo_Pose");
          if (!existsPhoto) {
            const photoInfo: GestureInfo = {
              name: "Photo_Pose",
              label: GESTURE_LABELS["Photo_Pose"],
              confidence: 0.85,
              timestamp: Date.now(),
            };
            frameGestures.push(photoInfo);
            const history = gestureHistoryRef.current;
            const isDup = history.some(g => g.name === "Photo_Pose" && Date.now() - g.timestamp < GESTURE_DEDUP_MS);
            if (!isDup) {
              gestureHistoryRef.current = [
                ...history.filter(g => Date.now() - g.timestamp < GESTURE_HISTORY_TTL),
                photoInfo,
              ];
              setGestureHistory([...gestureHistoryRef.current]);
            }
          }
        }
      } catch {
        // skip frame
      }
    }

    const nextGestures = dedupeFrameGestures(frameGestures);
    const nextGestureKey = nextGestures
      .map((g) => `${g.name}:${Math.round(g.confidence * 100)}`)
      .join("|");
    if (nextGestureKey !== lastGestureStateKeyRef.current) {
      lastGestureStateKeyRef.current = nextGestureKey;
      setCurrentGestures(nextGestures);
    }

    rafRef.current = requestAnimationFrame(detect);
  }, []);

  // Start detection loop once ready
  useEffect(() => {
    if (isReady) {
      rafRef.current = requestAnimationFrame(detect);
      return () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
      };
    }
  }, [isReady, detect]);

  const cleanup = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    faceDetectorRef.current?.close();
    faceDetectorRef.current = null;
    gestureRecognizerRef.current?.close();
    gestureRecognizerRef.current = null;
    faceLandmarkerRef.current?.close();
    faceLandmarkerRef.current = null;
    objectDetectorRef.current?.close();
    objectDetectorRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsReady(false);
    setFaceDetected(false);
    stableFaceDetectedRef.current = false;
    faceSeenStreakRef.current = 0;
    faceMissStreakRef.current = 0;
    lastFaceSeenAtRef.current = 0;
    lastVideoTimestampRef.current = 0;
    lastFaceUiUpdateAtRef.current = 0;
    lastSmileUiUpdateAtRef.current = 0;
    lastLandmarkDetectionRef.current = 0;
    lastGestureStateKeyRef.current = "";
    setFacePresenceDurationMs(0);
    setFaceCount(0);
    setCurrentGestures([]);
    setUserSmile(0);
    setPhoneDetected(false);
  }, []);

  return {
    faceDetected,
    facePresenceDurationMs,
    faceCount,
    currentGestures,
    gestureHistory,
    userSmile,
    phoneDetected,
    userGender,
    videoRef,
    isReady,
    error,
    cleanup,
  };
}

/** Build a context string from gesture history for the AI prompt */
export function buildGestureContext(gestures: GestureInfo[]): string {
  if (gestures.length === 0) return "";

  const recent = gestures
    .filter((g) => Date.now() - g.timestamp < 15_000) // last 15 seconds
    .map((g) => g.label);

  if (recent.length === 0) return "";

  const unique = [...new Set(recent)];
  return `\n\nUSER GESTURE DETECTION:\nThe camera has detected the user ${unique.join(", ")}. Respond naturally to these gestures — for example, if they waved, greet them warmly. If they gave a thumbs up, acknowledge it positively.`;
}
