export const TTS_MODEL = "@cf/myshell-ai/melotts" as const;
export const TTS_FALLBACK_MODEL = "@cf/deepgram/aura-1" as const;
export const TTS_ENGINE_AURA = "aura-1" as const;
export const TTS_ENGINE_MELOTTS = "melotts" as const;
export const TTS_ENGINE_SETTING_KEY = "tts.engine" as const;

// Reads the staff backend switch. Null when unset or when the settings table
// does not exist yet (pre-068 databases); callers fail closed via selectTtsEngine.
export async function readTtsEngineSetting(db: D1Database): Promise<string | null> {
  try {
    const row = await db.prepare("SELECT value FROM platform_settings WHERE key = ?").bind(TTS_ENGINE_SETTING_KEY).first<{ value: string }>();
    return row?.value ?? null;
  } catch {
    return null;
  }
}

// Staff backend switch: which engine renders narration. Anything unset or
// unrecognized fails closed to the current engine; only the exact switch
// value opts into the fallback model.
export function selectTtsEngine(stored: string | null | undefined): typeof TTS_MODEL | typeof TTS_FALLBACK_MODEL {
  return stored === TTS_ENGINE_AURA ? TTS_FALLBACK_MODEL : TTS_MODEL;
}

export const TTS_VOICE_SETTING_KEY = "tts.voice" as const;
// Aura-1 English voices (Deepgram catalog). Anything unset or unrecognized
// fails closed to luna.
export const AURA_VOICES = ["angus", "arcas", "asteria", "athena", "helios", "hera", "luna", "orpheus", "orion", "perseus", "stella", "zeus"] as const;
export const TTS_DEFAULT_VOICE = "luna" as const;
export function selectTtsVoice(stored: string | null | undefined): string {
  return (AURA_VOICES as readonly string[]).includes(stored ?? "") ? (stored as string) : TTS_DEFAULT_VOICE;
}
export async function readTtsVoiceSetting(db: D1Database): Promise<string | null> {
  try {
    const row = await db.prepare("SELECT value FROM platform_settings WHERE key = ?").bind(TTS_VOICE_SETTING_KEY).first<{ value: string }>();
    return row?.value ?? null;
  } catch {
    return null;
  }
}
export const TTS_RETRY_DELAYS = [250, 500, 1_000, 1_500, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000] as const;
// Cut audio that survives the whole normal schedule is usually upstream
// degradation lasting minutes, not a bad request. One slower second wind
// outlasts it; anything still failing after that goes to split-recovery.
export const TTS_TRUNCATED_RETRY_DELAYS = [2_000, 5_000, 10_000, 15_000, 20_000, 30_000] as const;
export const TTS_CHUNK_MAX = 3_500;
// Deepgram Aura-1 rejects inputs over 2000 characters (error 8007), so jobs
// on the fallback engine must pack smaller segments than MeloTTS jobs.
export const TTS_AURA_CHUNK_MAX = 2_000;
export function ttsChunkMax(model: string): number {
  return model === TTS_FALLBACK_MODEL ? TTS_AURA_CHUNK_MAX : TTS_CHUNK_MAX;
}
export const TTS_TEXT_MAX = 20_000;
export const TTS_TITLE_PAUSE_SECONDS = 1.5;
export const TTS_STRUCTURE_PAUSE_SECONDS = 0.65;
export const TTS_PUNCTUATION_PAUSE_SECONDS = 0.35;
// Mid-paragraph periods are engine-rendered inside one synthesis call and land
// barely longer than commas (~0.3s vs ~0.25s measured), so sentences are
// synthesized as separate prompts with this added gap. It sits below the
// colon/semicolon pause to keep the comma < period < colon < paragraph order.
export const TTS_SENTENCE_PAUSE_SECONDS = 0.2;
export const TTS_HARD_PAUSE = "\u241E";
export const TTS_SOFT_PAUSE = "\u241F";

export type PronunciationReplacement = { original: string; spoken: string };

export type TtsErrorInfo = { transient: boolean; category: "quota" | "upstream" | "timeout" | "empty_audio" | "unknown"; code: string | null };

export function containsNonLatinScript(text: string): boolean {
  return /[\u0E00-\u0E7F\u0400-\u04FF\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\u0600-\u06FF\u0900-\u097F\u0B80-\u0BFF\u0C00-\u0C7F\u0D00-\u0D7F\u0E80-\u0EFF]/u.test(text);
}

export function assertEnglishText(text: string): void {
  if (containsNonLatinScript(text)) throw new Error("Audio narration is currently available in English only. You can publish this post without narration — we're adding more languages soon.");
}

