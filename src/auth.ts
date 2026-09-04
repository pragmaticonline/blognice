// Authentication: password hashing (scrypt via native Node crypto), server-side
// sessions in D1, and cookie helpers. No external dependencies.

import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { pbkdf2, scrypt } from "node:crypto";

const enc = new TextEncoder();
const SESSION_COOKIE = "bn_session";
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days, in seconds
// OWASP's 32 MiB scrypt setting. Cloudflare workerd supports this natively and
// permits N * r * p up to 2^20; this setting costs 786,432 and stays below it.
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 3;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const DERIVED_KEY_BYTES = 32;
const CLOUDFLARE_MAX_PBKDF2_ITERATIONS = 100_000;

export type Account = {
  locked_until?: number | null;
  id: number;
  email: string;
  status?: string | null;
  status_reason?: string | null;
  status_changed_at?: number | null;
  billing_status?: string | null;
  billing_cancel_at_period_end?: number | null;
  crypto_paid_through?: number | null;
  vip_granted_at?: number | null;
  vip_expires_at?: number | null;
  vip_granted_by?: number | null;
  vip_reason?: string | null;
  max_blogs_override?: number | null;
  email_verified?: number | null;
  email_verified_at?: number | null;
};

export function isSuspended(account: Pick<Account, "status" | "locked_until">): boolean {
  if (String(account.status || "active") === "suspended") return true;
  const lu = (account as any).locked_until;
  if (lu && Number(lu) > Math.floor(Date.now()/1000)) return true;
  return false;
}

export function isEmailVerified(account: Pick<Account, "email_verified">): boolean {
  return Number(account.email_verified || 0) === 1;
}

export function accountIsVip(account: Pick<Account, "vip_granted_at" | "vip_expires_at">): boolean {
  const granted = Number((account as any).vip_granted_at || 0);
  if (!granted) return false;
  const expires = (account as any).vip_expires_at;
  if (expires == null) return true;
  return Number(expires) > Math.floor(Date.now() / 1000);
}

/** Paid access remains available during Stripe's short past-due recovery window. VIP is treated as paid. */
export function accountHasPaidPlan(account: Pick<Account, "billing_status" | "crypto_paid_through" | "vip_granted_at" | "vip_expires_at">): boolean {
  if (accountIsVip(account as any)) return true;
  return ["active", "trialing", "past_due"].includes(String(account.billing_status || "inactive")) ||
    Number(account.crypto_paid_through || 0) > Math.floor(Date.now() / 1000);
}

export function maxBlogsForAccount(account: Pick<Account, "billing_status" | "crypto_paid_through" | "vip_granted_at" | "vip_expires_at" | "max_blogs_override">): number {
  const override = (account as any).max_blogs_override;
  if (Number.isSafeInteger(override) && override >= 1 && override <= 50) return override;
  return accountHasPaidPlan(account as any) ? 5 : 1;
}

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
async function deriveScrypt(
  password: string,
  salt: Uint8Array,
  n = SCRYPT_N,
  r = SCRYPT_R,
  p = SCRYPT_P,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    scrypt(
      enc.encode(password),
      salt,
      DERIVED_KEY_BYTES,
      { N: n, r, p, maxmem: SCRYPT_MAXMEM },
      (error, key) => {
        if (error) reject(error);
        else resolve(new Uint8Array(key));
      },
    );
  });
}

