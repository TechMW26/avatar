export const AVATAR_VISEMES = [
  "viseme_PP",
  "viseme_FF",
  "viseme_TH",
  "viseme_DD",
  "viseme_kk",
  "viseme_CH",
  "viseme_SS",
  "viseme_nn",
  "viseme_RR",
  "viseme_aa",
  "viseme_E",
  "viseme_I",
  "viseme_O",
  "viseme_U",
] as const;

export type AvatarViseme = (typeof AVATAR_VISEMES)[number];

export interface LipSyncFrame {
  viseme: AvatarViseme;
  intensity: number;
  sentAt: number;
}

export interface AudioAlignment {
  chars: string[];
  char_start_times_ms: number[];
  char_durations_ms: number[];
}

interface VisemeCue {
  viseme: AvatarViseme;
  intensity: number;
  startAt: number;
  endAt: number;
}

const SILENCE_THRESHOLD = 0.018;
const MAX_FALLBACK_INTENSITY = 0.52;
const ALIGNMENT_PLAYBACK_LEAD_MS = 45;
const ALIGNMENT_GRACE_MS = 120;
const MIN_CUE_DURATION_MS = 32;

const CLOSED_LIP_CHARS = new Set([
  "p", "b", "m",
  "प", "फ", "ब", "भ", "म",
]);
const LABIODENTAL_CHARS = new Set(["f", "v", "फ़", "व"]);
const DENTAL_CHARS = new Set([
  "t", "d",
  "त", "थ", "द", "ध", "ट", "ठ", "ड", "ढ",
]);
const VELAR_CHARS = new Set(["k", "g", "q", "क", "ख", "ग", "घ", "ङ"]);
const SIBILANT_CHARS = new Set(["s", "z", "x", "स", "श", "ष", "ज़"]);
const NASAL_CHARS = new Set(["n", "l", "ण", "न", "ञ", "ल", "ळ"]);
const RHOTIC_CHARS = new Set(["r", "र", "ऱ"]);
const CH_CHARS = new Set(["c", "j", "च", "छ", "ज", "झ"]);
const TH_CHARS = new Set(["थ", "ध"]);
const AA_CHARS = new Set(["a", "अ", "आ", "ा"]);
const E_CHARS = new Set(["e", "ए", "ऐ", "े", "ै"]);
const I_CHARS = new Set(["i", "y", "इ", "ई", "ि", "ी"]);
const O_CHARS = new Set(["o", "ओ", "औ", "ो", "ौ"]);
const U_CHARS = new Set(["u", "w", "उ", "ऊ", "ु", "ू"]);
const RR_CHARS = new Set(["ऋ", "ॠ", "ृ", "ॄ"]);
const CLOSED_OR_SILENT_PATTERN = /^[\s.,!?;:'"()[\]{}\-–—…।॥़्॒॑]+$/u;

function cueForCharacter(
  rawCharacter: string,
  nextCharacter = "",
): Pick<VisemeCue, "viseme" | "intensity"> {
  const character = rawCharacter.normalize("NFC").toLowerCase();
  const next = nextCharacter.normalize("NFC").toLowerCase();

  if (!character || CLOSED_OR_SILENT_PATTERN.test(character)) {
    return { viseme: "viseme_PP", intensity: 0.34 };
  }
  if (CLOSED_LIP_CHARS.has(character)) {
    return { viseme: "viseme_PP", intensity: 0.5 };
  }
  if (LABIODENTAL_CHARS.has(character)) {
    return { viseme: "viseme_FF", intensity: 0.3 };
  }
  if (
    TH_CHARS.has(character)
    || (character === "t" && next === "h")
  ) {
    return { viseme: "viseme_TH", intensity: 0.28 };
  }
  if (CH_CHARS.has(character)) {
    return { viseme: "viseme_CH", intensity: 0.3 };
  }
  if (DENTAL_CHARS.has(character)) {
    return { viseme: "viseme_DD", intensity: 0.26 };
  }
  if (VELAR_CHARS.has(character)) {
    return { viseme: "viseme_kk", intensity: 0.28 };
  }
  if (SIBILANT_CHARS.has(character)) {
    return { viseme: "viseme_SS", intensity: 0.26 };
  }
  if (NASAL_CHARS.has(character)) {
    return { viseme: "viseme_nn", intensity: 0.24 };
  }
  if (RHOTIC_CHARS.has(character) || RR_CHARS.has(character)) {
    return { viseme: "viseme_RR", intensity: 0.26 };
  }
  if (E_CHARS.has(character)) {
    return { viseme: "viseme_E", intensity: 0.4 };
  }
  if (I_CHARS.has(character)) {
    return { viseme: "viseme_I", intensity: 0.36 };
  }
  if (O_CHARS.has(character)) {
    return { viseme: "viseme_O", intensity: 0.45 };
  }
  if (U_CHARS.has(character)) {
    return { viseme: "viseme_U", intensity: 0.38 };
  }
  if (AA_CHARS.has(character)) {
    return { viseme: "viseme_aa", intensity: 0.46 };
  }
  if (character === "ह" || character === "h") {
    return { viseme: "viseme_aa", intensity: 0.3 };
  }
  if (character === "ं" || character === "ँ") {
    return { viseme: "viseme_PP", intensity: 0.4 };
  }
  return { viseme: "viseme_DD", intensity: 0.2 };
}

/**
 * Converts ElevenLabs' character-level audio alignment into deterministic
 * mouth poses. Timed closure cues are what spectrum-only lip sync cannot
 * recover reliably, especially for bilabial consonants such as P/B/M.
 */
export class PronunciationLipSync {
  private cues: VisemeCue[] = [];
  private queuedUntil = 0;

  enqueue(alignment: AudioAlignment, now = performance.now()): void {
    const count = Math.min(
      alignment.chars.length,
      alignment.char_start_times_ms.length,
      alignment.char_durations_ms.length,
    );
    if (count === 0) return;

    const chunkStart = Math.max(now + ALIGNMENT_PLAYBACK_LEAD_MS, this.queuedUntil);
    let chunkEnd = chunkStart;
    for (let index = 0; index < count; index += 1) {
      const relativeStart = Math.max(0, alignment.char_start_times_ms[index] ?? 0);
      const duration = Math.max(
        MIN_CUE_DURATION_MS,
        alignment.char_durations_ms[index] ?? 0,
      );
      const cue = cueForCharacter(
        alignment.chars[index] ?? "",
        alignment.chars[index + 1] ?? "",
      );
      const startAt = chunkStart + relativeStart;
      const endAt = startAt + duration;
      this.cues.push({ ...cue, startAt, endAt });
      chunkEnd = Math.max(chunkEnd, endAt);
    }
    this.queuedUntil = chunkEnd;
    this.cues = this.cues.filter((cue) => cue.endAt >= now - ALIGNMENT_GRACE_MS);
  }

  getFrame(now = performance.now()): LipSyncFrame | null {
    while (this.cues[0] && this.cues[0].endAt < now) this.cues.shift();
    const cue = this.cues.find((candidate) => (
      candidate.startAt <= now && candidate.endAt >= now
    ));
    if (cue) {
      return {
        viseme: cue.viseme,
        intensity: cue.intensity,
        sentAt: Date.now(),
      };
    }
    if (this.cues.length > 0 || now <= this.queuedUntil + ALIGNMENT_GRACE_MS) {
      return {
        viseme: "viseme_PP",
        intensity: 0.34,
        sentAt: Date.now(),
      };
    }
    return null;
  }

  clear(): void {
    this.cues = [];
    this.queuedUntil = 0;
  }
}

function averageRange(data: Uint8Array, startHz: number, endHz: number): number {
  if (data.length === 0) return 0;
  // ElevenLabs exposes its output analyser bins but not its sample rate.
  // Its WebAudio graph uses the browser-default 48 kHz rate, giving a
  // 24 kHz Nyquist range across this byte array.
  const nyquist = 24_000;
  const start = Math.max(0, Math.floor((startHz / nyquist) * data.length));
  const end = Math.min(data.length, Math.max(start + 1, Math.ceil((endHz / nyquist) * data.length)));
  let sum = 0;
  for (let index = start; index < end; index += 1) sum += data[index];
  return sum / ((end - start) * 255);
}

export function classifyViseme(
  data: Uint8Array | undefined,
): Omit<LipSyncFrame, "sentAt"> | null {
  if (!data?.length) return null;

  const bands = [
    averageRange(data, 50, 200),
    averageRange(data, 200, 400),
    averageRange(data, 400, 800),
    averageRange(data, 800, 1_500),
    averageRange(data, 1_500, 2_500),
    averageRange(data, 2_500, 4_000),
    averageRange(data, 4_000, 8_000),
  ];
  const spectralVolume = bands.reduce((sum, value) => sum + value, 0) / bands.length;
  if (spectralVolume < SILENCE_THRESHOLD) return null;

  const [bass, low, lowMid, mid, highMid, presence, brilliance] = bands;
  const voiced = low + lowMid + mid;
  const high = presence + brilliance;
  let viseme: AvatarViseme;

  if (high > voiced * 1.35 && brilliance > 0.08) {
    viseme = brilliance > presence * 1.15 ? "viseme_SS" : "viseme_FF";
  } else if (lowMid > low && lowMid > mid * 1.08) {
    viseme = "viseme_I";
  } else if (low > lowMid * 1.12 && mid > highMid) {
    viseme = "viseme_E";
  } else if (Math.abs(low - lowMid) < 0.08 && mid < lowMid * 0.9) {
    viseme = bass > low * 0.8 ? "viseme_U" : "viseme_O";
  } else if (mid > lowMid && mid > highMid) {
    viseme = "viseme_aa";
  } else if (presence > mid * 0.9) {
    viseme = "viseme_CH";
  } else if (bass > mid * 1.2) {
    viseme = "viseme_PP";
  } else {
    viseme = "viseme_DD";
  }

  return {
    viseme,
    // getOutputVolume() commonly sits near 1 during normal compressed TTS,
    // so it is unsuitable as a morph coefficient. The analyser is retained
    // only as a bounded fallback when alignment data is unavailable.
    intensity: Math.min(
      MAX_FALLBACK_INTENSITY,
      Math.max(0.14, 0.12 + Math.pow(spectralVolume / 0.55, 0.85) * 0.4),
    ),
  };
}