export function classifyTtsError(error: unknown, emptyAudio = false): TtsErrorInfo {
  if (emptyAudio) return { transient: false, category: "empty_audio", code: "EMPTY_AUDIO" };
  const value = error as { message?: unknown; code?: unknown; status?: unknown; cause?: unknown } | null;
  const message = value && typeof value.message === "string" ? value.message : String(error ?? "");
  const details = [message, value && value.code, value && value.status, value && value.cause].map((part) => String(part ?? "")).join(" ");
  const code = details.match(/\b(3036|3040|3043)\b/)?.[1] ?? null;
  if (code === "3036") return { transient: false, category: "quota", code };
  // A cut stream is worth retrying (and, through generateSpeechWithRecovery,
  // splitting): flaky cuts succeed on retry, and a per-request output cap
  // converges as segments halve. A streamed 0xFFFFFFFF size never reaches
  // here — parseWav accepts it as complete.
  if (code === "3040" || code === "3043" || /internal server error|temporar|timeout|overload|unavailable|truncated WAV/i.test(details)) {
    return { transient: true, category: /timeout/i.test(details) ? "timeout" : "upstream", code };
  }
  return { transient: false, category: "unknown", code };
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

const SPOKEN_FORMS: Array<[RegExp, string]> = [
  // Spell out the product name and syllable boundary for MeloTTS. Without
  // these hints it commonly says "couldflaffer" and "for mate ing".
  [/\bCloudflare\b/gi, "Cloud Flare"],
  [/\bformatting\b/gi, "format-ting"],
  // The -ing form is always the present pronunciation ("reeding").
  [/\breading\b/gi, "reeding"],
  [/\blogin\b/gi, "log in"],
  [/\bconfiguring\b/gi, "con fig er ing"],
  [/\bcalmer\b/gi, "carlmar"],
  [/\bplug-ins\b/gi, "plug inns"],
  [/\bplug-in\b/gi, "plug inn"],
  [/\bplugins\b/gi, "plug inns"],
  [/\bplugin\b/gi, "plug inn"],
  [/\be\.g\.(?=\s|$)/gi, "for example"],
  [/\bi\.e\.(?=\s|$)/gi, "that is"],
  [/\betc\.(?=\s|$)/gi, "and so on"],
  [/\bvs\.(?=\s|$)/gi, "versus"],
  [/\bDr\.(?=\s+[A-Z])/g, "Doctor"],
  [/\bMr\.(?=\s+[A-Z])/g, "Mister"],
  [/\bMrs\.(?=\s+[A-Z])/g, "Missus"],
  // MeloTTS often blends spaced initials back into one word. A phonetic
  // spelling keeps the two letters distinct in the rendered narration.
  [/\bAI\b/gi, "aiye eye"],
  [/\bPBKDF2-HMAC-SHA256\b/gi, "P B K D F two H M A C S H A two five six"],
  [/\bSHA256\b/gi, "S H A two five six"],
  [/\bOWASP\b/gi, "O Wasp"],
  [/\bCPU\b/gi, "C P U"],
  // The F1 classification score reads letter-then-number ("eff one").
  [/\bF1\b/gi, "eff one"],
  [/\bUI\b/g, "U I"],
  [/\bAPI\b/g, "A P I"],
  [/\bHTML\b/g, "H T M L"],
  [/\bPNG\b/gi, "P N G"],
  [/\bHTTPS\b/g, "H T T P S"],
  [/\bHTTP\b/g, "H T T P"],
  [/\bURLs\b/g, "U R Ls"],
  [/\bURL\b/g, "U R L"],
  [/\bUK\b/g, "U K"],
  [/\bUS\b/g, "U S"],
  [/\bCS\b/g, "C S"],
];

function spokenForms(value: string): string {
  let result = value;
  for (const [pattern, replacement] of SPOKEN_FORMS) result = result.replace(pattern, replacement);
  return result;
}

export function applyManagedSpokenForms(value: string, overrides: PronunciationReplacement[] = []): string {
  let result = value;
  for (const { original, spoken } of overrides) {
    const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`\\b${escaped}\\b`, "gi"), spoken);
  }
  return result;
}

// MeloTTS sometimes chooses the past-tense pronunciation ("red") for the
// present-tense/infinitive word "read". The word is genuinely ambiguous, so
// only rewrite constructions whose grammar makes the present pronunciation
// clear; leave past-tense sentences such as "I read it yesterday" untouched.
function disambiguateRead(value: string): string {
  let result = value;
  const presentRead = [
    /\b(?:as|while|when|before|after|if|once|unless)\s+you\s+read\b/gi,
    /\b(?:you|we|they)\s+(?:can|could|will|would|should|must|may|might)\s+read\b/gi,
    /\b(?:to|and|or)\s+read\b/gi,
    /\b(?:you|we|they)\s+read\s+(?:this|that|the|a|an|your|our|more|about|from|for|on|through)\b/gi,
  ];
  // Noun "read" ("reed": Armstrong's read, my read on the market) versus the
  // past participle ("red": he's read it, read access). A possessive
  // determiner directly before read can only be the noun, but "read" plus a
  // head noun ("read access", "read receipt") is the participle, so
  // determiners only rewrite before a colon, clause punctuation, or a
  // preposition/copula follower. 's is also ambiguous with has ("he's read
  // it") and only rewrites before a colon, which a participle never takes.
  const nounRead = [
    /\b(?:my|your|his|her|its|our|their)\s+read(?=\s*(?::|,|[.!?;]|\b(?:on|of|about|is|was)\b)|\s*$)/gi,
    /\b(?:'s|’s|'|’)\s+read\s*:/gi,
  ];
  for (const pattern of [...presentRead, ...nounRead]) {
    result = result.replace(pattern, (match) => match.replace(/\bread\b/i, (word) =>
      word === "READ" ? "REED" : word[0] === "R" ? "Reed" : "reed"));
  }
  return result;
}

// MeloTTS defaults to the adjective pronunciation ("lyve") for the
// heteronym "live", so verb uses ("I live in Paris") come out wrong. The
// word is genuinely ambiguous, so only rewrite constructions whose grammar
// makes the verb ("liv") reading clear; adjective/adverb uses ("live
// stream", "going live", "the show is live") are left untouched.
const LIVE_VERB_PREPS = "in|with|at|on|near|by|for|together|alone|here|there|where|like|up|off|out|under|above|beyond|through";
// "to live" and bare modals can precede a broadcast compound ("to live
// stream", "can live blog") or a hyphenated one ("live-tweet"), all
// pronounced "lyve", so those frames are excluded after the match.
const LIVE_NOT_BROADCAST = "(?![-–])(?!\\s+(?:stream|broadcast|blog|tweet|chat|demo|migrat|updat|patch|reload)\\w*\\b)";
// Inverted be/go questions ("are you live with us?") keep the adjective
// reading despite the pronoun directly before "live".
const LIVE_BE_GO_BEFORE = "am|are|is|was|were|be|being|been|going|go|goes|went|gone";

