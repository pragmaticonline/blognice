export type MediaUse = { id: number; title: string };

export function validLibraryFile(file: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(file) && !file.startsWith("avatar-");
}

export function mediaKey(tenantId: number, file: string): string {
  return `${tenantId}/${file}`;
}

export function mediaUrl(key: string): string {
  return `/media/${key}`;
}

const MP3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MP3_SAMPLE_RATES = [44100, 48000, 32000, 0];

// Whole-file MP3 check: skip an ID3v2 tag, then walk every MPEG1 Layer III
// frame header. A header sniff alone accepts truncated uploads and HTML with
// an MP3 disguise; a corrupt frame anywhere fails the file. Frame payload
// bytes are opaque by design, so mid-frame content is never judged.
export function isValidMp3(bytes: Uint8Array): boolean {
  let at = 0;
  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    at = 10 + size;
  }
  let frames = 0;
  while (at < bytes.length) {
    if (at + 4 > bytes.length) return false;
    const b0 = bytes[at], b1 = bytes[at + 1], b2 = bytes[at + 2];
    if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return false;
    if ((b1 & 0x18) !== 0x18) return false; // not MPEG1
    if ((b1 & 0x06) !== 0x02) return false; // not Layer III
    const bitrate = MP3_BITRATES[(b2 & 0xf0) >> 4];
    const sampleRate = MP3_SAMPLE_RATES[(b2 & 0x0c) >> 2];
    if (!bitrate || !sampleRate) return false;
    const padding = (b2 & 0x02) >> 1;
    at += Math.floor((144 * bitrate * 1000) / sampleRate) + padding;
    frames++;
  }
  return frames > 0;
}

export const AUDIO_MIME = "audio/mpeg";

// audio/mp3 is a widespread non-standard alias (some HTTP clients and tools
// send it). Accept it at the gate; storage always uses the canonical type.
export function isAudioMime(type: unknown): boolean {
  return type === AUDIO_MIME || type === "audio/mp3";
}

// Single-range parsing for media seeking (audio scrubbing). Returns an
// inclusive slice or null when the header is absent, malformed, multi-range,
// or unsatisfiable (caller answers 416).
export function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, first, last] = m;
  if (first === "" && last === "") return null;
  let start: number, end: number;
  if (first === "") {
    const suffix = Number(last);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(first);
    end = last === "" ? size - 1 : Number(last);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
    if (start >= size) return null;
    end = Math.min(end, size - 1);
    if (end < start) return null;
  }
  return { start, end };
}

// Shared by the admin and REST upload handlers: validate bytes, then mint a
// tenant-scoped key, public URL, and ready-to-paste player snippet. Throws
// when the bytes are not a real MP3 frame chain.
export function prepareAudioUpload(
  tenantId: number,
  bytes: Uint8Array,
  originalName: string,
  kind: "clip" | "narration" = "clip"
): { key: string; url: string; snippet: string; originalName: string } {
  if (!isValidMp3(bytes)) throw new Error("not audio: expected an MP3 file");
  const rand = crypto.randomUUID().slice(0, 8);
  const key = `${tenantId}/${Date.now()}-${rand}-${kind === "narration" ? "narration" : "audio"}.mp3`;
  const url = mediaUrl(key);
  return {
    key,
    url,
    // Paste target for post bodies: a bare URL on its own line renders as a
    // player (see audioEmbeds). Raw <audio> HTML would be stripped by the
    // Markdown sanitizer, so never emit the tag itself here.
    snippet: url,
    originalName: originalName.slice(0, 200),
  };
}

// Keep the reference check in one tested place. The caller supplies the
// already tenant-routed posts database; tenant_id remains in the query as a
// second isolation boundary.
export async function findMediaUse(
  db: D1Database,
  tenantId: number,
  url: string
): Promise<MediaUse | null> {
  return db.prepare(
    "SELECT id, title FROM posts WHERE tenant_id = ? AND (instr(body_md, ?) > 0 OR featured_image_key = ?) LIMIT 1"
  ).bind(tenantId, url, url.slice("/media/".length)).first<MediaUse>();
}
