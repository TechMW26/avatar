"use client";
/* eslint-disable react-hooks/set-state-in-effect, react-hooks/refs -- MediaPipe exposes mutable media refs consumed by the display renderer. */

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useVisionDetection } from "../../hooks/useVisionDetection";
import { getCameraSelectorFromUrl } from "../../lib/cameraDevices";
import { preloadAvatarAssets } from "../../lib/avatarAssets";
import { useRearDisplaySync } from "../../lib/displaySync";
import {
  CHARACTER_STORAGE_KEY,
  getCharacter,
  getOptionalCharacterFromLocation,
  isCharacterSlug,
  type CharacterProfile,
} from "../../lib/characters";
import {
  updateRemoteCharacter,
  useRemoteControlState,
} from "../../hooks/useRemoteControl";

const Avatar3D = dynamic(() => import("../../components/Avatar3D"), { ssr: false });

export default function BackDisplayPage() {
  const cameraSelector = getCameraSelectorFromUrl();
  const vision = useVisionDetection({
    enabled: true,
    cameraSelector,
  });
  const { avatarCommand, isSpeaking, getLipSyncFrame } = useRearDisplaySync(true, vision);
  const [avatarReady, setAvatarReady] = useState(false);
  const [preloadRatio, setPreloadRatio] = useState(0);
  const [preloadError, setPreloadError] = useState<string | null>(null);
  const [character, setCharacter] = useState<CharacterProfile | null>(null);
  const remoteControl = useRemoteControlState();

  useEffect(() => {
    const navigationEntry = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (navigationEntry?.type === "reload") {
      window.localStorage.removeItem(CHARACTER_STORAGE_KEY);
      setCharacter(null);
      void updateRemoteCharacter(null, "display-refresh");
      return;
    }

    const selected = getOptionalCharacterFromLocation();
    setCharacter(selected);

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== CHARACTER_STORAGE_KEY) return;
      setCharacter(isCharacterSlug(event.newValue) ? getCharacter(event.newValue) : null);
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  useEffect(() => {
    if (!remoteControl.state) return;
    if (!remoteControl.state.character) {
      window.localStorage.removeItem(CHARACTER_STORAGE_KEY);
      setCharacter(null);
      return;
    }
    const selected = getCharacter(remoteControl.state.character);
    window.localStorage.setItem(CHARACTER_STORAGE_KEY, selected.slug);
    setCharacter(selected);
  }, [remoteControl.state]);

  useEffect(() => {
    document.title = character
      ? `${character.name} · Rear Display`
      : "Waiting for character selection";
  }, [character]);

  useEffect(() => {
    if (!character) {
      setAvatarReady(false);
      return;
    }
    let cancelled = false;
    setAvatarReady(false);
    setPreloadError(null);
    void preloadAvatarAssets(
      (progress) => {
        if (!cancelled) setPreloadRatio(progress.ratio);
      },
      undefined,
      undefined,
      character.modelPath,
    )
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
    };
  }, [character]);

  // Vision owns its lifecycle for the lifetime of the rear page.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => vision.cleanup(), []);

  return (
    <main
      data-vision-ready={vision.isReady}
      data-face-detected={vision.faceDetected}
      data-face-count={vision.faceCount}
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
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 1,
          pointerEvents: "none",
          background:
            "radial-gradient(ellipse at 50% 45%, transparent 34%, rgba(0,0,0,0.1) 58%, rgba(0,0,0,0.72) 100%)",
        }}
      />

      <div style={{ position: "absolute", inset: 0, zIndex: 2 }}>
        {avatarReady && character && (
          <Avatar3D
            avatarUrl={character.modelPath}
            isSpeaking={isSpeaking}
            getLipSyncFrame={getLipSyncFrame}
            faceDetected={vision.faceDetected}
            syncMode="follower"
            syncedAnimation={avatarCommand}
            viewMode="rear"
            cameraVideoRef={vision.videoRef}
          />
        )}
      </div>

      {!character && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 2,
            display: "grid",
            placeItems: "center",
            padding: 32,
            background:
              "radial-gradient(circle at 50% 45%, rgba(249,115,22,0.16), transparent 35%), #090705",
            color: "#f7c896",
            fontSize: 16,
            letterSpacing: "0.04em",
            textAlign: "center",
          }}
        >
          Choose a historical guide on the front display
        </div>
      )}

      {character && !avatarReady && (
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
            ? `${character.name} unavailable: ${preloadError}`
            : `Preparing ${character.name}… ${Math.round(preloadRatio * 100)}%`}
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
