"use client";

import { useEffect, useRef, useState } from "react";

export type EnvironmentalSoundName =
  | "dog_bark"
  | "cat_sound"
  | "door_knock"
  | "doorbell"
  | "clapping"
  | "siren"
  | "baby_cry"
  | "glass_breaking"
  | "thunder"
  | "laughter";

export interface EnvironmentalSoundEvent {
  name: EnvironmentalSoundName;
  label: string;
  confidence: number;
  timestamp: number;
}

interface Category {
  name: string;
  score: number;
}

interface EnvironmentalAudioOptions {
  enabled: boolean;
  suppressEvents?: boolean;
}

interface EnvironmentalAudioState {
  isReady: boolean;
  currentSound: EnvironmentalSoundEvent | null;
  error: string | null;
}

const STABLE_WINDOWS_REQUIRED = 2;
const SAME_EVENT_COOLDOWN_MS = 15_000;
const VISIBLE_EVENT_MS = 5_000;
const MIN_SCORE = 0.42;

const SOUND_PATTERNS: Array<{
  name: EnvironmentalSoundName;
  label: string;
  pattern: RegExp;
  threshold?: number;
}> = [
  { name: "dog_bark", label: "Dog barking", pattern: /\b(dog|bark|bow-wow|howl)\b/i },
  { name: "cat_sound", label: "Cat nearby", pattern: /\b(cat|meow|purr|caterwaul)\b/i },
  { name: "doorbell", label: "Doorbell", pattern: /doorbell|ding-dong/i },
  { name: "door_knock", label: "Knocking", pattern: /knock|tap(?:ping)? on (?:a )?surface/i },
  { name: "clapping", label: "Clapping", pattern: /clap|applause/i },
  { name: "siren", label: "Siren", pattern: /siren|emergency vehicle|alarm/i, threshold: 0.5 },
  { name: "baby_cry", label: "Baby crying", pattern: /baby cry|infant cry|crying, sobbing/i },
  { name: "glass_breaking", label: "Glass breaking", pattern: /glass.*(?:break|shatter)|shatter/i },
  { name: "thunder", label: "Thunder", pattern: /thunder/i },
  { name: "laughter", label: "Laughter", pattern: /laughter|giggle|chuckle/i, threshold: 0.52 },
];

function findRelevantSound(categories: Category[]): EnvironmentalSoundEvent | null {
  const speechScore = Math.max(
    0,
    ...categories
      .filter((category) => /speech|conversation|narration|human voice/i.test(category.name))
      .map((category) => category.score),
  );

  let best: EnvironmentalSoundEvent | null = null;
  for (const definition of SOUND_PATTERNS) {
    const score = Math.max(
      0,
      ...categories
        .filter((category) => definition.pattern.test(category.name))
        .map((category) => category.score),
    );
    const threshold = definition.threshold ?? MIN_SCORE;
    // Speech normally dominates the microphone. Require a clearly stronger
    // non-speech signal so ordinary conversation never becomes an event.
    if (score < threshold || (speechScore > 0.3 && score < speechScore * 1.15)) continue;
    if (!best || score > best.confidence) {
      best = {
        name: definition.name,
        label: definition.label,
        confidence: score,
        timestamp: Date.now(),
      };
    }
  }
  return best;
}

