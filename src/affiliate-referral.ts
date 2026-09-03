import { captureReferralInDb, type CaptureReferralResult } from "./affiliate";

const COOKIE_NAME = "bn_ref";
const ATTRIBUTION_WINDOW_SECONDS = 60 * 24 * 60 * 60;
const MIN_SIGNING_SECRET_BYTES = 32;
const encoder = new TextEncoder();

type ReferralCookie = {
  affiliateId: number;
  policyVersion: string;
  interactedAt: number;
  expiresAt: number;
};

function base64UrlEncode(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function signature(payload: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function createReferralCookie(payload: ReferralCookie, secret: string): Promise<string> {
  const encoded = base64UrlEncode(JSON.stringify(payload));
  return `${encoded}.${base64UrlEncode(await signature(encoded, secret))}`;
}

function validSigningSecrets(secrets: string[]): string[] {
  return [...new Set(secrets.map((secret) => secret.trim()).filter(
    (secret) => encoder.encode(secret).byteLength >= MIN_SIGNING_SECRET_BYTES,
  ))];
}

async function readReferralCookie(value: string, secrets: string[], now: number): Promise<ReferralCookie | null> {
  const [encoded, encodedSignature, extra] = value.split(".");
  const signatureBytes = encodedSignature ? base64UrlDecode(encodedSignature) : null;
  const payloadBytes = encoded ? base64UrlDecode(encoded) : null;
  if (!encoded || !signatureBytes || !payloadBytes || extra !== undefined) return null;
  let valid = false;
  for (const secret of validSigningSecrets(secrets)) {
    const matches = equalBytes(signatureBytes, await signature(encoded, secret));
    valid = matches || valid;
  }
  if (!valid) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payloadBytes)) as Partial<ReferralCookie>;
    if (!Number.isInteger(parsed.affiliateId) || !Number.isInteger(parsed.interactedAt)
      || !Number.isInteger(parsed.expiresAt) || typeof parsed.policyVersion !== "string"
      || parsed.expiresAt! <= now || parsed.interactedAt! > now) return null;
    return parsed as ReferralCookie;
  } catch {
    return null;
  }
}

function requestCookie(request: Request, name: string): string {
  for (const item of (request.headers.get("cookie") || "").split(";")) {
    const separator = item.indexOf("=");
    if (separator > 0 && item.slice(0, separator).trim() === name) return item.slice(separator + 1).trim();
  }
  return "";
}

export async function captureReferralCode(
  db: D1Database,
  accountId: number,
  rawCode: string,
  now: number,
): Promise<CaptureReferralResult | { accepted: false; reason: "invalid_code" | "self_referral" | "paid_account" }> {
  const code = rawCode.trim();
  if (!/^[a-z0-9-]{3,32}$/i.test(code)) return { accepted: false, reason: "invalid_code" };
  const affiliate = await db.prepare(
    `SELECT profile.account_id, acceptance.policy_version
       FROM affiliate_profiles AS profile
       JOIN affiliate_terms_acceptances AS acceptance ON acceptance.id = profile.terms_acceptance_id
      WHERE profile.referral_code = ? COLLATE NOCASE AND profile.status = 'active'
        AND profile.stripe_promotion_code_id IS NOT NULL`,
  ).bind(code).first<{ account_id: number; policy_version: string }>();
  if (!affiliate) return { accepted: false, reason: "invalid_code" };
  if (affiliate.account_id === accountId) return { accepted: false, reason: "self_referral" };
  const account = await db.prepare(
    `SELECT account.billing_status, account.crypto_paid_through,
            account.affiliate_eligibility_closed_at AS eligibility_closed_at,
            attribution.id AS attribution_id
       FROM accounts AS account
       LEFT JOIN affiliate_attributions AS attribution ON attribution.referred_account_id = account.id
      WHERE account.id = ?`,
  ).bind(accountId).first<{
    billing_status: string | null;
    crypto_paid_through: number | null;
    eligibility_closed_at: number | null;
    attribution_id: number | null;
  }>();
  if (!account) return { accepted: false, reason: "invalid_code" };
  if (!["inactive", "trialing"].includes(String(account.billing_status || "inactive"))
    || account.crypto_paid_through !== null) {
    return { accepted: false, reason: "paid_account" };
  }
  return captureReferralInDb(
    db,
    { affiliateId: affiliate.account_id, source: "code", interactedAt: now, policyVersion: affiliate.policy_version },
    { accountId, attributionId: account.attribution_id, eligibilityClosedAt: account.eligibility_closed_at },
    { attributionWindowSeconds: ATTRIBUTION_WINDOW_SECONDS },
    now,
  );
}

