export const TTS_MODEL = "@cf/myshell-ai/melotts" as const;
export const TTS_CHUNK_MAX = 3_500;
export const TTS_TEXT_MAX = 10_000;
export const TTS_TITLE_PAUSE_SECONDS = 1.5;
export const TTS_STRUCTURE_PAUSE_SECONDS = 0.65;
export const TTS_PUNCTUATION_PAUSE_SECONDS = 0.35;
export const TTS_HARD_PAUSE = "\u241E";
export const TTS_SOFT_PAUSE = "\u241F";

export type PronunciationReplacement = { original: string; spoken: string };

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
  for (const pattern of presentRead) {
    result = result.replace(pattern, (match) => match.replace(/\bread\b/i, (word) =>
      word === "READ" ? "REED" : word[0] === "R" ? "Reed" : "reed"));
  }
  return result;
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

function cleanSpeech(value: string, overrides: PronunciationReplacement[] = []): string {
  return disambiguateRead(spokenForms(applyManagedSpokenForms(removeEmoji(value), overrides)))
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

export function narrationSections(title: string, markdown: string, overrides: PronunciationReplacement[] = []): { title: string; body: string } {
  const cleaned = decodeEntities(markdown)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_~]/g, "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, " ")
    .replace(/\r/g, "");
  const blocks = cleaned.split(/\n\s*\n+/).map((block) => {
    let containsList = false;
    const lines = block.split("\n").map((line) => {
      const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
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
    title: cleanSpeech(finishPhrase(decodeEntities(title)), overrides),
    body: cleanSpeech(blocks.join(" ... "), overrides),
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
    if (dataOffset + size > bytes.length) throw new Error("The speech model returned truncated WAV audio.");
    if (id === "fmt ") format = bytes.slice(dataOffset, dataOffset + size);
    if (id === "data") {
      if (!format) throw new Error("The speech model returned WAV audio without a format chunk.");
      return { bytes, dataOffset, dataSize: size, dataSizeOffset: offset + 4, format };
    }
    offset = dataOffset + size + (size % 2);
  }
  throw new Error("The speech model returned WAV audio without sample data.");
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