export function useEnvironmentalAudio({
  enabled,
  suppressEvents = false,
}: EnvironmentalAudioOptions): EnvironmentalAudioState {
  const [isReady, setIsReady] = useState(false);
  const [currentSound, setCurrentSound] = useState<EnvironmentalSoundEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const suppressEventsRef = useRef(suppressEvents);
  const candidateRef = useRef<{ name: EnvironmentalSoundName; count: number } | null>(null);
  const lastEmittedRef = useRef(new Map<EnvironmentalSoundName, number>());
  const clearTimerRef = useRef<number | null>(null);

  useEffect(() => {
    suppressEventsRef.current = suppressEvents;
  }, [suppressEvents]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      return;
    }

    let disposed = false;
    let stream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let captureNode: AudioWorkletNode | null = null;
    let fallbackNode: ScriptProcessorNode | null = null;
    let muteGain: GainNode | null = null;
    const worker = new Worker("/environment-audio-worker.js");

    const handleResult = (categories: Category[]) => {
      if (suppressEventsRef.current) {
        candidateRef.current = null;
        return;
      }
      const detected = findRelevantSound(categories);
      if (!detected) {
        candidateRef.current = null;
        return;
      }

      const prior = candidateRef.current;
      const count = prior?.name === detected.name ? prior.count + 1 : 1;
      candidateRef.current = { name: detected.name, count };
      if (count < STABLE_WINDOWS_REQUIRED) return;

      const lastEmittedAt = lastEmittedRef.current.get(detected.name) ?? 0;
      if (Date.now() - lastEmittedAt < SAME_EVENT_COOLDOWN_MS) return;
      lastEmittedRef.current.set(detected.name, Date.now());
      candidateRef.current = null;
      setCurrentSound(detected);
      if (clearTimerRef.current) window.clearTimeout(clearTimerRef.current);
      clearTimerRef.current = window.setTimeout(() => setCurrentSound(null), VISIBLE_EVENT_MS);
    };

    worker.onmessage = (event: MessageEvent) => {
      if (disposed) return;
      const message = event.data;
      if (message.type === "ready") {
        setIsReady(true);
        setError(null);
      } else if (message.type === "result") {
        handleResult(message.categories as Category[]);
      } else if (message.type === "error") {
        setError("Sound awareness unavailable");
        console.warn("[Environmental audio]", message.message);
      }
    };

    const start = async () => {
      try {
        worker.postMessage({ type: "init" });
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 1,
          },
          video: false,
        });
        if (disposed) return;

        audioContext = new AudioContext({ sampleRate: 16_000 });
        source = audioContext.createMediaStreamSource(stream);
        muteGain = audioContext.createGain();
        muteGain.gain.value = 0;
        const postSamples = (samples: ArrayBuffer) => {
          worker.postMessage(
            {
              type: "classify",
              samples,
              sampleRate: audioContext?.sampleRate ?? 16_000,
            },
            [samples],
          );
        };

        if (audioContext.audioWorklet) {
          const workletSource = `
            class EnvironmentCaptureProcessor extends AudioWorkletProcessor {
              constructor() {
                super();
                this.chunkSize = Math.round(sampleRate * 0.975);
                this.chunk = new Float32Array(this.chunkSize);
                this.offset = 0;
              }
              process(inputs) {
                const input = inputs[0] && inputs[0][0];
                if (!input) return true;
                let sourceOffset = 0;
                while (sourceOffset < input.length) {
                  const count = Math.min(input.length - sourceOffset, this.chunkSize - this.offset);
                  this.chunk.set(input.subarray(sourceOffset, sourceOffset + count), this.offset);
                  this.offset += count;
                  sourceOffset += count;
                  if (this.offset === this.chunkSize) {
                    const completed = this.chunk;
                    this.port.postMessage(completed.buffer, [completed.buffer]);
                    this.chunk = new Float32Array(this.chunkSize);
                    this.offset = 0;
                  }
                }
                return true;
              }
            }
            registerProcessor("environment-capture", EnvironmentCaptureProcessor);
          `;
          const workletUrl = URL.createObjectURL(new Blob([workletSource], { type: "text/javascript" }));
          try {
            await audioContext.audioWorklet.addModule(workletUrl);
          } finally {
            URL.revokeObjectURL(workletUrl);
          }
          if (disposed) return;
          captureNode = new AudioWorkletNode(audioContext, "environment-capture");
          captureNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => postSamples(event.data);
          source.connect(captureNode);
          captureNode.connect(muteGain);
        } else {
          // Legacy browser fallback. Classification still remains in the
          // worker; this node only forwards a one-second PCM buffer.
          fallbackNode = audioContext.createScriptProcessor(16_384, 1, 1);
          fallbackNode.onaudioprocess = (event) => {
            const samples = new Float32Array(event.inputBuffer.getChannelData(0));
            postSamples(samples.buffer);
          };
          source.connect(fallbackNode);
          fallbackNode.connect(muteGain);
        }
        muteGain.connect(audioContext.destination);
        await audioContext.resume();
      } catch (startError) {
        if (disposed) return;
        console.warn("[Environmental audio] failed to start", startError);
        setError("Sound awareness unavailable");
      }
    };

    void start();

    return () => {
      disposed = true;
      if (clearTimerRef.current) window.clearTimeout(clearTimerRef.current);
      captureNode?.disconnect();
      fallbackNode?.disconnect();
      source?.disconnect();
      muteGain?.disconnect();
      stream?.getTracks().forEach((track) => track.stop());
      void audioContext?.close();
      worker.terminate();
    };
  }, [enabled]);

  return {
    isReady: enabled && isReady,
    currentSound: enabled ? currentSound : null,
    error: enabled ? error : null,
  };
}