export async function handleReferralCodeSubmission(
  request: Request,
  db: D1Database,
  accountId: number,
  now: number,
  onAccepted?: (event: {
    affiliateId: number;
    name: "affiliate_signup";
    source: "code";
    policyVersion: string;
  }) => void,
): Promise<Response> {
  const form = await request.formData();
  const result = await captureReferralCode(db, accountId, String(form.get("referral_code") || ""), now);
  if (result.accepted) {
    const attribution = await db.prepare(
      "SELECT affiliate_id, policy_version FROM affiliate_attributions WHERE referred_account_id = ?",
    ).bind(accountId).first<{ affiliate_id: number; policy_version: string }>();
    if (attribution) onAccepted?.({
      affiliateId: attribution.affiliate_id,
      name: "affiliate_signup",
      source: "code",
      policyVersion: attribution.policy_version,
    });
  }
  const message = result.accepted
    ? "Referral code applied."
    : result.reason === "already_attributed"
      ? "A referral code is already applied to this account."
      : result.reason === "paid_account" || result.reason === "eligibility_closed"
        ? "Referral codes can only be applied before your first payment."
        : result.reason === "self_referral"
          ? "You cannot apply your own referral code."
          : "That referral code is not valid.";
  return new Response(null, {
    status: 303,
    headers: { location: `/admin/billing?message=${encodeURIComponent(message)}` },
  });
}

export async function handleReferralLink(
  request: Request,
  db: D1Database,
  signingSecrets: string[],
  now: number,
  onAccepted?: (event: {
    affiliateId: number;
    name: "affiliate_click";
    source: "link";
    policyVersion: string;
  }) => void,
): Promise<Response | null> {
  const validSecrets = validSigningSecrets(signingSecrets);
  if (!validSecrets[0]) return null;
  const url = new URL(request.url);
  const code = String(url.searchParams.get("ref") || "").trim();
  if (!/^[a-z0-9-]{3,32}$/i.test(code)) return null;
  const affiliate = await db.prepare(
    `SELECT profile.account_id, acceptance.policy_version
       FROM affiliate_profiles AS profile
       JOIN affiliate_terms_acceptances AS acceptance
         ON acceptance.id = profile.terms_acceptance_id
      WHERE profile.referral_code = ? COLLATE NOCASE AND profile.status = 'active'
        AND profile.stripe_promotion_code_id IS NOT NULL`,
  ).bind(code).first<{ account_id: number; policy_version: string }>();
  if (!affiliate) return null;
  const cookie = await createReferralCookie({
    affiliateId: affiliate.account_id,
    policyVersion: affiliate.policy_version,
    interactedAt: now,
    expiresAt: now + ATTRIBUTION_WINDOW_SECONDS,
  }, validSecrets[0]);
  onAccepted?.({
    affiliateId: affiliate.account_id,
    name: "affiliate_click",
    source: "link",
    policyVersion: affiliate.policy_version,
  });
  url.searchParams.delete("ref");
  const location = `${url.pathname}${url.search}${url.hash}`;
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "set-cookie": `${COOKIE_NAME}=${cookie}; Path=/; Max-Age=${ATTRIBUTION_WINDOW_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
      "cache-control": "no-store",
    },
  });
}

export async function captureSignupReferral(
  request: Request,
  db: D1Database,
  accountId: number,
  signingSecrets: string[],
  now: number,
): Promise<CaptureReferralResult | { accepted: false; reason: "missing_or_invalid_referral" | "self_referral" }> {
  const payload = await readReferralCookie(requestCookie(request, COOKIE_NAME), signingSecrets, now);
  if (!payload) return { accepted: false, reason: "missing_or_invalid_referral" };
  if (payload.affiliateId === accountId) return { accepted: false, reason: "self_referral" };
  const active = await db.prepare(
    `SELECT 1
       FROM affiliate_profiles AS profile
       JOIN affiliate_terms_acceptances AS acceptance ON acceptance.id = profile.terms_acceptance_id
      WHERE profile.account_id = ? AND profile.status = 'active'
        AND profile.stripe_promotion_code_id IS NOT NULL AND acceptance.policy_version = ?`,
  ).bind(payload.affiliateId, payload.policyVersion).first();
  if (!active) return { accepted: false, reason: "missing_or_invalid_referral" };
  const state = await db.prepare(
    `SELECT account.affiliate_eligibility_closed_at AS eligibility_closed_at,
            attribution.id AS attribution_id
       FROM accounts AS account
       LEFT JOIN affiliate_attributions AS attribution ON attribution.referred_account_id = account.id
      WHERE account.id = ?`,
  ).bind(accountId).first<{ eligibility_closed_at: number | null; attribution_id: number | null }>();
  if (!state) return { accepted: false, reason: "missing_or_invalid_referral" };
  return captureReferralInDb(
    db,
    { affiliateId: payload.affiliateId, source: "link", interactedAt: payload.interactedAt, policyVersion: payload.policyVersion },
    { accountId, attributionId: state.attribution_id, eligibilityClosedAt: state.eligibility_closed_at },
    { attributionWindowSeconds: ATTRIBUTION_WINDOW_SECONDS },
    now,
  );
}