async function deriveLegacyPbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    pbkdf2(enc.encode(password), salt, iterations, DERIVED_KEY_BYTES, "sha256", (error, key) => {
      if (error) reject(error);
      else resolve(new Uint8Array(key));
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const dk = await deriveScrypt(password, salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${toB64(salt)}$${toB64(dk)}`;
}

/** Generate a high-entropy, URL-safe reset token. Store only its hash. */
export function generateResetToken(bytes = 32): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data, (b) => b.toString(16).padStart(2, "0")).join("");
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
  try {
    const parts = stored.split("$");
    if (parts.length === 6 && parts[0] === "scrypt") {
      const n = Number(parts[1]);
      const r = Number(parts[2]);
      const p = Number(parts[3]);
      if (n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return false;
      const salt = fromB64(parts[4]);
      const expected = fromB64(parts[5]);
      if (salt.length !== 16 || expected.length !== DERIVED_KEY_BYTES) return false;
      const actual = await deriveScrypt(password, salt, n, r, p);
      return timingSafeEqual(actual, expected);
    }

    // Compatibility for hashes created before the forced-reset migration.
    // Hosted workerd rejects PBKDF2 work factors above 100,000 even through
    // node:crypto, so any higher-round legacy account must use Forgot password.
    if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
    const iterations = Number(parts[1]);
    if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > CLOUDFLARE_MAX_PBKDF2_ITERATIONS) {
      return false;
    }
    const salt = fromB64(parts[2]);
    const expected = fromB64(parts[3]);
    if (!salt.length || expected.length !== DERIVED_KEY_BYTES) return false;
    const actual = await deriveLegacyPbkdf2(password, salt, iterations);
    return timingSafeEqual(actual, expected);
  } catch {
    // Malformed or unsupported stored hashes must fail authentication without
    // turning the login page into a 500 response.
    return false;
  }
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
  try {
    const row = (await c.env.DB.prepare(
      `SELECT a.id, a.email, COALESCE(a.status, 'active') AS status, a.status_reason, a.status_changed_at,
              COALESCE(a.billing_status, 'inactive') AS billing_status,
              COALESCE(a.billing_cancel_at_period_end, 0) AS billing_cancel_at_period_end,
              a.crypto_paid_through, a.vip_granted_at, a.vip_expires_at, a.max_blogs_override, COALESCE(a.email_verified, 0) AS email_verified, a.email_verified_at, a.locked_until
         FROM sessions s JOIN accounts a ON a.id = s.account_id
        WHERE s.token = ? AND s.expires_at > ?`
    ).bind(token, now).first()) as Account | null;
    return row ?? null;
  } catch {
    const row = (await c.env.DB.prepare(
      `SELECT a.id, a.email, COALESCE(a.status, 'active') AS status, a.status_reason, a.status_changed_at,
              COALESCE(a.billing_status, 'inactive') AS billing_status,
              COALESCE(a.billing_cancel_at_period_end, 0) AS billing_cancel_at_period_end,
              a.crypto_paid_through, a.vip_granted_at, a.vip_expires_at, a.max_blogs_override, COALESCE(a.email_verified, 0) AS email_verified, a.email_verified_at
         FROM sessions s JOIN accounts a ON a.id = s.account_id
        WHERE s.token = ? AND s.expires_at > ?`
    ).bind(token, now).first()) as Account | null;
    return row ?? null;
  }
}

// --- cookie set/clear ------------------------------------------------------
function sessionCookieDomain(c: any): string | undefined {
  const requestHost = new URL(c.req.url).hostname.toLowerCase();
  const rootDomain = String(c.env?.ROOT_DOMAIN ?? "").trim().toLowerCase();
  return rootDomain && (requestHost === rootDomain || requestHost.endsWith(`.${rootDomain}`))
    ? `.${rootDomain}`
    : undefined;
}

export function setSessionCookie(c: any, token: string): void {
  const secure = new URL(c.req.url).protocol === "https:";
  const cookieDomain = sessionCookieDomain(c);
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
  // Older deployments issued a host-only cookie before the shared
  // `.blognice.com` cookie was introduced. Clear both variants so a stale
  // duplicate cannot win cookie parsing in the browser.
  const domain = sessionCookieDomain(c);
  if (domain) deleteCookie(c, SESSION_COOKIE, { path: "/", domain });
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
    .prepare("SELECT id, email, COALESCE(status, 'active') AS status, status_reason, status_changed_at, COALESCE(billing_status, 'inactive') AS billing_status, COALESCE(billing_cancel_at_period_end, 0) AS billing_cancel_at_period_end, crypto_paid_through, vip_granted_at, vip_expires_at, max_blogs_override FROM accounts WHERE api_key_hash = ?")
    .bind(hash)
    .first()) as Account | null;
}
