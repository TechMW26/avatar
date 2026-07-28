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
import { resolveCameraDeviceId } from "../lib/cameraDevices";

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
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm";
const GESTURE_HISTORY_TTL = 30_000; // keep gestures for 30s
const GESTURE_DEDUP_MS = 2_000; // don't re-add same gesture within 2s
const GESTURE_MIN_CONFIDENCE = 0.65;
const GESTURE_STABLE_FRAMES = 2;
const DETECTION_INTERVAL_MS = 130; // ~7.7fps face/gesture loop
const DETECTION_INTERVAL_MOBILE_MS = 170; // lighter cadence on phones
const FACE_UI_UPDATE_INTERVAL_MS = 120; // throttle React updates for counters
const SMILE_UI_UPDATE_INTERVAL_MS = 160;
const LANDMARK_INTERVAL_MS = 200;
const LANDMARK_INTERVAL_MOBILE_MS = 320;
const OBJECT_DETECT_INTERVAL_MS = 333;
const OBJECT_DETECT_INTERVAL_MOBILE_MS = 900;
const FACE_ACQUIRE_FRAMES = 2; // require 2 consecutive hits before face=true
const FACE_LOSS_FRAMES = 4; // require multiple misses before face=false
const FACE_LOSS_GRACE_MS = 700; // short grace window smooths mobile jitter
const FACE_WORKER_STALE_MS = 1200;
const NAMASTE_ACQUIRE_FRAMES = 3;
const NAMASTE_HOLD_MS = 900;
const NAMASTE_RETRIGGER_MS = 6500;
const FACE_WORKER_MODE_KEY = "rishi:vision:face-worker-mode";
const FACE_WORKER_FAIL_COUNT_KEY = "rishi:vision:face-worker-fail-count";
const FACE_WORKER_DISABLE_UNTIL_KEY = "rishi:vision:face-worker-disable-until";
const FACE_WORKER_FAILS_BEFORE_DISABLE = 2;
const FACE_WORKER_DISABLE_MS = 24 * 60 * 60 * 1000;

function isMacOrWindowsDesktop(): boolean {
  if (typeof navigator === "undefined") return false;

  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  const maxTouchPoints = navigator.maxTouchPoints || 0;

  const isiPadOsPretendingMac = platform === "MacIntel" && maxTouchPoints > 1;
  if (isiPadOsPretendingMac) return false;

  const isWindows = /windows/i.test(ua) || /win/i.test(platform);
  const isMac = /macintosh|mac os x/i.test(ua) || /mac/i.test(platform);
  const isAndroid = /android/i.test(ua);
  const isIOSMobile = /iphone|ipad|ipod/i.test(ua);

  return (isWindows || isMac) && !isAndroid && !isIOSMobile;
}

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

