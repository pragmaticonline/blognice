import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";
import {
  ADS_CONVERSION_SEND_TO,
  ADS_TAG_ID,
  adsBaseTag,
  adsConversionScript,
  injectAdsClickParams,
  parseAdsClickFields,
  parseAdsClickParams,
  parseAdsLanding,
} from "../src/ads-funnel.ts";
import { adsFunnelSeries, recordAdsFunnelEvent } from "../src/metrics.ts";

const require = createRequire(import.meta.url);
for (const extension of [".html", ".svg"]) {
  require.extensions[extension] = (module, filename) => {
    module.exports = readFileSync(filename, "utf8");
  };
}

globalThis.caches = { default: { delete: async () => true, match: async () => undefined, put: async () => {} } };

test("ads click parameters validate and allowlisted landings only", () => {
  assert.deepEqual(parseAdsClickParams(new URL("https://x.test/?gclid=abc_123-XYZ&gbraid=g1&wbraid=w1")), {
    gclid: "abc_123-XYZ", gbraid: "g1", wbraid: "w1",
  });
  assert.equal(parseAdsClickParams(new URL("https://x.test/")), null);
  assert.equal(parseAdsClickParams(new URL("https://x.test/?gclid=bad!chars&gbraid=")), null);
  assert.equal(parseAdsClickParams(new URL(`https://x.test/?gclid=${"a".repeat(129)}`)), null);
  assert.equal(parseAdsLanding("/blogger-alternative"), "/blogger-alternative");
  assert.equal(parseAdsLanding("/evil"), null);
  assert.equal(parseAdsLanding(42), null);
  assert.deepEqual(parseAdsClickFields({ gclid: "g1", gbraid: "", wbraid: null }), { gclid: "g1", gbraid: undefined, wbraid: undefined });
  assert.equal(parseAdsClickFields({}), null);
});

test("signup-link injection forwards click params and nothing else", () => {
  const html = '<a href="/signup">A</a><a href="/signup">B</a><a href="/press">C</a>';
  const out = injectAdsClickParams(html, { gclid: "g1", wbraid: "w2" }, "/blogger-alternative");
  assert.equal(out.match(/\/signup\?gclid=g1&amp;wbraid=w2&amp;ads_landing=%2Fblogger-alternative/g), null); // raw & expected
  assert.ok(out.includes('/signup?gclid=g1&wbraid=w2&ads_landing=%2Fblogger-alternative'));
  assert.equal(out.split("/press").length, 2);
  assert.equal(injectAdsClickParams(html, null, null), html);
});

test("ads snippets carry the tag id, real value, and sanitized fields", () => {
  assert.equal(ADS_TAG_ID, "AW-16852730460");
  assert.equal(ADS_CONVERSION_SEND_TO, "AW-16852730460/HbVaCKq-iYkdENyEgeQ-");
  assert.match(adsBaseTag(), /googletagmanager\.com\/gtag\/js\?id=AW-16852730460/);
  assert.match(adsBaseTag(), /gtag\('config', 'AW-16852730460'\)/);
  assert.doesNotMatch(adsBaseTag(), /conversion/);
  const event = adsConversionScript({ valueMinor: 3600, currency: "USD", transactionId: "cs_test_123" });
  assert.match(event, /'send_to': 'AW-16852730460\/HbVaCKq-iYkdENyEgeQ-'/);
  assert.match(event, /'value': 36\.00/);
  assert.match(event, /'currency': 'USD'/);
  assert.match(event, /'transaction_id': 'cs_test_123'/);
  const dirty = adsConversionScript({ valueMinor: -5, currency: "xx", transactionId: "a'b\"<c>" });
  assert.match(dirty, /'value': 0\.00/);
  assert.match(dirty, /'currency': 'USD'/);
  assert.match(dirty, /'transaction_id': 'abc'/);
});

test("ads funnel events write aggregate-safe datapoints", () => {
  const points = [];
  recordAdsFunnelEvent({ EVENTS: { writeDataPoint: (p) => points.push(p) } }, { name: "signup", landing: "/blogger-alternative", detail: "attributed" });
  assert.deepEqual(points, [{
    indexes: ["0"],
    blobs: ["ads:signup", "/blogger-alternative", "attributed", "", "", ""],
    doubles: [1],
  }]);
  recordAdsFunnelEvent({}, { name: "landing_view" }); // unbound worker never throws
});