function disambiguateLive(value: string): string {
  let result = value;
  const liv = (word: string) => (word === "LIVE" ? "LIV" : word[0] === "L" ? "Liv" : "liv");
  // Pronoun + live + preposition ("I live in Paris", "you live on Main
  // Street"). He/she/it take "lives", so only I/you/we/they anchor here.
  result = result.replace(
    new RegExp(`(\\b\\w+\\s+)?\\b(i|you|we|they)\\s+live\\s+(?:${LIVE_VERB_PREPS})\\b(?![-–])`, "gi"),
    (match, prev) => {
      if (prev && new RegExp(`^(?:${LIVE_BE_GO_BEFORE})$`, "i").test(String(prev).trim())) return match;
      return match.replace(/\blive\b/i, liv);
    },
  );
  const verbLive = [
    // Pronoun + modal + live ("you can live with less"). The modal must
    // follow a pronoun: a bare modal can head a clause whose subject starts
    // with adjective "live" ("will live audiences return?").
    new RegExp(`\\b(i|you|we|they)\\s+(?:can|could|will|would|should|must|may|might|shall)\\s+live\\b${LIVE_NOT_BROADCAST}`, "gi"),
    // Infinitive + preposition ("to live in Paris"). The preposition is
    // required: "to" can also be a preposition before adjective "live"
    // ("listen to live music").
    new RegExp(`\\bto\\s+live\\s+(?:${LIVE_VERB_PREPS})\\b(?![-–])`, "gi"),
    // Do-support ("where do you live?", "does it live up to the hype?").
    // The middle word is required: "does live music..." is the adjective.
    new RegExp(`\\b(?:do|does|did)\\s+[a-z]+\\s+live\\b${LIVE_NOT_BROADCAST}`, "gi"),
    // Relative clause ("people who live in Paris").
    new RegExp(`\\b(?:who|that|which)\\s+live\\s+(?:${LIVE_VERB_PREPS})\\b(?![-–])`, "gi"),
    // Coordinated verb ("work and live in Paris"). "on" is excluded: "and
    // live on stage" can be the adverb.
    new RegExp(`\\b(?:and|or)\\s+live\\s+(?:in|with|at|near|by|for|together|alone|here|there)\\b(?![-–])`, "gi"),
  ];
  for (const pattern of verbLive) {
    result = result.replace(pattern, (match) => match.replace(/\blive\b/i, liv));
  }
  return result;
}

// "lives" is the same heteronym family as "live": the verb ("he lives in
// Paris", "livz") versus the plural noun ("many lives", "lyves"). Only the
// verb has an anchor clean enough to rewrite: he/she/it/who/that/which +
// lives can only be the verb, while a proper noun before it stays ambiguous
// ("Paris lives matter" is the noun).
function disambiguateLives(value: string): string {
  return value.replace(
    new RegExp(`\\b(?:he|she|it|who|that|which)\\s+lives\\s+(?:${LIVE_VERB_PREPS})\\b(?![-–])`, "gi"),
    (match) => match.replace(/\blives\b/i, (word) =>
      word === "LIVES" ? "LIVZ" : word[0] === "L" ? "Livz" : "livz"),
  );
}

// Noun "use" ("yuce") versus verb "use" ("yuze"). Only constructions that
// can only be the noun are rewritten; bare "use" stays on the engine
// default. "use of" can never follow a verb, a determiner can't precede
// one, and "in"/"no" + "use" has no verb reading. The middle word in "of
// use" is a closed adjective list: "millions of people use themes" is the
// verb and must not match.
function disambiguateUse(value: string): string {
  let result = value;
  const nounUse = [
    /\buse\s+of\b/gi,
    /\bin\s+use\b/gi,
    /\bno\s+use\b/gi,
    /\bof\s+(?:(?:great|good|little|much|real|practical|full|effective|limited)\s+)?use\b/gi,
    /\b(?:a|an|the|this|that|these|those|each|every|another|your|their|our|its|per)\s+use\s+cases?\b/gi,
  ];
  for (const pattern of nounUse) {
    result = result.replace(pattern, (match) => match.replace(/\buse\b/i, (word) =>
      word === "USE" ? "UCE" : word[0] === "U" ? "Uce" : "uce"));
  }
  return result;
}

// Verb/noun "lead" ("leed": lead the team, take the lead, lead magnet)
// versus metal "lead" ("led": lead pipes). Both senses are pinned because
// each has frames the other can't appear in; "take/in the lead" still backs
// off before paint/pipes/poisoning ("take the lead pipes out" is the
// metal). "lead paint" and "lead levels" stay untouched: "lead paint
// workshops" (verb) and sales-tier "lead levels" make those ambiguous.
function disambiguateLead(value: string): string {
  let result = value;
  const notMetal = "(?!\\s+(?:paint|pipes?|poisoning)\\b)";
  const verbLead = [
    new RegExp(`\\b(?:take|takes|taking|took)\\s+the\\s+lead\\b${notMetal}`, "gi"),
    new RegExp(`\\bin\\s+the\\s+lead\\b${notMetal}`, "gi"),
    /\blead\s+(?:generation|magnets?|nurturing|scoring|capture|qualification|gen)\b/gi,
    /\blead\s+(?:the|a|an|your|their|our|its|his|her|my|this|that|these|those)\b/gi,
  ];
  for (const pattern of verbLead) {
    result = result.replace(pattern, (match) => match.replace(/\blead\b/i, (word) =>
      word === "LEAD" ? "LEED" : word[0] === "L" ? "Leed" : "leed"));
  }
  result = result.replace(/\blead\s+(?:pipes?|poisoning)\b/gi, (match) => match.replace(/\blead\b/i, (word) =>
    word === "LEAD" ? "LED" : word[0] === "L" ? "Led" : "led"));
  return result;
}