export function useVisionDetection(options?: {
  enabled?: boolean;
  cameraSelector?: string | null;
}): VisionState {
  const enabled = options?.enabled ?? true;
  const cameraSelector = options?.cameraSelector ?? null;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const faceDetectorRef = useRef<FaceDetector | null>(null);
  const faceWorkerRef = useRef<Worker | null>(null);
  const faceWorkerReadyRef = useRef(false);
  const faceWorkerInFlightRef = useRef(false);
  const faceWorkerCountRef = useRef(0);
  const faceWorkerLastTsRef = useRef(0);
  const faceWorkerEnabledRef = useRef(false);
  const faceLandmarkerRef = useRef<FaceLandmarker | null>(null);
  const gestureRecognizerRef = useRef<GestureRecognizer | null>(null);
  const objectDetectorRef = useRef<ObjectDetector | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const detectRef = useRef<() => void>(() => {});
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
  const gestureStreakRef = useRef<Record<string, number>>({});
  const gestureLastSeenTsRef = useRef<Record<string, number>>({});
  const namasteSeenStreakRef = useRef(0);
  const namasteMissStreakRef = useRef(0);
  const namasteHoldUntilRef = useRef(0);
  const lastNamasteEmitAtRef = useRef(0);

  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialize MediaPipe models and camera
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const readStoredNumber = (key: string): number => {
      if (typeof window === "undefined") return 0;
      const raw = window.localStorage.getItem(key);
      const parsed = Number(raw || 0);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const writeStoredNumber = (key: string, value: number) => {
      if (typeof window === "undefined") return;
      window.localStorage.setItem(key, String(value));
    };
    const setWorkerMode = (mode: "auto" | "fallback") => {
      if (typeof window === "undefined") return;
      window.localStorage.setItem(FACE_WORKER_MODE_KEY, mode);
    };
    const getWorkerMode = (): "auto" | "fallback" => {
      if (typeof window === "undefined") return "auto";
      const raw = window.localStorage.getItem(FACE_WORKER_MODE_KEY);
      return raw === "fallback" ? "fallback" : "auto";
    };

    // Suppress noisy TensorFlow Lite INFO messages that MediaPipe logs via console.error
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].includes("Created TensorFlow Lite")) return;
      origError.apply(console, args);
    };

    async function init() {
      try {
        const isDesktopGesturePlatform = isMacOrWindowsDesktop();
        const isMobileDevice = !isDesktopGesturePlatform;
        isMobileRef.current = isMobileDevice;

        // Spin up a dedicated worker for face inference. Keep a fallback
        // detector on the main thread if worker init fails.
        const faceWorkerTask = (async (): Promise<boolean> => {
          const disableUntil = readStoredNumber(FACE_WORKER_DISABLE_UNTIL_KEY);
          const mode = getWorkerMode();
          if (mode === "fallback" || Date.now() < disableUntil) {
            return false;
          }
          if (typeof Worker === "undefined" || typeof createImageBitmap === "undefined") {
            return false;
          }
          try {
            const worker = new Worker("/face-detector-worker.js", { type: "module" });
            faceWorkerRef.current = worker;
            const ready = await new Promise<boolean>((resolve) => {
              let settled = false;
              const finish = (value: boolean) => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timeout);
                resolve(value);
              };
              const timeout = window.setTimeout(() => finish(false), 4_000);
              worker.onmessage = (event: MessageEvent<{ type: string; stage?: string; count?: number; ts?: number }>) => {
                const msg = event.data;
                if (!msg || typeof msg !== "object") return;
                if (msg.type === "ready") {
                  faceWorkerReadyRef.current = true;
                  faceWorkerEnabledRef.current = true;
                  writeStoredNumber(FACE_WORKER_FAIL_COUNT_KEY, 0);
                  writeStoredNumber(FACE_WORKER_DISABLE_UNTIL_KEY, 0);
                  setWorkerMode("auto");
                  finish(true);
                  return;
                }
                if (msg.type === "result") {
                  faceWorkerInFlightRef.current = false;
                  faceWorkerCountRef.current = Number(msg.count ?? 0);
                  faceWorkerLastTsRef.current = Number(msg.ts ?? performance.now());
                  return;
                }
                if (msg.type === "error") {
                  faceWorkerInFlightRef.current = false;
                  faceWorkerReadyRef.current = false;
                  faceWorkerEnabledRef.current = false;
                  // Init failure should not sit until timeout. Detection
                  // failure must also immediately hand over to the always
                  // available main-thread detector.
                  if (msg.stage === "init") {
                    finish(false);
                  } else {
                    try { worker.terminate(); } catch {}
                    if (faceWorkerRef.current === worker) {
                      faceWorkerRef.current = null;
                    }
                  }
                }
              };
              worker.onerror = () => {
                faceWorkerReadyRef.current = false;
                faceWorkerEnabledRef.current = false;
                finish(false);
              };
              worker.postMessage({
                type: "init",
                wasmRoot: VISION_CDN,
                modelAssetPath:
                  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
                minDetectionConfidence: 0.5,
              });
            });
            if (!ready) {
              const failCount = readStoredNumber(FACE_WORKER_FAIL_COUNT_KEY) + 1;
              writeStoredNumber(FACE_WORKER_FAIL_COUNT_KEY, failCount);
              if (failCount >= FACE_WORKER_FAILS_BEFORE_DISABLE) {
                writeStoredNumber(FACE_WORKER_DISABLE_UNTIL_KEY, Date.now() + FACE_WORKER_DISABLE_MS);
                setWorkerMode("fallback");
              }
              try { worker.terminate(); } catch {}
              faceWorkerRef.current = null;
              faceWorkerReadyRef.current = false;
              faceWorkerEnabledRef.current = false;
            }
            return ready;
          } catch {
            const failCount = readStoredNumber(FACE_WORKER_FAIL_COUNT_KEY) + 1;
            writeStoredNumber(FACE_WORKER_FAIL_COUNT_KEY, failCount);
            if (failCount >= FACE_WORKER_FAILS_BEFORE_DISABLE) {
              writeStoredNumber(FACE_WORKER_DISABLE_UNTIL_KEY, Date.now() + FACE_WORKER_DISABLE_MS);
              setWorkerMode("fallback");
            }
            faceWorkerRef.current = null;
            faceWorkerReadyRef.current = false;
            faceWorkerEnabledRef.current = false;
            return false;
          }
        })();

        // 1) Warm camera and 2) load MediaPipe models concurrently so
        // startup doesn't pay both latencies serially on mobile.
        const streamTask = (async (): Promise<MediaStream> => {
          let stream: MediaStream | null = null;
          const preferredDeviceId = await resolveCameraDeviceId(cameraSelector);
          console.log("[useVisionDetection] preferred deviceId:", preferredDeviceId?.slice(0, 12) ?? "null", "selector:", cameraSelector);

          const constraints: MediaStreamConstraints[] = [];

          // 1. Preferred camera with ideal resolution
          if (preferredDeviceId) {
            constraints.push({
              video: {
                deviceId: { exact: preferredDeviceId },
                width: { ideal: isMobileDevice ? 640 : 960 },
                height: { ideal: isMobileDevice ? 480 : 540 },
                frameRate: { ideal: 24, max: 30 },
              },
              audio: false,
            });
          }

          // 2. Preferred camera without resolution constraints (relaxed)
          if (preferredDeviceId) {
            constraints.push({
              video: { deviceId: { exact: preferredDeviceId } },
              audio: false,
            });
          }

          // 3. Any camera — last resort
          constraints.push({
            video: {
              width: { ideal: isMobileDevice ? 640 : 960 },
              height: { ideal: isMobileDevice ? 480 : 540 },
              frameRate: { ideal: 24, max: 30 },
            },
            audio: false,
          });
          constraints.push({ video: true, audio: false });

          let usedConstraint = -1;
          for (let i = 0; i < constraints.length; i++) {
            try {
              stream = await navigator.mediaDevices.getUserMedia(constraints[i]);
              usedConstraint = i;
              break;
            } catch (err) {
              console.log(`[useVisionDetection] constraint ${i} failed:`, err instanceof Error ? err.message : err);
            }
          }

          if (!stream) {
            throw new Error("No camera found. Please connect a camera and grant permission.");
          }

          const track = stream.getVideoTracks()[0];
          console.log(`[useVisionDetection] opened "${track?.label ?? "unknown"}" (constraint #${usedConstraint})`);

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

          // Keep a local detector alive even when the worker starts. Module
          // workers can become unavailable after startup (CDN/CSP/context
          // loss); face detection must continue without reloading the page.
          void faceWorkerTask;
          const faceDetector = await createWithFallback((v, d) =>
            FaceDetector.createFromOptions(v, {
              baseOptions: {
                modelAssetPath:
                  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
                delegate: d,
              },
              runningMode: "VIDEO",
              minDetectionConfidence: 0.5,
            }),
          );

          // Mobile devices skip hand-gesture model entirely to reduce
          // startup time and steady-state CPU/GPU load.
          const gestureRecognizerTask: Promise<GestureRecognizer | null> = !isDesktopGesturePlatform
            ? Promise.resolve(null)
            : createWithFallback((v, d) =>
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
              ).catch((err) => {
                console.warn("GestureRecognizer init failed (gesture detection disabled):", err);
                return null;
              });

          return { createWithFallback, faceDetector, gestureRecognizerTask };
        })();

        const [stream, modelBundle] = await Promise.all([streamTask, modelTask]);
        const { createWithFallback, faceDetector, gestureRecognizerTask } = modelBundle;

        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          faceDetector?.close();
          void gestureRecognizerTask.then((g) => g?.close?.()).catch(() => {});
          return;
        }

        faceDetectorRef.current = faceDetector;
        // ── Mark ready as soon as camera + face detector are available. ──
        setIsReady(true);

        void gestureRecognizerTask.then((gestureRecognizer) => {
          if (!gestureRecognizer) return;
          if (cancelled) {
            gestureRecognizer.close();
            return;
          }
          gestureRecognizerRef.current = gestureRecognizer;
        });

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
      try { faceWorkerRef.current?.terminate(); } catch {}
      faceWorkerRef.current = null;
      faceWorkerReadyRef.current = false;
      faceWorkerEnabledRef.current = false;
      gestureRecognizerRef.current?.close();
      faceLandmarkerRef.current?.close();
      objectDetectorRef.current?.close();
      console.error = origError;
    };
  }, [cameraSelector, enabled]);

  // Detection loop — runs at DETECTION_INTERVAL_MS via rAF
  const detect = useCallback(() => {
    const video = videoRef.current;
    const faceDetector = faceDetectorRef.current;
    const faceWorker = faceWorkerRef.current;
    const gestureRecognizer = gestureRecognizerRef.current;
    const faceLandmarker = faceLandmarkerRef.current;
    const objectDetector = objectDetectorRef.current;

    if (
      !video ||
      (!faceWorkerReadyRef.current && !faceDetector) ||
      video.readyState < 2
    ) {
      rafRef.current = requestAnimationFrame(() => detectRef.current());
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
      rafRef.current = requestAnimationFrame(() => detectRef.current());
      return;
    }
    lastDetectionTimeRef.current = now;

    // ── Face Detection ──
    let faces = 0;
    if (faceWorkerReadyRef.current && faceWorker) {
      // Keep exactly one worker inference in flight to avoid queue buildup.
      if (!faceWorkerInFlightRef.current) {
        faceWorkerInFlightRef.current = true;
        createImageBitmap(video)
          .then((bitmap) => {
            faceWorker.postMessage({ type: "detect", imageBitmap: bitmap, ts: safeNow }, [bitmap]);
          })
          .catch(() => {
            faceWorkerInFlightRef.current = false;
            faceWorkerReadyRef.current = false;
            faceWorkerEnabledRef.current = false;
          });
      }
      const hasFreshWorkerResult =
        faceWorkerLastTsRef.current > 0
        && safeNow - faceWorkerLastTsRef.current <= FACE_WORKER_STALE_MS;
      if (hasFreshWorkerResult) {
        faces = faceWorkerCountRef.current;
      } else if (faceDetector) {
        try {
          faces = faceDetector.detectForVideo(video, safeNow).detections.length;
        } catch {
          // MediaPipe can throw on timestamp issues; skip frame.
        }
      }
    } else if (faceDetector) {
      let faceResult: FaceDetectorResult | null = null;
      try {
        faceResult = faceDetector.detectForVideo(video, safeNow);
      } catch {
        // MediaPipe can throw on timestamp issues; skip frame
      }
      faces = faceResult?.detections?.length ?? 0;
    }

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
      setFacePresenceDurationMs((previous) => (previous === 0 ? previous : 0));
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
    if (gestureRecognizer) {
      try {
        gestureResult = gestureRecognizer.recognizeForVideo(video, safeNow);
      } catch {
        // skip frame
      }
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
    let namasteDetectedRaw = false;
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
      const fingersUp0 = mid0.y < wrist0.y - 0.05;
      const fingersUp1 = mid1.y < wrist1.y - 0.05;
      const wristsAligned = Math.abs(wrist0.y - wrist1.y) < 0.14;
      const palmsCentered = (wrist0.x + wrist1.x) / 2 > 0.22 && (wrist0.x + wrist1.x) / 2 < 0.78;

      // Prefer opposite hands for true palm-join posture when handedness
      // metadata is available.
      let oppositeHands = true;
      const handedness = (gestureResult as { handedness?: Array<Array<{ categoryName?: string; score?: number }>> }).handedness;
      if (Array.isArray(handedness) && handedness.length >= 2) {
        const h0 = handedness[0]?.[0];
        const h1 = handedness[1]?.[0];
        const n0 = h0?.categoryName ?? "";
        const n1 = h1?.categoryName ?? "";
        const s0 = h0?.score ?? 0;
        const s1 = h1?.score ?? 0;
        oppositeHands = n0 !== "" && n1 !== "" && n0 !== n1 && s0 > 0.45 && s1 > 0.45;
      }

      // Tight thresholds reduce accidental Namaste from generic open-palms.
      const caseA = wristDist < 0.42 && tipDist < 0.26 && fingersUp0 && fingersUp1;
      const caseB = wristsAligned && wristDist < 0.46 && tipDist < 0.32 && fingersUp0 && fingersUp1;
      const caseC = wristDist < 0.36 && fingersUp0 && fingersUp1;
      if (caseA || caseB || caseC) {
        namasteDetectedRaw = palmsCentered && oppositeHands;
      }
    }

    if (namasteDetectedRaw) {
      namasteSeenStreakRef.current += 1;
      namasteMissStreakRef.current = 0;
      if (namasteSeenStreakRef.current >= NAMASTE_ACQUIRE_FRAMES) {
        namasteHoldUntilRef.current = safeNow + NAMASTE_HOLD_MS;
      }
    } else {
      namasteSeenStreakRef.current = 0;
      namasteMissStreakRef.current += 1;
    }
    const namasteDetected = safeNow <= namasteHoldUntilRef.current;

    const frameGestures: GestureInfo[] = [];

    // Add Namaste as a synthetic gesture (highest priority)
    if (namasteDetected) {
      const namasteInfo: GestureInfo = {
        name: "Namaste",
        label: GESTURE_LABELS["Namaste"],
        confidence: 0.95,
        timestamp: Date.now(),
      };
      frameGestures.push(namasteInfo);
      const history = gestureHistoryRef.current;
      const nowMs = Date.now();
      const isDup = history.some(g => g.name === "Namaste" && nowMs - g.timestamp < GESTURE_DEDUP_MS);
      if (!isDup) {
        if (nowMs - lastNamasteEmitAtRef.current >= NAMASTE_RETRIGGER_MS) {
          lastNamasteEmitAtRef.current = nowMs;
          gestureHistoryRef.current = [
            ...history.filter(g => nowMs - g.timestamp < GESTURE_HISTORY_TTL),
            namasteInfo,
          ];
          setGestureHistory([...gestureHistoryRef.current]);
        }
      }
    }

    if (gestureResult?.gestures) {
      for (let i = 0; i < gestureResult.gestures.length; i++) {
        const gesture = gestureResult.gestures[i];
        if (gesture.length > 0) {
          const top = gesture[0];
          if (top.categoryName !== "None" && top.score >= GESTURE_MIN_CONFIDENCE) {
            // Skip individual hand gestures if Namaste is detected (both hands together)
            if (namasteDetected) continue;

            const gestureName = top.categoryName;
            const nowTs = Date.now();
            const lastSeen = gestureLastSeenTsRef.current[gestureName] ?? 0;
            const isContinuous = nowTs - lastSeen <= 350;
            const nextStreak = isContinuous
              ? (gestureStreakRef.current[gestureName] ?? 0) + 1
              : 1;
            gestureLastSeenTsRef.current[gestureName] = nowTs;
            gestureStreakRef.current[gestureName] = nextStreak;
            if (nextStreak < GESTURE_STABLE_FRAMES) {
              continue;
            }

            const info: GestureInfo = {
              name: gestureName,
              label:
                GESTURE_LABELS[gestureName] || gestureName,
              confidence: top.score,
              timestamp: nowTs,
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

    rafRef.current = requestAnimationFrame(() => detectRef.current());
  }, []);

  // Start detection loop once ready
  useEffect(() => {
    detectRef.current = detect;
    if (isReady) {
      rafRef.current = requestAnimationFrame(() => detectRef.current());
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
    try { faceWorkerRef.current?.terminate(); } catch {}
    faceWorkerRef.current = null;
    faceWorkerReadyRef.current = false;
    faceWorkerEnabledRef.current = false;
    faceWorkerInFlightRef.current = false;
    faceWorkerCountRef.current = 0;
    faceWorkerLastTsRef.current = 0;
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
    gestureStreakRef.current = {};
    gestureLastSeenTsRef.current = {};
    namasteSeenStreakRef.current = 0;
    namasteMissStreakRef.current = 0;
    namasteHoldUntilRef.current = 0;
    lastNamasteEmitAtRef.current = 0;
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
