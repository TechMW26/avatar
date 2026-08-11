let faceDetector = null;
let ready = false;
let scanIndex = 0;
let detectionHoldFrames = 0;

// The tiny short-range detector is fast but can miss a small face when the
// whole wide camera frame is reduced to its 128px input. Alternate between
// the full native frame and an overlapping 3x3 scan. Each inference remains
// small, while every part of the camera—not merely the visible CSS crop—is
// inspected at roughly 3x the effective detail.
const SCAN_REGIONS = [
  null,
  [0, 0], [0.33, 0], [0.66, 0],
  [0, 0.33], [0.33, 0.33], [0.66, 0.33],
  [0, 0.66], [0.33, 0.66], [0.66, 0.66],
];

async function initFaceDetector(payload) {
  if (ready && faceDetector) return;
  const {
    wasmRoot,
    modelAssetPath,
    minDetectionConfidence = 0.42,
  } = payload || {};

  // Keep the worker module same-origin so restrictive CSP, ad blockers, or a
  // transient CDN module failure cannot disable face detection.
  const mp = await import("/mediapipe/vision_bundle.mjs");
  const vision = await mp.FilesetResolver.forVisionTasks(wasmRoot);

  // CPU delegate is the most reliable in workers across browsers.
  faceDetector = await mp.FaceDetector.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath,
      delegate: "CPU",
    },
    runningMode: "IMAGE",
    minDetectionConfidence,
  });

  ready = true;
}

self.onmessage = async (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;

  if (data.type === "init") {
    try {
      await initFaceDetector(data);
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({
        type: "error",
        stage: "init",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (data.type === "detect") {
    const bitmap = data.imageBitmap;
    const ts = typeof data.ts === "number" ? data.ts : Date.now();
    if (!bitmap) {
      self.postMessage({ type: "result", ts, count: 0 });
      return;
    }

    if (!ready || !faceDetector) {
      try { bitmap.close?.(); } catch {}
      self.postMessage({ type: "result", ts, count: 0 });
      return;
    }

    try {
      const region = SCAN_REGIONS[scanIndex];
      scanIndex = (scanIndex + 1) % SCAN_REGIONS.length;
      let detectionImage = bitmap;
      if (region) {
        const cropWidth = Math.max(1, Math.ceil(bitmap.width * 0.38));
        const cropHeight = Math.max(1, Math.ceil(bitmap.height * 0.38));
        const x = Math.min(bitmap.width - cropWidth, Math.round(bitmap.width * region[0]));
        const y = Math.min(bitmap.height - cropHeight, Math.round(bitmap.height * region[1]));
        detectionImage = await createImageBitmap(bitmap, x, y, cropWidth, cropHeight);
      }

      const result = faceDetector.detect(detectionImage);
      const rawCount = result?.detections?.length ?? 0;
      if (detectionImage !== bitmap) {
        try { detectionImage.close?.(); } catch {}
      }
      if (rawCount > 0) detectionHoldFrames = 2;
      const count = rawCount > 0 ? rawCount : detectionHoldFrames > 0 ? 1 : 0;
      if (rawCount === 0 && detectionHoldFrames > 0) detectionHoldFrames -= 1;
      try { bitmap.close?.(); } catch {}
      self.postMessage({ type: "result", ts, count });
    } catch (err) {
      try { bitmap.close?.(); } catch {}
      self.postMessage({
        type: "error",
        stage: "detect",
        message: err instanceof Error ? err.message : String(err),
      });
      self.postMessage({ type: "result", ts, count: 0 });
    }
    return;
  }

  if (data.type === "dispose") {
    try {
      faceDetector?.close?.();
    } catch {}
    faceDetector = null;
    ready = false;
    scanIndex = 0;
    detectionHoldFrames = 0;
  }
};
