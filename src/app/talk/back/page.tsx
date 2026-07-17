"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useVisionDetection } from "../../hooks/useVisionDetection";
import { getCameraSelectorFromUrl } from "../../lib/cameraDevices";
import { preloadAvatarAssets } from "../../lib/avatarAssets";
import { useRearDisplaySync } from "../../lib/displaySync";

const Avatar3D = dynamic(() => import("../../components/Avatar3D"), { ssr: false });

export default function BackDisplayPage() {
  const cameraSelector = getCameraSelectorFromUrl();
  const vision = useVisionDetection({
    enabled: true,
    cameraSelector,
  });
  const { avatarCommand, isSpeaking } = useRearDisplaySync(true, vision);
  const [avatarReady, setAvatarReady] = useState(false);
  const [preloadRatio, setPreloadRatio] = useState(0);
  const [preloadError, setPreloadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void preloadAvatarAssets((progress) => {
      if (!cancelled) setPreloadRatio(progress.ratio);
    })
      .then(() => {
        if (!cancelled) setAvatarReady(true);
      })
      .catch((error) => {
        if (!cancelled) {
          setPreloadError(error instanceof Error ? error.message : "Avatar preload failed");
        }
      });
    return () => {
      cancelled = true;
      vision.cleanup();
    };
    // Vision owns its own lifecycle; cleanup is needed only when this
    // display is actually unmounted by Electron.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main
      style={{
        position: "fixed",
        inset: 0,
        overflow: "hidden",
        background: "#050505",
      }}
    >
      <video
        ref={vision.videoRef}
        playsInline
        muted
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: "scaleX(-1)",
          pointerEvents: "none",
          zIndex: 0,
        }}
      />

      <div style={{ position: "absolute", inset: 0, zIndex: 1 }}>
        {avatarReady && (
          <Avatar3D
            isSpeaking={isSpeaking}
            faceDetected={vision.faceDetected}
            syncMode="follower"
            syncedAnimation={avatarCommand}
            viewMode="rear"
          />
        )}
      </div>

      {!avatarReady && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 2,
            display: "grid",
            placeItems: "center",
            background: "rgba(5,5,5,0.5)",
            color: "#FFB366",
            fontSize: 14,
          }}
        >
          {preloadError
            ? `Rear avatar unavailable: ${preloadError}`
            : `Synchronizing avatar… ${Math.round(preloadRatio * 100)}%`}
        </div>
      )}

      {vision.error && (
        <div
          style={{
            position: "absolute",
            right: 16,
            bottom: 16,
            zIndex: 3,
            padding: "8px 12px",
            borderRadius: 10,
            background: "rgba(0,0,0,0.65)",
            color: "#ff9a9a",
            fontSize: 11,
          }}
        >
          CV camera: {vision.error}
        </div>
      )}
    </main>
  );
}
