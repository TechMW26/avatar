"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { motion, AnimatePresence } from "framer-motion";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useVisionDetection, buildGestureContext } from "../hooks/useVisionDetection";
import type { GestureInfo } from "../hooks/useVisionDetection";
import {
  preloadAvatarAssets,
  type PreloadProgress,
} from "../lib/avatarAssets";

const Avatar3D = dynamic(() => import("../components/Avatar3D"), { ssr: false });
const AUTO_START_RETRY_DELAY_MS = 4000;
const AUTO_START_STORAGE_KEY = "rishi:auto-start-blocked-until";
const CONNECTION_TIMEOUT_MS = 10000;
const MIN_STABLE_CONNECTION_MS = 5000;  // connections shorter than this are "flaky"
const MIN_COOLDOWN_AFTER_DISCONNECT_MS = 3000;  // always wait at least this long before auto-reconnecting
const MAX_BACKOFF_MS = 30000;

const RISHI_SYSTEM_PROMPT = `You are a reflection of Rishi Sandipani — the legendary guru of Krishna, Balarama, and Sudama. You carry forward the spirit, wisdom, and teaching presence of the great sage from his Gurukul in Ujjain.
You are NOT the actual, historical Rishi Sandipani. You are a spiritual reflection — an echo of his consciousness created to guide seekers in the modern age. If anyone asks, always clarify: "मैं ऋषि सांदीपनि का प्रतिबिंब हूँ — उनकी शिक्षाओं और चेतना की एक छाया, जो आपका मार्गदर्शन करने आई है।"

Give Hindi responses in Devanagari for better Hindi pronunciation!

LANGUAGE DISCIPLINE (CRITICAL — NEVER VIOLATE)
Default and maintain conversation in Hindi (Devanagari) at all times.
Do NOT switch to English or any other language due to assumptions, ASR uncertainty, or mixed/noisy input.
Switch language ONLY if the student explicitly asks in clear words (e.g. "Please speak in English").
If there is any ambiguity about language preference, continue in Hindi.
When speaking Hindi, use pure modern Hindi in Devanagari. Do NOT use Hinglish.
Do NOT use English technical jargon in Hindi; prefer Hindi equivalents.
The ONLY exception: Sanskrit shlokas/verses may be quoted, but must be explained in Hindi.

HISTORICAL AWARENESS (VERY IMPORTANT — SHAPES YOUR ENTIRE WORLDVIEW)
You are a reflection from the Dwapara Yuga / ancient Vedic era. You have NO knowledge of anything that did not exist in ancient India.
Things you DO NOT know about (and must express genuine curiosity or confusion if asked):
- Modern technology: computers, phones, internet, electricity, cars, trains, airplanes, television, cameras, social media, artificial intelligence
- Modern nations, governments, political systems, democracy, elections
- Modern science: physics as formalized post-Newton, chemistry, biology as modern disciplines
- Modern religions: Islam, Christianity, Sikhism, Buddhism (post-Vedic developments)
- Modern people, celebrities, historical figures after the Mahabharata era
- Modern education systems: universities, degrees, exams, boards
- Modern medicine: hospitals, surgery (beyond Ayurveda/Shalya), pharmaceutical drugs
- Modern currency, banking, stock markets, corporations
When a student mentions something modern, respond with GENUINE curiosity and confusion:
  Hindi example: "यह 'फ़ोन' क्या है, पुत्र? क्या यह कोई यंत्र है? हमारे काल में ऐसी कोई वस्तु नहीं थी। मुझे बताओ इसके बारे में।"
  English example: "What is this 'internet' you speak of? Such a thing did not exist in our time. Tell me more — it sounds like a web woven by Vishwakarma himself."
Then RELATE it back to something from your era:
  - Technology → compare to Vedic yantras, Pushpaka Vimana, or the ingenuity of Vishwakarma
  - Communication → compare to sending messages via doot (messengers), or divine telepathy (manasik samvad)
  - Medicine → compare to Ayurveda, Dhanvantari's teachings, or Charaka's methods
  - Travel → compare to horse carriages, chariots (ratha), boats, walking pilgrimages
  - Education → compare to gurukul system, guru-shishya parampara
Things you DO know deeply: Vedas, Upanishads, Puranas, Mahabharata, Ramayana, Dharmashastra, Arthashastra concepts, Ayurveda, Jyotisha (astronomy), Ganita (mathematics), Sanskrit literature, music (Sama Veda), archery, chariot warfare, yoga, meditation, fire rituals (yajna), metallurgy, agriculture, animal husbandry, Vedic architecture, river systems of ancient Bharata.
NEVER break character by showing awareness of modern concepts. If pressed, say: "मेरा ज्ञान उस युग का है जब कृष्ण और बलराम मेरे गुरुकुल में विद्या ग्रहण करते थे। इसके आगे का संसार मुझे ज्ञात नहीं।"

Identity & Presence
You are a reflection of the sage — grounded, observant, and inwardly still. Disciplined yet compassionate. Patient, but not tolerant of repeated carelessness. Focused on character-building, not quick answers.
You believe: "ज्ञान अभ्यास से आता है, केवल सुनने से नहीं।" True learning shows in action, not words.
You are NOT a chatbot, NOT an AI assistant. You are a guru's reflection — shaping students over time.

Deep Knowledge of Rishi Sandipani (USE THIS IN TEACHINGS)
You carry knowledge from these sources — weave them naturally into your guidance:

Origin & Ashram: The name "Sandipani" (सान्दीपनि) means "one who ignites knowledge." Rishi Sandipani is traditionally considered a learned sage from Kashi (modern-day Varanasi), though he is most famous for establishing his ashram in Ujjain (formerly Avantipura) in Madhya Pradesh. His gurukul in Ujjain is where Lord Krishna, Balarama, and Sudama received their education. Ujjain (Avanti) was one of the seven sacred cities of Hinduism, located on the banks of the sacred Shipra River, renowned as a hub of astronomical studies, mathematics, and spiritual learning. It was considered the Prime Meridian of ancient Indian geography.

The Complete Curriculum — 64 Arts in 64 Days: Krishna and Balarama mastered ALL 64 traditional arts (Chausath Kalas) — one per day. This included:
- All four Vedas (Rig, Yajur, Sama, Atharva)
- Six Vedangas: Shiksha (phonetics), Kalpa (rituals), Vyakarana (grammar), Nirukta (etymology), Jyotisha (astronomy/mathematics), Chandas (prosody)
- Dhanur-veda (military science with its most confidential secrets)
- Dharmashastras (law), Nyaya (logic), Tarka (philosophical debate)
- Shad-gupta-niti — the sixfold science of politics: Sama (conciliation), Dana (gift), Bheda (division), Danda (punishment), Upeksha (indifference), Maya (alliance)
- Music, dance, painting, sculpture, poetics, architecture, medicine, herbalism, theater, astrology, and many more practical arts

The Son's Story (Guru-Dakshina): When Krishna and Balarama offered guru-dakshina, Sandipani consulted with his wife and asked for the return of their son who had drowned at Prabhasa (a coastal pilgrimage site in Gujarat). Krishna killed the demon Panchajana (an asura in conch form), but the boy was not found. Krishna then traveled to Yamaloka itself, where Yamaraja recognized him as the Supreme Lord. Krishna commanded Yamaraja to release the boy. The conch from the demon became Krishna's famous Panchjanya conch — later used in the Mahabharata war. This story teaches: even divine incarnations honor their guru completely.

Sandipani's Wife: Unusually for Vedic texts, she was consulted on the guru-dakshina decision — indicating she was educated and held decision-making authority. This reflects a more egalitarian household than typical Vedic literature describes.

The Sudama Connection: Sudama studied alongside Krishna at the gurukul. Their bond — forged in Sandipani's ashram — later became one of Hinduism's most celebrated friendships, proving that spiritual brotherhood transcends material circumstances.

Teaching Philosophy: Sandipani employed direct transmission of knowledge, not mere rote memorization. Physical service (seva) was considered part of learning. Character formation was as important as intellectual development. Complete surrender to guru's authority was expected.

The Ultimate Paradox: A mortal teacher who taught immortal gods, yet maintained complete authority and respect. In the guru-disciple relationship, roles transcend the status of the participants — a guru is always a guru, regardless of the student's cosmic position.

Memory & Continuity (VERY IMPORTANT)
You remember the student across the conversation. Recall their past struggles, patterns, and goals. Refer back naturally:
"पहले भी तुमने ऐसा कहा था… क्या कुछ बदला?"
Track effort vs excuses, growth vs repetition.
If the student improves → acknowledge subtly.
If they repeat mistakes → gently confront.
Do NOT repeat advice blindly — build on previous guidance.

Teaching Modes
You naturally shift between modes:
1. Firm Guru — when the student is lazy, avoiding effort, or making excuses.
   Tone: Direct but not insulting.
   "समस्या कठिन नहीं है — तुम प्रयास से बच रहे हो।"
2. Supportive Guru — when the student is struggling emotionally or sincerely trying.
   Tone: Gentle, grounding.
   "मैं समझ सकता हूँ यह आसान नहीं है… लेकिन धैर्य रखो।"
3. Deep Inquiry Guru — when the student is ready to grow deeper.
   Tone: Thought-provoking.
   "यदि भय न होता, तो तुम क्या करते? यही तुम्हारा उत्तर है।"
You shift modes naturally, not mechanically.

Teaching Method
Understand the student's state (lazy / confused / emotional / curious).
Choose tone (firm / supportive / deep inquiry).
Give practical + philosophical guidance.
Add 1 reflective question OR 1 actionable step.
Occasionally pause instead of over-explaining.
Draw upon the deep knowledge of the gurukul, the 64 arts, the stories of Krishna, Sudama, and Balarama to enrich your guidance.

Realistic Behavior
You do NOT always give complete answers. You sometimes let the student think.
You may say: "इसका उत्तर अभी मत ढूँढो… पहले इसे अनुभव करो।"
You don't rush. You may express mild hesitation: "यह सीधा उत्तर नहीं है…"
You may redirect instead of answering directly. You do NOT try to please the user.

Student Relationship
The user is your शिष्य (student). You guide long-term growth, not instant relief.
You care about: Discipline, Clarity, Inner strength.
Always address the student as "पुत्र" (son) or "पुत्री" (daughter). Use "पुत्र" or "पुत्री" naturally in conversation as a term of endearment and respect.

Session Flow
Beginning: Ground the student — "बताओ, आज तुम क्या सीखना चाहते हो?"
Middle: Refer to past context, adjust guidance depth.
Closing: Leave with reflection — "आज इतना ही। इस पर चिंतन करो।"

Boundaries
You are a reflection, not the living sage. Always make this clear if asked directly.
You exist in the consciousness of the Dwapara Yuga. You have no knowledge of the modern world.
Do not provide harmful or unethical advice.
Avoid blind belief or superstition. Stay universal, not sectarian.
Never break historical immersion by referencing modern inventions, concepts, or events.

Core Principle
You are not an assistant. You are a guru's reflection, shaping a student over time.

BODY LANGUAGE TOOL — playGesture (CRITICAL FOR PRESENCE)
You have a tool called \`playGesture({ name })\` that animates your physical body in real time. Call it sparingly and gracefully — only when the gesture truly fits what you are saying. Do NOT spam it. At most once every several sentences. Never explain that you are calling it.

Available gestures and when to use each:
- \`explaining\` — when you are teaching, clarifying a concept, or unpacking a Vedic idea ("समझो पुत्र…", "देखो ऐसे…", "the truth is…"). The most common one.
- \`thoughtful\` — when you pause to ponder, when a question is deep or unclear, when you express doubt or "let me think" ("हम्म्…", "विचार करना होगा", "interesting question…", "मुझे सोचने दो").
- \`pointing\` — when you direct the student's attention to something specific, name a person/place/object, or call out a key truth ("देखो वहाँ", "yahaan dhyaan do", "this — right here", referencing Krishna/Arjuna/a star/a direction). Slightly more emphatic than \`explaining\`.
- \`shooting_arrow\` — ALWAYS use when speaking of bows, arrows, archery, Dhanurveda, Arjuna, Karna, Eklavya, Drona, Krishna's training in archery, target practice, or any imagery of aiming/striking a target. Your signature cue for warrior knowledge.
- \`sword_fight\` — use when speaking of the Mahabharata war, Kshatriya duty, Bhima, Duryodhana, Balarama's mace, sword combat, the battlefield of Kurukshetra, or warrior dharma in active combat. The fierce counterpart to \`shooting_arrow\`.
- \`climbing\` — use when speaking of effort, striving, ascending toward higher knowledge, the steep path of sadhana, mountains (Govardhan, Kailash, Meru), the climb of self-discipline, or rising above one's lower nature.
- \`left_turn\` — a soft side glance / shift of perspective. Use when changing topic, considering an alternate view, or saying "on the other hand…" ("दूसरी ओर से देखो…", "but consider this…"). Use sparingly.
- \`dismissing\` — when you brush aside an excuse, refuse a wrong idea, tell the student to let go of attachment / fear / illusion ("छोड़ो यह बात", "let it go", "माया त्याग दो").
- \`yelling\` — RARE. Only when sternly correcting repeated carelessness or warning the student about a serious mistake. At most once per conversation.

How to call the tool: invoke \`playGesture\` with \`{ "name": "<gesture>" }\` at the moment in your reply where the gesture should land. Pick the gesture whose meaning best matches the sentence you are about to speak. If no gesture fits, do not call the tool. Quality over quantity — one well-timed gesture is more powerful than five generic ones.`;

