import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Miniflare } from "miniflare";
import staffModule from "../src/staff.ts";

function b64url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  return Buffer.from(bytes).toString("base64url");
}
async function accessFixture(subject, email) {
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  publicJwk.kid = "staff-test-key-" + subject;
  publicJwk.alg = "RS256";
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", kid: publicJwk.kid }));
  const payload = b64url(JSON.stringify({ sub: subject, email, iss: "https://team.cloudflareaccess.com", aud: ["staff-audience"], iat: now - 1, exp: now + 3600 }));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return { token: `${header}.${payload}.${b64url(signature)}`, publicJwk };
}

const staff = readFileSync(new URL("../src/staff.ts", import.meta.url), "utf8");
const auth = readFileSync(new URL("../src/auth.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/014-staff-administration.sql", import.meta.url), "utf8");
const config = readFileSync(new URL("../wrangler.staff.production.example.jsonc", import.meta.url), "utf8");
const mailnice = readFileSync(new URL("../src/mailnice.ts", import.meta.url), "utf8");
const email = readFileSync(new URL("../src/email.ts", import.meta.url), "utf8");

test("staff Worker validates Access JWTs and keeps staff identity separate", () => {
  assert.match(staff, /Cf-Access-Jwt-Assertion/);
  assert.match(staff, /cdn-cgi\/access\/certs/);
  assert.match(staff, /RSASSA-PKCS1-v1_5/);
  assert.match(staff, /!claims\.iss/);
  assert.match(staff, /staff_users/);
  assert.match(staff, /STAFF_ALLOWED_EMAILS/);
});

