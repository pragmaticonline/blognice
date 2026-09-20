// Shared worker<->comment-room authentication. Disqus-style: HMAC over a
// normalized request with a timestamped single-use nonce. The room never
// accepts unsigned event injections; browsers can only open WebSockets.
export const ROOM_NONCE_TTL_MS = 5 * 60 * 1000;

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function randomHex(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return [...data].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256HexText(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function hmacHex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}

// Normalized form both sides sign: nonce, method, path, body hash.
export async function signRoomRequest(secret: string, method: string, path: string, body: string, nonce?: string): Promise<{ nonce: string; bodyHash: string; mac: string }> {
  const fresh = nonce ?? `${Date.now()}:${randomHex(8)}`;
  const bodyHash = await sha256HexText(body);
  const mac = await hmacHex(secret, `${fresh}\n${method}\n${path}\n${bodyHash}`);
  return { nonce: fresh, bodyHash, mac };
}

export async function verifyRoomRequest(
  secret: string,
  method: string,
  path: string,
  body: string,
  nonce: string | null,
  mac: string | null,
  seenNonces: Set<string>,
  nowMs: number
): Promise<boolean> {
  if (!nonce || !mac) return false;
  const parts = nonce.split(":");
  if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !/^[0-9a-f]+$/.test(parts[1])) return false;
  if (Math.abs(nowMs - Number(parts[0])) > ROOM_NONCE_TTL_MS) return false;
  if (seenNonces.has(nonce)) return false;
  const expected = await signRoomRequest(secret, method, path, body, nonce);
  let ok = false;
  try {
    ok = timingSafeEqualBytes(unhex(expected.mac), unhex(mac));
  } catch { ok = false; }
  if (ok) seenNonces.add(nonce);
  return ok;
}

export function commentRoomName(tenantId: number, postId: number): string {
  return `comment-room:${tenantId}:${postId}`;
}
