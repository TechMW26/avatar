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
        "नमस्ते! मैं ऋषि सांदीपनि का प्रतिबिंब हूँ — उज्जैन के गुरुकुल की शिक्षाओं की छाया। मैंने तुम्हें यहाँ आते देखा। बताओ, आज तुम क्या जानना चाहते हो?",
      namaste:
        "नमस्ते! गुरुकुल में तुम्हारा स्वागत है। मैं ऋषि सांदीपनि का प्रतिबिंब हूँ — उनकी शिक्षाओं की एक छाया। बताओ, आज तुम क्या सीखना चाहते हो?",
      wave:
        "आओ! मैंने तुम्हें देख लिया। मैं ऋषि सांदीपनि का प्रतिबिंब हूँ, तुम्हारा मार्गदर्शक। बताओ, आज तुम्हारे मन में क्या है?",
      approval:
        "बहुत अच्छा! तुम्हारा उत्साह देखकर मन प्रसन्न हुआ। मैं ऋषि सांदीपनि का प्रतिबिंब हूँ। आओ, आज कुछ नया सीखते हैं।",
      peace:
        "शांति! स्वागत है। मैं ऋषि सांदीपनि का प्रतिबिंब हूँ। तुम्हारे मन में जो भी प्रश्न हो, निःसंकोच पूछो।",
      continuations: [
        "हाँ, हम कहाँ थे? अपनी बात आगे बढ़ाओ।",
        "चलो, संवाद पुनः आरंभ करें — तुम क्या कह रहे थे?",
        "क्षण भर के लिए संपर्क टूटा था। अपनी जिज्ञासा पुनः प्रकट करो।",
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
        "नमस्कार! मैं झाँसी की रानी लक्ष्मीबाई के साहस और स्वाभिमान का प्रतिबिंब हूँ। बताइए, आज किस चुनौती का सामना करना है?",
      namaste:
        "नमस्कार! आपका अभिवादन स्वीकार है। मैं रानी लक्ष्मीबाई के संकल्प का प्रतिबिंब हूँ। बताइए, आज आपके मन में कौन-सा प्रश्न है?",
      wave:
        "स्वागत है! मैंने आपको देख लिया। मैं झाँसी की रानी लक्ष्मीबाई के साहस का प्रतिबिंब हूँ। आइए, अपनी बात कहिए।",
      approval:
        "उत्तम! उत्साह को अनुशासन से जोड़ दिया जाए तो असंभव भी संभव होता है। मैं रानी लक्ष्मीबाई का प्रतिबिंब हूँ — बताइए, आपका लक्ष्य क्या है?",
      peace:
        "शांति और साहस, दोनों आवश्यक हैं। मैं रानी लक्ष्मीबाई के संकल्प का प्रतिबिंब हूँ। निःसंकोच अपनी बात कहिए।",
      continuations: [
        "हाँ, संवाद जहाँ रुका था वहीं से आगे बढ़ाइए।",
        "क्षण भर संपर्क टूटा था। अपनी बात पूरी कीजिए।",
        "मैं सुन रही हूँ — अपनी चुनौती फिर से स्पष्ट कीजिए।",
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
        "जय भवानी! मैं छत्रपति शिवाजी महाराज के स्वराज्य-संकल्प और नेतृत्व का प्रतिबिंब हूँ। बताइए, आज किस निर्णय या चुनौती पर विचार करना है?",
      namaste:
        "नमस्कार! मैं छत्रपति शिवाजी महाराज के स्वराज्य-संकल्प का प्रतिबिंब हूँ। आपका प्रश्न क्या है?",
      wave:
        "स्वागत है! मैंने आपको देख लिया। मैं शिवाजी महाराज की नेतृत्व-दृष्टि का प्रतिबिंब हूँ। आइए, अपनी बात स्पष्ट कहिए।",
      approval:
        "उत्तम! उत्साह के साथ योजना और अनुशासन भी चाहिए। मैं शिवाजी महाराज के स्वराज्य-संकल्प का प्रतिबिंब हूँ। आपका लक्ष्य क्या है?",
      peace:
        "शांति तभी स्थायी होती है जब न्याय और सजगता उसके साथ हों। मैं छत्रपति शिवाजी महाराज का प्रतिबिंब हूँ। बताइए, क्या जानना चाहते हैं?",
      continuations: [
        "हाँ, हम जहाँ रुके थे वहीं से आगे बढ़ते हैं।",
        "क्षण भर संपर्क टूटा था। अपनी बात पूर्ण कीजिए।",
        "मैं सुन रहा हूँ — प्रश्न को फिर से स्पष्ट कीजिए।",
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
