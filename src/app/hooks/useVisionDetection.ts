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
  /** Stabilized presentation estimate from the visible face. */
  userGender: "male" | "female" | "unknown";
  /** Ref to attach to a <video> element */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Whether MediaPipe models are loaded and camera is ready */
  isReady: boolean;
  /** Face worker mode: "worker" (offloaded), "main-thread" (fallback), or "disabled" */
  faceWorkerMode: "worker" | "main-thread" | "disabled";
  /** Any error that occurred during setup */
  error: string | null;
  /** Imperatively stop camera, detection, and release all resources */
  cleanup: () => void;
}

const VISION_WASM_ROOT = "/mediapipe/wasm";
const FACE_DETECTOR_MODEL_PATH = "/mediapipe/models/blaze_face_short_range.tflite";
const FACE_DETECTION_CONFIDENCE = 0.42;
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
const FACE_LOSS_GRACE_MS = 1_400; // covers one complete worker tile scan
const FACE_WORKER_STALE_MS = 1200;
const FACE_WORKER_HUNG_MS = 3_000;
const FACE_WORKER_INIT_TIMEOUT_MS = 12_000;
const FACE_WORKER_RETRY_BASE_MS = 5_000;
const FACE_WORKER_RETRY_MAX_MS = 30_000;
const VISION_RETRY_BASE_MS = 3_000;
const VISION_RETRY_MAX_MS = 20_000;
const NAMASTE_ACQUIRE_FRAMES = 3;
const NAMASTE_HOLD_MS = 900;
const NAMASTE_RETRIGGER_MS = 6500;
const FACE_WORKER_MODE_KEY = "rishi:vision:face-worker-mode";
const FACE_WORKER_FAIL_COUNT_KEY = "rishi:vision:face-worker-fail-count";
const FACE_WORKER_DISABLE_UNTIL_KEY = "rishi:vision:face-worker-disable-until";
const GENDER_MODEL_ROOT = "/face-api-models";
const GENDER_INFERENCE_INTERVAL_MS = 2_400;
const GENDER_MIN_CONFIDENCE = 0.76;
const GENDER_ACQUIRE_SAMPLES = 3;
const GENDER_SWITCH_SAMPLES = 4;

type UserGender = VisionState["userGender"];
type FaceApiModule = typeof import("@vladmandic/face-api");

let genderClassifierPromise: Promise<FaceApiModule | null> | null = null;

function loadGenderClassifier(): Promise<FaceApiModule | null> {
  if (genderClassifierPromise) return genderClassifierPromise;
  genderClassifierPromise = import("@vladmandic/face-api")
    .then(async (faceApi) => {
      // Gender classification runs only every few seconds. CPU avoids adding
      // another WebGL context beside MediaPipe and the Three.js avatar.
      const tfRuntime = faceApi.tf as unknown as {
        setBackend: (backend: string) => Promise<boolean>;
        ready: () => Promise<void>;
      };
      await tfRuntime.setBackend("cpu");
      await tfRuntime.ready();
      await Promise.all([
        faceApi.nets.tinyFaceDetector.loadFromUri(GENDER_MODEL_ROOT),
        faceApi.nets.faceLandmark68TinyNet.loadFromUri(GENDER_MODEL_ROOT),
        faceApi.nets.ageGenderNet.loadFromUri(GENDER_MODEL_ROOT),
      ]);
      return faceApi;
    })
    .catch((error) => {
      console.warn("Gender classifier unavailable:", error);
      genderClassifierPromise = null;
      return null;
    });
  return genderClassifierPromise;
}

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