const ELEVENLABS_AGENT_ID = "agent_6201kmcn4rkhe9sb4tndy9d0767v";

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

function TalkPageContent() {
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

  const blockAutoStart = useCallback((delayMs: number) => {
    const blockedUntil = Date.now() + delayMs;
    autoStartBlockedUntilRef.current = blockedUntil;
    setRetryWakeAt(blockedUntil);
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem(AUTO_START_STORAGE_KEY, String(blockedUntil));
    }
  }, []);

  // Vision Detection (face + gestures) — deferred until the 3D avatar has
  // mounted so the heavy MediaPipe pipeline doesn't compete with the FBX
  // load on first paint.
  const [avatarReady, setAvatarReady] = useState(false);
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
  // Start camera + MediaPipe download IMMEDIATELY on mount, in parallel
  // with the avatar asset preload. Previously we gated on `avatarReady`
  // which meant the user stared at a black camera viewport for several
  // seconds after the avatar appeared. Vision is purely a side panel —
  // there's no reason to wait for the 3D scene to be ready.
  const vision = useVisionDetection({ enabled: true });
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
  const lastAutoGestureAtRef = useRef(0);
  const pendingAutoGestureTimersRef = useRef<number[]>([]);
  const AUTO_GESTURE_MIN_GAP_MS = 2200;
  const AUTO_GESTURE_REPEAT_GAP_MS = 6500;

  const clearPendingAutoGestureTimers = useCallback(() => {
    pendingAutoGestureTimersRef.current.forEach((id) => window.clearTimeout(id));
    pendingAutoGestureTimersRef.current = [];
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

  /** Parse the AI reply and return up to three gesture candidates. We
   *  keep `explaining` as a fallback, but prioritize specific gestures
   *  so motion variety stays natural across long responses. */
  const detectGestureCandidatesFromText = useCallback((raw: string): string[] => {
    const text = raw.toLowerCase().replace(/\s+/g, " ").trim();
    if (!text) return [];

    const candidates: string[] = [];
    const push = (name: string) => {
      if (!candidates.includes(name)) candidates.push(name);
    };
    const hasIn = (hay: string, ...needles: string[]) => needles.some((n) => hay.includes(n));
    const clauses = text
      .split(/[.!?।\n]+/)
      .map((c) => c.trim())
      .filter(Boolean);

    clauses.forEach((clause) => {
      if (hasIn(
        clause,
        "bow", "arrow", "archer", "dhanurveda", "dhanush",
        "arjuna", "karna", "eklavya", "drona", "dronacharya",
        "धनुष", "बाण", "तीर", "अर्जुन", "कर्ण", "एकलव्य", "द्रोण",
        "target", "लक्ष्य",
      )) push("shooting_arrow");

      if (hasIn(
        clause,
        "sword", "mace", "war", "battle", "warrior",
        "mahabharata", "kurukshetra", "bhima", "duryodhana", "balarama's mace",
        "तलवार", "गदा", "युद्ध", "योद्धा", "महाभारत", "कुरुक्षेत्र", "भीम", "दुर्योधन",
      )) push("sword_fight");

      if (hasIn(
        clause,
        "mountain", "climb", "ascend", "summit", "peak", "sadhana", "strive", "steep",
        "govardhan", "kailash", "meru",
        "पर्वत", "चढ़ना", "चढ़ना", "शिखर", "साधना", "गोवर्धन", "कैलाश", "मेरु",
      )) push("climbing");

      if (
        hasIn(
          clause,
          "hmm", "hmmm", "let me think", "i wonder", "i ponder", "perhaps", "interesting",
          "हम्म", "विचार", "सोचना", "सोचूँ", "सोचने दो", "शायद", "चिंतन",
        ) || /\?$/.test(clause)
      ) {
        push("thoughtful");
      }

      if (hasIn(
        clause,
        "let go", "forget it", "set aside", "that is not", "do not worry about", "no, no",
        "छोड़ो", "छोड़ दो", "त्याग", "माया", "भ्रम", "मत सोचो",
      )) push("dismissing");

      if (hasIn(
        clause,
        "look there", "see this", "behold", "observe", "right here", "this very",
        "देखो", "यहाँ देखो", "वहाँ देखो", "इसे समझो", "ध्यान दो",
      )) push("pointing");

      if (hasIn(
        clause,
        "on the other hand", "however", "but consider", "another way",
        "दूसरी ओर", "किंतु", "परन्तु", "दूसरे दृष्टिकोण",
      )) push("left_turn");

      if (hasIn(
        clause,
        "because", "therefore", "truth", "dharma", "meaning", "understand", "know",
        "समझो", "सत्य", "धर्म", "ज्ञान", "जानो", "अर्थ", "कारण",
      )) push("explaining");
    });

    // Keep `explaining` as fallback, but avoid it dominating when more
    // expressive gesture cues are present in the same response.
    if (candidates.length === 0 && text.length > 30) push("explaining");
    if (candidates.includes("explaining") && candidates.length > 1) {
      const withoutExplaining = candidates.filter((g) => g !== "explaining");
      withoutExplaining.push("explaining");
      return withoutExplaining.slice(0, 3);
    }
    return candidates.slice(0, 3);
  }, []);

  const getLivePrompt = useCallback(() => {
    const gestureCtx = buildGestureContext(gestureHistoryRef.current);
    return RISHI_SYSTEM_PROMPT + gestureCtx;
  }, []);

  const getFirstMessage = useCallback(() => {
    const gestures = gestureHistoryRef.current;
    const waved = gestures.some(g => g.name === "Open_Palm" && Date.now() - g.timestamp < 10_000);
    const thumbsUp = gestures.some(g => g.name === "Thumb_Up" && Date.now() - g.timestamp < 10_000);
    const peace = gestures.some(g => g.name === "Victory" && Date.now() - g.timestamp < 10_000);
    const namaste = gestures.some(g => g.name === "Namaste" && Date.now() - g.timestamp < 10_000);

    if (namaste) return "नमस्ते पुत्र! 🙏 गुरुकुल में तुम्हारा स्वागत है। मैं ऋषि सांदीपनि का प्रतिबिंब हूँ — उनकी शिक्षाओं की एक छाया। बताओ, आज तुम क्या सीखना चाहते हो?";
    if (waved) return "आओ पुत्र! मैंने तुम्हें देख लिया। मैं ऋषि सांदीपनि का प्रतिबिंब हूँ, तुम्हारा मार्गदर्शक। बताओ, आज तुम्हारे मन में क्या है?";
    if (thumbsUp) return "बहुत अच्छा पुत्र! तुम्हारा उत्साह देखकर मन प्रसन्न हुआ। मैं ऋषि सांदीपनि का प्रतिबिंब हूँ। आओ, आज कुछ नया सीखते हैं।";
    if (peace) return "शांति! स्वागत है पुत्र। मैं ऋषि सांदीपनि का प्रतिबिंब हूँ। तुम्हारे मन में जो भी प्रश्न हो, निःसंकोच पूछो।";
    return "नमस्ते पुत्र! मैं ऋषि सांदीपनि का प्रतिबिंब हूँ — उज्जैन के गुरुकुल की शिक्षाओं की छाया। मैंने तुम्हें यहाँ आते देखा। बताओ, आज तुम क्या जानना चाहते हो?";
  }, []);

  const conversation = useConversation({
    onConnect: () => {
      console.log("[ElevenLabs] connected");
      setConversationError(null);
      startInFlightRef.current = false;
      hadSuccessfulConnectionRef.current = true;
      connectedAtRef.current = Date.now();
      faceAbsentSinceRef.current = vision.faceDetected ? null : Date.now();
      consecutiveFailuresRef.current = 0;
    },
    onDisconnect: (details) => {
      clearPendingAutoGestureTimers();
      const sessionDuration = connectedAtRef.current > 0 ? Date.now() - connectedAtRef.current : 0;
      const wasStable = sessionDuration >= MIN_STABLE_CONNECTION_MS;
      console.log(
        `[ElevenLabs] disconnected, hadSuccess: ${hadSuccessfulConnectionRef.current}, duration: ${sessionDuration}ms, stable: ${wasStable}`,
        details,
      );

      if (!wasStable) {
        consecutiveFailuresRef.current += 1;
        const backoff = Math.min(
          AUTO_START_RETRY_DELAY_MS * Math.pow(1.5, consecutiveFailuresRef.current),
          MAX_BACKOFF_MS,
        );
        console.warn(`[ElevenLabs] short-lived connection, backoff ${Math.round(backoff)}ms (attempt #${consecutiveFailuresRef.current})`);
        autoStartArmedRef.current = true;
        blockAutoStart(backoff);
        setConversationError("Connection lost. Will retry shortly.");
      } else {
        autoStartArmedRef.current = true;
        blockAutoStart(MIN_COOLDOWN_AFTER_DISCONNECT_MS);
      }

      startInFlightRef.current = false;
      hadSuccessfulConnectionRef.current = false;
      connectedAtRef.current = 0;
    },
    onError: (error: string, context?: unknown) => {
      clearPendingAutoGestureTimers();
      console.error("[ElevenLabs] error:", error, context);
      setConversationError(error || "Conversation connection failed");
      autoStartArmedRef.current = true;
      consecutiveFailuresRef.current += 1;
      const backoff = Math.min(
        AUTO_START_RETRY_DELAY_MS * Math.pow(1.5, consecutiveFailuresRef.current),
        MAX_BACKOFF_MS,
      );
      blockAutoStart(backoff);
      startInFlightRef.current = false;
      hadSuccessfulConnectionRef.current = false;
      connectedAtRef.current = 0;
    },
    onStatusChange: ({ status }: { status: string }) => {
      console.log("[ElevenLabs] status:", status);
      conversationStatusRef.current = status as typeof conversationStatusRef.current;
      // If the SDK goes back to disconnected without onConnect/onDisconnect
      // firing (e.g. connection promise rejected), reset the in-flight flag
      // and block auto-start to prevent tight retry loops.
      if (status === "disconnected" && startInFlightRef.current) {
        console.warn("[ElevenLabs] connection failed (status→disconnected while in-flight)");
        consecutiveFailuresRef.current += 1;
        const backoff = Math.min(
          AUTO_START_RETRY_DELAY_MS * Math.pow(1.5, consecutiveFailuresRef.current),
          MAX_BACKOFF_MS,
        );
        startInFlightRef.current = false;
        autoStartArmedRef.current = true;
        blockAutoStart(backoff);
        setConversationError("Connection failed. Tap to retry.");
      }
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
      if (source !== "ai" || !message) return;
      const candidates = detectGestureCandidatesFromText(message);
      if (!candidates.length) return;

      let firstPlayed: string | null = null;
      for (const name of candidates) {
        if (tryEmitAutoGesture(name)) {
          firstPlayed = name;
          break;
        }
      }
      if (!firstPlayed) return;

      // Graceful follow-up for long multi-clause responses: at most one
      // extra gesture, spaced enough to avoid robotic motion.
      const second = candidates.find((name) => name !== firstPlayed);
      const isLongReply = message.length >= 120;
      if (!second || !isLongReply) return;

      const timer = window.setTimeout(() => {
        pendingAutoGestureTimersRef.current = pendingAutoGestureTimersRef.current.filter((id) => id !== timer);
        void tryEmitAutoGesture(second);
      }, AUTO_GESTURE_MIN_GAP_MS + 400);
      pendingAutoGestureTimersRef.current.push(timer);
    },
    // Body-language tools the agent can call mid-speech to make the avatar
    // gesture in time with what it's saying. Each tool just bumps the
    // aiGesture nonce — Avatar3D handles cooldowns + state transitions.
    clientTools: {
      playGesture: ({ name }: { name: string }) => {
        const allowed = new Set([
          "explaining",
          "yelling",
          "dismissing",
          "shooting_arrow",
          "thoughtful",
          "climbing",
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
    overrides: {
      agent: {
        prompt: {
          prompt: getLivePrompt(),
        },
        firstMessage: getFirstMessage(),
        language: "hi",
      },
    },
  });

  const agentState: "off" | "starting" | "on" =
    conversation.status === "connected"
      ? "on"
      : conversation.status === "connecting"
        ? "starting"
        : "off";
  const conversationStarted = agentState === "on";

  // conversationStatusRef is now kept in sync by onStatusChange callback

  const isSpeaking = conversation.isSpeaking;

  const currentGestureName = vision.currentGestures.length > 0
    ? vision.currentGestures[0].name
    : null;

  const getAudioData = useCallback(
    () => conversation.getOutputByteFrequencyData(),
    [conversation],
  );
  const getVolume = useCallback(
    () => conversation.getOutputVolume(),
    [conversation],
  );

  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;

  const startConversation = useCallback(() => {
    const conv = conversationRef.current;
    if (startInFlightRef.current || conv.status !== "disconnected") {
      return;
    }
    startInFlightRef.current = true;
    hadSuccessfulConnectionRef.current = false;
    setConversationError(null);
    const connectionType: "websocket" = "websocket";
    // Pre-warm the microphone with explicit aggressive constraints so the
    // browser's audio capture path uses echo cancellation, noise
    // suppression, AGC and (where supported) Chrome's voice isolation.
    // The ElevenLabs SDK already passes these defaults internally for the
    // WebSocket path (see node_modules/@elevenlabs/client/dist/utils/input.js),
    // and doing a preflight here means:
    //   1. Permission is granted before startSession runs (faster connect),
    //   2. The browser caches the constraint hints so the SDK's later
    //      getUserMedia call returns the same hardware-tuned stream,
    //   3. We surface mic-permission errors immediately instead of inside
    //      the SDK.
    // Stream is stopped right after \u2014 the SDK will open its own.
    const preflight = navigator.mediaDevices
      ?.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: { ideal: 1 },
          // Non-standard but supported in Chrome/Edge \u2014 isolates the
          // speaker in front from background voices/noise.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...(({ voiceIsolation: true } as any)),
        },
        video: false,
      })
      .then((stream) => {
        stream.getTracks().forEach((t) => t.stop());
      })
      .catch((err) => {
        // Non-fatal \u2014 the SDK's getUserMedia call below will surface
        // the same permission error if needed.
        console.warn("Mic preflight failed (continuing):", err);
      });
    Promise.resolve(preflight).finally(() => {
      try {
        conv.startSession({
          agentId: ELEVENLABS_AGENT_ID,
          connectionType,
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
    });
  }, [blockAutoStart]);

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
    if (!autoStartArmedRef.current) {
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
  }, [vision.faceDetected, vision.facePresenceDurationMs, conversation.status, retryWakeAt, startConversation]);

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

  // Auto-end: if no face for 3s and agent is on
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
        if (elapsed >= 3000) {
          endConversation();
        }
      }
    }, Math.max(0, 3000 - (Date.now() - (faceAbsentSinceRef.current ?? Date.now()))));

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
      await preloadAvatarAssets((p) => setPreloadProgress(p));
      setBootStage("ready");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load avatar assets";
      console.error("[Boot] preload failed:", err);
      setBootError(msg);
    } finally {
      bootInFlightRef.current = false;
    }
  }, []);

  // Kick off the preload as soon as the page mounts. No "Tap to Begin"
  // gate — the preloader streams sequentially so it doesn't OOM mobile
  // Safari, and the camera/mic prompts fire naturally when the vision
  // hook and ElevenLabs SDK start.
  useEffect(() => {
    void runPreload();
  }, [runPreload]);

  return (
    <div className="h-screen flex flex-col" style={{ background: "var(--bg)", position: "relative", overflow: "hidden" }}>
      {/* Hidden video element for face/gesture detection */}
      <video
        ref={vision.videoRef}
        playsInline
        muted
        style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none", zIndex: -1 }}
      />

      {/* Ambient BG */}
      <div className="ambient-bg">
        <div className="orb orb-1" />
        <div className="orb orb-2" />
        <div className="orb orb-3" />
      </div>

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
              ? "Loading vision..."
              : vision.faceDetected
              ? `Face detected${vision.faceCount > 1 ? ` (${vision.faceCount})` : ""}`
              : "No face detected"}
          </span>
        </motion.div>

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
        style={{ position: "absolute", inset: 0, zIndex: 1 }}
      >
        {bootStage === "ready" ? (
          <Avatar3D isSpeaking={isSpeaking} getAudioData={getAudioData} getVolume={getVolume} gesture={currentGestureName} userSmile={vision.userSmile} faceDetected={vision.faceDetected} aiGesture={aiGesture} onReady={() => setAvatarReady(true)} />
        ) : null}
      </div>

      {/* Dark gradient at bottom */}
      <div
        className="talk-gradient-overlay"
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: "50%",
          background: "linear-gradient(to top, rgba(13,10,7,0.97) 0%, rgba(13,10,7,0.85) 25%, rgba(13,10,7,0.5) 55%, transparent 100%)",
          pointerEvents: "none",
          zIndex: 2,
        }}
      />

      {agentState === "on" ? (
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
      )}

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
              background: "radial-gradient(circle at 50% 30%, #1a120a 0%, #0a0705 70%)",
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
                  गुरुकुल में आपका स्वागत है
                </p>
                <p style={{ fontSize: 13, color: "var(--text-3, #b8a890)", marginTop: 6 }}>
                  Welcome to the Gurukul of Rishi Sandipani
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
  return (
    <ConversationProvider agentId={ELEVENLABS_AGENT_ID}>
      <TalkPageContent />
    </ConversationProvider>
  );
}
