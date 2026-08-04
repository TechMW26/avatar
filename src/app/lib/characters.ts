export const CHARACTER_STORAGE_KEY = "avatar:selected-character";

export type CharacterSlug = "sandipani" | "rani-laxmi-bai" | "shivaji-maharaj";

export interface CharacterProfile {
  slug: CharacterSlug;
  name: string;
  hindiName: string;
  role: string;
  hindiRole: string;
  era: string;
  description: string;
  accent: string;
  accentDark: string;
  agentId: string;
  modelPath: string;
  portraitPath: string;
  greetings: {
    default: string;
    namaste: string;
    wave: string;
    approval: string;
    peace: string;
    continuations: string[];
  };
}

export const CHARACTERS: readonly CharacterProfile[] = [
  {
    slug: "sandipani",
    name: "Rishi Sandipani",
    hindiName: "ऋषि सांदीपनि",
    role: "The timeless teacher",
    hindiRole: "गुरु और मार्गदर्शक",
    era: "Dwapara Yuga",
    description: "Seek clarity, discipline, and wisdom through the Gurukul tradition.",
    accent: "#f59e0b",
    accentDark: "#9a3412",
    agentId: process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID_SANDIPANI || "",
    modelPath: "/models/sandipani.glb",
    portraitPath: "/portraits/rishi-sandipani.png",
    greetings: {
      default:
        "आओ, बैठो। हम्म… बताओ, आज मन में क्या चल रहा है?",
      namaste:
        "नमस्ते। आओ—बताओ, आज किस बात पर मन अटका है?",
      wave:
        "हाँ, मैंने देख लिया। आओ, बात शुरू करें—क्या सोच रहे हो?",
      approval:
        "अच्छा, उत्साह तो है। अब बताओ, आज किस बात पर काम करना है?",
      peace:
        "शांति। पहले एक श्वास स्थिर करो… अब बताओ, मन में क्या है?",
      continuations: [
        "हाँ… बात कहाँ रुकी थी? आगे कहो।",
        "हम्म… मैं सुन रहा हूँ। अपनी बात पूरी करो।",
        "संपर्क क्षण भर टूटा था—जहाँ रुके थे, वहीं से कहो।",
      ],
    },
  },
  {
    slug: "rani-laxmi-bai",
    name: "Rani Lakshmi Bai",
    hindiName: "रानी लक्ष्मीबाई",
    role: "The fearless queen of Jhansi",
    hindiRole: "साहस और स्वाभिमान",
    era: "Jhansi · 1857",
    description: "Learn courage, leadership, resilience, and duty from Jhansi's warrior queen.",
    accent: "#fb7185",
    accentDark: "#881337",
    agentId:
      process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID_RANI_LAXMI_BAI
      || "agent_9801kyfjapdrf30bcmk5ddn4yerb",
    modelPath: "/models/rani-laxmi-bai.glb",
    portraitPath: "/portraits/rani-lakshmi-bai.png",
    greetings: {
      default:
        "आइए। बताइए—कौन-सी बात आपको रोक रही है?",
      namaste:
        "नमस्कार। हम्म… कहिए, मन में क्या है?",
      wave:
        "हाँ, मैंने देख लिया। आइए—अपनी बात खुलकर कहिए।",
      approval:
        "अच्छा! यह आत्मविश्वास बनाए रखिए। अब बताइए, सामने चुनौती क्या है?",
      peace:
        "शांति। घबराइए नहीं—धीरे से बताइए, क्या हुआ?",
      continuations: [
        "हाँ… जहाँ रुके थे, वहीं से आगे कहिए।",
        "हम्म… मैं सुन रही हूँ। अपनी बात पूरी कीजिए।",
        "संपर्क क्षण भर टूटा था—आपकी बात कहाँ रुकी थी?",
      ],
    },
  },
  {
    slug: "shivaji-maharaj",
    name: "Chhatrapati Shivaji Maharaj",
    hindiName: "छत्रपति शिवाजी महाराज",
    role: "The architect of Swarajya",
    hindiRole: "स्वराज्य और सुशासन",
    era: "Maratha Swarajya",
    description: "Explore strategy, just governance, courage, and people-first leadership.",
    accent: "#f97316",
    accentDark: "#7c2d12",
    agentId:
      process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID_SHIVAJI_MAHARAJ
      || "agent_9301kyfjb9rqffnah8wrm0248x56",
    modelPath: "/models/shivaji-maharaj.glb",
    portraitPath: "/portraits/chhatrapati-shivaji-maharaj.png",
    greetings: {
      default:
        "आइए। बताइए—किस बात पर निर्णय लेना है?",
      namaste:
        "नमस्कार। हाँ, कहिए—क्या परिस्थिति है?",
      wave:
        "हाँ, मैंने देख लिया। आइए—बात सीधे कहिए।",
      approval:
        "अच्छा! आत्मविश्वास है—अब लक्ष्य स्पष्ट कीजिए।",
      peace:
        "शांत मन से देखेंगे तो मार्ग साफ़ होगा। बताइए, उलझन कहाँ है?",
      continuations: [
        "हाँ… जहाँ रुके थे, वहीं से आगे कहिए।",
        "हम्म… मैं सुन रहा हूँ। बात पूरी कीजिए।",
        "संपर्क क्षण भर टूटा था—अपनी आख़िरी बात दोहराइए।",
      ],
    },
  },
] as const;

const CHARACTER_BY_SLUG = new Map(
  CHARACTERS.map((character) => [character.slug, character]),
);

export const DEFAULT_CHARACTER = CHARACTERS[0];

export function isCharacterSlug(value: string | null): value is CharacterSlug {
  return Boolean(value && CHARACTER_BY_SLUG.has(value as CharacterSlug));
}

export function getCharacter(slug: string | null | undefined): CharacterProfile {
  return (slug && CHARACTER_BY_SLUG.get(slug as CharacterSlug)) || DEFAULT_CHARACTER;
}

export function getCharacterFromLocation(): CharacterProfile {
  if (typeof window === "undefined") return DEFAULT_CHARACTER;
  const querySlug = new URLSearchParams(window.location.search).get("character");
  if (isCharacterSlug(querySlug)) return getCharacter(querySlug);
  const storedSlug = window.localStorage.getItem(CHARACTER_STORAGE_KEY);
  return getCharacter(storedSlug);
}

export function getOptionalCharacterFromLocation(): CharacterProfile | null {
  if (typeof window === "undefined") return null;
  const querySlug = new URLSearchParams(window.location.search).get("character");
  if (isCharacterSlug(querySlug)) return getCharacter(querySlug);
  const storedSlug = window.localStorage.getItem(CHARACTER_STORAGE_KEY);
  return isCharacterSlug(storedSlug) ? getCharacter(storedSlug) : null;
}