async function createNativeCameraFrame(video: HTMLVideoElement): Promise<ImageBitmap> {
  const width = video.videoWidth;
  const height = video.videoHeight;

  // Supplying the source rectangle explicitly prevents a hidden/CSS-cropped
  // detector video from ever influencing the pixels sent to the worker.
  if (width > 0 && height > 0) {
    return createImageBitmap(video, 0, 0, width, height);
  }
  return createImageBitmap(video);
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
  detectGender?: boolean;
}): VisionState {
  const enabled = options?.enabled ?? true;
  const cameraSelector = options?.cameraSelector ?? null;
  const detectGender = options?.detectGender ?? false;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const faceDetectorRef = useRef<FaceDetector | null>(null);
  const faceWorkerRef = useRef<Worker | null>(null);
  const faceWorkerReadyRef = useRef(false);
  const faceWorkerInFlightRef = useRef(false);
  const faceWorkerCountRef = useRef(0);
  const faceWorkerLastTsRef = useRef(0);
  const faceWorkerRequestStartedAtRef = useRef(0);
  const faceWorkerEnabledRef = useRef(false);
  const restartFaceWorkerRef = useRef<() => void>(() => {});
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

  // Gender-presentation estimate. Multiple high-confidence samples are
  // required before acquisition, and even more before switching, so a single
  // blurred/profile frame cannot flip the conversation grammar.
  const [userGender, setUserGender] = useState<UserGender>("unknown");
  const userGenderRef = useRef<UserGender>("unknown");
  const genderClassifierRef = useRef<FaceApiModule | null>(null);
  const genderInferenceInFlightRef = useRef(false);
  const lastGenderInferenceAtRef = useRef(0);
  const genderCandidateRef = useRef<{ gender: Exclude<UserGender, "unknown">; samples: number } | null>(null);

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
  const [faceWorkerMode, setFaceWorkerMode] = useState<"worker" | "main-thread" | "disabled">(
    enabled ? "main-thread" : "disabled",
  );

  // Initialize MediaPipe models and camera
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let initRetryTimer = 0;
    let initAttempt = 0;
    let initInProgress = false;
    let initGeneration = 0;
    let faceWorkerRetryTimer = 0;
    let faceWorkerAttempt = 0;
    let faceWorkerStarting = false;

    // Older releases permanently disabled the worker after two transient
    // failures. Clear that legacy state: the local detector is now the
    // reliable baseline and worker recovery is automatic.
    window.localStorage.removeItem(FACE_WORKER_MODE_KEY);
    window.localStorage.removeItem(FACE_WORKER_FAIL_COUNT_KEY);
    window.localStorage.removeItem(FACE_WORKER_DISABLE_UNTIL_KEY);

    // Suppress noisy TensorFlow Lite INFO messages that MediaPipe logs via console.error
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].includes("Created TensorFlow Lite")) return;
      origError.apply(console, args);
    };

    const stopFaceWorker = () => {
      const worker = faceWorkerRef.current;
      faceWorkerRef.current = null;
      faceWorkerReadyRef.current = false;
      faceWorkerEnabledRef.current = false;
      faceWorkerInFlightRef.current = false;
      faceWorkerRequestStartedAtRef.current = 0;
      faceWorkerLastTsRef.current = 0;
      try { worker?.terminate(); } catch {}
    };

    const scheduleFaceWorkerRetry = () => {
      if (cancelled || faceWorkerRetryTimer || typeof Worker === "undefined") return;
      const delay = Math.min(
        FACE_WORKER_RETRY_BASE_MS * 2 ** Math.min(faceWorkerAttempt, 3),
        FACE_WORKER_RETRY_MAX_MS,
      );
      faceWorkerRetryTimer = window.setTimeout(() => {
        faceWorkerRetryTimer = 0;
        void startFaceWorker();
      }, delay);
    };

    const handleFaceWorkerFailure = (worker: Worker, reason: string) => {
      if (faceWorkerRef.current !== worker) return;
      console.warn(`[useVisionDetection] face worker unavailable (${reason}); using main-thread detector`);
      stopFaceWorker();
      if (!cancelled) {
        setFaceWorkerMode("main-thread");
        scheduleFaceWorkerRetry();
      }
    };

    const startFaceWorker = async (): Promise<void> => {
      if (
        cancelled
        || faceWorkerStarting
        || faceWorkerReadyRef.current
        || typeof Worker === "undefined"
        || typeof createImageBitmap === "undefined"
      ) {
        return;
      }

      faceWorkerStarting = true;
      stopFaceWorker();
      let worker: Worker | null = null;

      try {
        // MediaPipe's WASM bootstrap uses importScripts inside workers. A
        // classic worker supports that path; a module worker throws and then
        // hits the library's non-standard `self.import` fallback.
        const activeWorker = new Worker("/face-detector-worker.js");
        worker = activeWorker;
        faceWorkerRef.current = activeWorker;
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (failure?: Error) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timeout);
            if (failure) reject(failure);
            else resolve();
          };
          const timeout = window.setTimeout(
            () => finish(new Error("initialization timed out")),
            FACE_WORKER_INIT_TIMEOUT_MS,
          );

          activeWorker.onmessage = (event: MessageEvent<{
            type: string;
            stage?: string;
            count?: number;
            ts?: number;
            message?: string;
          }>) => {
            const msg = event.data;
            if (!msg || typeof msg !== "object" || faceWorkerRef.current !== activeWorker) return;
            if (msg.type === "ready") {
              faceWorkerReadyRef.current = true;
              faceWorkerEnabledRef.current = true;
              faceWorkerAttempt = 0;
              setFaceWorkerMode("worker");
              finish();
              return;
            }
            if (msg.type === "result") {
              faceWorkerInFlightRef.current = false;
              faceWorkerRequestStartedAtRef.current = 0;
              faceWorkerCountRef.current = Number(msg.count ?? 0);
              faceWorkerLastTsRef.current = Number(msg.ts ?? performance.now());
              return;
            }
            if (msg.type === "error") {
              const message = msg.message || `${msg.stage || "runtime"} error`;
              if (!faceWorkerReadyRef.current) finish(new Error(message));
              else handleFaceWorkerFailure(activeWorker, message);
            }
          };
          activeWorker.onerror = (event) => {
            const message = event.message || "script error";
            if (!faceWorkerReadyRef.current) finish(new Error(message));
            else handleFaceWorkerFailure(activeWorker, message);
          };
          activeWorker.onmessageerror = () => {
            if (!faceWorkerReadyRef.current) finish(new Error("message error"));
            else handleFaceWorkerFailure(activeWorker, "message error");
          };
          activeWorker.postMessage({
            type: "init",
            wasmRoot: VISION_WASM_ROOT,
            modelAssetPath: FACE_DETECTOR_MODEL_PATH,
            minDetectionConfidence: FACE_DETECTION_CONFIDENCE,
          });
        });
        console.log("[useVisionDetection] face worker ready (offloaded mode)");
      } catch (workerError) {
        faceWorkerAttempt += 1;
        const reason = workerError instanceof Error ? workerError.message : "initialization failed";
        if (worker) handleFaceWorkerFailure(worker, reason);
        else {
          console.warn(`[useVisionDetection] face worker unavailable (${reason}); using main-thread detector`);
          setFaceWorkerMode("main-thread");
          scheduleFaceWorkerRetry();
        }
      } finally {
        faceWorkerStarting = false;
      }
    };

    restartFaceWorkerRef.current = () => {
      const worker = faceWorkerRef.current;
      if (worker) handleFaceWorkerFailure(worker, "stalled");
      else scheduleFaceWorkerRetry();
    };

    void startFaceWorker();

    const disposeMainResources = () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      faceDetectorRef.current?.close();
      faceDetectorRef.current = null;
      gestureRecognizerRef.current?.close();
      gestureRecognizerRef.current = null;
      faceLandmarkerRef.current?.close();
      faceLandmarkerRef.current = null;
      objectDetectorRef.current?.close();
      objectDetectorRef.current = null;
    };

    const scheduleVisionRetry = () => {
      if (cancelled || initRetryTimer) return;
      const delay = Math.min(
        VISION_RETRY_BASE_MS * 2 ** Math.min(initAttempt, 3),
        VISION_RETRY_MAX_MS,
      );
      initRetryTimer = window.setTimeout(() => {
        initRetryTimer = 0;
        void init();
      }, delay);
    };

    async function init() {
      if (cancelled || initInProgress || faceDetectorRef.current) return;
      initInProgress = true;
      const generation = ++initGeneration;
      try {
        const isDesktopGesturePlatform = isMacOrWindowsDesktop();
        const isMobileDevice = !isDesktopGesturePlatform;
        isMobileRef.current = isMobileDevice;

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
          let lastCameraError: unknown = null;
          for (let i = 0; i < constraints.length; i++) {
            try {
              stream = await navigator.mediaDevices.getUserMedia(constraints[i]);
              usedConstraint = i;
              break;
            } catch (err) {
              lastCameraError = err;
              console.log(`[useVisionDetection] constraint ${i} failed:`, err instanceof Error ? err.message : err);
              if (
                err instanceof DOMException
                && (err.name === "NotAllowedError" || err.name === "SecurityError")
              ) {
                throw err;
              }
            }
          }

          if (!stream) {
            if (lastCameraError instanceof Error) throw lastCameraError;
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
            const settings = track?.getSettings();
            const nativeWidth = video.videoWidth || settings?.width || 0;
            const nativeHeight = video.videoHeight || settings?.height || 0;
            if (nativeWidth > 0 && nativeHeight > 0) {
              video.width = nativeWidth;
              video.height = nativeHeight;
            }
          }
          return stream;
        })();

        const modelTask = (async () => {
          const vision = await FilesetResolver.forVisionTasks(VISION_WASM_ROOT);
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
          const faceDetector = await createWithFallback((v, d) =>
            FaceDetector.createFromOptions(v, {
              baseOptions: {
                modelAssetPath: FACE_DETECTOR_MODEL_PATH,
                delegate: d,
              },
              runningMode: "VIDEO",
              minDetectionConfidence: FACE_DETECTION_CONFIDENCE,
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

        if (cancelled || generation !== initGeneration) {
          stream.getTracks().forEach((t) => t.stop());
          faceDetector?.close();
          void gestureRecognizerTask.then((g) => g?.close?.()).catch(() => {});
          return;
        }

        faceDetectorRef.current = faceDetector;
        // ── Mark ready as soon as camera + face detector are available. ──
        initAttempt = 0;
        setError(null);
        setIsReady(true);

        if (detectGender) {
          void loadGenderClassifier().then((classifier) => {
            if (!cancelled && generation === initGeneration) {
              genderClassifierRef.current = classifier;
            }
          });
        }

        const track = stream.getVideoTracks()[0];
        if (track) {
          track.onended = () => {
            if (cancelled || generation !== initGeneration) return;
            initGeneration += 1;
            console.warn("[useVisionDetection] camera stream ended; reconnecting");
            setIsReady(false);
            setError("Camera disconnected. Reconnecting…");
            disposeMainResources();
            scheduleVisionRetry();
          };
        }

        void gestureRecognizerTask.then((gestureRecognizer) => {
          if (!gestureRecognizer) return;
          if (cancelled || generation !== initGeneration) {
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
          if (cancelled || generation !== initGeneration) {
            faceLandmarker?.close();
            objectDetector?.close();
            return;
          }
          faceLandmarkerRef.current = faceLandmarker;
          objectDetectorRef.current = objectDetector;
        });
      } catch (err) {
        if (!cancelled && generation === initGeneration) {
          console.error("Vision detection init error:", err);
          disposeMainResources();
          setIsReady(false);
          const message = err instanceof Error ? err.message : "Failed to initialize vision";
          const isPermissionFailure =
            err instanceof DOMException
            && (err.name === "NotAllowedError" || err.name === "SecurityError");
          setError(isPermissionFailure ? message : "Vision temporarily unavailable. Reconnecting…");
          if (!isPermissionFailure) {
            initAttempt += 1;
            scheduleVisionRetry();
          }
        }
      } finally {
        initInProgress = false;
      }
    }

    init();

    return () => {
      cancelled = true;
      initGeneration += 1;
      window.clearTimeout(initRetryTimer);
      window.clearTimeout(faceWorkerRetryTimer);
      restartFaceWorkerRef.current = () => {};
      // Cleanup
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      disposeMainResources();
      stopFaceWorker();
      console.error = origError;
    };
  }, [cameraSelector, detectGender, enabled]);

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
      if (
        faceWorkerInFlightRef.current
        && faceWorkerRequestStartedAtRef.current > 0
        && performance.now() - faceWorkerRequestStartedAtRef.current > FACE_WORKER_HUNG_MS
      ) {
        restartFaceWorkerRef.current();
      }
      // Keep exactly one worker inference in flight to avoid queue buildup.
      if (faceWorkerReadyRef.current && !faceWorkerInFlightRef.current) {
        faceWorkerInFlightRef.current = true;
        faceWorkerRequestStartedAtRef.current = performance.now();
        createNativeCameraFrame(video)
          .then((bitmap) => {
            if (faceWorkerRef.current !== faceWorker || !faceWorkerReadyRef.current) {
              bitmap.close();
              return;
            }
            try {
              faceWorker.postMessage({ type: "detect", imageBitmap: bitmap, ts: safeNow }, [bitmap]);
            } catch {
              bitmap.close();
              restartFaceWorkerRef.current();
            }
          })
          .catch(() => {
            faceWorkerInFlightRef.current = false;
            faceWorkerRequestStartedAtRef.current = 0;
            restartFaceWorkerRef.current();
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

    // ── Stabilized gender-presentation estimation ──
    const genderNow = performance.now();
    const genderClassifier = genderClassifierRef.current;
    if (
      detectGender
      && hasFace
      && genderClassifier
      && !genderInferenceInFlightRef.current
      && genderNow - lastGenderInferenceAtRef.current >= GENDER_INFERENCE_INTERVAL_MS
    ) {
      lastGenderInferenceAtRef.current = genderNow;
      genderInferenceInFlightRef.current = true;
      const options = new genderClassifier.TinyFaceDetectorOptions({
        inputSize: 224,
        scoreThreshold: 0.55,
      });
      void genderClassifier
        .detectAllFaces(video, options)
        .withFaceLandmarks(true)
        .withAgeAndGender()
        .then((results) => {
          // When several people are visible, address the foreground visitor:
          // the largest aligned face, not whichever face happened to receive
          // the detector's highest confidence score.
          const result = results.reduce<(typeof results)[number] | null>((largest, item) => {
            if (!largest) return item;
            const itemArea = item.detection.box.width * item.detection.box.height;
            const largestArea = largest.detection.box.width * largest.detection.box.height;
            return itemArea > largestArea ? item : largest;
          }, null);
          if (!result || !stableFaceDetectedRef.current) return results;
          const confidence = result.genderProbability ?? 0;
          if (confidence < GENDER_MIN_CONFIDENCE) {
            genderCandidateRef.current = null;
            return results;
          }
          const candidate = result.gender === "female" ? "female" : "male";
          const previousCandidate = genderCandidateRef.current;
          const samples = previousCandidate?.gender === candidate
            ? previousCandidate.samples + 1
            : 1;
          genderCandidateRef.current = { gender: candidate, samples };
          const requiredSamples = userGenderRef.current === "unknown"
            ? GENDER_ACQUIRE_SAMPLES
            : userGenderRef.current === candidate
              ? 1
              : GENDER_SWITCH_SAMPLES;
          if (samples >= requiredSamples && userGenderRef.current !== candidate) {
            userGenderRef.current = candidate;
            setUserGender(candidate);
          }
          return results;
        })
        .catch(() => {
          // A transient inference failure should not affect face detection.
        })
        .finally(() => {
          genderInferenceInFlightRef.current = false;
        });
    } else if (!hasFace && userGenderRef.current !== "unknown") {
      userGenderRef.current = "unknown";
      genderCandidateRef.current = null;
      setUserGender("unknown");
    }

    // ── Smile Detection (FaceLandmarker blendshapes) ──
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
  }, [detectGender]);

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
    faceWorkerRequestStartedAtRef.current = 0;
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
    userGenderRef.current = "unknown";
    genderCandidateRef.current = null;
    genderInferenceInFlightRef.current = false;
    lastGenderInferenceAtRef.current = 0;
    setUserGender("unknown");
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
    faceWorkerMode,
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
