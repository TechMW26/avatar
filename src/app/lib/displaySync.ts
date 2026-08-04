"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GestureInfo, VisionState } from "../hooks/useVisionDetection";
import { isCharacterSlug, type CharacterSlug } from "./characters";
import type { LipSyncFrame } from "./lipSync";

const DISPLAY_CHANNEL_NAME = "rishi-dual-display-v1";
const REMOTE_VISION_STALE_MS = 4_000;

export type AvatarAnimationState =
  | "sitting"
  | "standing_up"
  | "walking_in"
  | "walking_out"
  | "turning_away"
  | "turning_back"
  | "stopping"
  | "idle_standing"
  | "waving"
  | "praying"
  | "explaining"
  | "yelling"
  | "dismissing"
  | "shooting_arrow"
  | "thoughtful"
  | "climbing"
  | "falling"
  | "left_turn"
  | "pointing"
  | "sword_fight";

export interface AvatarAnimationCommand {
  state: AvatarAnimationState;
  startedAt: number;
  sequence: number;
}

export interface VisionSnapshot {
  faceDetected: boolean;
  facePresenceDurationMs: number;
  faceCount: number;
  currentGestures: GestureInfo[];
  gestureHistory: GestureInfo[];
  userSmile: number;
  phoneDetected: boolean;
  userGender: "male" | "female" | "unknown";
  isReady: boolean;
  faceWorkerMode: "worker" | "main-thread" | "disabled";
  error: string | null;
  sentAt: number;
}

type DisplayMessage =
  | { type: "vision"; payload: VisionSnapshot }
  | {
      type: "avatar";
      command: AvatarAnimationCommand;
      isSpeaking: boolean;
      character: CharacterSlug;
    }
  | { type: "lipsync"; frame: LipSyncFrame | null }
  | { type: "sync-request" };

const EMPTY_VISION: VisionSnapshot = {
  faceDetected: false,
  facePresenceDurationMs: 0,
  faceCount: 0,
  currentGestures: [],
  gestureHistory: [],
  userSmile: 0,
  phoneDetected: false,
  userGender: "unknown",
  isReady: false,
  faceWorkerMode: "disabled",
  error: null,
  sentAt: 0,
};

function openDisplayChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
    return null;
  }
  return new BroadcastChannel(DISPLAY_CHANNEL_NAME);
}

function postVisionSnapshot(channel: BroadcastChannel, vision: VisionState) {
  const payload: VisionSnapshot = {
    faceDetected: vision.faceDetected,
    facePresenceDurationMs: vision.facePresenceDurationMs,
    faceCount: vision.faceCount,
    currentGestures: vision.currentGestures,
    gestureHistory: vision.gestureHistory,
    userSmile: vision.userSmile,
    phoneDetected: vision.phoneDetected,
    userGender: vision.userGender,
    isReady: vision.isReady,
    faceWorkerMode: vision.faceWorkerMode,
    error: vision.error,
    sentAt: Date.now(),
  };
  channel.postMessage({ type: "vision", payload } satisfies DisplayMessage);
}

export function useRemoteVision(enabled: boolean) {
  const [snapshot, setSnapshot] = useState<VisionSnapshot>(EMPTY_VISION);
  const lastSnapshotAtRef = useRef(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const channel = openDisplayChannel();
    if (!channel) return;

    channel.onmessage = (event: MessageEvent<DisplayMessage>) => {
      if (event.data?.type !== "vision") return;
      lastSnapshotAtRef.current = Date.now();
      setSnapshot(event.data.payload);
    };

    const staleTimer = window.setInterval(() => {
      if (
        lastSnapshotAtRef.current > 0
        && Date.now() - lastSnapshotAtRef.current > REMOTE_VISION_STALE_MS
      ) {
        setSnapshot((current) => ({
          ...current,
          faceDetected: false,
          facePresenceDurationMs: 0,
          faceCount: 0,
          currentGestures: [],
          isReady: false,
          error: "Waiting for the rear CV display.",
        }));
      }
    }, 1_000);

    return () => {
      window.clearInterval(staleTimer);
      channel.close();
    };
  }, [enabled]);

  const cleanup = useCallback(() => {}, []);

  return { ...snapshot, videoRef, cleanup };
}