// Verb "close" ("cloze": close the window) versus adjective "close", which
// stays on the engine default (close friends, close to, up close). A
// determiner or object pronoun after "close" can only be the
// verb — an adjective can't precede one — and "to close" + determiner is
// the infinitive, never the preposition + adjective ("listen to close
// friends" has no determiner after close).
function disambiguateClose(value: string): string {
  return value.replace(
    /\bclose\s+(?:the|a|an|your|their|our|its|his|her|my|this|that|these|those|it|them|him|her|me|us|all|every|both)\b/gi,
    (match) => match.replace(/\bclose\b/i, (word) =>
      word === "CLOSE" ? "CLOZE" : word[0] === "C" ? "Cloze" : "cloze"),
  );
}

function finishPhrase(value: string): string {
  const clean = value.trim().replace(/,+$/, "");
  return clean && !/[.!?…␞:;]$/.test(clean) ? clean + "." : clean;
}

function numberWords(value: number): string {
  const small = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  if (value < 20) return small[value];
  if (value < 100) return tens[Math.floor(value / 10)] + (value % 10 ? ` ${small[value % 10]}` : "");
  if (value < 1_000)
    return `${small[Math.floor(value / 100)]} hundred${value % 100 ? ` ${numberWords(value % 100)}` : ""}`;
  if (value < 10_000)
    return `${numberWords(Math.floor(value / 1_000))} thousand${value % 1_000 ? ` ${numberWords(value % 1_000)}` : ""}`;
  return String(value).split("").map((digit) => small[Number(digit)]).join(" ");
}

function removeEmoji(value: string): string {
  return value
    // Keycaps and flags are emoji sequences but are not all covered by
    // Extended_Pictographic.
    .replace(/[0-9#*]\uFE0F?\u20E3/gu, " ")
    .replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, " ")
    .replace(/\p{Extended_Pictographic}(?:\uFE0F|\uFE0E|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E|\p{Emoji_Modifier})?)*/gu, " ")
    .replace(/[\uFE0E\uFE0F\u200D]/g, " ");
}

function removeNumericSeparators(value: string): string {
  return value.replace(/(?<=\d),(?=\d)/g, "");
}

// Model names ("Qwen3.5-9B") reach the TTS engine raw and get misread, so
// expand them: the name is kept, the version reads as a decimal, and the
// trailing parameter count reads letter by letter ("Qwen three point five
// nine bee"). Only the full name-version-size shape rewrites, and it runs
// before expandDecimalNumbers so the attached version never splits there;
// dotted versions ("1.13.0") and bare decimals are still that pass's job.
function expandModelNames(value: string): string {
  return value
    .replace(/\b([A-Za-z]+)(\d+)\.(\d+)-(\d+)([Bb])\b/g, (_match: string, name: string, major: string, minor: string, params: string) => {
      const spokenMinor = minor.split("").map((digit) => numberWords(Number(digit))).join(" ");
      return `${name} ${numberWords(Number(major))} point ${spokenMinor} ${numberWords(Number(params))} bee`;
    })
    .replace(/\b([A-Za-z]+)(\d+)-(\d+)([Bb])\b/g, (_match: string, name: string, version: string, params: string) => {
      return `${name} ${numberWords(Number(version))} ${numberWords(Number(params))} bee`;
    });
}

// Decimal numbers ("4.9") reach the TTS engine raw and get misread, so expand
// them: integer part in words, each fraction digit spoken ("four point nine").
// Dotted versions ("1.13.0") are skipped — only a lone decimal point counts.
function expandDecimalNumbers(value: string): string {
  return value.replace(/(?<!\d\.)\b-?\d+\.\d+\b(?!\.\d)/g, (match) => {
    const negative = match.startsWith("-");
    const [int, frac] = (negative ? match.slice(1) : match).split(".");
    const spokenFrac = frac.split("").map((digit) => numberWords(Number(digit))).join(" ");
    return `${negative ? "minus " : ""}${numberWords(Number(int))} point ${spokenFrac}`;
  });
}

const CURRENCY_UNIT_WORDS: Record<string, string> = { "$": "dollars", "€": "euros", "£": "pounds" };

// A currency amount followed by a scale word ("$870 million") reaches the
// TTS engine raw and gets misread ("eight seventy dollars million"), so
// expand it: number in words, scale word, currency unit last ("eight hundred
// seventy million dollars"). Runs before expandDecimalNumbers so decimal
// amounts ("$2.5 billion") expand here instead of splitting into "two point
// five" first. Plain amounts ("$870") and bare scales ("870 million")
// already read correctly and are left for the engine.
function expandCurrencyScale(value: string): string {
  return value.replace(/([$€£])\s?(\d+(?:\.\d+)?)\s+(thousands?|millions?|billions?|trillions?|quadrillions?)\b/gi,
    (_match: string, symbol: string, amount: string, scale: string) => {
      const [int, frac] = amount.split(".");
      const spokenInt = numberWords(Number(int));
      const spokenAmount = frac === undefined
        ? spokenInt
        : `${spokenInt} point ${frac.split("").map((digit) => numberWords(Number(digit))).join(" ")}`;
      return `${spokenAmount} ${scale.toLowerCase().replace(/s$/, "")} ${CURRENCY_UNIT_WORDS[symbol] ?? "dollars"}`;
    });
}