test("ads funnel series maps sampled daily rows", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /analytics_engine\/sql/);
    assert.match(String(init.body), /blognice_events/);
    assert.match(String(init.body), /ads:landing_view/);
    return new Response(JSON.stringify({ data: [
      { date: "2026-09-20", event: "ads:signup", landing: "/blogger-alternative", events: 4.2 },
      { date: "2026-09-20", event: "something-else", landing: "", events: 9 },
    ] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const rows = await adsFunnelSeries({ CF_ACCOUNT_ID: "a", CF_ANALYTICS_TOKEN: "t" }, 7, new Date("2026-09-21T00:00:00Z"));
    assert.deepEqual(rows, [{ date: "2026-09-20", event: "signup", landing: "/blogger-alternative", events: 4 }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function loadSchema(db, path) {
  const schema = readFileSync(new URL(path, import.meta.url), "utf8");
  const statements = schema
    .replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "")
    .split(/;\s*(?=\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const st of statements) await db.prepare(st).run();
}

async function setupFunnel() {
  const { blogniceApp } = await import("../src/index.ts");
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: ["DB", "POSTS"],
    r2Buckets: ["MEDIA"],
  });
  const indexDb = await mf.getD1Database("DB");
  const postsDb = await mf.getD1Database("POSTS");
  const media = await mf.getR2Bucket("MEDIA");
  await loadSchema(indexDb, "../schema.sql");
  await loadSchema(postsDb, "../schema-posts.sql");
  const now = Math.floor(Date.now() / 1000);
  await indexDb.prepare(
    "INSERT INTO accounts (id, email, pw_hash, email_verified, created_at) VALUES (1, 'owner@example.com', 'x', 1, ?)",
  ).bind(now).run();
  await indexDb.prepare(
    "INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES ('ads-session', 1, ?, ?)",
  ).bind(now, now + 3600).run();
  await indexDb.prepare(
    "INSERT INTO tenants (id, public_id, slug, title, created_at) VALUES (1, 'adsblog0000000001', 'adsblog', 'Ads Blog', ?)",
  ).bind(now).run();
  await indexDb.prepare(
    "INSERT INTO memberships (account_id, tenant_id, role, created_at) VALUES (1, 1, 'owner', ?)",
  ).bind(now).run();
  await postsDb.prepare(
    "INSERT INTO posts (id, tenant_id, slug, title, body_md, published, created_at, updated_at) VALUES (1, 1, 'hello', 'Hello', 'Hi.', 1, ?, ?)",
  ).bind(now, now).run();
  const events = [];
  const env = {
    DB: indexDb, POSTS: postsDb, MEDIA: media, ROOT_DOMAIN: "blognice.test",
    STRIPE_SECRET_KEY: "sk_test", STRIPE_MONTHLY_PRICE_ID: "price_monthly", STRIPE_YEARLY_PRICE_ID: "price_yearly",
    EVENTS: { writeDataPoint: (p) => events.push(p) },
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  return { blogniceApp, mf, indexDb, postsDb, env, ctx, events };
}

test("landing page renders headline, offer, FAQ, comparison, tag, and no custom scripts", async () => {
  const { blogniceApp, mf, env, ctx, events } = await setupFunnel();
  try {
    const res = await blogniceApp.request("https://www.blognice.test/blogger-alternative", undefined, env, ctx);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.equal(html.match(/<h1>/g).length, 1);
    assert.match(html, /<h1>A Better Alternative to Blogger<\/h1>/);
    assert.match(html, /<title>Blogger Alternative \| Blognice<\/title>/);
    assert.match(html, /Looking for a Blogger alternative\? Blognice lets you manage up to five/);
    assert.match(html, /rel="canonical" href="https:\/\/www\.blognice\.com\/blogger-alternative"/);
    assert.match(html, /Create beautiful blogs without hosting, plugins, updates or technical maintenance\./);
    assert.match(html, /Start your free blog/);
    assert.match(html, /href="\/signup"/);
    assert.match(html, /See how Blognice compares with Blogger/);
    assert.match(html, /Blogger is free and familiar, but Blognice is designed for people/);
    assert.match(html, /\$36\/<small>year<\/small>|\$36<small>\/year<\/small>/);
    assert.match(html, /first 1,000 paying members/);
    assert.match(html, /Pro free for 14 days/);
    for (const question of ["Can I use my own domain?", "How many blogs can I manage?", "Do I need to install anything?", "Can I export my content?", "Is Blognice open source?", "Can I import an existing Blogger blog?"]) {
      assert.ok(html.includes(`<summary>${question}</summary>`), question);
    }
    assert.match(html, /Import from Blogger/);
    const faqJson = JSON.parse(html.match(/<script type="application\/ld\+json">(\{"@context":"https:\/\/schema\.org","@type":"FAQPage".*?\})<\/script>/)[1]);
    assert.equal(faqJson.mainEntity.length, 6);
    for (const entry of faqJson.mainEntity) {
      assert.ok(html.includes(`<summary>${entry.name}</summary>`));
      assert.ok(html.includes(entry.acceptedAnswer.text.replace(/ → .*/, "")) || html.includes(entry.acceptedAnswer.text.slice(0, 40)));
    }
    // Funnel-scoped Google tag present; no other scripts, so the page works without JS.
    assert.match(html, /googletagmanager\.com\/gtag\/js\?id=AW-16852730460/);
    const stripped = html
      .replace('<script async src="https://www.googletagmanager.com/gtag/js?id=AW-16852730460"></script>', "")
      .replace(/<script>\nwindow\.dataLayer[\s\S]*?<\/script>/, "")
      .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, "");
    assert.doesNotMatch(stripped, /<script/);
    assert.ok(html.includes("<details>"));
    assert.deepEqual(events, [{
      indexes: ["0"],
      blobs: ["ads:landing_view", "/blogger-alternative", "organic", "", "", ""],
      doubles: [1],
    }]);
  } finally {
    await mf.dispose();
  }
});

test("landing CTAs forward validated click params; junk is dropped", async () => {
  const { blogniceApp, mf, env, ctx, events } = await setupFunnel();
  try {
    const res = await blogniceApp.request("https://www.blognice.test/blogger-alternative?gclid=abc_123&gbraid=g1", undefined, env, ctx);
    const html = await res.text();
    assert.ok(!html.includes('href="/signup"'), "all signup links rewritten");
    assert.ok(html.includes("/signup?gclid=abc_123&gbraid=g1&ads_landing=%2Fblogger-alternative"));
    assert.equal(events[0].blobs[2], "attributed");

    const dirty = await blogniceApp.request("https://www.blognice.test/blogger-alternative?gclid=%3Cscript%3E", undefined, env, ctx);
    const dirtyHtml = await dirty.text();
    assert.ok(dirtyHtml.includes('href="/signup"'));
    assert.doesNotMatch(dirtyHtml, /%3Cscript%3E|<script>alert/);
  } finally {
    await mf.dispose();
  }
});

test("Google tag is absent from unrelated pages", async () => {
  const { blogniceApp, mf, env, ctx } = await setupFunnel();
  try {
    const pages = [
      "https://www.blognice.test/",
      "https://www.blognice.test/signup",
      "https://www.blognice.test/press",
      "https://www.blognice.test/manifesto",
    ];
    for (const url of pages) {
      const html = await (await blogniceApp.request(url, undefined, env, ctx)).text();
      assert.doesNotMatch(html, /AW-16852730460/, url);
    }
    const authed = await blogniceApp.request("https://www.blognice.test/admin/billing", {
      headers: { cookie: "bn_session=ads-session" },
    }, env, ctx);
    assert.doesNotMatch(await authed.text(), /AW-16852730460/);
    const blog = await blogniceApp.request("https://adsblog.blognice.test/hello", {
      headers: { host: "adsblog.blognice.test" },
    }, env, ctx);
    assert.equal(blog.status, 200);
    assert.doesNotMatch(await blog.text(), /AW-16852730460/);
  } finally {
    await mf.dispose();
  }
});

test("signup carries click params into hidden fields and stores attribution", async () => {
  const { blogniceApp, mf, indexDb, env, ctx, events } = await setupFunnel();
  try {
    const form = await (await blogniceApp.request(
      "https://www.blognice.test/signup?gclid=abc_123&ads_landing=/blogger-alternative", undefined, env, ctx,
    )).text();
    assert.match(form, /<input type="hidden" name="gclid" value="abc_123">/);
    assert.match(form, /<input type="hidden" name="ads_landing" value="\/blogger-alternative">/);
    const plain = await (await blogniceApp.request("https://www.blognice.test/signup", undefined, env, ctx)).text();
    assert.doesNotMatch(plain, /name="gclid"/);

    const signup = new FormData();
    signup.set("email", "ads-reader@example.com");
    signup.set("password", "correct horse battery staple");
    signup.set("gclid", "abc_123");
    signup.set("ads_landing", "/blogger-alternative");
    const res = await blogniceApp.request(new Request("https://www.blognice.test/signup", {
      method: "POST", body: signup, headers: { "CF-Connecting-IP": "203.0.113.90" },
    }), undefined, env, ctx);
    assert.equal(res.status, 302);
    const account = await indexDb.prepare("SELECT id FROM accounts WHERE email = 'ads-reader@example.com'").first();
    const stored = await indexDb.prepare("SELECT gclid, landing_path FROM ads_attributions WHERE account_id = ?").bind(account.id).first();
    assert.deepEqual(stored, { gclid: "abc_123", landing_path: "/blogger-alternative" });
    assert.ok(events.some((p) => p.blobs[0] === "ads:signup" && p.blobs[1] === "/blogger-alternative"));

    const organic = new FormData();
    organic.set("email", "organic-reader@example.com");
    organic.set("password", "correct horse battery staple");
    const organicRes = await blogniceApp.request(new Request("https://www.blognice.test/signup", {
      method: "POST", body: organic, headers: { "CF-Connecting-IP": "203.0.113.91" },
    }), undefined, env, ctx);
    assert.equal(organicRes.status, 302);
    const organicAccount = await indexDb.prepare("SELECT id FROM accounts WHERE email = 'organic-reader@example.com'").first();
    assert.equal(await indexDb.prepare("SELECT COUNT(*) AS count FROM ads_attributions WHERE account_id = ?").bind(organicAccount.id).first().then((r) => r.count), 0);
  } finally {
    await mf.dispose();
  }
});

test("plan checkout points at the verified success page and records checkout start", async () => {
  const { blogniceApp, mf, indexDb, env, ctx, events } = await setupFunnel();
  const originalFetch = globalThis.fetch;
  try {
    const now = Math.floor(Date.now() / 1000);
    await indexDb.prepare("INSERT INTO ads_attributions (account_id, gclid, landing_path, created_at) VALUES (1, 'abc_123', '/blogger-alternative', ?)").bind(now).run();
    let captured;
    globalThis.fetch = async (url, init = {}) => {
      captured = new URLSearchParams(init.body);
      return new Response(JSON.stringify({ id: "cs_test_new", url: "https://checkout.stripe.test/new" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    const form = new FormData();
    form.set("plan", "yearly");
    const res = await blogniceApp.request(new Request("https://www.blognice.test/admin/billing/checkout", {
      method: "POST", body: form, headers: { cookie: "bn_session=ads-session", Origin: "https://www.blognice.test" },
    }), undefined, env, ctx);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "https://checkout.stripe.test/new");
    assert.match(captured.get("success_url"), /\/admin\/billing\/success\?session_id=\{CHECKOUT_SESSION_ID\}$/);
    assert.match(captured.get("cancel_url"), /Checkout cancelled/);
    assert.ok(events.some((p) => p.blobs[0] === "ads:checkout_start" && p.blobs[1] === "/blogger-alternative" && p.blobs[2] === "attributed"));
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});

test("billing success fires the conversion once with the real Stripe value", async () => {
  const { blogniceApp, mf, indexDb, env, ctx, events } = await setupFunnel();
  const originalFetch = globalThis.fetch;
  try {
    const now = Math.floor(Date.now() / 1000);
    await indexDb.prepare("INSERT INTO ads_attributions (account_id, gclid, landing_path, created_at) VALUES (1, 'abc_123', '/blogger-alternative', ?)").bind(now).run();
    globalThis.fetch = async (url) => {
      assert.match(String(url), /checkout\/sessions\/cs_test_paid1/);
      return new Response(JSON.stringify({
        id: "cs_test_paid1", status: "complete", payment_status: "paid",
        amount_total: 3600, currency: "usd", client_reference_id: "1",
        subscription: { id: "sub_1", status: "active" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const first = await blogniceApp.request("https://www.blognice.test/admin/billing/success?session_id=cs_test_paid1", {
      headers: { cookie: "bn_session=ads-session" },
    }, env, ctx);
    assert.equal(first.status, 200);
    const html = await first.text();
    assert.match(html, /Subscription confirmed/);
    assert.match(html, /gtag\('config', 'AW-16852730460'\)/);
    assert.match(html, /'send_to': 'AW-16852730460\/HbVaCKq-iYkdENyEgeQ-'/);
    assert.match(html, /'value': 36\.00/);
    assert.match(html, /'currency': 'USD'/);
    assert.match(html, /'transaction_id': 'cs_test_paid1'/);
    const row = await indexDb.prepare("SELECT transaction_id, value_minor, currency FROM ads_conversions WHERE account_id = 1").first();
    assert.deepEqual(row, { transaction_id: "cs_test_paid1", value_minor: 3600, currency: "USD" });
    assert.ok(events.some((p) => p.blobs[0] === "ads:conversion" && p.blobs[2] === "USD"));

    const refresh = await blogniceApp.request("https://www.blognice.test/admin/billing/success?session_id=cs_test_paid1", {
      headers: { cookie: "bn_session=ads-session" },
    }, env, ctx);
    assert.equal(refresh.status, 200);
    assert.doesNotMatch(await refresh.text(), /send_to/);
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});

test("billing success stays silent on incomplete, foreign, unattributed, and anonymous visits", async () => {
  const { blogniceApp, mf, indexDb, env, ctx } = await setupFunnel();
  const originalFetch = globalThis.fetch;
  try {
    const now = Math.floor(Date.now() / 1000);
    await indexDb.prepare("INSERT INTO ads_attributions (account_id, gclid, landing_path, created_at) VALUES (1, 'abc_123', '/blogger-alternative', ?)").bind(now).run();
    await indexDb.prepare("INSERT INTO accounts (id, email, pw_hash, email_verified, created_at) VALUES (2, 'organic@example.com', 'x', 1, ?)").bind(now).run();
    await indexDb.prepare("INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES ('organic-session', 2, ?, ?)").bind(now, now + 3600).run();
    const sessions = {
      cs_test_open1: { id: "cs_test_open1", status: "open", client_reference_id: "1", subscription: { id: "sub_9", status: "incomplete" } },
      cs_test_other1: { id: "cs_test_other1", status: "complete", amount_total: 500, currency: "usd", client_reference_id: "999", subscription: { id: "sub_8", status: "active" } },
      cs_test_org1: { id: "cs_test_org1", status: "complete", amount_total: 500, currency: "usd", client_reference_id: "2", subscription: { id: "sub_7", status: "active" } },
    };
    globalThis.fetch = async (url) => {
      const id = String(url).match(/sessions\/(cs_test_[a-z0-9]+)/)[1];
      return new Response(JSON.stringify(sessions[id]), { status: 200, headers: { "content-type": "application/json" } });
    };
    const get = (session, cookie) => blogniceApp.request(`https://www.blognice.test/admin/billing/success?session_id=${session}`, {
      headers: { cookie },
    }, env, ctx);

    assert.equal((await get("cs_test_open1", "bn_session=ads-session")).status, 302);
    assert.equal((await get("cs_test_other1", "bn_session=ads-session")).status, 302);
    const organic = await get("cs_test_org1", "bn_session=organic-session");
    assert.equal(organic.status, 200);
    assert.doesNotMatch(await organic.text(), /AW-16852730460/);
    assert.equal(await indexDb.prepare("SELECT COUNT(*) AS count FROM ads_conversions").first().then((r) => r.count), 0);

    assert.equal((await blogniceApp.request("https://www.blognice.test/admin/billing/success?session_id=cs_test_org1", undefined, env, ctx)).status, 302);
    assert.equal((await blogniceApp.request("https://www.blognice.test/admin/billing/success", {
      headers: { cookie: "bn_session=ads-session" },
    }, env, ctx)).status, 302);
    await indexDb.prepare("UPDATE accounts SET billing_status = 'active' WHERE id = 1").run();
    const active = await blogniceApp.request("https://www.blognice.test/admin/billing/success", {
      headers: { cookie: "bn_session=ads-session" },
    }, env, ctx);
    assert.equal(active.status, 200);
    assert.doesNotMatch(await active.text(), /send_to/);
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});

test("trial checkouts confirm with trial days and a zero-value conversion", async () => {
  const { blogniceApp, mf, indexDb, env, ctx } = await setupFunnel();
  const originalFetch = globalThis.fetch;
  try {
    const now = Math.floor(Date.now() / 1000);
    await indexDb.prepare("INSERT INTO ads_attributions (account_id, gclid, landing_path, created_at) VALUES (1, 'abc_123', '/blogger-alternative', ?)").bind(now).run();
    globalThis.fetch = async () => new Response(JSON.stringify({
      id: "cs_test_trial1", status: "complete", amount_total: 0, currency: "usd",
      client_reference_id: "1", subscription: { id: "sub_t", status: "trialing", trial_end: now + 14 * 86400 },
    }), { status: 200, headers: { "content-type": "application/json" } });
    const res = await blogniceApp.request("https://www.blognice.test/admin/billing/success?session_id=cs_test_trial1", {
      headers: { cookie: "bn_session=ads-session" },
    }, env, ctx);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Trial started: 14 days free, then your plan begins\. Cancel anytime before day 14\./);
    assert.match(html, /'value': 0\.00/);
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});