export function useFrontDisplaySync(
  enabled: boolean,
  isSpeaking: boolean,
  character: CharacterSlug,
) {
  const channelRef = useRef<BroadcastChannel | null>(null);
  const commandRef = useRef<AvatarAnimationCommand>({
    state: "idle_standing",
    startedAt: 0,
    sequence: 0,
  });
  const sequenceRef = useRef(0);
  const speakingRef = useRef(isSpeaking);
  const characterRef = useRef(character);

  const publishCurrent = useCallback(() => {
    if (!enabled) return;
    channelRef.current?.postMessage({
      type: "avatar",
      command: commandRef.current,
      isSpeaking: speakingRef.current,
      character: characterRef.current,
    } satisfies DisplayMessage);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const channel = openDisplayChannel();
    if (!channel) return;
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent<DisplayMessage>) => {
      if (event.data?.type === "sync-request") publishCurrent();
    };
    publishCurrent();
    const heartbeat = window.setInterval(publishCurrent, 750);
    return () => {
      window.clearInterval(heartbeat);
      channelRef.current = null;
      channel.close();
    };
  }, [enabled, publishCurrent]);

  useEffect(() => {
    speakingRef.current = isSpeaking;
    publishCurrent();
  }, [isSpeaking, publishCurrent]);

  useEffect(() => {
    characterRef.current = character;
    publishCurrent();
  }, [character, publishCurrent]);

  const publishAvatarState = useCallback((state: AvatarAnimationState) => {
    sequenceRef.current += 1;
    commandRef.current = {
      state,
      startedAt: Date.now(),
      sequence: sequenceRef.current,
    };
    publishCurrent();
  }, [publishCurrent]);

  const publishLipSyncFrame = useCallback((frame: LipSyncFrame | null) => {
    if (!enabled) return;
    channelRef.current?.postMessage({
      type: "lipsync",
      frame,
    } satisfies DisplayMessage);
  }, [enabled]);

  return { publishAvatarState, publishLipSyncFrame };
}

export function useRearDisplaySync(enabled: boolean, vision: VisionState) {
  const channelRef = useRef<BroadcastChannel | null>(null);
  const visionRef = useRef(vision);
  const [avatarCommand, setAvatarCommand] = useState<AvatarAnimationCommand>({
    state: "idle_standing",
    startedAt: 0,
    sequence: 0,
  });
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [character, setCharacter] = useState<CharacterSlug | null>(null);
  const lipSyncFrameRef = useRef<LipSyncFrame | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const channel = openDisplayChannel();
    if (!channel) return;
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent<DisplayMessage>) => {
      if (event.data?.type === "lipsync") {
        lipSyncFrameRef.current = event.data.frame;
        return;
      }
      if (event.data?.type === "avatar") {
        const {
          command,
          isSpeaking: nextSpeaking,
          character: nextCharacter,
        } = event.data;
        setAvatarCommand((current) => (
          current.sequence === command.sequence
          && current.startedAt === command.startedAt
            ? current
            : command
        ));
        setIsSpeaking(nextSpeaking);
        if (isCharacterSlug(nextCharacter)) setCharacter(nextCharacter);
        if (!nextSpeaking) lipSyncFrameRef.current = null;
      }
    };
    channel.postMessage({ type: "sync-request" } satisfies DisplayMessage);
    postVisionSnapshot(channel, visionRef.current);
    const heartbeat = window.setInterval(() => {
      postVisionSnapshot(channel, visionRef.current);
    }, 1_000);
    return () => {
      window.clearInterval(heartbeat);
      channelRef.current = null;
      channel.close();
    };
  }, [enabled]);

  useEffect(() => {
    visionRef.current = vision;
    if (!enabled || !channelRef.current) return;
    postVisionSnapshot(channelRef.current, visionRef.current);
  }, [enabled, vision]);

  const getLipSyncFrame = useCallback(() => lipSyncFrameRef.current, []);

  return { avatarCommand, isSpeaking, character, getLipSyncFrame };
}
