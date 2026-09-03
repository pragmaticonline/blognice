import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";
import { createNowPaymentsCheckoutInDb, preparePayoutInDb, recordManualAffiliateAdjustmentInDb } from "../src/affiliate.ts";
import { canonicalizeIpn } from "../src/nowpayments.ts";

const require = createRequire(import.meta.url);
for (const extension of [".html", ".svg"]) {
  require.extensions[extension] = (module, filename) => {
    module.exports = readFileSync(filename, "utf8");
  };
}

test("the production Blognice Hono application is directly HTTP-testable", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  assert.equal(typeof blogniceApp.request, "function");
});

async function signNowPayments(payload, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonicalizeIpn(payload)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

test("verified accounts enroll through the production HTTP and Stripe seams", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-http-enrollment" },
  });
  const originalFetch = globalThis.fetch;
  try {
    const db = await mf.getD1Database("DB");
    const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
    for (const statement of schema.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    const now = Math.floor(Date.now() / 1000);
    await db.prepare(
      "INSERT INTO accounts (id, email, pw_hash, email_verified, created_at) VALUES (7, 'affiliate@example.com', 'test', 1, ?)",
    ).bind(now).run();
    await db.prepare(
      "INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES ('enrollment-session', 7, ?, ?)",
    ).bind(now, now + 3600).run();
    const form = () => {
      const body = new FormData();
      body.set("referral_code", "Writer-7");
      body.set("accept_terms", "yes");
      return body;
    };
    const request = (body, path = "/admin/affiliate/enroll") => new Request(`https://www.blognice.test${path}`, {
      method: "POST", body,
      headers: { cookie: "bn_session=enrollment-session", Origin: "https://www.blognice.test" },
    });
    const baseEnv = {
      DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test", STRIPE_SECRET_KEY: "sk_test",
      AFFILIATE_EVENTS: { writeDataPoint() {} },
    };
    const executionCtx = { waitUntil() {}, passThroughOnException() {} };

    const disabled = await blogniceApp.request(request(form()), undefined, baseEnv, executionCtx);
    assert.equal(disabled.status, 503);
    assert.equal(await db.prepare("SELECT count(*) AS count FROM affiliate_profiles").first().then((row) => row.count), 0);

    const stripeRequests = [];
    let couponValid = false;
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).includes("/analytics_engine/sql")) {
        return new Response(JSON.stringify({ data: [
          { date: new Date().toISOString().slice(0, 10), event: "affiliate_click", events: 8 },
          { date: new Date().toISOString().slice(0, 10), event: "affiliate_conversion", events: 2 },
        ] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      stripeRequests.push({ url: String(url), method: init.method || "GET", body: String(init.body || "") });
      if (String(url).includes("/coupons/")) {
        return new Response(JSON.stringify({
          id: "coupon_affiliate", valid: couponValid, percent_off: 10,
          duration: "repeating", duration_in_months: 12,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ id: "promo_writer7", code: "WRITER-7" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    const env = {
      ...baseEnv,
      AFFILIATE_TERMS_VERSION: "terms-v1",
      AFFILIATE_TERMS_DOCUMENT_DIGEST: "sha256:approved-terms",
      AFFILIATE_POLICY_VERSION: "policy-v1",
      AFFILIATE_TERMS_URL: "https://www.blognice.test/legal/affiliate-terms",
      STRIPE_AFFILIATE_COUPON_ID: "coupon_affiliate",
      AFFILIATE_REFERRAL_COOKIE_SECRETS: "r".repeat(32),
      CF_ACCOUNT_ID: "cloudflare-account",
      CF_ANALYTICS_TOKEN: "analytics-token",
    };
    const enrollmentPage = await blogniceApp.request(new Request("https://www.blognice.test/admin/affiliate", {
      headers: { cookie: "bn_session=enrollment-session" },
    }), undefined, env, executionCtx);
    const enrollmentHtml = await enrollmentPage.text();
    assert.equal(enrollmentPage.status, 200);
    assert.match(enrollmentHtml, /class="topbar"/);
    assert.match(enrollmentHtml, />Blogs</);
    assert.match(enrollmentHtml, /href="\/admin\/billing">Billing</);
    assert.match(enrollmentHtml, /href="\/admin\/affiliate"[^>]*aria-current="page"[^>]*>Affiliate</);
    assert.match(enrollmentHtml, />Log out</);
    assert.match(enrollmentHtml, /affiliate-enrollment-layout/);
    assert.match(enrollmentHtml, /50% commission/);
    assert.match(enrollmentHtml, /60 days/);
    assert.match(enrollmentHtml, /US\$100/);
    const pending = await blogniceApp.request(request(form()), undefined, env, executionCtx);
    assert.equal(pending.status, 303);
    assert.match(pending.headers.get("location"), /Discount\+setup\+is\+pending/);
    assert.equal(await db.prepare(
      "SELECT stripe_promotion_code_id FROM affiliate_profiles WHERE account_id = 7",
    ).first().then((row) => row.stripe_promotion_code_id), null);
    const pendingDashboard = await blogniceApp.request(new Request("https://www.blognice.test/admin/affiliate", {
      headers: { cookie: "bn_session=enrollment-session" },
    }), undefined, env, executionCtx).then((response) => response.text());
    assert.match(pendingDashboard, /class="affiliate-btn secondary"[^>]*>Retry discount setup</);
    const inactiveLink = await blogniceApp.request(
      "https://www.blognice.test/?ref=Writer-7", { headers: { Host: "www.blognice.test" } }, env, executionCtx,
    );
    assert.equal(inactiveLink.headers.get("set-cookie"), null);

    couponValid = true;
    const retried = await blogniceApp.request(request(new FormData(), "/admin/affiliate/promotion"), undefined, env, executionCtx);
    assert.equal(retried.status, 303);
    assert.equal(retried.headers.get("location"), "/admin/affiliate");
    const profile = await db.prepare(
      `SELECT referral_code, stripe_promotion_code_id, status,
              terms.terms_version, terms.terms_document_digest, terms.policy_version
         FROM affiliate_profiles AS profile
         JOIN affiliate_terms_acceptances AS terms ON terms.id = profile.terms_acceptance_id
        WHERE profile.account_id = 7`,
    ).first();
    assert.deepEqual(profile, {
      referral_code: "Writer-7", stripe_promotion_code_id: "promo_writer7", status: "active",
      terms_version: "terms-v1", terms_document_digest: "sha256:approved-terms", policy_version: "policy-v1",
    });
    const dashboardPage = await blogniceApp.request(new Request("https://www.blognice.test/admin/affiliate", {
      headers: { cookie: "bn_session=enrollment-session" },
    }), undefined, env, executionCtx);
    const dashboardHtml = await dashboardPage.text();
    assert.equal(dashboardPage.status, 200);
    assert.match(dashboardHtml, /affiliate-kpi-grid/);
    assert.match(dashboardHtml, /aria-live="polite"/);
    assert.match(dashboardHtml, /Referral clicks and sales over 90 days/);
    assert.match(dashboardHtml, /Clicks 8/);
    assert.match(dashboardHtml, /Sales 2/);
    assert.match(dashboardHtml, /class="affiliate-chart-line clicks"/);
    assert.match(dashboardHtml, /class="affiliate-chart-line sales"/);
    assert.match(dashboardHtml, />Copy link</);
    assert.match(dashboardHtml, /readonly[^>]+value="https:\/\/www\.blognice\.test\/\?ref=Writer-7"/);
    assert.match(dashboardHtml, /<select[^>]+name="country"/);
    assert.match(dashboardHtml, /class="affiliate-btn"[^>]*>Set up Stripe payouts</);
    for (const country of ["United States", "Canada", "United Kingdom", "Thailand"]) assert.match(dashboardHtml, new RegExp(`>${country}<`));
    assert.equal(stripeRequests.length, 3);
    assert.match(stripeRequests[0].url, /\/coupons\/coupon_affiliate$/);
    assert.match(stripeRequests[1].url, /\/coupons\/coupon_affiliate$/);
    assert.match(stripeRequests[2].body, /code=WRITER-7/);
    assert.match(stripeRequests[2].body, /metadata%5Baffiliate_account_id%5D=7/);
    const activeLink = await blogniceApp.request(
      "https://www.blognice.test/?ref=Writer-7", { headers: { Host: "www.blognice.test" } }, env, executionCtx,
    );
    assert.equal(activeLink.status, 302);
    assert.equal(activeLink.headers.get("location"), "/affiliate-offer");
    assert.match(activeLink.headers.get("set-cookie"), /^bn_ref=/);
    const activeReferralCookie = activeLink.headers.get("set-cookie").split(";", 1)[0];
    const affiliateOffer = await blogniceApp.request(
      "https://www.blognice.test/affiliate-offer", { headers: { Host: "www.blognice.test", cookie: activeReferralCookie } }, env, executionCtx,
    );
    assert.equal(affiliateOffer.status, 200);
    const affiliateOfferHtml = await affiliateOffer.text();
    assert.match(affiliateOfferHtml, /<title>10% off Blognice for 12 months<\/title>/);
    assert.match(affiliateOfferHtml, /<link rel="canonical" href="https:\/\/www\.blognice\.test\/affiliate-offer">/);
    assert.match(affiliateOfferHtml, /<meta name="robots" content="noindex,follow">/);
    assert.match(affiliateOfferHtml, /Save 10% for your first 12 paid months/);
    assert.match(affiliateOfferHtml, /href="\/signup"[^>]*>Claim 10% off/);
    const offerWithoutReferral = await blogniceApp.request(
      "https://www.blognice.test/affiliate-offer", { headers: { Host: "www.blognice.test" } }, env, executionCtx,
    );
    assert.equal(offerWithoutReferral.status, 302);
    assert.equal(offerWithoutReferral.headers.get("location"), "/");

    await db.prepare(
      "INSERT INTO accounts (id, email, pw_hash, email_verified, created_at) VALUES (8, 'reader-code@example.com', 'test', 1, ?)",
    ).bind(now).run();
    await db.prepare(
      "INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES ('code-session', 8, ?, ?)",
    ).bind(now, now + 3600).run();
    const codeForm = new FormData();
    codeForm.set("referral_code", "Writer-7");
    const crossOriginCode = await blogniceApp.request(new Request("https://www.blognice.test/admin/billing/referral", {
      method: "POST", body: codeForm,
      headers: { cookie: "bn_session=code-session", Origin: "https://evil.example" },
    }), undefined, env, executionCtx);
    assert.equal(crossOriginCode.status, 403);
    const validCodeForm = new FormData();
    validCodeForm.set("referral_code", "Writer-7");
    const validCode = await blogniceApp.request(new Request("https://www.blognice.test/admin/billing/referral", {
      method: "POST", body: validCodeForm,
      headers: { cookie: "bn_session=code-session", Origin: "https://www.blognice.test" },
    }), undefined, env, executionCtx);
    assert.equal(validCode.status, 303);
    assert.match(validCode.headers.get("location"), /Referral%20code%20applied/);
    assert.deepEqual(await db.prepare("SELECT affiliate_id, source FROM affiliate_attributions WHERE referred_account_id = 8").first(), {
      affiliate_id: 7, source: "code",
    });

    const connectForm = () => { const body = new FormData(); body.set("country", "GB"); return body; };
    const connectEnv = { ...env, AFFILIATE_STRIPE_CONNECT_COUNTRIES: "GB" };
    const crossOriginConnect = await blogniceApp.request(new Request("https://www.blognice.test/admin/affiliate/connect", {
      method: "POST", body: connectForm(),
      headers: { cookie: "bn_session=enrollment-session", Origin: "https://evil.example" },
    }), undefined, connectEnv, executionCtx);
    assert.equal(crossOriginConnect.status, 403);
    let connectedAccountCreates = 0;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/v1/accounts")) {
        connectedAccountCreates += 1;
        return new Response(JSON.stringify({ id: "acct_affiliate7" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ url: "https://connect.stripe.test/onboard", expires_at: now + 3600 }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const connect = await blogniceApp.request(new Request("https://www.blognice.test/admin/affiliate/connect", {
        method: "POST", body: connectForm(),
        headers: { cookie: "bn_session=enrollment-session", Origin: "https://www.blognice.test" },
      }), undefined, connectEnv, executionCtx);
      assert.equal(connect.status, 303);
      assert.equal(connect.headers.get("location"), "https://connect.stripe.test/onboard");
    }
    assert.equal(connectedAccountCreates, 1);
    assert.deepEqual(await db.prepare("SELECT stripe_connected_account_id, stripe_connect_country FROM affiliate_profiles WHERE account_id = 7").first(), {
      stripe_connected_account_id: "acct_affiliate7", stripe_connect_country: "GB",
    });

    globalThis.fetch = async () => new Response(JSON.stringify({
      error: { message: "Connect is not enabled for this platform." },
    }), { status: 400, headers: { "content-type": "application/json" } });
    const rejectedConnect = await blogniceApp.request(new Request("https://www.blognice.test/admin/affiliate/connect", {
      method: "POST", body: connectForm(),
      headers: { cookie: "bn_session=enrollment-session", Origin: "https://www.blognice.test" },
    }), undefined, connectEnv, executionCtx);
    assert.equal(rejectedConnect.status, 303);
    assert.equal(rejectedConnect.headers.get("location"), "/admin/affiliate?message=Payout+setup+could+not+be+started.+Please+try+again+or+contact+support.");
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});

test("signed NOWPayments HTTP callbacks settle once, wait for full payment, and reverse once", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: { DB: "affiliate-http-nowpayments" } });
  const originalFetch = globalThis.fetch;
  try {
    const db = await mf.getD1Database("DB");
    const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
    for (const statement of schema.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) await db.prepare(statement).run();
    const now = Math.floor(Date.now() / 1000);
    await db.prepare("INSERT INTO accounts (id, email, pw_hash, email_verified, created_at) VALUES (17, 'affiliate@example.com', 'test', 1, ?), (42, 'reader@example.com', 'test', 1, ?)").bind(now, now).run();
    await db.prepare("INSERT INTO affiliate_attributions (id, referred_account_id, affiliate_id, source, interacted_at, captured_at, policy_version) VALUES (9, 42, 17, 'link', ?, ?, 'policy-v1')").bind(now, now).run();
    const checkout = await createNowPaymentsCheckoutInDb(db, {
      accountId: 42, attributionId: 9, expectedDiscountedAmountMinor: 3240,
      policyVersion: "policy-v1", discountRateNumerator: 1, discountRateDenominator: 10,
      commissionRateNumerator: 1, commissionRateDenominator: 2, createdAt: now, expiresAt: now + 900,
    });
    const secret = "nowpayments-test-secret";
    const payload = { payment_id: "np_42", order_id: checkout.orderId, payment_status: "finished" };
    let providerPayment = { ...payload, price_amount: 32.4, price_currency: "usd", pay_currency: "btc", pay_amount: "0.001", actually_paid: "0.0009" };
    globalThis.fetch = async () => new Response(JSON.stringify(providerPayment), { status: 200, headers: { "content-type": "application/json" } });
    const env = { DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test", NOWPAYMENTS_API_KEY: "np-key", NOWPAYMENTS_IPN_SECRET: secret, AFFILIATE_EVENTS: { writeDataPoint() {} } };
    const send = async (body = payload) => blogniceApp.request(new Request("https://www.blognice.test/nowpayments/webhook", {
      method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-nowpayments-sig": await signNowPayments(body, secret) },
    }), undefined, env, { waitUntil() {}, passThroughOnException() {} });

    assert.equal((await send()).status, 200);
    assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM affiliate_revenue_occurrences").first().then((row) => row.count), 0);
    assert.equal(await db.prepare("SELECT crypto_paid_through FROM accounts WHERE id = 42").first().then((row) => row.crypto_paid_through), null);

    providerPayment = { ...providerPayment, actually_paid: "0.001" };
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);
    assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM affiliate_revenue_occurrences").first().then((row) => row.count), 1);
    assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM affiliate_ledger_entries WHERE entry_kind = 'earning'").first().then((row) => row.count), 1);
    assert.ok(await db.prepare("SELECT crypto_paid_through FROM accounts WHERE id = 42").first().then((row) => row.crypto_paid_through) > now);

    const refundPayload = { ...payload, payment_status: "refunded" };
    providerPayment = { ...providerPayment, payment_status: "refunded" };
    assert.equal((await send(refundPayload)).status, 200);
    assert.equal((await send(refundPayload)).status, 200);
    assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM affiliate_revenue_adjustments WHERE provider = 'nowpayments'").first().then((row) => row.count), 1);
    assert.ok(await db.prepare("SELECT revoked_at FROM crypto_payments WHERE order_id = ?").bind(checkout.orderId).first().then((row) => row.revoked_at));
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});

test("production scheduled handler enforces terms and prepares the monthly payout run", async () => {
  const worker = (await import("../src/index.ts")).default;
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: { DB: "affiliate-scheduled-handler" } });
  const originalFetch = globalThis.fetch;
  try {
    const db = await mf.getD1Database("DB");
    const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
    for (const statement of schema.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) await db.prepare(statement).run();
    await db.prepare("INSERT INTO accounts (id, email, pw_hash, email_verified, created_at) VALUES (17, 'affiliate@example.com', 'test', 1, 1800000000)").run();
    await db.prepare("INSERT INTO affiliate_terms_acceptances (id, account_id, terms_version, terms_document_digest, policy_version, accepted_at) VALUES ('old-terms', 17, 'terms-v1', 'digest-v1', 'policy-v1', 1800000000)").run();
    await db.prepare("INSERT INTO affiliate_profiles (account_id, referral_code, status, terms_acceptance_id, enabled_at) VALUES (17, 'WRITER17', 'active', 'old-terms', 1800000000)").run();
    const scheduledTime = Date.UTC(2026, 8, 1, 3, 0, 0);
    const promises = [];
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
    worker.scheduled({ scheduledTime }, {
      DB: db, POSTS: db, AFFILIATE_TERMS_VERSION: "terms-v2",
      AFFILIATE_TERMS_DOCUMENT_DIGEST: "digest-v2", AFFILIATE_POLICY_VERSION: "policy-v2",
      AFFILIATE_TERMS_URL: "https://www.blognice.test/legal/affiliate-terms", STRIPE_AFFILIATE_COUPON_ID: "coupon-affiliate",
      CF_ACCOUNT_ID: "account", CF_ANALYTICS_TOKEN: "token",
      METRICS_ARCHIVE: { async put() {}, async delete() {} },
    }, { waitUntil(promise) { promises.push(promise); } });
    assert.equal(promises.length, 1);
    await Promise.all(promises);
    assert.equal(await db.prepare("SELECT status FROM affiliate_profiles WHERE account_id = 17").first().then((row) => row.status), "terms_required");
    assert.deepEqual(await db.prepare("SELECT kind, status FROM affiliate_email_outbox").first(), { kind: "affiliate-terms-required", status: "pending" });
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});

test("production HTTP referral and Stripe seams flow through payout and post-payout correction", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "affiliate-http-journey" },
  });
  const originalFetch = globalThis.fetch;
  try {
    const db = await mf.getD1Database("DB");
    const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
    for (const statement of schema.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    const now = Math.floor(Date.now() / 1000);
    await db.prepare(
      "INSERT INTO accounts (id, email, pw_hash, email_verified, created_at) VALUES (17, 'affiliate@example.com', 'test', 1, ?)",
    ).bind(now - 100).run();
    await db.prepare(
      `INSERT INTO affiliate_terms_acceptances
         (id, account_id, terms_version, terms_document_digest, policy_version, accepted_at)
       VALUES ('terms-17', 17, 'terms-v1', 'digest-v1', 'policy-v1', ?)`,
    ).bind(now - 100).run();
    await db.prepare(
      `INSERT INTO affiliate_profiles
         (account_id, referral_code, stripe_promotion_code_id,
          stripe_connected_account_id, stripe_connect_country, stripe_connect_status,
          stripe_connect_details_submitted, stripe_connect_payouts_enabled,
          status, terms_acceptance_id, enabled_at)
       VALUES (17, 'WRITER17', 'promo_writer17', 'acct_writer17', 'GB', 'ready',
               1, 1, 'active', 'terms-17', ?)`,
    ).bind(now - 100).run();

    const points = [];
    const env = {
      DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test",
      AFFILIATE_REFERRAL_COOKIE_SECRETS: "a".repeat(32),
      STRIPE_SECRET_KEY: "sk_test", STRIPE_WEBHOOK_SECRET: "whsec_journey",
      STRIPE_MONTHLY_PRICE_ID: "price_monthly",
      AFFILIATE_EVENTS: { writeDataPoint(point) { points.push(point); } },
      METRICS: { writeDataPoint() {} }, EVENTS: { writeDataPoint() {} },
    };
    const executionCtx = { waitUntil() {}, passThroughOnException() {} };

    const referralResponse = await blogniceApp.request(
      "https://www.blognice.test/?ref=WRITER17", { headers: { Host: "www.blognice.test" } }, env, executionCtx,
    );
    assert.equal(referralResponse.status, 302);
    const referralCookie = referralResponse.headers.get("set-cookie").match(/bn_ref=[^;]+/)[0];

    const signupForm = new FormData();
    signupForm.set("slug", "referred-writer");
    signupForm.set("title", "Referred Writer");
    signupForm.set("email", "reader@example.com");
    signupForm.set("password", "correct horse battery staple");
    const signupResponse = await blogniceApp.request(
      new Request("https://www.blognice.test/signup", {
        method: "POST", body: signupForm,
        headers: { cookie: referralCookie, "CF-Connecting-IP": "203.0.113.8" },
      }), undefined, env, executionCtx,
    );
    assert.equal(signupResponse.status, 302);
    const sessionCookie = signupResponse.headers.get("set-cookie").match(/bn_session=[^;]+/)[0];
    const referred = await db.prepare("SELECT id FROM accounts WHERE email = 'reader@example.com'").first();
    const attribution = await db.prepare(
      "SELECT id, affiliate_id, source FROM affiliate_attributions WHERE referred_account_id = ?",
    ).bind(referred.id).first();
    assert.deepEqual({ affiliate_id: attribution.affiliate_id, source: attribution.source }, { affiliate_id: 17, source: "link" });

    let checkoutRequest;
    globalThis.fetch = async (url, init = {}) => {
      checkoutRequest = { url: String(url), body: new URLSearchParams(init.body) };
      return new Response(JSON.stringify({ id: "cs_journey", url: "https://checkout.stripe.test/journey" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    const checkoutForm = new FormData();
    checkoutForm.set("plan", "monthly");
    const checkoutResponse = await blogniceApp.request(
      new Request("https://www.blognice.test/admin/billing/checkout", {
        method: "POST", body: checkoutForm, headers: { cookie: sessionCookie },
      }), undefined, env, executionCtx,
    );
    assert.equal(checkoutResponse.status, 303);
    assert.equal(checkoutResponse.headers.get("location"), "https://checkout.stripe.test/journey");
    assert.equal(checkoutRequest.body.get("discounts[0][promotion_code]"), "promo_writer17");
    const checkout = await db.prepare(
      "SELECT id FROM affiliate_stripe_checkouts WHERE account_id = ?",
    ).bind(referred.id).first();

    const signStripeEvent = async (event) => {
      const raw = JSON.stringify(event);
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${now}.${raw}`));
      const digest = [...new Uint8Array(signed)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      return { raw, signature: `t=${now},v1=${digest}` };
    };
    const earlyRefund = await signStripeEvent({
      id: "evt_refund_before_invoice", type: "charge.refunded", created: now,
      data: { object: {
        id: "ch_journey", payment_intent: "pi_journey", amount: 24_000,
        metadata: { account_id: String(referred.id) },
        refunds: { data: [{ id: "re_journey", amount: 2_000, created: now }] },
      } },
    });
    const earlyRefundResponse = await blogniceApp.request(
      new Request("https://www.blognice.test/stripe/webhook", {
        method: "POST", body: earlyRefund.raw,
        headers: { "content-type": "application/json", "Stripe-Signature": earlyRefund.signature },
      }), undefined, env, executionCtx,
    );
    assert.equal(earlyRefundResponse.status, 200, await earlyRefundResponse.text());
    assert.deepEqual(await db.prepare(
      "SELECT applied_at FROM affiliate_stripe_financial_events WHERE source_key = 'refund:re_journey'",
    ).first(), { applied_at: null });
    for (const financialEvent of [
      { id: "evt_dispute_close_early", type: "charge.dispute.closed", data: { object: { id: "dp_journey", status: "won", created: now } } },
      { id: "evt_dispute_open_early", type: "charge.dispute.created", data: { object: { id: "dp_journey", payment_intent: "pi_journey", created: now } } },
      { id: "evt_credit_early", type: "credit_note.created", data: { object: {
        id: "cn_journey", invoice: "in_journey", status: "issued", created: now,
        lines: { data: [{ invoice_line_item: "il_journey", amount_excluding_tax: 2_000 }] },
      } } },
    ]) {
      const signedFinancialEvent = await signStripeEvent({ ...financialEvent, created: now });
      const response = await blogniceApp.request(new Request("https://www.blognice.test/stripe/webhook", {
        method: "POST", body: signedFinancialEvent.raw,
        headers: { "content-type": "application/json", "Stripe-Signature": signedFinancialEvent.signature },
      }), undefined, env, executionCtx);
      assert.equal(response.status, 200, await response.text());
    }

    const event = {
      id: "evt_invoice_journey", type: "invoice.paid", created: now,
      data: { object: {
        id: "in_journey", payment_intent: "pi_journey", currency: "usd",
        metadata: { account_id: String(referred.id) },
        parent: { subscription_details: { subscription: "sub_journey", metadata: { affiliate_checkout_id: checkout.id } } },
        status_transitions: { paid_at: now },
        lines: { data: [{
          id: "il_journey", currency: "usd", subtotal: 24_000,
          pricing: { price_details: { price: "price_monthly" } },
          period: { start: now, end: now + 30 * 24 * 60 * 60 },
        }] },
      } },
    };
    const signedInvoice = await signStripeEvent(event);
    const webhookResponse = await blogniceApp.request(
      new Request("https://www.blognice.test/stripe/webhook", {
        method: "POST", body: signedInvoice.raw,
        headers: { "content-type": "application/json", "Stripe-Signature": signedInvoice.signature },
      }), undefined, env, executionCtx,
    );
    assert.equal(webhookResponse.status, 200, await webhookResponse.text());
    const occurrence = await db.prepare("SELECT id FROM affiliate_revenue_occurrences WHERE provider_invoice_id = 'in_journey'").first();
    assert.ok(occurrence?.id);
    assert.equal(await db.prepare(
      "SELECT applied_at FROM affiliate_stripe_financial_events WHERE source_key = 'refund:re_journey'",
    ).first().then((row) => row.applied_at), now);
    assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM affiliate_stripe_financial_events WHERE applied_at IS NOT NULL").first().then((row) => row.count), 4);
    assert.deepEqual(await db.prepare("SELECT status FROM affiliate_reserves WHERE dispute_id = 'dp_journey'").first(), { status: "released" });

    const payout = await preparePayoutInDb(db, {
      affiliateId: 17, currency: "usd", cutoff: now + 60 * 24 * 60 * 60, minimumMinor: 10_000,
    });
    assert.equal(payout.prepared, true);
    assert.equal(payout.amountMinor, 10_000);
    assert.deepEqual(await recordManualAffiliateAdjustmentInDb(db, {
      occurrenceId: occurrence.id, sourceKey: "case:post-payout-journey", amountMinor: -500,
      actorSubject: "admin-journey", actorRole: "admin", reason: "Post-payout correction", recordedAt: now + 61 * 24 * 60 * 60,
    }), { recorded: true });
    assert.equal(await db.prepare(
      "SELECT amount_minor FROM affiliate_ledger_entries WHERE entry_kind = 'manual_adjustment'",
    ).first().then((row) => row.amount_minor), -500);
    assert.ok(points.length >= 2);
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});
