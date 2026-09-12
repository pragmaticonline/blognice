// Social login with Google (OAuth 2.0 authorization code flow).
// Distinct from src/oauth.ts, where Blognice acts as the provider for MCP
// clients. Here Blognice is the relying party: visitors sign in with Google
// and are linked to a Blognice account by verified email.

import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createSession, setSessionCookie } from "./auth";
import { loginPage } from "./admin";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_STATE_COOKIE = "bn_google_state";
const STATE_TTL = 600; // 10 minutes, in seconds

export function newGoogleState(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function buildGoogleAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
  });
  return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`;
}

export function googleRedirectUri(c: any): string {
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}/auth/google/callback`;
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

function sameState(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length || ab.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function newPlaceholderHash(): string {
  // Never verifies: verifyPassword rejects unknown hash formats. Google-only
  // accounts sign in via OAuth; a password can be set later through reset.
  return `google-oauth$${newGoogleState()}`;
}

export async function handleGoogleCallback(c: any): Promise<Response> {
  const fail = (message: string, status: 401 | 502) => {
    const response = c.html(loginPage(message), status);
    response.headers.set("Cache-Control", "no-store, max-age=0");
    return response;
  };

  const clientId = String(c.env?.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(c.env?.GOOGLE_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) return c.text("Sign in with Google is not configured.", 503);

  const url = new URL(c.req.url);
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const expected = getCookie(c, GOOGLE_STATE_COOKIE) || "";
  if (!code || !sameState(state, expected)) {
    return fail("Google sign-in failed. Please try again.", 401);
  }

  let accessToken = "";
  try {
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: googleRedirectUri(c),
        grant_type: "authorization_code",
      }).toString(),
    });
    if (!tokenRes.ok) return fail("Google sign-in is temporarily unavailable. Please try again.", 502);
    accessToken = String((await tokenRes.json() as any)?.access_token || "");
  } catch {
    return fail("Google sign-in is temporarily unavailable. Please try again.", 502);
  }
  if (!accessToken) return fail("Google sign-in is temporarily unavailable. Please try again.", 502);

  let profile: any;
  try {
    const profileRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!profileRes.ok) return fail("Google sign-in is temporarily unavailable. Please try again.", 502);
    profile = await profileRes.json();
  } catch {
    return fail("Google sign-in is temporarily unavailable. Please try again.", 502);
  }
  const email = String(profile?.email || "").trim().toLowerCase();
  if (!email || profile?.email_verified !== true) {
    return fail("Google did not provide a verified email address.", 401);
  }

  const db: D1Database = c.env.DB;
  const now = Math.floor(Date.now() / 1000);
  let account = await db.prepare("SELECT id FROM accounts WHERE email = ?").bind(email).first<{ id: number }>();
  if (account) {
    await db.prepare("UPDATE accounts SET email_verified = 1, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?")
      .bind(now, account.id).run();
  } else {
    try {
      const inserted = await db.prepare(
        "INSERT INTO accounts (email, pw_hash, email_verified, email_verified_at, created_at) VALUES (?, ?, 1, ?, ?)"
      ).bind(email, newPlaceholderHash(), now, now).run();
      account = { id: inserted.meta.last_row_id as number };
    } catch {
      // Lost an insert race: another request created the account first.
      account = await db.prepare("SELECT id FROM accounts WHERE email = ?").bind(email).first<{ id: number }>();
      if (!account) return fail("Google sign-in failed. Please try again.", 401);
      await db.prepare("UPDATE accounts SET email_verified = 1, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?")
        .bind(now, account.id).run();
    }
  }

  const token = await createSession(db, account.id);
  deleteCookie(c, GOOGLE_STATE_COOKIE, { path: "/" });
  setSessionCookie(c, token);
  return c.redirect("/admin");
}

export async function handleGoogleStart(c: any): Promise<Response> {
  const clientId = String(c.env?.GOOGLE_CLIENT_ID || "").trim();
  if (!clientId) return c.text("Sign in with Google is not configured.", 503);
  const state = newGoogleState();
  const secure = new URL(c.req.url).protocol === "https:";
  setCookie(c, GOOGLE_STATE_COOKIE, state, {
    httpOnly: true,
    secure, // off on http://localhost so the cookie is still sent in dev
    sameSite: "Lax",
    path: "/",
    maxAge: STATE_TTL,
  });
  return c.redirect(buildGoogleAuthUrl(clientId, googleRedirectUri(c), state), 302);
}