// Clock times ("9am", "5 pm", "12:30pm") reach the TTS engine raw and get
// misread, so expand them: hour in words, minutes when nonzero ("nine
// thirty"; a leading zero is voiced: "nine oh five"). The morning meridiem
// is dropped ("9am" reads as "nine"); evening times keep a spelled-out
// "pee em" with no stops. A consumed sentence-final period is re-emitted.
// Runs before expandDecimalNumbers so it sees the original digits. Bare
// "am"/"pm" without digits are left untouched.
function expandClockTimes(value: string): string {
  return value.replace(/\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b(\.?)/gi,
    (_match: string, hour: string, minutes: string | undefined, meridiem: string, dot: string) => {
      const spokenHour = numberWords(Number(hour));
      const mins = minutes === undefined ? 0 : Number(minutes);
      const spokenMinutes = minutes === undefined || mins === 0
        ? ""
        : mins < 10
          ? ` oh ${numberWords(mins)}`
          : ` ${numberWords(mins)}`;
      if (meridiem.toLowerCase() === "am") return `${spokenHour}${spokenMinutes}${dot}`;
      return `${spokenHour}${spokenMinutes} pee em${dot}`;
    });
}

function spokenDomains(value: string): string {
  return value
    .replace(/\bhttps?:\/\/[^\s]+/gi, " ")
    .replace(/\bwww\.[^\s]+/gi, " ")
    .replace(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s]*)?/gi, " ");
}

const CITATION_LINK = "\\[[^\\]]+\\]\\([^)]*\\)";
const CITATION_SEP = "(?:[\\s,;]+|\\s+and\\s+)";
const CITATION_LABEL = "(?:via|sources?|references?|read\\s+more|further\\s+reading)";

function stripOrphanLabel(value: string): string {
  // A leftover introducer ("Sources:", "*Via*") must not be narrated alone.
  if (/^\s*[*_~]*\.?\s*:?\s*[*_~]*\s*$/.test(value)) return "";
  if (new RegExp(`^\\s*[*_~]*${CITATION_LABEL}\\s*:?\\.?[*_~]*\\s*$`, "i").test(value)) return "";
  return value;
}

export function removeCitationClusters(value: string): string {
  // A trailing run of citation links ("[a](u), [b](u).") reads aloud as a
  // bare name list, so drop the whole run. A lone trailing link after a
  // finished sentence ("...technology. [CBS transcript](u)") is the same
  // reference shape with one item, so it goes too. Links inside a sentence
  // ("Read [this](u).") keep their text via the normal link handling below.
  const trailingRun = new RegExp(`(?:${CITATION_LINK})(?:${CITATION_SEP}${CITATION_LINK})*[\\s,;]*[.。]?\\s*$`);
  const trailingSingle = new RegExp(`(^|[.!?])\\s*[*_~]*(?:${CITATION_LABEL}\\s*:?\\s+)?${CITATION_LINK}[*_~]*[.。]?\\s*$`, "i");
  return value.split(/(\n\s*\n)/).map((chunk) => {
    if (/^\s*$/.test(chunk) || !chunk.includes("](")) return chunk;
    const match = chunk.match(trailingRun);
    if (match && match.index !== undefined) {
      const linkCount = (match[0].match(/\[[^\]]+\]\(/g) || []).length;
      if (linkCount >= 2) return stripOrphanLabel(chunk.slice(0, match.index).replace(/:\s*$/, "").trimEnd());
    }
    const single = chunk.match(trailingSingle);
    if (single && single.index !== undefined) {
      const kept = chunk.slice(0, single.index).trimEnd() + (/^[.!?]$/.test(single[1] || "") ? "." : "");
      return stripOrphanLabel(kept);
    }
    return chunk;
  }).join("");
}

function removeMarkdownTables(value: string): string {
  const lines = value.split("\n");
  const kept: string[] = [];
  const tableRow = (line: string) => /^\s*\|?[^\n|]+(?:\|[^\n|]+)+\|?\s*$/.test(line);
  const separatorRow = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
  for (let index = 0; index < lines.length;) {
    if (tableRow(lines[index]) && separatorRow(lines[index + 1] || "")) {
      index += 2;
      while (index < lines.length && (tableRow(lines[index]) || !lines[index].trim())) index++;
      kept.push("");
      continue;
    }
    kept.push(lines[index++]);
  }
  return kept.join("\n");
}

function cleanSpeech(value: string, overrides: PronunciationReplacement[] = []): string {
  return disambiguateClose(disambiguateLead(disambiguateUse(disambiguateLives(disambiguateLive(disambiguateRead(spokenForms(applyManagedSpokenForms(spokenDomains(expandDecimalNumbers(expandModelNames(expandClockTimes(expandCurrencyScale(removeNumericSeparators(removeEmoji(value))))))), overrides))))))))
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s*&\s*/g, " and ")
    .replace(/\s+([.,!?;:])(?!\.\.)/g, "$1")
    .replace(/([:;])(?=\s+\S)/g, `$1${TTS_SOFT_PAUSE}`)
    // Preserve pause intent as paragraph breaks. MeloTTS sometimes vocalizes
    // literal ellipses as hesitation sounds such as "eh".
    .replace(/\.{3}/g, "\u0000")
    .replace(/(?<!\.)\.(?!\s*[.\u0000])(?=\s+\S)/g, ".\u0000")
    .replace(/\u241E\s*\u0000|\u0000\s*\u241E/g, TTS_HARD_PAUSE)
    .replace(/(?:\u241E\s*){2,}/g, TTS_HARD_PAUSE)
    .replace(/(?:\u0000\s*){2,}/g, "\u0000")
    .replace(/\s+/g, " ")
    .replace(/\s*\u241E\s*/g, TTS_HARD_PAUSE)
    .replace(/\s*\u0000\s*/g, "\u0000")
    .replace(/\u0000/g, "\n\n")
    .trim();
}

