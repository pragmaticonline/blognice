import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Miniflare } from "miniflare";
import staffModule from "../src/staff.ts";
import { preparePayoutInDb, recognizeRevenueInDb } from "../src/affiliate.ts";

function b64url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  return Buffer.from(bytes).toString("base64url");
}

async function accessFixture(subject, email) {
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  publicJwk.kid = "staff-test-key";
  publicJwk.alg = "RS256";
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", kid: publicJwk.kid }));
  const payload = b64url(JSON.stringify({ sub: subject, email, iss: "https://team.cloudflareaccess.com", aud: ["staff-audience"], iat: now - 1, exp: now + 3600 }));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return { token: `${header}.${payload}.${b64url(signature)}`, publicJwk };
}

test("staff payout HTTP requires Access, same origin, valid config, and records ambiguous Stripe dispatch", async () => {
  const staffApp = typeof staffModule.request === "function" ? staffModule : staffModule.default;
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: { DB: "staff-affiliate-http" } });
  const originalFetch = globalThis.fetch;
  try {
    const db = await mf.getD1Database("DB");
    const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
    for (const statement of schema.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) await db.prepare(statement).run();
    const now = Math.floor(Date.now() / 1000);
    await db.prepare("INSERT INTO accounts (id, email, pw_hash, email_verified, created_at) VALUES (17, 'affiliate@example.com', 'test', 1, ?), (42, 'reader@example.com', 'test', 1, ?)").bind(now, now).run();
    await db.prepare("INSERT INTO affiliate_terms_acceptances (id, account_id, terms_version, terms_document_digest, policy_version, accepted_at) VALUES ('terms-17', 17, 'terms-v1', 'digest', 'policy-v1', ?)").bind(now).run();
    await db.prepare("INSERT INTO affiliate_profiles (account_id, referral_code, stripe_connected_account_id, stripe_connect_country, stripe_connect_status, stripe_connect_payouts_enabled, status, terms_acceptance_id, enabled_at) VALUES (17, 'WRITER17', 'acct_17', 'GB', 'ready', 1, 'active', 'terms-17', ?)").bind(now).run();
    await db.prepare("INSERT INTO affiliate_attributions (id, referred_account_id, affiliate_id, source, interacted_at, captured_at, policy_version) VALUES (9, 42, 17, 'link', ?, ?, 'policy-v1')").bind(now, now).run();
    await recognizeRevenueInDb(db, {
      provider: "stripe", sourceKey: "invoice:staff-http:line:1", providerPaymentId: "pi_staff", providerInvoiceId: "in_staff", providerLineId: "il_staff",
      affiliateId: 17, referredAccountId: 42, attributionId: 9, cadence: "monthly", currency: "usd", eligibleRevenueMinor: 20_000,
      processingFeeMinor: 0, policyVersion: "policy-v1", commissionRateNumerator: 1, commissionRateDenominator: 2,
      paidAt: now - 61 * 86400, maturationSeconds: 60 * 86400,
    });
    const prepared = await preparePayoutInDb(db, { affiliateId: 17, currency: "usd", cutoff: now, minimumMinor: 10_000 });
    assert.equal(prepared.prepared, true);
    const access = await accessFixture("staff|admin", "admin@example.com");
    await db.prepare("INSERT INTO staff_users (subject, email, role, active, created_at, updated_at) VALUES ('staff|admin', 'admin@example.com', 'admin', 1, ?, ?)").bind(now, now).run();
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/cdn-cgi/access/certs")) return new Response(JSON.stringify({ keys: [access.publicJwk] }), { status: 200 });
      throw new Error("Stripe response lost after transfer request");
    };
    const env = { DB: db, ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "staff-audience", STRIPE_SECRET_KEY: "sk_test" };
    const request = (origin = "https://staff.blognice.test") => new Request(`https://staff.blognice.test/api/affiliate-payouts/${prepared.payoutId}/dispatch`, {
      method: "POST", body: JSON.stringify({ reason: "Monthly verified payout run" }),
      headers: { "content-type": "application/json", Origin: origin, "Cf-Access-Jwt-Assertion": access.token },
    });
    assert.equal((await staffApp.request(new Request(`https://staff.blognice.test/api/affiliate-payouts/${prepared.payoutId}/dispatch`, {
      method: "POST", body: JSON.stringify({ reason: "unauthorized" }), headers: { "content-type": "application/json", Origin: "https://staff.blognice.test" },
    }), undefined, env)).status, 403);
    assert.equal((await staffApp.request(request(), undefined, env)).status, 503);
    assert.equal((await staffApp.request(request("https://evil.example"), undefined, { ...env, AFFILIATE_STRIPE_CONNECT_COUNTRIES: "GB", AFFILIATE_PAYOUT_DUAL_CONTROL_THRESHOLD_MINOR: "50000" })).status, 403);
    const response = await staffApp.request(request(), undefined, { ...env, AFFILIATE_STRIPE_CONNECT_COUNTRIES: "GB", AFFILIATE_PAYOUT_DUAL_CONTROL_THRESHOLD_MINOR: "50000" });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: true, reconciliation_required: true, payout_id: prepared.payoutId });
    assert.equal(await db.prepare("SELECT status FROM affiliate_payouts WHERE id = ?").bind(prepared.payoutId).first().then((row) => row.status), "reconciliation");
    assert.deepEqual(await db.prepare("SELECT outcome, actor_subject, reason FROM affiliate_payout_attempts").first(), { outcome: "ambiguous", actor_subject: "staff|admin", reason: "Monthly verified payout run" });
    assert.equal(await db.prepare("SELECT result FROM staff_audit_events WHERE action = 'affiliate-payout-dispatch'").first().then((row) => row.result), "reconciliation");
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});
