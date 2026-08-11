"use client";
/* eslint-disable react-hooks/set-state-in-effect -- Browser media/bootstrap state is initialized and synchronized from effects. */

import { useState, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { motion, AnimatePresence } from "framer-motion";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import type { Conversation as ElevenLabsConversation } from "@elevenlabs/client";
import { useVisionDetection, buildGestureContext } from "../hooks/useVisionDetection";
import type { GestureInfo } from "../hooks/useVisionDetection";
import { useEnvironmentalAudio } from "../hooks/useEnvironmentalAudio";
import { useCameraFeed } from "../hooks/useCameraFeed";
import {
  preloadAvatarAssets,
  type PreloadProgress,
} from "../lib/avatarAssets";
import {
  getDisplayCameraSelector,
} from "../lib/cameraDevices";
import {
  useFrontDisplaySync,
} from "../lib/displaySync";
import {
  CHARACTER_STORAGE_KEY,
  getCharacter,
  getCharacterFromLocation,
  type CharacterProfile,
} from "../lib/characters";
import { getCharacterSystemPrompt } from "../lib/characterPrompts";
import {
  updateRemoteCharacter,
  useRemoteControlState,
} from "../hooks/useRemoteControl";
import { PronunciationLipSync } from "../lib/lipSync";

const Avatar3D = dynamic(() => import("../components/Avatar3D"), { ssr: false });
const AUTO_START_RETRY_DELAY_MS = 4000;
const AUTO_START_STORAGE_KEY = "rishi:auto-start-blocked-until";
const CONNECTION_TIMEOUT_MS = 10000;
const MIN_STABLE_CONNECTION_MS = 5000;  // connections shorter than this are "flaky"
const MAX_BACKOFF_MS = 30000;
// If a stable session disconnects and we reconnect within this window
// AND the user actually exchanged at least one turn, treat it as a
// continuation rather than a fresh greeting. Prevents "Namaste main
// rishi sandipani hu" from re-firing when the voice session
// transiently drops mid-conversation.
const RECONNECT_CONTINUATION_WINDOW_MS = 90_000;
// Mid-conversation no-face grace period. Previously 3s — too short
// for users who lean back, look down at notes, or step half a foot to
// the side. Long sessions were getting torn down and restarted with
// the full greeting.
const NO_FACE_AUTO_END_MS = 12_000;
const SHOW_CONVERSATION_CONTROLS = false;

type VisitorAddressPreference = "masculine" | "feminine";
type ConversationFailure = { message: string; terminal: boolean };

function classifyConversationFailure(message: string, context?: unknown): ConversationFailure {
  let details = "";
  try {
    details = context ? JSON.stringify(context) : "";
  } catch {
    // Ignore non-serializable SDK context.
  }
  const combined = `${message} ${details}`.toLocaleLowerCase();

  if (combined.includes("quota") || combined.includes("credits") || combined.includes("usage limit")) {
    return {
      message: "ElevenLabs voice quota is exhausted. Replenish the account quota, then reload this page.",
      terminal: true,
    };
  }
  if (
    combined.includes("unauthorized")
    || combined.includes("authentication")
    || combined.includes("agent not found")
    || combined.includes("invalid agent")
  ) {
    return {
      message: "The configured ElevenLabs agent is unavailable. Check its public access and agent ID.",
      terminal: true,
    };
  }
  return {
    message: "Voice connection interrupted. Reconnecting shortly…",
    terminal: false,
  };
}

function getExplicitAddressPreference(message: string): VisitorAddressPreference | null {
  const text = message.normalize("NFKC").trim();
  const femininePatterns = [
    /(?:^|\s)मैं\s+(?:एक\s+)?(?:महिला|लड़की|स्त्री|नारी)\s*(?:हूँ|हूं)(?:\s|$|[।,.!?])/u,
    /\b(?:i am|i'm)\s+(?:a\s+)?(?:woman|girl|female)\b/i,
    /\b(?:my pronouns are|use)\s+(?:she\s*\/\s*her|she-her)\b/i,
  ];
  const masculinePatterns = [
    /(?:^|\s)मैं\s+(?:एक\s+)?(?:पुरुष|आदमी|लड़का|नर)\s*(?:हूँ|हूं)(?:\s|$|[।,.!?])/u,
    /\b(?:i am|i'm)\s+(?:a\s+)?(?:man|boy|male)\b/i,
    /\b(?:my pronouns are|use)\s+(?:he\s*\/\s*him|he-him)\b/i,
  ];

  if (femininePatterns.some((pattern) => pattern.test(text))) return "feminine";
  if (masculinePatterns.some((pattern) => pattern.test(text))) return "masculine";
  return null;
}

function getAddressContext(
  preference: VisitorAddressPreference | null,
  characterSlug: CharacterProfile["slug"],
): string {
  if (!preference) {
    return "\n\nVISITOR ADDRESS:\nNo stable visitor-gender signal is currently available. Use respectful gender-neutral forms and never ask the visitor how to address them.";
  }
  const grammar = preference === "feminine" ? "feminine" : "masculine";
  const vocatives = characterSlug === "sandipani"
    ? preference === "feminine" ? "पुत्री or वत्से" : "पुत्र or वत्स"
    : characterSlug === "rani-laxmi-bai"
      ? preference === "feminine" ? "बहन or वीरांगना" : "भाई or वीर"
      : preference === "feminine" ? "भगिनी or वीरांगना" : "बंधु or वीर";
  return `\n\nVISITOR ADDRESS — LIVE SESSION CONTEXT:\nUse ${grammar} agreement whenever the active language marks the visitor's gender. Address them with the matching relational warmth and stature; in Hindi, character-fitting vocatives include ${vocatives}. Use a vocative only occasionally, never in every reply. In English and other languages, use the natural equivalent only when it would sound human. Never announce or discuss the detection, and never infer interests, abilities, duties, or temperament from gender.`;
}


function SoundWave({ active }: { active: boolean }) {
  return (
    <div className="flex items-center h-8" style={{ gap: 5 }}>
      {[...Array(7)].map((_, i) => (
        <div
          key={i}
          className={`rounded-full transition-all duration-300 ${
            active ? "bg-saffron-400 sound-bar" : "bg-gray-700"
          }`}
          style={{
            width: 4,
            height: active ? undefined : 8,
            animationDelay: active ? `${i * 0.1}s` : undefined,
          }}
        />
      ))}
    </div>
  );
}

function TalkPageContent({ character }: { character: CharacterProfile }) {
  const pronunciationLipSyncRef = useRef(new PronunciationLipSync());
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [retryWakeAt, setRetryWakeAt] = useState(0);
  const startInFlightRef = useRef(false);
  const autoStartArmedRef = useRef(true);
  const autoStartBlockedUntilRef = useRef(0);
  const hadSuccessfulConnectionRef = useRef(false);
  const conversationStatusRef = useRef<"disconnected" | "connecting" | "connected" | "error">("disconnected");
  const connectedAtRef = useRef<number>(0);  // timestamp when connection was established
  const consecutiveFailuresRef = useRef(0);  // for exponential backoff
  const faceAbsentSinceRef = useRef<number | null>(null);
  // Continuation tracking: when the user has actually exchanged turns
  // with the agent, we mark the session as "engaged". On a reconnect
  // soon after, we issue a brief resume line instead of the full
  // Namaste introduction.
  const lastStableDisconnectAtRef = useRef<number>(0);
  const sessionTurnsRef = useRef(0);  // user+ai messages exchanged in current session
  const lastSessionWasEngagedRef = useRef(false);
  const addressPreferenceRef = useRef<VisitorAddressPreference | null>(null);
  const explicitAddressPreferenceRef = useRef<VisitorAddressPreference | null>(null);
  const lastSessionErrorRef = useRef<{ message: string; context?: unknown } | null>(null);
  const retryScheduledRef = useRef(false);
  const activeConversationRef = useRef<ElevenLabsConversation | null>(null);
  const sessionTeardownStartedRef = useRef(false);
  const [conversationRetryBlocked, setConversationRetryBlocked] = useState(false);

  useEffect(() => {
    document.title = `${character.name} · Living History`;
  }, [character.name]);

  const blockAutoStart = useCallback((delayMs: number) => {
    const blockedUntil = Date.now() + delayMs;
    autoStartBlockedUntilRef.current = blockedUntil;
    setRetryWakeAt(blockedUntil);
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem(AUTO_START_STORAGE_KEY, String(blockedUntil));
    }
  }, []);

  // Asset preload state. We kick this off automatically on mount (no
  // "Tap to Begin" button) so the experience feels instant. Camera +
  // microphone permission prompts are handled organically by the
  // MediaPipe vision hook and the ElevenLabs SDK respectively — the
  // browser will queue them after the user's first interaction with the
  // page (or, on most platforms, immediately).
  const [bootStage, setBootStage] = useState<"loading" | "ready">("loading");
  const [bootError, setBootError] = useState<string | null>(null);
  const [preloadProgress, setPreloadProgress] = useState<PreloadProgress | null>(null);
  const bootInFlightRef = useRef(false);
  // The front page owns both physical cameras: the presentation camera is
  // visible behind the avatar while the CV camera feeds a hidden detector.
  // This keeps face-triggered conversations working even when `/talk/back`
  // is closed; the rear display can still open the CV camera for its feed.
  const dualDisplay = true;
  const frontCameraSelector = getDisplayCameraSelector("front");
  const cvCameraSelector = getDisplayCameraSelector("rear");
  const localVision = useVisionDetection({
    enabled: true,
    cameraSelector: cvCameraSelector,
    detectGender: true,
  });
  const frontCamera = useCameraFeed({
    enabled: dualDisplay,
    cameraSelector: frontCameraSelector,
  });
  const vision = localVision;
  const gestureHistoryRef = useRef<GestureInfo[]>([]);
  gestureHistoryRef.current = vision.gestureHistory;

  // AI-driven body gesture trigger. Two pathways feed this:
  //   1. ElevenLabs `clientTools.playGesture` (if the tool is registered
  //      in the agent dashboard — the LLM calls it directly).
  //   2. `onMessage` text scanning of the agent's spoken reply for
  //      keyword cues (always on, works even without the tool).
  // Both paths funnel through `triggerAiGesture` which bumps the nonce so
  // Avatar3D plays the gesture exactly once.
  const [aiGesture, setAiGesture] = useState<{ name: string; nonce: number } | null>(null);
  const triggerAiGesture = useCallback((name: string) => {
    setAiGesture({ name, nonce: Date.now() + Math.floor(Math.random() * 1000) });
  }, []);
  const lastAutoGestureNameRef = useRef<string | null>(null);
  const lastSuggestedGestureRef = useRef<string | null>(null);
  const lastAutoGestureAtRef = useRef(0);
  const pendingAutoGestureTimersRef = useRef<number[]>([]);
  const AUTO_GESTURE_MIN_GAP_MS = 2200;
  const AUTO_GESTURE_REPEAT_GAP_MS = 6500;

  const clearPendingAutoGestureTimers = useCallback(() => {
    pendingAutoGestureTimersRef.current.forEach((id) => window.clearTimeout(id));
    pendingAutoGestureTimersRef.current = [];
  }, []);

  const sanitizeAiSpeech = useCallback((raw: string): string => {
    if (!raw) return raw;
    let text = raw;
    const blockedPatterns: RegExp[] = [
      /पुत्र\s*(?:तुम|आप)\s*अभी\s*भी\s*यहाँ\s*हो\??/gi,
      /क्या\s*(?:तुम|आप)\s*अभी\s*भी\s*यहाँ\s*हो\??/gi,
      /are\s+you\s+still\s+there\??/gi,
      /still\s+there\??/gi,
    ];
    const hasBlocked = blockedPatterns.some((re) => re.test(text));
    if (!hasBlocked) return text;
    blockedPatterns.forEach((re) => {
      text = text.replace(re, "");
    });
    text = text.replace(/\s{2,}/g, " ").trim();
    if (!text) {
      return "अपनी बात का एक छोटा-सा उदाहरण दीजिए, ताकि हम वहीं से आगे बढ़ें।";
    }
    return text;
  }, []);

  const tryEmitAutoGesture = useCallback((name: string): boolean => {
    const now = Date.now();
    if (now - lastAutoGestureAtRef.current < AUTO_GESTURE_MIN_GAP_MS) return false;
    if (
      lastAutoGestureNameRef.current === name
      && now - lastAutoGestureAtRef.current < AUTO_GESTURE_REPEAT_GAP_MS
    ) {
      return false;
    }
    triggerAiGesture(name);
    lastAutoGestureNameRef.current = name;
    lastAutoGestureAtRef.current = now;
    return true;
  }, [triggerAiGesture]);

  /** Parse the AI reply and return the most semantically relevant gesture
   *  candidates (highest-score first). */
  const detectGestureCandidatesFromText = useCallback((raw: string): string[] => {
    const text = raw.toLowerCase().replace(/\s+/g, " ").trim();
    if (!text) return [];

    const scores = new Map<string, number>();
    const addScore = (name: string, weight: number) => {
      scores.set(name, (scores.get(name) ?? 0) + weight);
    };
    const hasIn = (hay: string, ...needles: string[]) => needles.some((n) => hay.includes(n));
    // Word-boundary check for short English tokens — prevents false hits
    // like "war" inside "toward"/"warm"/"forward" or "bow" in "bowl".
    const hasWord = (hay: string, ...words: string[]) =>
      words.some((w) => new RegExp(`(?:^|[^a-z])${w}(?:$|[^a-z])`, "i").test(hay));
    const clauses = text
      .split(/[.!?।\n]+/)
      .map((c) => c.trim())
      .filter(Boolean);

    clauses.forEach((clause) => {
      // Archery — require a CLEAR weapon/character mention.
      if (
        hasWord(clause, "bow", "arrow", "arrows", "archer", "archery")
        || hasIn(clause, "dhanurveda", "dhanush", "धनुष", "बाण", "तीर", "लक्ष्य")
        || hasIn(clause, "arjuna", "karna", "eklavya", "drona", "dronacharya",
                 "अर्जुन", "कर्ण", "एकलव्य", "द्रोण")
      ) addScore("shooting_arrow", 3);

      // Combat — word-bounded English to prevent "war" inside "toward".
      if (
        hasWord(clause, "sword", "mace", "battle", "warrior", "warriors", "combat", "duel")
        || hasIn(clause, "mahabharata", "kurukshetra", "bhima", "duryodhana",
                 "तलवार", "गदा", "युद्ध", "योद्धा", "महाभारत", "कुरुक्षेत्र", "भीम", "दुर्योधन")
      ) addScore("sword_fight", 3);

      // NOTE: `climbing` is intentionally NOT detected — it is reserved
      // exclusively for attract-mode (no visitor in front of camera).


      // Thoughtful — only on EXPLICIT pondering cues. A trailing "?"
      // alone was far too noisy (the sage asks reflective questions every
      // turn). Generic words like "विचार"/"शायद" also dropped — too common.
      if (hasIn(
        clause,
        "hmm", "hmmm", "let me think", "i wonder", "i ponder",
        "हम्म", "विचार करना", "सोचने दो", "चिंतन",
      )) addScore("thoughtful", 2.0);

      // Dismissing — explicit "let go" / "छोड़" only. Dropped generic
      // "त्याग"/"माया"/"भ्रम" — these appear in normal teaching prose.
      if (
        hasIn(clause, "छोड़ो", "छोड़ दो", "त्याग दो", "माया त्याग", "मत सोचो")
        || hasIn(clause, "let it go", "let go of", "set it aside", "forget it")
      ) addScore("dismissing", 2.4);

      // Pointing — explicit attention-direction phrases only. Bare
      // "देखो" appears in nearly every Hindi explanatory sentence.
      if (
        hasIn(clause, "यहाँ देखो", "वहाँ देखो", "इधर देखो", "उधर देखो", "ध्यान दो")
        || hasIn(clause, "look there", "look here", "behold", "this very")
      ) addScore("pointing", 2.1);

      // Left turn — explicit perspective-shift phrases. Dropped
      // "किंतु"/"परन्तु"/"however" — too common as ordinary connectives.
      if (
        hasIn(clause, "दूसरी ओर", "दूसरे दृष्टिकोण", "दूसरी दृष्टि")
        || hasIn(clause, "on the other hand", "but consider", "another way to see")
      ) addScore("left_turn", 1.9);

      // `explaining` is no longer auto-scored from common words like
      // "because"/"समझो"/"ज्ञान" — those fired on almost every sentence.
      // It now only fires as a fallback for substantial replies (below).
    });

    if (scores.size === 0) {
      // Generic explaining only for substantial paragraph-length replies.
      if (text.length >= 140) return ["explaining"];
      return [];
    }

    // Require a meaningful score (≥1.8) before triggering — anything
    // weaker is suppressed to avoid spurious gestures.
    const significant = Array.from(scores.entries())
      .filter(([, score]) => score >= 1.8)
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);

    if (!significant.length) {
      if (text.length >= 140) return ["explaining"];
      return [];
    }

    return significant.slice(0, 1);
  }, []);

  const getLivePrompt = useCallback(() => {
    const gestureCtx = buildGestureContext(gestureHistoryRef.current);
    const cameraPreference: VisitorAddressPreference | null = vision.userGender === "female"
      ? "feminine"
      : vision.userGender === "male"
        ? "masculine"
        : null;
    const effectivePreference = explicitAddressPreferenceRef.current
      ?? cameraPreference
      ?? addressPreferenceRef.current;
    const faceCtx = vision.faceDetected
      ? `\n\nLIVE CAMERA CONTEXT:\nThe visitor is present. Silence may mean they are thinking or have not finished speaking. Do not perform a presence check or invent an answer.`
      : "\n\nLIVE CAMERA CONTEXT:\nNo face is currently detected.";
    return getCharacterSystemPrompt(character.slug)
      + gestureCtx
      + faceCtx
      + getAddressContext(effectivePreference, character.slug);
  }, [character.slug, vision.faceDetected, vision.userGender]);

  const getFirstMessage = useCallback(() => {
    // Mid-conversation reconnect: if a recent stable session was
    // actually engaged (user spoke at least once), pick up where we
    // left off instead of restarting the whole introduction. Prevents
    // the jarring full identity-introduction loop
    // when ElevenLabs' voice session transiently drops mid-conversation.
    const since = Date.now() - lastStableDisconnectAtRef.current;
    if (
      lastSessionWasEngagedRef.current
      && lastStableDisconnectAtRef.current > 0
      && since < RECONNECT_CONTINUATION_WINDOW_MS
    ) {
      const continuations = character.greetings.continuations;
      return continuations[Math.floor(Math.random() * continuations.length)];
    }

    const gestures = gestureHistoryRef.current;
    const waved = gestures.some(g => g.name === "Open_Palm" && Date.now() - g.timestamp < 10_000);
    const thumbsUp = gestures.some(g => g.name === "Thumb_Up" && Date.now() - g.timestamp < 10_000);
    const peace = gestures.some(g => g.name === "Victory" && Date.now() - g.timestamp < 10_000);
    const namaste = gestures.some(g => g.name === "Namaste" && Date.now() - g.timestamp < 10_000);

    if (namaste) return character.greetings.namaste;
    if (waved) return character.greetings.wave;
    if (thumbsUp) return character.greetings.approval;
    if (peace) return character.greetings.peace;
    const welcomes = character.greetings.welcomes;
    return welcomes[Math.floor(Math.random() * welcomes.length)];
  }, [character]);

  const conversation = useConversation({
    onConnect: () => {
      console.log("[ElevenLabs] connected");
      sessionTeardownStartedRef.current = false;
      pronunciationLipSyncRef.current.clear();
      setConversationError(null);
      startInFlightRef.current = false;
      hadSuccessfulConnectionRef.current = true;
      connectedAtRef.current = Date.now();
      faceAbsentSinceRef.current = vision.faceDetected ? null : Date.now();
      retryScheduledRef.current = false;
      lastSessionErrorRef.current = null;
      // Reset per-session counters — these only count turns inside the
      // CURRENT live session. The prior session's engagement flag stays
      // on `lastSessionWasEngagedRef` to drive the continuation message.
      sessionTurnsRef.current = 0;
    },
    onDisconnect: (details) => {
      activeConversationRef.current = null;
      pronunciationLipSyncRef.current.clear();
      clearPendingAutoGestureTimers();
      const sessionDuration = connectedAtRef.current > 0 ? Date.now() - connectedAtRef.current : 0;
      const wasStable = sessionDuration >= MIN_STABLE_CONNECTION_MS;
      console.log(
        `[ElevenLabs] disconnected, hadSuccess: ${hadSuccessfulConnectionRef.current}, duration: ${sessionDuration}ms, stable: ${wasStable}, turns: ${sessionTurnsRef.current}`,
        details,
      );

      if (sessionTurnsRef.current > 0) {
        // If even the first greeting was delivered, resume on a transient
        // reconnect instead of replaying the greeting in a loop.
        lastStableDisconnectAtRef.current = Date.now();
        lastSessionWasEngagedRef.current = true;
      }

      const recordedError = lastSessionErrorRef.current;
      const failure = details.reason === "error"
        ? classifyConversationFailure(details.message, details)
        : recordedError
          ? classifyConversationFailure(recordedError.message, recordedError.context)
          : null;

      if (failure?.terminal) {
        autoStartArmedRef.current = false;
        retryScheduledRef.current = false;
        setConversationRetryBlocked(true);
        setConversationError(failure.message);
      } else if (failure || !wasStable) {
        consecutiveFailuresRef.current += 1;
        const backoff = Math.min(
          AUTO_START_RETRY_DELAY_MS * Math.pow(1.5, consecutiveFailuresRef.current),
          MAX_BACKOFF_MS,
        );
        console.warn(`[ElevenLabs] short-lived connection, backoff ${Math.round(backoff)}ms (attempt #${consecutiveFailuresRef.current})`);
        autoStartArmedRef.current = true;
        retryScheduledRef.current = true;
        blockAutoStart(backoff);
        setConversationError(failure?.message ?? "Connection lost. Will retry shortly.");
      } else {
        consecutiveFailuresRef.current = 0;
        // A deliberate user/agent ending must not immediately start another
        // greeting while the same face remains present. Leaving the camera
        // and returning re-arms auto-start through the face-presence effect.
        autoStartArmedRef.current = false;
        retryScheduledRef.current = false;
        setConversationError(null);
      }

      startInFlightRef.current = false;
      hadSuccessfulConnectionRef.current = false;
      connectedAtRef.current = 0;
      lastSessionErrorRef.current = null;
      sessionTeardownStartedRef.current = false;
    },
    onError: (error: string, context?: unknown) => {
      pronunciationLipSyncRef.current.clear();
      clearPendingAutoGestureTimers();
      console.error("[ElevenLabs] error:", error, context);
      const message = error || "Conversation connection failed";
      lastSessionErrorRef.current = { message, context };
      const failure = classifyConversationFailure(message, context);
      setConversationError(failure.message);
      if (failure.terminal) {
        autoStartArmedRef.current = false;
        setConversationRetryBlocked(true);
      }
      // ElevenLabs can emit a server error before its socket close event.
      // Stop microphone/audio pumps immediately so they cannot keep writing
      // packets into a socket that is already closing.
      if (
        (message.startsWith("Server error:") || failure.terminal)
        && !sessionTeardownStartedRef.current
      ) {
        sessionTeardownStartedRef.current = true;
        void activeConversationRef.current?.endSession().catch((endError) => {
          console.warn("[ElevenLabs] session teardown failed:", endError);
        });
      }
      // Do not reset timing or increment retries here. The SDK follows this
      // callback with onDisconnect; that is the single retry authority.
    },
    onStatusChange: ({ status }: { status: string }) => {
      console.log("[ElevenLabs] status:", status);
      conversationStatusRef.current = status as typeof conversationStatusRef.current;
      // If the SDK goes back to disconnected without onConnect/onDisconnect
      // firing (e.g. connection promise rejected), reset the in-flight flag
      // and block auto-start to prevent tight retry loops.
      if (status === "disconnected" && startInFlightRef.current) {
        console.warn("[ElevenLabs] connection failed (status→disconnected while in-flight)");
        startInFlightRef.current = false;
        if (!retryScheduledRef.current && !conversationRetryBlocked) {
          consecutiveFailuresRef.current += 1;
          const backoff = Math.min(
            AUTO_START_RETRY_DELAY_MS * Math.pow(1.5, consecutiveFailuresRef.current),
            MAX_BACKOFF_MS,
          );
          retryScheduledRef.current = true;
          autoStartArmedRef.current = true;
          blockAutoStart(backoff);
          setConversationError("Connection failed. Retrying shortly…");
        }
      }
    },
    onAudioAlignment: (alignment) => {
      pronunciationLipSyncRef.current.enqueue(alignment);
    },
    onInterruption: () => {
      pronunciationLipSyncRef.current.clear();
    },
    onModeChange: ({ mode }) => {
      if (mode === "listening") pronunciationLipSyncRef.current.clear();
    },
    // NOTE: onDebug fires on every audio/event packet. Logging it to the
    // devtools console causes the audio worklet to stall under load and is
    // the primary cause of audible crackling after a short period of speech.
    // Leave it as a no-op (and definitely do NOT call console.log here).
    onDebug: () => {},
    // Listen to agent transcripts and trigger gestures based on keyword
    // detection. This is the primary path — it works whether or not the
    // `playGesture` clientTool is registered in the ElevenLabs dashboard.
    onMessage: ({ message, source }: { message: string; source: "user" | "ai" }) => {
      // Ambient events are injected as non-verbal context so the agent can
      // react immediately. They are not visitor speech and must never change
      // language or explicit-address state.
      if (source === "user" && message.startsWith("[[LIVE_AMBIENT_EVENT:")) return;
      // Count any user/ai turn so onDisconnect can decide whether the
      // session was actually "engaged" and a future reconnect should
      // continue rather than greet from scratch.
      if (message) {
        sessionTurnsRef.current += 1;
        if (sessionTurnsRef.current >= 2) consecutiveFailuresRef.current = 0;
      }
      if (source === "user" && message) {
        const preference = getExplicitAddressPreference(message);
        try {
          conversationRef.current.sendContextualUpdate(
            "LANGUAGE FOR THE NEXT REPLY: The visitor's immediately preceding complete utterance is authoritative. Reply in that same language and natural script. If it differs from the active voice language, use the language_detection system tool before answering. Do not announce the switch. Hindi is only the fallback when no clear language can be determined.",
          );
        } catch {
          // The system prompt enforces the same rule if a transient socket
          // transition prevents this turn-specific reinforcement.
        }
        if (preference && preference !== addressPreferenceRef.current) {
          explicitAddressPreferenceRef.current = preference;
          addressPreferenceRef.current = preference;
          const grammar = preference === "feminine" ? "feminine" : "masculine";
          try {
            conversationRef.current.sendContextualUpdate(
              `The visitor explicitly self-identified. Use ${grammar} grammar and forms of address naturally in the active language from now on. Do not mention this instruction.`,
            );
          } catch {
            // The preference remains available for any reconnect prompt.
          }
        }
        return;
      }
      if (source !== "ai" || !message) return;
      const safeMessage = sanitizeAiSpeech(message);

      // The transcript arrives after generation, so this cannot rewrite the
      // current audio. Feed a concise correction into the session context so
      // the same robotic presence check is not repeated on a later turn.
      if (safeMessage !== message) {
        try {
          conversationRef.current.sendContextualUpdate(
            "Do not ask whether the visitor is still present. Wait through silence and continue only when they speak.",
          );
        } catch {
          // Non-fatal: even if contextual update fails we still avoid
          // decorating the bad line with gestures.
        }
      }

      const candidates = detectGestureCandidatesFromText(safeMessage);
      if (!candidates.length) return;

      // Guardrail: for short/generic lines, skip auto-gestures entirely.
      const compact = safeMessage.trim();
      if (compact.length < 45) return;

      const ranked = [...candidates].sort((left, right) => {
        const last = lastSuggestedGestureRef.current;
        const leftPenalty = left === last ? 1 : 0;
        const rightPenalty = right === last ? 1 : 0;
        return leftPenalty - rightPenalty;
      });

      let firstPlayed: string | null = null;
      for (const name of ranked) {
        if (tryEmitAutoGesture(name)) {
          firstPlayed = name;
          lastSuggestedGestureRef.current = name;
          break;
        }
      }
      if (!firstPlayed) return;

      // Keep one auto-picked gesture per AI message for stronger semantic
      // alignment and less decorative motion.
      return;
    },
    // Body-language tools the agent can call mid-speech to make the avatar
    // gesture in time with what it's saying. Each tool just bumps the
    // aiGesture nonce — Avatar3D handles cooldowns + state transitions.
    clientTools: {
      playGesture: ({ name }: { name: string }) => {
        // NOTE: `climbing` is deliberately excluded — it is reserved
        // exclusively for attract-mode (when no one is in front of the
        // camera) and must never fire mid-conversation.
        const allowed = new Set([
          "explaining",
          "yelling",
          "dismissing",
          "shooting_arrow",
          "thoughtful",
          "left_turn",
          "pointing",
          "sword_fight",
        ]);
        const normalized = String(name || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
        if (!allowed.has(normalized)) {
          console.warn("[ElevenLabs] playGesture: unknown gesture", name);
          return `unknown gesture: ${name}`;
        }
        // Tool-driven gestures should still feel graceful: if the same
        // motion was played just now, skip this one to avoid stutter.
        if (!tryEmitAutoGesture(normalized)) {
          return "skipped: cooldown";
        }
        return "ok";
      },
    },
  });

  const agentState: "off" | "starting" | "on" =
    conversation.status === "connected"
      ? "on"
      : conversation.status === "connecting"
        ? "starting"
        : "off";

  // conversationStatusRef is now kept in sync by onStatusChange callback

  const isSpeaking = conversation.isSpeaking;
  const environmentalAudio = useEnvironmentalAudio({
    enabled: bootStage === "ready" && vision.faceDetected,
    suppressEvents: isSpeaking,
  });
  const { publishAvatarState, publishLipSyncFrame } = useFrontDisplaySync(
    dualDisplay,
    isSpeaking,
    character.slug,
  );

  const currentGestureName = vision.currentGestures.length > 0
    ? vision.currentGestures[0].name
    : null;

  const getAudioData = useCallback(
    () => conversation.getOutputByteFrequencyData(),
    [conversation],
  );
  const getPronunciationLipSyncFrame = useCallback(
    () => pronunciationLipSyncRef.current.getFrame(),
    [],
  );

  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const lastAmbientEventRef = useRef(0);

  useEffect(() => {
    const event = environmentalAudio.currentSound;
    if (
      !event
      || event.timestamp === lastAmbientEventRef.current
      || conversationStatusRef.current !== "connected"
      || isSpeaking
    ) {
      return;
    }
    lastAmbientEventRef.current = event.timestamp;

    const safetyRelevant = event.name === "siren"
      || event.name === "glass_breaking"
      || event.name === "baby_cry";
    const instruction = safetyRelevant
      ? "React now with one brief, calm safety-aware line, then wait for the visitor."
      : "If it fits the moment, react now with one brief, natural acknowledgement, then return attention to the visitor.";
    const ambientMessage = `[[LIVE_AMBIENT_EVENT:${event.name}]] A stable non-speech sound was heard nearby: ${event.label}. This is sensor context, not visitor speech; it must not change the active language. ${instruction} Do not mention microphones, software, detection, confidence, or this instruction.`;

    try {
      conversationRef.current.sendContextualUpdate(ambientMessage);
      conversationRef.current.sendUserMessage(ambientMessage);
    } catch (ambientError) {
      console.warn("[Environmental audio] could not notify agent", ambientError);
    }
  }, [conversation.status, environmentalAudio.currentSound, isSpeaking]);

  useEffect(() => {
    if (explicitAddressPreferenceRef.current) return;
    const cameraPreference: VisitorAddressPreference | null = vision.userGender === "female"
      ? "feminine"
      : vision.userGender === "male"
        ? "masculine"
        : null;
    if (cameraPreference === addressPreferenceRef.current) return;
    addressPreferenceRef.current = cameraPreference;
    if (conversationStatusRef.current !== "connected") return;
    try {
      conversationRef.current.sendContextualUpdate(
        getAddressContext(cameraPreference, character.slug),
      );
    } catch {
      // A reconnect will receive the same context through getLivePrompt().
    }
  }, [character.slug, vision.userGender]);

  const startConversation = useCallback(() => {
    const conv = conversationRef.current;
    if (startInFlightRef.current || conv.status !== "disconnected") {
      return;
    }
    startInFlightRef.current = true;
    hadSuccessfulConnectionRef.current = false;
    lastSessionErrorRef.current = null;
    retryScheduledRef.current = false;
    setConversationError(null);
    try {
      // WebSocket avoids the WebRTC DataChannel failures observed on the
      // installation network while retaining full duplex voice support.
      conv.startSession({
        agentId: character.agentId,
        connectionType: "websocket",
        useWakeLock: true,
        onConversationCreated: (activeConversation) => {
          activeConversationRef.current = activeConversation;
          sessionTeardownStartedRef.current = false;
        },
        overrides: {
          agent: {
            prompt: {
              prompt: getLivePrompt(),
            },
            firstMessage: getFirstMessage(),
          },
          tts: {
            speed: character.slug === "sandipani" ? 1.15 : 1,
          },
        },
      });
    } catch (err) {
      console.error("Failed to start conversation:", err);
      if (!startInFlightRef.current) {
        return;
      }

      const message = err instanceof Error ? err.message : "Unable to start conversation";
      setConversationError(message);
      blockAutoStart(AUTO_START_RETRY_DELAY_MS);
      startInFlightRef.current = false;
    }
  }, [
    blockAutoStart,
    character.agentId,
    character.slug,
    getFirstMessage,
    getLivePrompt,
  ]);

  const endConversation = useCallback(() => {
    try {
      conversationRef.current.endSession();
    } catch (err) {
      console.error("Failed to end conversation:", err);
    }
  }, []);

  // Face-triggered auto-start
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const stored = Number(window.sessionStorage.getItem(AUTO_START_STORAGE_KEY) || 0);
    if (Number.isFinite(stored)) {
      autoStartBlockedUntilRef.current = stored;
      setRetryWakeAt(stored);
    }
  }, []);

  useEffect(() => {
    if (retryWakeAt === 0) {
      return;
    }

    const delayMs = retryWakeAt - Date.now();
    if (delayMs <= 0) {
      setRetryWakeAt(0);
      return;
    }

    const timer = window.setTimeout(() => {
      setRetryWakeAt(0);
    }, delayMs);

    return () => window.clearTimeout(timer);
  }, [retryWakeAt]);

  // Re-arm auto-start only after face has been ABSENT for at least 2 seconds.
  // This prevents face-detection flicker from re-arming during active sessions.
  const faceGoneSinceRef = useRef<number | null>(null);
  useEffect(() => {
    if (vision.faceDetected) {
      faceGoneSinceRef.current = null;
    } else {
      if (faceGoneSinceRef.current === null) {
        faceGoneSinceRef.current = Date.now();
      }
      const gone = Date.now() - faceGoneSinceRef.current;
      if (gone >= 2000) {
        autoStartArmedRef.current = true;
      }
    }
  }, [vision.faceDetected]);

  useEffect(() => {
    if (!autoStartArmedRef.current || conversationRetryBlocked) {
      return;
    }

    // Never auto-start speech before both boot prerequisites are ready:
    //   1) avatar assets preloaded
    //   2) vision detectors initialized
    if (bootStage !== "ready" || !vision.isReady) {
      return;
    }

    if (Date.now() < autoStartBlockedUntilRef.current) {
      return;
    }

    if (
      vision.faceDetected &&
      vision.facePresenceDurationMs >= 1500 &&
      conversation.status === "disconnected"
    ) {
      autoStartArmedRef.current = false;
      startConversation();
    }
  }, [
    bootStage,
    vision.isReady,
    vision.faceDetected,
    vision.facePresenceDurationMs,
    conversation.status,
    conversationRetryBlocked,
    retryWakeAt,
    startConversation,
  ]);

  // Connection timeout: if stuck in "connecting" for too long, give up.
  // Uses a ref for status checks to avoid re-triggering on every render.
  const timeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (conversation.status === "connecting") {
      if (timeoutIdRef.current === null) {
        timeoutIdRef.current = setTimeout(() => {
          timeoutIdRef.current = null;
          if (conversationStatusRef.current !== "connecting") return;
          setConversationError("Connection timed out. Tap to retry.");
          blockAutoStart(AUTO_START_RETRY_DELAY_MS);
          startInFlightRef.current = false;
          try { conversationRef.current.endSession(); } catch {}
        }, CONNECTION_TIMEOUT_MS);
      }
    } else {
      if (timeoutIdRef.current !== null) {
        clearTimeout(timeoutIdRef.current);
        timeoutIdRef.current = null;
      }
    }
  }, [blockAutoStart, conversation.status]);

  // Auto-end: if no face for NO_FACE_AUTO_END_MS and agent is on. The
  // window is intentionally generous (12s) — short pauses where the
  // user looks away or leans back used to tear down the session and
  // trigger a full re-greeting on reconnect.
  useEffect(() => {
    if (vision.faceDetected) {
      faceAbsentSinceRef.current = null;
      return;
    }
    if (faceAbsentSinceRef.current === null) {
      faceAbsentSinceRef.current = Date.now();
    }
    if (conversation.status !== "connected") return;

    const timer = setTimeout(() => {
      if (!vision.faceDetected && faceAbsentSinceRef.current !== null) {
        const elapsed = Date.now() - faceAbsentSinceRef.current;
        if (elapsed >= NO_FACE_AUTO_END_MS) {
          // User has truly left — clear the engagement flag so the next
          // visitor gets a fresh greeting, not a confusing continuation.
          lastSessionWasEngagedRef.current = false;
          lastStableDisconnectAtRef.current = 0;
          endConversation();
        }
      }
    }, Math.max(0, NO_FACE_AUTO_END_MS - (Date.now() - (faceAbsentSinceRef.current ?? Date.now()))));

    return () => clearTimeout(timer);
  }, [vision.faceDetected, conversation.status, endConversation]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearPendingAutoGestureTimers();
      blockAutoStart(AUTO_START_RETRY_DELAY_MS);
      try { conversationRef.current.endSession(); } catch {}
      vision.cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearPendingAutoGestureTimers]);

  /** Sequentially streams every avatar/animation asset (filtered by the
   *  device's tier) into Cache Storage with byte-level progress. Once
   *  this resolves, `<Avatar3D>` is mounted with a fully-warmed cache so
   *  every Suspense fetch returns instantly — keeping iOS Safari well
   *  below its tab memory ceiling.
   *
   *  Camera + microphone permissions are intentionally NOT requested
   *  here: the vision hook and the ElevenLabs SDK each request the
   *  permission they actually need at the moment they need it, which is
   *  the most familiar pattern for users on every platform.
   */
  const runPreload = useCallback(async () => {
    if (bootInFlightRef.current) return;
    bootInFlightRef.current = true;
    setBootError(null);
    setBootStage("loading");
    setPreloadProgress({
      ratio: 0,
      currentIndex: 0,
      totalAssets: 1,
      currentPath: "",
      loadedBytes: 0,
      totalBytes: 1,
    });

    try {
      await preloadAvatarAssets(
        (p) => setPreloadProgress(p),
        undefined,
        undefined,
        character.modelPath,
      );
      setBootStage("ready");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load avatar assets";
      console.error("[Boot] preload failed:", err);
      setBootError(msg);
    } finally {
      bootInFlightRef.current = false;
    }
  }, [character.modelPath]);

  // Kick off the preload as soon as the page mounts. No "Tap to Begin"
  // gate — the preloader streams sequentially so it doesn't OOM mobile
  // Safari, and the camera/mic prompts fire naturally when the vision
  // hook and ElevenLabs SDK start.
  useEffect(() => {
    void runPreload();
  }, [runPreload]);

  return (
    <div className="h-screen flex flex-col" style={{ background: "transparent", position: "relative", overflow: "hidden" }}>
      {/* Live camera feed as full-screen background (also used for face/gesture detection) */}
      <video
        ref={frontCamera.videoRef}
        playsInline
        muted
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          pointerEvents: "none",
          zIndex: 0,
        }}
      />
      <video
        ref={vision.videoRef}
        autoPlay
        playsInline
        muted
        aria-hidden="true"
        style={{
          position: "fixed",
          width: 1,
          height: 1,
          left: -10,
          bottom: -10,
          opacity: 0,
          pointerEvents: "none",
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

      {/* Vision Detection Status Indicator */}
      <div
        className="vision-status-container"
        style={{
          position: "absolute",
          top: 24,
          right: 24,
          zIndex: 20,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          alignItems: "flex-end",
        }}
      >
        {/* Face detection indicator */}
        <motion.div
          className="flex items-center rounded-full"
          style={{
            gap: 6,
            padding: "6px 12px",
            background: vision.faceDetected ? "rgba(255,153,51,0.12)" : "rgba(255,255,255,0.05)",
            border: `1px solid ${vision.faceDetected ? "rgba(255,153,51,0.3)" : "rgba(255,255,255,0.08)"}`,
            backdropFilter: "blur(12px)",
          }}
          animate={{ opacity: vision.isReady ? 1 : 0.4 }}
        >
          <span
            className="rounded-full"
            style={{
              width: 6,
              height: 6,
              background: vision.faceDetected ? "#FF9933" : "#6b7280",
              boxShadow: vision.faceDetected ? "0 0 8px #FF9933" : "none",
            }}
          />
          <span style={{ fontSize: 10, fontWeight: 600, color: vision.faceDetected ? "#FFB366" : "var(--text-3)" }}>
            {!vision.isReady
              ? vision.error ?? "Loading vision…"
              : vision.faceDetected
              ? `Face detected${vision.faceCount > 1 ? ` (${vision.faceCount})` : ""}`
              : "No face detected"}
          </span>
        </motion.div>

        <AnimatePresence>
          {vision.faceDetected && (
            <motion.div
              key="detected-gender"
              role="status"
              aria-live="polite"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="rounded-full"
              style={{
                padding: "5px 10px",
                background: "rgba(0,0,0,0.34)",
                border: "1px solid rgba(255,255,255,0.12)",
                backdropFilter: "blur(12px)",
                fontSize: 9,
                fontWeight: 600,
                color: vision.userGender === "unknown" ? "var(--text-3)" : "rgba(255,255,255,0.82)",
              }}
            >
              {vision.userGender === "unknown"
                ? "Detecting gender…"
                : `${vision.userGender === "female" ? "Female" : "Male"} detected`}
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {vision.faceDetected && (environmentalAudio.isReady || environmentalAudio.error) && (
            <motion.div
              key="environment-awareness"
              role="status"
              aria-live="polite"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="rounded-full"
              style={{
                padding: "5px 10px",
                background: environmentalAudio.currentSound
                  ? "rgba(255,153,51,0.14)"
                  : "rgba(0,0,0,0.34)",
                border: `1px solid ${environmentalAudio.currentSound
                  ? "rgba(255,153,51,0.3)"
                  : "rgba(255,255,255,0.12)"}`,
                backdropFilter: "blur(12px)",
                fontSize: 9,
                fontWeight: 600,
                color: environmentalAudio.error ? "#fca5a5" : "rgba(255,255,255,0.82)",
              }}
            >
              {environmentalAudio.error
                ? environmentalAudio.error
                : environmentalAudio.currentSound?.label ?? "Aware of surroundings"}
            </motion.div>
          )}
        </AnimatePresence>

        {dualDisplay && frontCamera.error && (
          <div
            role="alert"
            className="rounded-full"
            style={{
              padding: "6px 12px",
              background: "rgba(239,68,68,0.14)",
              border: "1px solid rgba(239,68,68,0.3)",
              backdropFilter: "blur(12px)",
              fontSize: 10,
              color: "#fca5a5",
            }}
          >
            Front camera: {frontCamera.error}
          </div>
        )}

        {/* Gesture indicators */}
        <AnimatePresence>
          {vision.currentGestures.map((g) => (
            <motion.div
              key={`${g.name}-${Math.round(g.timestamp / 100)}`}
              className="flex items-center rounded-full"
              style={{
                gap: 6,
                padding: "6px 12px",
                background: "rgba(255,153,51,0.12)",
                border: "1px solid rgba(255,153,51,0.3)",
                backdropFilter: "blur(12px)",
              }}
              initial={{ opacity: 0, x: 20, scale: 0.8 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 20, scale: 0.8 }}
            >
              <span style={{ fontSize: 12 }}>
                {g.name === "Open_Palm" ? "\uD83D\uDC4B" : g.name === "Thumb_Up" ? "\uD83D\uDC4D" : g.name === "Thumb_Down" ? "\uD83D\uDC4E" : g.name === "Victory" ? "\u270C\uFE0F" : g.name === "ILoveYou" ? "\uD83E\uDD1F" : g.name === "Closed_Fist" ? "\u270A" : g.name === "Pointing_Up" ? "\u261D\uFE0F" : g.name === "Namaste" ? "\uD83D\uDE4F" : g.name === "Photo_Pose" ? "\uD83D\uDCF8" : "\uD83D\uDD90\uFE0F"}
              </span>
              <span style={{ fontSize: 10, fontWeight: 600, color: "#FFB366" }}>
                {g.label}
              </span>
            </motion.div>
          ))}
        </AnimatePresence>

        {/* Waiting for face indicator */}
        {agentState === "off" && vision.isReady && !vision.faceDetected && (
          <motion.div
            className="rounded-full"
            style={{
              padding: "6px 12px",
              background: "rgba(255,153,51,0.1)",
              border: "1px solid rgba(255,153,51,0.2)",
              backdropFilter: "blur(12px)",
              fontSize: 10,
              fontWeight: 600,
              color: "#FFB366",
            }}
            animate={{ opacity: [0.5, 1, 0.5] }}
            transition={{ duration: 2, repeat: Infinity }}
          >
            Step in front of camera to start
          </motion.div>
        )}

        {/* Face detected progress */}
        {agentState === "off" && vision.faceDetected && vision.facePresenceDurationMs < 1500 && (
          <motion.div
            className="flex items-center rounded-full"
            style={{
              gap: 6,
              padding: "6px 12px",
              background: "rgba(255,193,7,0.12)",
              border: "1px solid rgba(255,193,7,0.3)",
              backdropFilter: "blur(12px)",
            }}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" style={{ animation: "spin 1.5s linear infinite" }}>
              <circle cx="7" cy="7" r="5.5" fill="none" stroke="rgba(255,193,7,0.2)" strokeWidth="2" />
              <path d={`M7 1.5a5.5 5.5 0 0 1 ${5.5 * Math.sin((vision.facePresenceDurationMs / 1500) * Math.PI * 2)} ${5.5 - 5.5 * Math.cos((vision.facePresenceDurationMs / 1500) * Math.PI * 2)}`} fill="none" stroke="#FFC107" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span style={{ fontSize: 10, fontWeight: 600, color: "#FFC107" }}>
              Starting in {Math.max(0, Math.ceil((1500 - vision.facePresenceDurationMs) / 100) / 10)}s...
            </span>
          </motion.div>
        )}
      </div>

      {/* Full-screen avatar canvas. Only mount once the boot preloader
          has warmed Cache Storage with every asset; otherwise iOS Safari
          tries to download + parse 17 FBX/JSON files in parallel via
          Suspense and the tab gets killed for memory ("A problem
          repeatedly occurred"). */}
      <div
        className="talk-avatar-container"
        style={{ position: "absolute", inset: 0, zIndex: 2 }}
      >
        {bootStage === "ready" ? (
          <Avatar3D
            avatarUrl={character.modelPath}
            isSpeaking={isSpeaking}
            getAudioData={getAudioData}
            getLipSyncFrame={getPronunciationLipSyncFrame}
            onLipSyncFrame={publishLipSyncFrame}
            gesture={currentGestureName}
            userSmile={vision.userSmile}
            faceDetected={vision.faceDetected}
            aiGesture={aiGesture}
            syncMode="leader"
            viewMode="front"
            cameraVideoRef={dualDisplay ? frontCamera.videoRef : vision.videoRef}
            onAnimationStateChange={publishAvatarState}
          />
        ) : null}
      </div>

      {SHOW_CONVERSATION_CONTROLS && (agentState === "on" ? (
        <div
          className="talk-controls-overlay"
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            width: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "clamp(6px, 1vh, 14px)",
            padding: "0 24px clamp(24px, 4vh, 48px)",
            zIndex: 10,
          }}
        >
          <SoundWave active={isSpeaking} />

          <AnimatePresence mode="wait">
            <motion.div
              key={isSpeaking ? "speaking" : "listening"}
              className="text-center"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
            >
              <p className="font-semibold" style={{ fontSize: "clamp(14px, 1.4vw, 20px)", color: isSpeaking ? "#FFB366" : "var(--text-2)" }}>
                {isSpeaking ? "\u0917\u0941\u0930\u0941\u091C\u0940 \u092C\u094B\u0932 \u0930\u0939\u0947 \u0939\u0948\u0902..." : "\u0938\u0941\u0928 \u0930\u0939\u0947 \u0939\u0948\u0902..."}
              </p>
              <p style={{ fontSize: "clamp(11px, 1vw, 14px)", color: "var(--text-3)", marginTop: 4 }}>
                {isSpeaking ? "Guruji is speaking" : "Speak naturally, Guruji is listening"}
              </p>
            </motion.div>
          </AnimatePresence>

          <motion.button
            onClick={endConversation}
            className="flex items-center cursor-pointer font-semibold"
            style={{
              gap: 10, padding: "clamp(10px, 1.2vh, 16px) clamp(20px, 2.5vw, 36px)", borderRadius: 50,
              background: "rgba(239,68,68,0.12)", color: "#f87171",
              border: "1px solid rgba(239,68,68,0.25)", fontSize: "clamp(12px, 1.1vw, 15px)",
            }}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
            End Conversation
          </motion.button>
        </div>
      ) : (
        <div
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 10,
            display: "flex",
            justifyContent: "center",
            padding: "0 16px clamp(18px, 3.2vh, 36px)",
            pointerEvents: "none",
          }}
        >
          <AnimatePresence mode="wait">
            <motion.div
              key={agentState}
              className="text-center"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              style={{
                width: "min(94vw, 460px)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "clamp(10px, 1.6vh, 16px)",
                padding: "clamp(12px, 1.6vh, 18px) clamp(14px, 2vw, 22px)",
                borderRadius: 18,
                background: "rgba(15,10,6,0.68)",
                border: "1px solid rgba(255,153,51,0.18)",
                boxShadow: "0 10px 30px rgba(0,0,0,0.28)",
                backdropFilter: "blur(14px)",
                WebkitBackdropFilter: "blur(14px)",
                pointerEvents: "auto",
              }}
            >
              <div className="text-center">
                {agentState === "off" ? (
                  <>
                    <p className="font-semibold" style={{ fontSize: "clamp(14px, 1.4vw, 18px)", color: "var(--text-2)" }}>
                      {vision.isReady ? "\u0917\u0941\u0930\u0941\u0915\u0941\u0932 \u092E\u0947\u0902 \u0906\u092A\u0915\u093E \u0938\u094D\u0935\u093E\u0917\u0924 \u0939\u0948..." : "Initializing camera..."}
                    </p>
                    <p style={{ fontSize: "clamp(11px, 0.95vw, 13px)", color: "var(--text-3)", marginTop: 4 }}>
                      {conversationError
                        ? conversationError
                        : vision.isReady
                          ? vision.faceDetected
                            ? "\u0917\u0941\u0930\u0941\u091C\u0940 \u0938\u0947 \u0938\u0902\u092A\u0930\u094D\u0915 \u0939\u094B \u0930\u0939\u093E \u0939\u0948..."
                            : "Step in front of the camera to begin"
                          : "Setting up face detection"}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="font-semibold" style={{ fontSize: "clamp(14px, 1.4vw, 18px)", color: "var(--text-2)" }}>Connecting...</p>
                    <p style={{ fontSize: "clamp(11px, 0.95vw, 13px)", color: "var(--text-3)", marginTop: 4 }}>{"\u0917\u0941\u0930\u0941\u091C\u0940 \u0938\u0947 \u0938\u0902\u092A\u0930\u094D\u0915 \u0939\u094B \u0930\u0939\u093E \u0939\u0948"}</p>
                  </>
                )}
              </div>

              {agentState === "off" ? (
                <motion.div
                  className="flex items-center font-semibold"
                  style={{
                    gap: 8, padding: "clamp(10px, 1.1vh, 14px) clamp(16px, 2vw, 24px)", borderRadius: 999,
                    background: "rgba(255,153,51,0.08)", color: "#FFB366",
                    border: "1px solid rgba(255,153,51,0.2)", fontSize: "clamp(12px, 1vw, 14px)",
                  }}
                  animate={{ opacity: vision.faceDetected ? [0.6, 1, 0.6] : 1 }}
                  transition={{ duration: 1.5, repeat: vision.faceDetected ? Infinity : 0 }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                  </svg>
                  {vision.faceDetected ? "Detected \u2014 starting..." : "Waiting for you..."}
                </motion.div>
              ) : (
                <motion.div
                  className="flex items-center font-semibold"
                  style={{
                    gap: 8, padding: "clamp(10px, 1.1vh, 14px) clamp(16px, 2vw, 24px)", borderRadius: 999,
                    background: "rgba(255,153,51,0.08)", color: "#FFB366",
                    border: "1px solid rgba(255,153,51,0.2)", fontSize: "clamp(12px, 1vw, 14px)",
                  }}
                  animate={{ opacity: [0.5, 1, 0.5] }}
                  transition={{ duration: 1.5, repeat: Infinity }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" style={{ animation: "spin 1.2s linear infinite" }}>
                    <circle cx="12" cy="12" r="9" fill="none" stroke="rgba(255,179,102,0.2)" strokeWidth="2.5" />
                    <path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke="#FFB366" strokeWidth="2.5" strokeLinecap="round" />
                  </svg>
                  Connecting...
                </motion.div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      ))}

      {/* Boot overlay: covers the whole viewport while we sequentially
          preload the avatar/animation assets into Cache Storage. Without
          this gate, mobile Safari would parallel-fetch all 17 files via
          Suspense and the tab gets killed for memory ("A problem
          repeatedly occurred"). The preload starts automatically on
          mount; on retry after an error the same button kicks it off. */}
      <AnimatePresence>
        {bootStage !== "ready" && (
          <motion.div
            key="boot-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 50,
              background: "transparent",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: 24,
            }}
          >
            <div
              style={{
                width: "min(92vw, 460px)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 22,
                padding: "32px 26px",
                borderRadius: 20,
                background: "rgba(20,14,8,0.78)",
                border: "1px solid rgba(255,153,51,0.22)",
                boxShadow: "0 18px 48px rgba(0,0,0,0.5)",
                backdropFilter: "blur(18px)",
                WebkitBackdropFilter: "blur(18px)",
                textAlign: "center",
              }}
            >
              <div style={{ fontSize: 48, lineHeight: 1 }}>🙏</div>
              <div>
                <p style={{ fontSize: 18, fontWeight: 700, color: "var(--text-1, #f5e9d8)", margin: 0 }}>
                  {character.hindiName} से संवाद
                </p>
                <p style={{ fontSize: 13, color: "var(--text-3, #b8a890)", marginTop: 6 }}>
                  Preparing {character.name}
                </p>
              </div>

              <div style={{ width: "100%" }}>
                <div
                  style={{
                    width: "100%",
                    height: 8,
                    borderRadius: 999,
                    background: "rgba(255,255,255,0.08)",
                    overflow: "hidden",
                  }}
                >
                  <motion.div
                    animate={{ width: `${Math.round((preloadProgress?.ratio ?? 0) * 100)}%` }}
                    transition={{ ease: "easeOut", duration: 0.25 }}
                    style={{
                      height: "100%",
                      background: "linear-gradient(90deg, #E65100, #FF9933, #FFB366)",
                      borderRadius: 999,
                    }}
                  />
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginTop: 10,
                    fontSize: 11,
                    color: "var(--text-3, #b8a890)",
                  }}
                >
                  <span>{Math.round((preloadProgress?.ratio ?? 0) * 100)}%</span>
                  <span>
                    {preloadProgress
                      ? `${(preloadProgress.loadedBytes / 1024 / 1024).toFixed(1)} / ${(preloadProgress.totalBytes / 1024 / 1024).toFixed(1)} MB`
                      : "0 MB"}
                  </span>
                </div>
              </div>
              <p style={{ fontSize: 11, color: "var(--text-3, #b8a890)", margin: 0, minHeight: 16 }}>
                {preloadProgress?.currentPath
                  ? `Loading ${preloadProgress.currentPath.replace(/^\//, "")}…`
                  : "Preparing…"}
              </p>
              {bootError && (
                <>
                  <p style={{ fontSize: 11, color: "#ff8a8a", margin: 0, lineHeight: 1.5 }}>
                    {bootError}
                  </p>
                  <motion.button
                    onClick={runPreload}
                    className="font-semibold text-white"
                    style={{
                      padding: "10px 24px",
                      borderRadius: 999,
                      background: "linear-gradient(135deg, #E65100, #FF9933)",
                      boxShadow: "0 6px 18px rgba(255,153,51,0.28)",
                      border: "none",
                      fontSize: 13,
                      cursor: "pointer",
                    }}
                    whileHover={{ scale: 1.04 }}
                    whileTap={{ scale: 0.96 }}
                  >
                    Retry
                  </motion.button>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function TalkPage() {
  const [character, setCharacter] = useState<CharacterProfile | null>(null);
  const remoteControl = useRemoteControlState(Boolean(character));

  useEffect(() => {
    const navigationEntry = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (navigationEntry?.type === "reload") {
      window.localStorage.removeItem(CHARACTER_STORAGE_KEY);
      void updateRemoteCharacter(null, "display-refresh").finally(() => {
        const selectionUrl = new URL("/", window.location.origin);
        window.location.replace(selectionUrl);
      });
      return;
    }

    const selected = getCharacterFromLocation();
    window.localStorage.setItem(CHARACTER_STORAGE_KEY, selected.slug);
    setCharacter(selected);
  }, []);

  useEffect(() => {
    if (!character || !remoteControl.state) return;

    if (!remoteControl.state.character) {
      window.localStorage.removeItem(CHARACTER_STORAGE_KEY);
      const selectionUrl = new URL("/", window.location.origin);
      window.location.replace(selectionUrl);
      return;
    }

    if (remoteControl.state.character !== character.slug) {
      const selected = getCharacter(remoteControl.state.character);
      window.localStorage.setItem(CHARACTER_STORAGE_KEY, selected.slug);
      const talkUrl = new URL("/talk", window.location.origin);
      talkUrl.searchParams.set("character", selected.slug);
      window.location.replace(talkUrl);
    }
  }, [character, remoteControl.state]);

  if (!character) {
    return <main style={{ minHeight: "100dvh", background: "#090705" }} />;
  }

  if (!character.agentId) {
    return (
      <main
        role="alert"
        style={{
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          padding: 24,
          background: "#090705",
          color: "#ffd6ad",
          textAlign: "center",
        }}
      >
        ElevenLabs agent is not configured for {character.name}.
      </main>
    );
  }

  return (
    <ConversationProvider key={character.slug} agentId={character.agentId}>
      <TalkPageContent character={character} />
    </ConversationProvider>
  );
}