test("affiliate offer experiment reporting stays Access-protected and controls are admin-only, same-origin, and audited", () => {
  assert.match(staff, /app\.get\("\/staff\/experiments\/affiliate-offer"/);
  assert.match(staff, /app\.post\("\/api\/experiments\/affiliate-offer\/status"/);
  assert.match(staff, /if \(!canAdmin\(staff\)\)/);
  assert.match(staff, /if \(!sameOrigin\(c\)\)/);
  assert.match(staff, /affiliate-offer-experiment-status/);
  assert.match(staff, /Exact D1 funnel totals/);
  assert.match(staff, /Analytics Engine estimates use sampling intervals/);
  assert.match(staff, /Decision diagnostics/);
  assert.match(staff, /Payment failures/);
  assert.match(staff, /Largest affiliate share/);
  assert.match(staff, /Trend data unavailable/);
  assert.match(staff, /No trend events have been recorded yet/);
});

test("staff phase 1 mutations require role, same origin, reason, and audit", () => {
  assert.match(staff, /function canMutate/);
  assert.match(staff, /same-origin request required/);
  assert.doesNotMatch(staff, /fetchSite === "same-origin" \|\| fetchSite === "same-site"/);
  assert.match(staff, /a reason is required/);
  assert.match(staff, /staff_audit_events/);
  assert.match(staff, /revoke-sessions/);
  assert.match(staff, /revoke-api-key/);
  assert.match(staff, /test-email/);
  assert.match(staff, /Send test email/);
  assert.match(staff, /subscriber-welcome/);
  assert.match(staff, /subscriber-confirmation/);
  assert.match(staff, /subscription-active/);
  assert.match(staff, /new-post/);
  assert.match(staff, /password-reset/);
  assert.match(staff, /Reset your password/);
  assert.match(email, /List-Unsubscribe/);
  assert.match(staff, /sendEmailDetailed/);
  assert.match(staff, /headers: template\.headers/);
  assert.match(staff, /emailKind: type === "subscriber-confirmation"/);
  assert.match(staff, /senderName: type === "subscriber-confirmation"/);
});

test("staff payout reconciliation is inspectable and restricted to admins", () => {
  assert.match(staff, /app\.get\("\/api\/affiliate-payouts"/);
  assert.match(staff, /getAffiliatePayoutQueueInDb/);
  assert.match(staff, /app\.post\("\/api\/affiliate-payouts\/:id\/reconcile"/);
  assert.match(staff, /admin role required for payout reconciliation/);
  assert.match(staff, /decision must be confirm_paid or cancel/);
  assert.match(staff, /evidence is required/);
  assert.match(staff, /affiliate-payout-reconcile/);
  assert.match(staff, /reconcilePayoutInDb/);
});

test("manual affiliate corrections are admin-only, same-origin, immutable, and audited", () => {
  assert.match(staff, /app\.post\("\/api\/accounts\/:id\/affiliate-adjustment"/);
  assert.match(staff, /admin role required for affiliate adjustments/);
  assert.match(staff, /recordManualAffiliateAdjustmentInDb/);
  assert.match(staff, /affiliate-manual-adjustment/);
  assert.match(staff, /a unique source_key is required/);
  assert.match(staff, /Append this immutable commission correction/);
});

test("only Stripe transfer creation is classified as an ambiguous dispatch", () => {
  const route = staff.slice(
    staff.indexOf('app.post("/api/affiliate-payouts/:id/dispatch"'),
    staff.indexOf("async function mutateAccount"),
  );
  const ambiguityBoundary = route.match(/try \{([\s\S]*?)\n  \} catch \(error\) \{/);
  assert.ok(ambiguityBoundary);
  assert.match(ambiguityBoundary[1], /createAffiliateTransfer/);
  assert.doesNotMatch(ambiguityBoundary[1], /recordPayoutDispatchResultInDb/);
  assert.doesNotMatch(ambiguityBoundary[1], /await audit/);
});

test("staff can operate the affiliate payout queue from one page", () => {
  assert.match(staff, /app\.get\("\/affiliate-payouts"/);
  assert.match(staff, /href="\/affiliate-payouts" data-staff-nav>Affiliate payouts/);
  assert.match(staff, /Affiliate payout operations/);
  assert.match(staff, /Awaiting reconciliation/);
  assert.match(staff, /Dispatch through Stripe/);
  assert.match(staff, /Confirm paid/);
  assert.match(staff, /Cancel payout/);
  assert.match(staff, /Stripe transfer ID/);
  assert.match(staff, /Evidence/);
  assert.match(staff, /\/api\/affiliate-payouts\/.*\/dispatch/);
  assert.match(staff, /\/api\/affiliate-payouts\/.*\/reconcile/);
});

test("staff account pages expose read-only affiliate support context", () => {
  assert.match(staff, /getAffiliateSupportSummaryInDb\(c\.env\.DB, id/);
  assert.match(staff, /getAffiliateSupportActivityInDb\(c\.env\.DB, id\)/);
  assert.match(staff, /Affiliate program/);
  assert.match(staff, /Referral code/);
  assert.match(staff, /Matured balance/);
  assert.match(staff, /Open reserve/);
  assert.match(staff, /Paid payouts/);
  assert.match(staff, /Referral attributions/);
  assert.match(staff, /Commission ledger/);
  assert.match(staff, /Payout history/);
});

test("admins can suspend and reactivate an affiliate without changing account state", () => {
  assert.match(staff, /app\.post\("\/api\/accounts\/:id\/affiliate-status"/);
  assert.match(staff, /admin role required for affiliate status changes/);
  assert.match(staff, /status must be active or suspended/);
  assert.match(staff, /UPDATE affiliate_profiles SET status = \?/);
  assert.match(staff, /affiliate-status-change/);
  assert.match(staff, /Suspend affiliate/);
  assert.match(staff, /Reactivate affiliate/);
  assert.match(staff, /\/api\/accounts\/\$\{id\}\/affiliate-status/);
});

test("staff test email uses MailNice without exposing its API key", () => {
  assert.match(mailnice, /api\.mailnice\.net\/api\/v1\/send\/message/);
  assert.match(mailnice, /X-Server-API-Key/);
  assert.match(mailnice, /plain_body/);
  assert.doesNotMatch(staff, /MAILNICE_API_KEY[^\n]*=[^?]/);
});

test("staff can manage the global pronunciation dictionary", () => {
  assert.match(staff, /Pronunciation dictionary/);
  assert.match(staff, /api\/pronunciations/);
  assert.match(staff, /upsert-pronunciation/);
  assert.match(staff, /delete-pronunciation/);
  assert.match(staff, /form method="post" action="\/api\/pronunciations\/\$\{row\.id\}\/delete"/);
  assert.match(staff, /Referer is the next-best CSRF signal/);
});

test("staff can generate short pronunciation samples", () => {
  assert.match(staff, /TTS test/);
  assert.match(staff, /api\/tts-test/);
  assert.match(staff, /TTS_MODEL/);
  assert.match(staff, /short phrase/);
  assert.match(config, /"ai":\s*\{\s*"binding":\s*"AI"\s*\}/);
  assert.match(staff, /ttsTestWithRetry/);
  assert.match(staff, /TTS_RETRY_DELAYS/);
  assert.match(staff, /classifyTtsError/);
  assert.match(staff, /attempts/);
  assert.match(staff, /transient/);
});

test("staff can send a rate-limited password reset email with an audit trail", () => {
  assert.match(staff, /send-password-reset/);
  assert.match(staff, /password_resets/);
  assert.match(staff, /A reset email was already issued/);
  assert.match(staff, /send-password-reset/);
  assert.match(staff, /Reset your blognice password/);
});

test("suspended accounts can log in but cannot perform actions", () => {
  assert.match(auth, /isSuspended/);
  assert.match(auth, /COALESCE\(a\.status, 'active'\) AS status/);
  assert.doesNotMatch(auth, /WHERE s\.token = \? AND s\.expires_at > \? AND COALESCE\(a\.status/);
  assert.match(auth, /status_reason/);
  assert.match(migration, /status TEXT NOT NULL DEFAULT 'active'/);
  assert.match(migration, /staff_audit_events/);
  const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(indexSource, /suspendedAccountPage/);
  assert.match(indexSource, /isSuspended\(account\)/);
  assert.match(indexSource, /Your account is currently suspended and you should contact support/);
  const admin = readFileSync(new URL("../src/admin.ts", import.meta.url), "utf8");
  assert.match(admin, /suspendedAccountPage/);
  assert.match(admin, /Your account is currently suspended/);
});

test("staff deployment is a separate Worker route", () => {
  assert.match(config, /"name": "blognice-staff"/);
  assert.match(config, /"main": "src\/staff\.ts"/);
  assert.match(config, /staff\.blognice\.com/);
  assert.match(config, /ACCESS_AUD/);
  assert.match(config, /"ai":\s*\{\s*"binding":\s*"AI"\s*\}/);
});

test("all staff pages expose the shared navigation", () => {
  assert.match(staff, /app\.get\("\/dashboard"/);
  assert.match(staff, /app\.get\("\/email-preview"/);
  assert.match(staff, /Recent staff activity/);
  assert.match(staff, /crypto_paid_through/);
  assert.match(staff, /Pronunciation dictionary.*TTS test/s);
  assert.ok(staff.includes("blognice staff") && staff.includes("<nav"));
  assert.match(staff, /staff-footer/);
  assert.match(staff, /href="https:\/\/www\.blognice\.com\/policies"/);
  assert.doesNotMatch(staff, /staff-footer[\s\S]*mailto:/);
});

test("transactional email links use the Blognice palette", () => {
  const email = readFileSync(new URL("../src/email.ts", import.meta.url), "utf8");
  assert.doesNotMatch(email, /#9098a0/);
  assert.match(email, /href="\$\{unsub\}" style="color:#5c6455"/);
  assert.match(email, /href="\$\{manage\}" style="color:#5c6455"/);
});

test("staff panel exposes logout, audit history, search, and read-only account context", () => {
  assert.match(staff, /cdn-cgi\/access\/logout/);
  assert.match(staff, /class="staff-top"/);
  assert.match(staff, /class="staff-sidebar"/);
  assert.match(staff, /data-staff-nav/);
  assert.match(staff, /staff-menu-toggle/);
  assert.match(staff, /scrollbar-gutter:stable/);
  assert.match(staff, /staff-content a:not\(\.btn\).*#1a8917/);
  assert.match(staff, /staff-sidebar\{visibility:hidden;position:fixed/);
  assert.match(staff, /event\.key==='Escape'/);
  assert.match(staff, /path\.indexOf\('\/accounts\/'\)===0/);
  assert.match(staff, /id="email-preview"/);
  assert.match(staff, /href="\/email-preview" data-staff-nav>Email preview/);
  assert.match(staff, /app\.get\("\/audit"/);
  assert.match(staff, /FROM staff_audit_events ORDER BY occurred_at DESC/);
  assert.match(staff, /Search by email, account ID, blog title/);
  assert.match(staff, /Open in Stripe/);
  assert.match(staff, /View live blog/);
  assert.match(staff, /domain_status/);
  assert.match(staff, /billing_price_id/);
  assert.match(staff, /function boundedPage/);
  assert.match(staff, /ORDER BY a\.created_at DESC, a\.id DESC/);
  assert.match(staff, /Delete this pronunciation entry/);
});

test("account deletion cannot orphan an owned blog", () => {
  assert.match(staff, /m\.account_id=\? AND m\.role='owner' LIMIT 1/);
  assert.match(staff, /transfer or delete owned blogs before deleting this account/);
});

test("autopilot runs table shows human-readable wrapped dates", () => {
  const page = staff.slice(staff.indexOf('app.get("/autopilot-runs"'));
  assert.doesNotMatch(page, /new Date\(r\.started_at\*1000\)\.toISOString\(\)/);
  assert.match(page, /\.slice\(0, 16\)\} UTC/);
  assert.match(page, /<td>\$\{started\}<\/td>/);
  assert.match(page, /target="_blank" rel="noopener noreferrer" title="\$\{esc\(sourceUrl\)\}">\$\{esc\(sourceHost\)\}<\/a>/);
  assert.match(page, /SELECT id, slug FROM posts WHERE id IN/);
  assert.match(page, /postSlugs\.get\(Number\(r\.post_id\)\)/);
  assert.match(page, /target="_blank" rel="noopener noreferrer">#/);
  assert.match(staff, /overflow-wrap:anywhere/);
});

test("autopilot enable/disable uses the setup panel, not prompt modals", () => {
  const start = staff.indexOf('id="autopilot-edit-panel"');
  const script = staff.slice(start, staff.indexOf("<\\/script>", start));
  assert.doesNotMatch(script, /prompt\(/);
  assert.match(script, /autopilot-disable/);
});

test("autopilot staff script parses and kicks off loading", async () => {
  const { Script } = await import("node:vm");
  const start = staff.indexOf("var tids=");
  const end = staff.indexOf("load()})();", start) + "load()})();".length;
  const body = staff.slice(start, end).replace(/\$\{[^}]*\}/g, "0");
  new Script("(function(){" + body);
  assert.match(body, /\bload\(\)\}\)\(\);$/);
});

test("autopilot row buttons bind after load and enable opens the panel", async () => {
  const { Script, createContext } = await import("node:vm");
  const start = staff.indexOf("var tids=");
  const end = staff.indexOf("load()})();", start) + "load()})();".length;
  const js = staff
    .slice(start, end)
    .replace("${idsJson}", "[7]")
    .replace("${blogsJson}", JSON.stringify([{ id: 7, title: "T", slug: "t", custom_domain: null }]))
    .replace(/\$\{[^}]*\}/g, "0");
  const clicks = [];
  const fakeButton = (attrs) => ({
    getAttribute: (k) => (attrs[k] === undefined ? null : attrs[k]),
    addEventListener: (ev, fn) => clicks.push({ attrs, ev, fn }),
  });
  const store = {};
  const field = (name) => ({
    get value() { return store[name] ?? ""; },
    set value(v) { store[name] = v; },
  });
  const panel = { style: {}, scrollIntoView: () => {} };
  const formEls = {};
  const form = {
    elements: new Proxy({}, { get: (_t, k) => (formEls[k] ??= field("form:" + k)) }),
    addEventListener: (ev, fn) => clicks.push({ attrs: { form: true }, ev, fn }),
  };
  let rendered = false;
  const byId = {
    "autopilot-rows": { set innerHTML(v) { this.html = v; rendered = true; } },
    "autopilot-edit-panel": panel,
    "autopilot-form": form,
    "autopilot-cancel": { addEventListener: () => {} },
    "autopilot-disable": { style: {}, addEventListener: () => {} },
  };
  const buttons = {
    edit: [fakeButton({ "data-autopilot-edit": "7" })],
    toggle: [fakeButton({ "data-autopilot-toggle": "7" })],
    run: [fakeButton({ "data-autopilot-run": "7" })],
  };
  const documentStub = {
    getElementById: (id) => byId[id] ?? null,
    querySelectorAll: (sel) => {
      if (!rendered) return [];
      return sel.includes("edit") ? buttons.edit : sel.includes("toggle") ? buttons.toggle : sel.includes("run") ? buttons.run : [];
    },
    createElement: () => ({ set textContent(v) { this.html = v; }, get innerHTML() { return this.html; } }),
    location: { hostname: "staff.blognice.com" },
  };
  const fetchStub = async (url) => ({ ok: true, json: async () => ({}) });
  const ctx = createContext({ document: documentStub, fetch: fetchStub });
  new Script(`(function(){${js}`).runInContext(ctx);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  const toggle = clicks.find((c) => c.attrs["data-autopilot-toggle"] === "7" && c.ev === "click");
  assert.ok(toggle, "toggle button has a click handler after load");
  toggle.fn();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(store["form:tenant_id"], "7");
  assert.equal(panel.style.display, "block");
  const html = byId["autopilot-rows"].html;
  assert.ok(html.includes("Needs topic"), "row flags the missing topic when unconfigured");
  assert.ok(html.includes("Set up"), "toggle button offers setup when the topic is missing");
});

test("autopilot long actions show a spinner while busy", () => {
  assert.match(staff, /@keyframes spin/);
  assert.match(staff, /prefers-reduced-motion/);
  assert.match(staff, /class=spin/);
});

test("run now polls the shared runs table until the run finishes", async () => {
  const { Script, createContext } = await import("node:vm");
  const start = staff.indexOf("var tids=");
  const end = staff.indexOf("load()})();", start) + "load()})();".length;
  const nowSec = Math.floor(Date.now() / 1000);
  const js = staff
    .slice(start, end)
    .replace("${idsJson}", "[7]")
    .replace("${blogsJson}", JSON.stringify([{ id: 7, title: "T", slug: "t", custom_domain: null }]))
    .replace(/\$\{[^}]*\}/g, "0");
  let rendered = false;
  const clicks = [];
  const fakeButton = (attrs) => ({
    getAttribute: (k) => (attrs[k] === undefined ? null : attrs[k]),
    addEventListener: (ev, fn) => clicks.push({ attrs, ev, fn }),
    set innerHTML(v) { this.html = v; },
    set textContent(v) { this.label = v; },
  });
  const alerts = [];
  const panel = { style: {}, scrollIntoView: () => {} };
  const byId = {
    "autopilot-rows": { set innerHTML(v) { this.html = v; rendered = true; } },
    "autopilot-edit-panel": panel,
    "autopilot-form": { elements: {}, addEventListener: () => {} },
    "autopilot-cancel": { addEventListener: () => {} },
    "autopilot-disable": { style: {}, addEventListener: () => {} },
  };
  const buttons = { run: [fakeButton({ "data-autopilot-run": "7" })] };
  const documentStub = {
    getElementById: (id) => byId[id] ?? null,
    querySelectorAll: (sel) => (!rendered ? [] : sel.includes("run") ? buttons.run : []),
    createElement: () => ({ set textContent(v) { this.html = v; }, get innerHTML() { return this.html; } }),
    location: { hostname: "staff.blognice.com" },
  };
  const fetchStub = async (url, opts) => {
    const u = String(url);
    if (u.endsWith("/run-now")) return { ok: true, json: async () => ({ ok: true, started: true, since: nowSec }) };
    if (u.includes("/api/autopilot-runs")) {
      return { ok: true, json: async () => ({ runs: [{ started_at: nowSec, finished_at: nowSec + 60, status: "success", error: null }] }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  const ctx = createContext({
    document: documentStub,
    fetch: fetchStub,
    confirm: () => true,
    alert: (m) => alerts.push(String(m)),
    location: { reload: () => {}, hostname: "staff.blognice.com" },
    setTimeout,
    Date,
  });
  new Script(`(function(){${js}`).runInContext(ctx);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  const run = clicks.find((c) => c.attrs["data-autopilot-run"] === "7" && c.ev === "click");
  assert.ok(run, "run button has a click handler after load");
  await run.fn();
  assert.ok(alerts.some((m) => m.includes("Run finished: success")), "page reports the polled run result, got: " + JSON.stringify(alerts));
});

test("audit log shows ticks for success/failure and notes UTC once", async () => {
  const staffApp = typeof staffModule.request === "function" ? staffModule : staffModule.default;
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: { DB: "staff-audit-page" } });
  const originalFetch = globalThis.fetch;
  try {
    const db = await mf.getD1Database("DB");
    const baseSchema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
    for (const s of baseSchema.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((v) => v.trim()).filter(Boolean)) await db.prepare(s).run();
    const now = Math.floor(Date.now() / 1000);
    await db.prepare("INSERT INTO staff_audit_events (id, occurred_at, subject, email, role, action, target_type, target_id, reason, result, request_id) VALUES ('e1', ?, 'staff|admin', 'admin@blognice.com', 'admin', 'lock', 'account', '1', 'test', 'success', 'req-1'), ('e2', ?, 'staff|admin', 'admin@blognice.com', 'admin', 'delete-account', 'account', '2', 'test', 'failure', 'req-2'), ('e3', ?, 'staff|admin', 'very-long-staff-name@blognice.com', 'admin', 'lock', 'account', '3', 'test', 'success', 'req-3')").bind(now, now - 60, now - 120).run();
    const adminAccess = await accessFixture("staff|admin", "admin@blognice.com");
    await db.prepare("INSERT INTO staff_users (subject, email, role, active, created_at, updated_at) VALUES ('staff|admin','admin@blognice.com','admin',1,?,?)").bind(now, now).run();
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/cdn-cgi/access/certs")) return new Response(JSON.stringify({ keys: [adminAccess.publicJwk] }), { status: 200 });
      throw new Error("unexpected " + url);
    };
    const env = { DB: db, ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "staff-audience" };
    const res = await staffApp.request(new Request("https://staff.blognice.test/audit", { headers: { "Cf-Access-Jwt-Assertion": adminAccess.token } }), undefined, env);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /aria-label="Result: success"[^>]*>✓</);
    assert.match(html, /aria-label="Result: failure"[^>]*>✗</);
    assert.doesNotMatch(html, />success</);
    assert.doesNotMatch(html, />failure</);
    assert.match(html, /Times are in UTC/);
    assert.doesNotMatch(html, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
    assert.match(html, /<span title="admin@blognice\.com">admin@blognic…<\/span>/);
    assert.match(html, /<span title="very-long-staff-name@blognice\.com">very-long-sta…<\/span>/);
    assert.doesNotMatch(html, /very-long-staff-name@blognice\.com<br>/);
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});

test("staff TTS engine switch persists and gates by role", async () => {
  const staffApp = typeof staffModule.request === "function" ? staffModule : staffModule.default;
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: { DB: "staff-tts-engine" } });
  const originalFetch = globalThis.fetch;
  try {
    const db = await mf.getD1Database("DB");
    const baseSchema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
    for (const s of baseSchema.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((v) => v.trim()).filter(Boolean)) await db.prepare(s).run();
    const now = Math.floor(Date.now() / 1000);
    const adminAccess = await accessFixture("staff|admin", "admin@blognice.com");
    const readerAccess = await accessFixture("staff|reader", "reader@blognice.com");
    await db.prepare("INSERT INTO staff_users (subject, email, role, active, created_at, updated_at) VALUES ('staff|admin','admin@blognice.com','admin',1,?,?),('staff|reader','reader@blognice.com','read_only',1,?,?)").bind(now, now, now, now).run();
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/cdn-cgi/access/certs")) return new Response(JSON.stringify({ keys: [adminAccess.publicJwk, readerAccess.publicJwk] }), { status: 200 });
      throw new Error("unexpected " + url);
    };
    const env = { DB: db, ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "staff-audience" };
    const authed = (access, init = {}) => new Request("https://staff.blognice.test/api/tts-engine", {
      headers: { "Cf-Access-Jwt-Assertion": access.token, Origin: "https://staff.blognice.test", "content-type": "application/json" },
      ...init,
    });
    let res = await staffApp.request(authed(adminAccess), undefined, env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { engine: "melotts" });
    res = await staffApp.request(authed(readerAccess), undefined, env);
    assert.equal(res.status, 200);
    res = await staffApp.request(authed(adminAccess, { method: "POST", body: JSON.stringify({ engine: "bogus" }) }), undefined, env);
    assert.equal(res.status, 400);
    res = await staffApp.request(authed(readerAccess, { method: "POST", body: JSON.stringify({ engine: "aura-1" }) }), undefined, env);
    assert.equal(res.status, 403);
    res = await staffApp.request(authed(adminAccess, { method: "POST", body: JSON.stringify({ engine: "aura-1" }) }), undefined, env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { engine: "aura-1" });
    res = await staffApp.request(authed(adminAccess), undefined, env);
    assert.deepEqual(await res.json(), { engine: "aura-1" });
    const stored = await db.prepare("SELECT value FROM platform_settings WHERE key = 'tts.engine'").first();
    assert.equal(stored.value, "aura-1");
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});

test("staff TTS test page shows the active narration engine", async () => {
  const staffApp = typeof staffModule.request === "function" ? staffModule : staffModule.default;
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: { DB: "staff-tts-engine-page" } });
  const originalFetch = globalThis.fetch;
  try {
    const db = await mf.getD1Database("DB");
    const baseSchema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
    for (const s of baseSchema.replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((v) => v.trim()).filter(Boolean)) await db.prepare(s).run();
    const now = Math.floor(Date.now() / 1000);
    const adminAccess = await accessFixture("staff|pageadmin", "pageadmin@blognice.com");
    const readerAccess = await accessFixture("staff|pagereader", "pagereader@blognice.com");
    await db.prepare("INSERT INTO staff_users (subject, email, role, active, created_at, updated_at) VALUES ('staff|pageadmin','pageadmin@blognice.com','admin',1,?,?),('staff|pagereader','pagereader@blognice.com','read_only',1,?,?)").bind(now, now, now, now).run();
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/cdn-cgi/access/certs")) return new Response(JSON.stringify({ keys: [adminAccess.publicJwk, readerAccess.publicJwk] }), { status: 200 });
      throw new Error("unexpected " + url);
    };
    const env = { DB: db, ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "staff-audience" };
    const page = (access) => staffApp.request(new Request("https://staff.blognice.test/tts-test", { headers: { "Cf-Access-Jwt-Assertion": access.token } }), undefined, env);
    let html = await (await page(adminAccess)).text();
    assert.match(html, /<strong id="tts-engine-status">melotts<\/strong>/);
    assert.match(html, /id="tts-engine-form"/);
    html = await (await page(readerAccess)).text();
    assert.match(html, /id="tts-engine-status"/);
    assert.doesNotMatch(html, /id="tts-engine-form"/);
    await db.prepare("INSERT INTO platform_settings (key, value, updated_at) VALUES ('tts.engine', 'aura-1', ?)").bind(now).run();
    html = await (await page(adminAccess)).text();
    assert.match(html, /<strong id="tts-engine-status">aura-1<\/strong>/);
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});
