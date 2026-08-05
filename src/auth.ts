// Authentication: password hashing (PBKDF2 via Web Crypto), server-side
// sessions in D1, and cookie helpers. No external dependencies.

import { getCookie, setCookie, deleteCookie } from "hono/cookie";

const enc = new TextEncoder();
const SESSION_COOKIE = "bn_session";
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days, in seconds
const PBKDF2_ITERATIONS = 100_000;

export type Account = {
  id: number;
  email: string;
};

// --- base64 helpers for raw bytes -----------------------------------------
function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// --- passwords -------------------------------------------------------------
async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const dk = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(dk)}`;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = parseInt(parts[1], 10);
  const salt = fromB64(parts[2]);
  const expected = fromB64(parts[3]);
  const actual = await derive(password, salt, iterations);
  return timingSafeEqual(actual, expected);
}

// --- sessions --------------------------------------------------------------
function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function createSession(
  db: D1Database,
  accountId: number
): Promise<string> {
  const token = newToken();
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      "INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
    )
    .bind(token, accountId, now, now + SESSION_TTL)
    .run();
  return token;
}

export async function destroySession(
  db: D1Database,
  token: string
): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
}

// Resolve the current logged-in account from the session cookie, or null.
export async function currentAccount(c: any): Promise<Account | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const now = Math.floor(Date.now() / 1000);
  const row = (await c.env.DB.prepare(
    `SELECT a.id, a.email
       FROM sessions s JOIN accounts a ON a.id = s.account_id
      WHERE s.token = ? AND s.expires_at > ?`
  )
    .bind(token, now)
    .first()) as Account | null;
  return row ?? null;
}

// --- cookie set/clear ------------------------------------------------------
export function setSessionCookie(c: any, token: string): void {
  const secure = new URL(c.req.url).protocol === "https:";
  const requestHost = new URL(c.req.url).hostname.toLowerCase();
  const rootDomain = String(c.env?.ROOT_DOMAIN ?? "").trim().toLowerCase();
  const cookieDomain = rootDomain && (requestHost === rootDomain || requestHost.endsWith(`.${rootDomain}`))
    ? `.${rootDomain}`
    : undefined;
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure, // off on http://localhost so the cookie is still sent in dev
    sameSite: "Lax", // blocks the cookie on cross-site POSTs (CSRF defense)
    path: "/",
    maxAge: SESSION_TTL,
    ...(cookieDomain ? { domain: cookieDomain } : {}),
  });
}

export function clearSessionCookie(c: any): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export function getSessionToken(c: any): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

// --- Per-account API keys --------------------------------------------------
// A key is a high-entropy random token shown to the account holder once; only
// its SHA-256 hash is stored, so a database leak can't expose usable keys.

export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `bnk_${b64}`;
}

export async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function accountFromApiKey(
  db: D1Database,
  key: string
): Promise<Account | null> {
  if (!key || !key.startsWith("bnk_")) return null;
  const hash = await sha256hex(key);
  return (await db
    .prepare("SELECT id, email FROM accounts WHERE api_key_hash = ?")
    .bind(hash)
    .first()) as Account | null;
}