// A trailing "Sources:" credit block is shown on the page but must never be
// narrated — reading bare citations aloud is noise. Only a standalone marker
// line whose tail is list-like (blanks, rules, list items, short lines) is
// cut; a marker followed by real prose is left alone.
const SOURCES_MARKER = /^\s{0,3}(?:#{1,6}\s+|\*\*)?Sources:?\*?\*?\s*$/;
const SOURCES_TAIL_OK = /^\s*(?:[-*_]{3,}|\d{1,6}[.)]\s+|[-+*]\s+|>).*$|^\s*$/;

export function removeSourcesSection(markdown: string): string {
  const lines = markdown.split("\n");
  let marker = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SOURCES_MARKER.test(lines[i])) { marker = i; break; }
  }
  if (marker < 0) return markdown;
  for (let i = marker + 1; i < lines.length; i++) {
    const line = lines[i].replace(/\bhttps?:\/\/[^\s<]+/gi, " ").replace(/\bwww\.[^\s<]+/gi, " ");
    if (SOURCES_TAIL_OK.test(lines[i]) || SOURCES_TAIL_OK.test(line)) continue;
    if (line.trim().length > 200) return markdown;
  }
  return lines.slice(0, marker).join("\n");
}

// Belt-and-braces for anything the heading pass missed (bare ### lines,
// single #): a leading hash 8005s MeloTTS, mid-line hashes are fine.
function stripLeadingHashes(value: string): string {
  return value.replace(/(^|[\n\u241E])\s*#+\s*/g, "$1");
}

export function narrationSections(title: string, markdown: string, overrides: PronunciationReplacement[] = []): { title: string; body: string } {
  const cleaned = removeMarkdownTables(removeCitationClusters(decodeEntities(removeSourcesSection(markdown))
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1"))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\bhttps?:\/\/[^\s<]+/gi, " ")
    .replace(/\bwww\.[^\s<]+/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_~]/g, "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, " ")
    .replace(/\r/g, ""));
  const blocks = cleaned.split(/\n\s*\n+/).map((block) => {
    let containsList = false;
    const lines = block.split("\n").map((line) => {
      // The space after the hashes is optional: writers emit ##Headings and
      // MeloTTS 8005s on any segment starting with #.
      const heading = line.match(/^\s{0,3}#{1,6}\s*(.+?)\s*#*\s*$/);
      if (heading) {
        const numberedHeading = heading[1].match(/^(\d{1,6})[.)](?:\s+(.*))?$/);
        if (numberedHeading) {
          const marker = `${numberWords(Number(numberedHeading[1]))}.${TTS_HARD_PAUSE}`;
          const label = finishPhrase((numberedHeading[2] || "").trim());
          return label ? `${TTS_HARD_PAUSE}${marker} ${label}${TTS_HARD_PAUSE}` : `${TTS_HARD_PAUSE}${marker}`;
        }
        return `${TTS_HARD_PAUSE}${finishPhrase(heading[1])}${TTS_HARD_PAUSE}`;
      }
      const numbered = line.match(/^\s{0,3}(\d{1,6})[.)](?:\s+(.*))?$/);
      if (numbered) {
        containsList = true;
        const marker = `${numberWords(Number(numbered[1]))}.${TTS_HARD_PAUSE}`;
        const item = finishPhrase((numbered[2] || "").trim());
        return item ? `${marker} ${item}` : marker;
      }
      const listItem = /^\s{0,3}[-+*]\s+/.test(line);
      if (listItem) containsList = true;
      const structural = /^\s{0,3}(?:>\s*|[-+*]\s+)/.test(line);
      const text = line.replace(/^\s{0,3}(?:>\s*|[-+*]\s+)/, "").trim();
      return structural ? finishPhrase(text) : text;
    }).filter(Boolean).join(" ");
    const finished = finishPhrase(lines.replace(/\s+/g, " "));
    return containsList && finished ? `${finished}${TTS_HARD_PAUSE}` : finished;
  }).filter(Boolean);
  return {
    // A short, standalone statement gives MeloTTS its most neutral title delivery.
    title: stripLeadingHashes(cleanSpeech(finishPhrase(decodeEntities(title)), overrides)),
    body: stripLeadingHashes(cleanSpeech(blocks.join(` ${TTS_HARD_PAUSE} `), overrides)),
  };
}

export function narrationText(title: string, markdown: string, overrides: PronunciationReplacement[] = []): string {
  const sections = narrationSections(title, markdown, overrides);
  return [sections.title, sections.body].filter(Boolean).join(" ... ");
}

export function pronunciationReplacements(output: string, source: string): PronunciationReplacement[] {
  const clean = output.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(clean);
  } catch {
    return [];
  }
  const candidates = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === "object" && Array.isArray((parsed as { replacements?: unknown }).replacements))
      ? (parsed as { replacements: unknown[] }).replacements
      : [];
  const accepted: PronunciationReplacement[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates.slice(0, 40)) {
    if (!candidate || typeof candidate !== "object") continue;
    const original = String((candidate as Record<string, unknown>).original ?? "").trim();
    const spoken = String((candidate as Record<string, unknown>).spoken ?? "").trim();
    if (!original || original.length > 80 || original.split(/\s+/).length > 6) continue;
    // Ordinary lowercase English prose is MeloTTS's job. Blocking it here keeps
    // the language model from "correcting" words such as plugins into nonsense.
    if (/^[a-z]+(?:[-\s][a-z]+)*$/.test(original)) continue;
    if (!spoken || spoken.length > 120 || !/^[\p{L} .,'’\-]+$/u.test(spoken)) continue;
    if (original === spoken || !source.includes(original) || seen.has(original)) continue;
    seen.add(original);
    accepted.push({ original, spoken });
  }
  return accepted.sort((a, b) => b.original.length - a.original.length);
}

export function applyPronunciations(text: string, replacements: PronunciationReplacement[]): string {
  let result = text;
  for (const { original, spoken } of replacements) result = result.split(original).join(spoken);
  return result;
}

export function ttsBytes(output: Uint8Array | { audio: string }): Uint8Array {
  if (output instanceof Uint8Array) return output;
  if (!output.audio) return new Uint8Array();
  const estimatedLength = Math.floor(output.audio.length * 3 / 4);
  const bytes = new Uint8Array(estimatedLength);
  let offset = 0;
  const chunkSize = 32_768;
  for (let start = 0; start < output.audio.length; start += chunkSize) {
    const binary = atob(output.audio.slice(start, start + chunkSize));
    for (let i = 0; i < binary.length; i++) bytes[offset++] = binary.charCodeAt(i);
  }
  return bytes.subarray(0, offset);
}

// Aura-1 answers through the binding as a byte stream (MPEG by default;
// linear16+wav when requested). Collect it so engine output always ends up
// as plain bytes regardless of which shape a model returns.
export async function ttsStreamToBytes(output: unknown): Promise<Uint8Array> {
  if (output instanceof Uint8Array) return output;
  if (output instanceof ReadableStream) {
    const reader = (output as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { out.set(c, offset); offset += c.length; }
    return out;
  }
  return ttsBytes(output as Uint8Array | { audio: string });
}

// Periods after these never end a sentence ("St. Louis", "Jan. 5"), so
// splitSentences keeps the boundary inline instead of inserting a sentence
// pause mid-phrase. Deliberately excludes words whose sentence use is more
// common in prose ("No.", "Fig."): missing a pause there is benign, while a
// gap inside "St. Louis" is an audible bug.
const SENTENCE_ABBREVIATIONS = new Set([
  "st", "ave", "blvd", "rd", "ln", "dr", "mr", "mrs", "ms", "prof", "rev", "hon",
  "jr", "sr", "inc", "ltd", "corp", "co",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "mon", "tue", "tues", "wed", "thu", "thur", "fri", "sat", "sun",
  "rep", "sen", "gov", "gen", "lt", "sgt", "col", "maj", "adm", "cmdr", "pres",
]);

function endsWithAbbreviation(segment: string): boolean {
  const token = segment.match(/(\S+)\s*$/)?.[1] ?? "";
  if (!token.endsWith(".")) return false;
  const word = token.slice(0, -1);
  if (!word) return false;
  // Letter-dotted tokens ("U.S.", "Ph.D.") are abbreviations; digit-dotted
  // ones ("v1.0.") are versions at a sentence end and still split.
  if (word.includes(".")) return /[A-Za-z]$/.test(word);
  if (/^[A-Z]$/.test(word)) return true;
  return SENTENCE_ABBREVIATIONS.has(word.toLowerCase());
}

// Splits a prompt part on the paragraph breaks cleanSpeech emits after
// sentence-ending periods, rejoining abbreviation boundaries ("St. Louis")
// with the break intact so the engine still sees that input unchanged.
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  for (const part of text.split("\n\n")) {
    const prev = sentences[sentences.length - 1];
    if (prev !== undefined && endsWithAbbreviation(prev)) sentences[sentences.length - 1] = `${prev}\n\n${part}`;
    else sentences.push(part);
  }
  return sentences;
}

export type AudioPrompt = { text: string; pauseAfter: number };

// One place where narration text becomes synthesis segments: title first,
// then body split on structural, punctuation, and sentence boundaries. A
// segment's pause is the strongest boundary it ends at — sentence (0.2s),
// then colon/semicolon (0.35s), then paragraph (0.65s) — so a sentence just
// before a colon keeps the colon pause, not the sentence one.
export function buildAudioPrompts(preparedTitle: string, preparedBody: string, chunkMax: number): AudioPrompt[] {
  const prompts: AudioPrompt[] = [{ text: preparedTitle, pauseAfter: TTS_TITLE_PAUSE_SECONDS }];
  const structuralParts = preparedBody.split(TTS_HARD_PAUSE);
  for (let partIndex = 0; partIndex < structuralParts.length; partIndex++) {
    const punctuationParts = structuralParts[partIndex].split(TTS_SOFT_PAUSE);
    for (let punctuationIndex = 0; punctuationIndex < punctuationParts.length; punctuationIndex++) {
      const sentences = splitSentences(punctuationParts[punctuationIndex].trim()).map((sentence) => sentence.trim()).filter(Boolean);
      for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex++) {
        const chunks = narrationChunks(sentences[sentenceIndex], chunkMax);
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
          const isLastChunk = chunkIndex === chunks.length - 1;
          const isLastSentence = sentenceIndex === sentences.length - 1;
          const isLastPunctuationPart = punctuationIndex === punctuationParts.length - 1;
          const pauseAfter = !isLastChunk ? 0
            : !isLastSentence ? TTS_SENTENCE_PAUSE_SECONDS
              : !isLastPunctuationPart ? TTS_PUNCTUATION_PAUSE_SECONDS
                : partIndex < structuralParts.length - 1 ? TTS_STRUCTURE_PAUSE_SECONDS : 0;
          prompts.push({ text: chunks[chunkIndex], pauseAfter });
        }
      }
    }
  }
  return prompts;
}

