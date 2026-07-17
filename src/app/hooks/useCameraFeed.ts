"use client";

import { useEffect, useRef, useState } from "react";
import { resolveCameraDeviceId } from "../lib/cameraDevices";

export function useCameraFeed(options?: {
  enabled?: boolean;
  cameraSelector?: string | null;
}) {
  const enabled = options?.enabled ?? true;
  const cameraSelector = options?.cameraSelector ?? null;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const videoElement = videoRef.current;

    const start = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("Camera access is not available in this browser.");
        }

        const preferredId = await resolveCameraDeviceId(cameraSelector);
        console.log("[useCameraFeed] preferred deviceId:", preferredId?.slice(0, 12) ?? "null", "selector:", cameraSelector);

        // Try the preferred camera first with ideal constraints, then with
        // relaxed constraints. Only fall back to other cameras if the
        // preferred one genuinely cannot be opened.
        const streamConstraints: MediaStreamConstraints[] = [];

        const mkConstraint = (deviceId: string | undefined, relaxed: boolean) => ({
          audio: false,
          video: {
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
            ...(relaxed
              ? {}
              : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }),
          },
        });

        // 1. Preferred camera with ideal resolution
        if (preferredId) {
          streamConstraints.push(mkConstraint(preferredId, false));
        }

        // 2. Preferred camera without resolution constraints (relaxed)
        if (preferredId) {
          streamConstraints.push(mkConstraint(preferredId, true));
        }

        // 3. Any camera at all (last resort)
        streamConstraints.push({ audio: false, video: { facingMode: "user" } });
        streamConstraints.push({ audio: false, video: true });

        let stream: MediaStream | null = null;
        let usedConstraint = -1;
        for (let i = 0; i < streamConstraints.length; i++) {
          try {
            stream = await navigator.mediaDevices.getUserMedia(streamConstraints[i]);
            usedConstraint = i;
            break;
          } catch (err) {
            console.log(`[useCameraFeed] constraint ${i} failed:`, err instanceof Error ? err.message : err);
          }
        }

        if (!stream) {
          throw new Error("No camera available. Please connect a camera and grant permission.");
        }

        // Log which camera was actually opened
        const track = stream.getVideoTracks()[0];
        const actualLabel = track?.label ?? "unknown";
        console.log(`[useCameraFeed] opened "${actualLabel}" (constraint #${usedConstraint})`);
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoElement) {
          videoElement.srcObject = stream;
          videoElement.muted = true;
          videoElement.playsInline = true;
          await videoElement.play();
        }
        setIsReady(true);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setIsReady(false);
        setError(err instanceof Error ? err.message : "Unable to open camera.");
      }
    };

    void start();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (videoElement) videoElement.srcObject = null;
    };
  }, [cameraSelector, enabled]);

  return { videoRef, isReady, error };
}
