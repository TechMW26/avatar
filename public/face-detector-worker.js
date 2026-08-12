let faceDetector = null;
let ready = false;

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
      // Every result now comes from the complete camera frame. The previous
      // rotating tile scan examined a face only once per full scan and then
      // emitted synthetic hold frames, causing detected/not-detected loops.
      const result = faceDetector.detect(bitmap);
      const count = result?.detections?.length ?? 0;
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
  }
};