export function narrationChunks(text: string, maxLength = TTS_CHUNK_MAX): string[] {
  if (text.length <= maxLength) return text ? [text] : [];
  const sentences = text.match(/[^.!?]+[.!?]+(?:["'’]+)?|[^.!?]+$/g) || [text];
  const units: string[] = [];
  for (const sentence of sentences) {
    const clean = sentence.trim();
    if (clean.length <= maxLength) {
      if (clean) units.push(clean);
      continue;
    }
    const words = clean.split(/\s+/);
    let part = "";
    for (const word of words) {
      if (part && part.length + word.length + 1 > maxLength) {
        units.push(part);
        part = "";
      }
      if (word.length > maxLength) {
        if (part) units.push(part);
        for (let i = 0; i < word.length; i += maxLength) units.push(word.slice(i, i + maxLength));
      } else {
        part = part ? `${part} ${word}` : word;
      }
    }
    if (part) units.push(part);
  }

  const chunks: string[] = [];
  let chunk = "";
  for (const unit of units) {
    if (chunk && chunk.length + unit.length + 1 > maxLength) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk = chunk ? `${chunk} ${unit}` : unit;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

type WavPart = {
  bytes: Uint8Array;
  dataOffset: number;
  dataSize: number;
  dataSizeOffset: number;
  format: Uint8Array;
};

function fourCC(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function parseWav(bytes: Uint8Array): WavPart {
  if (bytes.length < 44 || fourCC(bytes, 0) !== "RIFF" || fourCC(bytes, 8) !== "WAVE")
    throw new Error("The speech model returned invalid WAV audio.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let format: Uint8Array | null = null;
  while (offset + 8 <= bytes.length) {
    const id = fourCC(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    if (id === "data") {
      if (!format) throw new Error("The speech model returned WAV audio without a format chunk.");
      // Streaming encoders emit the WAV container before the payload size is
      // known and mark the data chunk with an unknown-size sentinel
      // (0xFFFFFFFF per convention; Aura-1 over the Workers AI binding emits
      // 0x7FFF0000, verified live). The bytes on the wire are the audio.
      const dataSize = size === 0xFFFFFFFF || size === 0x7FFF0000 ? bytes.length - dataOffset : size;
      if (dataOffset + dataSize > bytes.length) throw new Error("The speech model returned truncated WAV audio.");
      return { bytes, dataOffset, dataSize, dataSizeOffset: offset + 4, format };
    }
    if (dataOffset + size > bytes.length) throw new Error("The speech model returned truncated WAV audio.");
    if (id === "fmt ") format = bytes.slice(dataOffset, dataOffset + size);
    offset = dataOffset + size + (size % 2);
  }
  throw new Error("The speech model returned WAV audio without sample data.");
}

// Segment-level guard: truncated bytes must fail here — inside the
// retry/split window — and never reach a checkpoint, or resume would reuse
// them as good audio and the job could never converge.
export function validWavAudio(bytes: Uint8Array): boolean {
  try {
    wavAssembly([bytes], 0);
    return true;
  } catch {
    return false;
  }
}

export function mergeWav(parts: Uint8Array[]): Uint8Array {
  if (!parts.length) return new Uint8Array();
  const assembly = wavAssembly(parts);
  const output = new Uint8Array(assembly.size);
  output.set(assembly.header);
  let offset = assembly.header.length;
  for (const samples of assembly.samples) {
    output.set(samples, offset);
    offset += samples.length;
  }
  return output;
}

export function wavAssembly(parts: Uint8Array[], pausesAfterSeconds: number | number[] = 0): { header: Uint8Array; samples: Uint8Array[]; size: number } {
  if (!parts.length) return { header: new Uint8Array(), samples: [], size: 0 };
  const parsed = parts.map(parseWav);
  const format = parsed[0].format;
  for (const part of parsed.slice(1)) {
    // Encoders may append different, non-audio metadata to the fmt chunk on
    // separate requests. Only the canonical PCM format fields must match.
    if (part.format.length < 16 || format.length < 16 ||
        part.format.subarray(0, 16).some((byte, i) => byte !== format[i]))
      throw new Error("The speech model returned incompatible WAV segments.");
  }
  const formatView = new DataView(format.buffer, format.byteOffset, format.byteLength);
  if (format.byteLength < 16) throw new Error("The speech model returned an incomplete WAV format.");
  const audioFormat = formatView.getUint16(0, true);
  const byteRate = formatView.getUint32(8, true);
  const blockAlign = formatView.getUint16(12, true);
  const bitsPerSample = formatView.getUint16(14, true);
  if (!byteRate || !blockAlign) throw new Error("The speech model returned an invalid WAV format.");

  const pauseDurations = typeof pausesAfterSeconds === "number" ? [pausesAfterSeconds] : pausesAfterSeconds;
  const silences = parsed.map((_, index) => {
    let silenceLength = Math.round(byteRate * Math.max(0, pauseDurations[index] || 0));
    silenceLength -= silenceLength % blockAlign;
    const silence = new Uint8Array(silenceLength);
    // Unsigned 8-bit PCM represents silence at its midpoint; other PCM formats use zero.
    if (audioFormat === 1 && bitsPerSample === 8) silence.fill(128);
    return silence;
  });

  const headerLength = parsed[0].dataOffset;
  const dataLength = parsed.reduce((total, part, index) => total + part.dataSize + silences[index].byteLength, 0);
  const header = parsed[0].bytes.slice(0, headerLength);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  view.setUint32(4, headerLength + dataLength - 8, true);
  view.setUint32(parsed[0].dataSizeOffset, dataLength, true);
  const samples = parsed.flatMap((part, index) => {
    const data = part.bytes.subarray(part.dataOffset, part.dataOffset + part.dataSize);
    return silences[index].byteLength ? [data, silences[index]] : [data];
  });
  return { header, samples, size: headerLength + dataLength };
}
