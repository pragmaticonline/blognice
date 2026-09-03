import { Hono } from "hono";
import { esc } from "./render";
import { sendEmailDetailed, registrationWelcomeEmail, subscriptionActiveEmail, subscriberConfirmationEmail, passwordResetEmail, subscriberWelcomeEmail, postNotificationEmail } from "./email";
import { generateResetToken, sha256hex } from "./auth";
import { classifyTtsError, ttsBytes, TTS_MODEL, TTS_RETRY_DELAYS } from "./tts";
import { getAffiliatePayoutQueueInDb, getAffiliateSupportActivityInDb, getAffiliateSupportSummaryInDb } from "./affiliate-support";
import { approveAffiliatePayoutInDb, hasIndependentPayoutApprovalInDb, loadStripePayoutDispatchInDb, parseAffiliateStripeConnectCountries, parsePayoutDualControlThreshold, reconcilePayoutInDb, recordAffiliateAccountRelationshipInDb, recordManualAffiliateAdjustmentInDb, recordPayoutDispatchResultInDb } from "./affiliate";
import { createAffiliateTransfer } from "./stripe";
import { relayAffiliateEmailOutboxInDb, type AffiliateEmailJob } from "./affiliate-notifications";
import { getFunnelExperimentReportInDb } from "./funnel-experiment-report";
import { experimentFunnelSeries } from "./metrics";

type StaffRole = "read_only" | "support" | "admin";
type StaffIdentity = { subject: string; email: string; role: StaffRole };

type StaffBindings = {
  DB: D1Database;
  AI?: Ai;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  STAFF_ALLOWED_EMAILS?: string;
  MAILNICE_API_KEY?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  ROOT_DOMAIN?: string;
  STRIPE_MONTHLY_PRICE_ID?: string;
  STRIPE_YEARLY_PRICE_ID?: string;
  STRIPE_SECRET_KEY?: string;
  AFFILIATE_PAYOUT_DUAL_CONTROL_THRESHOLD_MINOR?: string;
  AFFILIATE_STRIPE_CONNECT_COUNTRIES?: string;
  AFFILIATE_OFFER_EXPERIMENT?: string;
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_TOKEN?: string;
  EMAIL_QUEUE?: Queue<AffiliateEmailJob>;
};

type TestEmailType = "registration" | "subscription-active" | "subscriber-confirmation" | "subscriber-welcome" | "new-post" | "password-reset";

type AccessClaims = {
  sub?: string;
  email?: string;
  aud?: string[] | string;
  iss?: string;
  exp?: number;
  iat?: number;
};

const STAFF_ROLES = new Set<StaffRole>(["read_only", "support", "admin"]);

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(normalized);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

function decodeJson<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(value))) as T;
}

function normalizedTeamDomain(value: string): string {
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withScheme.replace(/\/+$/, "");
}

async function accessClaims(c: any): Promise<AccessClaims | null> {
  const token = c.req.header("Cf-Access-Jwt-Assertion");
  const team = String(c.env.ACCESS_TEAM_DOMAIN || "").trim();
  const audience = String(c.env.ACCESS_AUD || "").trim();
  if (!token || !team || !audience) return null;
  try {
    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
    if (!encodedHeader || !encodedPayload || !encodedSignature) return null;
    const header = decodeJson<{ alg?: string; kid?: string }>(encodedHeader);
    const claims = decodeJson<AccessClaims>(encodedPayload);
    if (header.alg !== "RS256" || !header.kid || !claims.sub || !claims.email) return null;
    const now = Math.floor(Date.now() / 1000);
    if (!claims.exp || claims.exp <= now || (claims.iat && claims.iat > now + 60)) return null;
    const issuer = normalizedTeamDomain(team);
    if (!claims.iss || claims.iss.replace(/\/+$/, "") !== issuer) return null;
    const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
    if (!audiences.includes(audience)) return null;
    const certs = await fetch(`${issuer}/cdn-cgi/access/certs`, { cf: { cacheTtl: 300 } } as RequestInit).then((res) => res.ok ? res.json<{ keys?: JsonWebKey[] }>() : null);
    const key = certs?.keys?.find((candidate) => (candidate as JsonWebKey & { kid?: string }).kid === header.kid);
    if (!key) return null;
    const cryptoKey = await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, base64UrlDecode(encodedSignature), new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`));
    return valid ? claims : null;
  } catch {
    return null;
  }
}

async function resolveStaff(c: any): Promise<StaffIdentity | null> {
  const claims = await accessClaims(c);
  if (!claims) return null;
  const row = await c.env.DB.prepare(
    "SELECT subject, email, role FROM staff_users WHERE subject = ? AND active = 1"
  ).bind(claims.sub).first() as { subject: string; email: string; role: string } | null;
  if (row && STAFF_ROLES.has(row.role as StaffRole)) return { ...row, role: row.role as StaffRole };
  const email = String(claims.email).trim();
  const allowed = String(c.env.STAFF_ALLOWED_EMAILS || "").split(",").map((value: string) => value.trim().toLowerCase()).filter(Boolean);
  if (allowed.includes(email.toLowerCase())) {
    return { subject: claims.sub!, email, role: "admin" };
  }
  return null;
}

function canMutate(staff: StaffIdentity): boolean {
  return staff.role === "support" || staff.role === "admin";
}
function canAdmin(staff: StaffIdentity): boolean { return staff.role === "admin"; }

function requestId(c: any): string {
  return c.req.header("Cf-Ray") || c.req.header("X-Request-ID") || crypto.randomUUID();
}

function boundedPage(value: string | undefined): number {
  const parsed = Number(value || 1);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 10_000_000 ? parsed : 1;
}

function sameOrigin(c: any): boolean {
  const origin = c.req.header("Origin");
  const requestUrl = new URL(c.req.url);
  const host = c.req.header("Host");
  const requestOrigins = new Set([requestUrl.origin]);
  if (host) requestOrigins.add(`${requestUrl.protocol}//${host}`);
  if (origin) return requestOrigins.has(origin);
  const fetchSite = c.req.header("Sec-Fetch-Site");
  if (fetchSite === "same-origin") return true;
  // Some browsers and privacy extensions omit Origin on same-origin DELETE
  // requests. Referer is the next-best CSRF signal in that case.
  const referer = c.req.header("Referer");
  if (!referer) return false;
  try {
    return requestOrigins.has(new URL(referer).origin);
  } catch {
    return false;
  }
}

async function ttsTestWithRetry(ai: Ai, prompt: string): Promise<{ bytes: Uint8Array; attempts: number; retries: Array<{ attempt: number; category: string; code: string | null; delayMs: number }> }> {
  let lastError: unknown;
  const retries: Array<{ attempt: number; category: string; code: string | null; delayMs: number }> = [];
  for (let attempt = 0; attempt <= TTS_RETRY_DELAYS.length; attempt++) {
    try {
      const generated = await ai.run(TTS_MODEL, { prompt, lang: "en" }) as Uint8Array | { audio: string };
      const bytes = ttsBytes(generated);
      if (!bytes.length) throw Object.assign(new Error("The model returned no audio."), { code: "EMPTY_AUDIO" });
      return { bytes, attempts: attempt + 1, retries };
    } catch (error) {
      lastError = error;
      const info = classifyTtsError(error, (error as { code?: unknown })?.code === "EMPTY_AUDIO");
      if (!info.transient || attempt === TTS_RETRY_DELAYS.length) throw Object.assign(error instanceof Error ? error : new Error(String(error)), { ttsErrorInfo: info, ttsRetries: retries });
      const jitter = Math.floor(Math.random() * 250);
      const delayMs = TTS_RETRY_DELAYS[attempt] + jitter;
      retries.push({ attempt: attempt + 1, category: info.category, code: info.code, delayMs });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function audit(c: any, staff: StaffIdentity, event: {
  action: string;
  targetType: string;
  targetId: string;
  reason?: string;
  result: string;
  before?: unknown;
  after?: unknown;
}) {
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    `INSERT INTO staff_audit_events
      (id, occurred_at, subject, email, role, action, target_type, target_id,
       reason, result, request_id, before_json, after_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(), now, staff.subject, staff.email, staff.role,
    event.action, event.targetType, event.targetId, event.reason || null,
    event.result, requestId(c), event.before == null ? null : JSON.stringify(event.before),
    event.after == null ? null : JSON.stringify(event.after)
  ).run();
}

async function accountById(c: any, id: number) {
  const now = Math.floor(Date.now() / 1000);
  try {
    return await c.env.DB.prepare(
      `SELECT a.id, a.email, COALESCE(a.status, 'active') AS status, a.status_reason, a.status_changed_at, a.created_at, a.stripe_customer_id, a.billing_status, a.billing_price_id, a.billing_period_end, a.billing_cancel_at_period_end, a.api_key_hash IS NOT NULL AS has_api_key, COALESCE(a.email_verified,0) AS email_verified, a.email_verified_at, a.signup_ip, a.signup_ua, a.signup_referer, a.signup_country, a.locked_until, a.deleted_at, (SELECT COUNT(*) FROM sessions s WHERE s.account_id = a.id AND s.expires_at > ?) AS active_sessions, (SELECT COUNT(*) FROM memberships m WHERE m.account_id = a.id) AS blog_count FROM accounts a WHERE a.id = ?`
    ).bind(now, id).first();
  } catch {
    return await c.env.DB.prepare(
      `SELECT a.id, a.email, COALESCE(a.status, 'active') AS status, a.status_reason, a.status_changed_at, a.created_at, a.stripe_customer_id, a.billing_status, a.billing_price_id, a.billing_period_end, a.billing_cancel_at_period_end, a.api_key_hash IS NOT NULL AS has_api_key, (SELECT COUNT(*) FROM sessions s WHERE s.account_id = a.id AND s.expires_at > ?) AS active_sessions, (SELECT COUNT(*) FROM memberships m WHERE m.account_id = a.id) AS blog_count FROM accounts a WHERE a.id = ?`
    ).bind(now, id).first();
  }
}
async function fetchSessions(c: any, id: number, limit = 20) {
  try { return await c.env.DB.prepare("SELECT token, ip, user_agent, created_via, created_at, expires_at FROM sessions WHERE account_id = ? ORDER BY created_at DESC LIMIT ?").bind(id, limit).all(); } catch { try { return await c.env.DB.prepare("SELECT token, created_at, expires_at FROM sessions WHERE account_id = ? ORDER BY created_at DESC LIMIT ?").bind(id, limit).all(); } catch { return { results: [] } as any; } }
}
async function fetchNotes(c: any, id: number) {
  try { return await c.env.DB.prepare("SELECT id, author_email, note, created_at FROM account_notes WHERE account_id = ? ORDER BY created_at DESC LIMIT 50").bind(id).all(); } catch { return { results: [] } as any; }
}
async function fetchActivity(c: any, id: number) {
  const out: any[] = [];
  try { const ev = await c.env.DB.prepare("SELECT occurred_at, action, target_type, target_id, result FROM staff_audit_events WHERE target_type='account' AND target_id=? ORDER BY occurred_at DESC LIMIT 20").bind(String(id)).all() as any; for (const r of (ev.results||[])) out.push({ at: r.occurred_at, kind: "staff:"+r.action, detail: r.target_type+":"+r.target_id+" "+r.result }); } catch {}
  try { const dom = await c.env.DB.prepare("SELECT hostname, status, created_at FROM domains WHERE tenant_id IN (SELECT tenant_id FROM memberships WHERE account_id=?) ORDER BY created_at DESC LIMIT 10").bind(id).all() as any; for (const r of (dom.results||[])) out.push({ at: r.created_at, kind: "domain", detail: r.hostname+" ("+r.status+")" }); } catch {}
  try { const se = await c.env.DB.prepare("SELECT type, created_at FROM stripe_events WHERE account_id=? ORDER BY created_at DESC LIMIT 10").bind(id).all() as any; for (const r of (se.results||[])) out.push({ at: r.created_at, kind: "billing", detail: r.type }); } catch {}
  try { const cp = await c.env.DB.prepare("SELECT status, created_at FROM crypto_payments WHERE account_id=? ORDER BY created_at DESC LIMIT 10").bind(id).all() as any; for (const r of (cp.results||[])) out.push({ at: r.created_at, kind: "crypto", detail: r.status }); } catch {}
  try { const aa = await c.env.DB.prepare("SELECT kind, detail, created_at FROM account_activity WHERE account_id=? ORDER BY created_at DESC LIMIT 20").bind(id).all() as any; for (const r of (aa.results||[])) out.push({ at: r.created_at, kind: r.kind, detail: r.detail || "" }); } catch {}
  out.sort((a,b)=>b.at-a.at);
  return out.slice(0,30);
}
async function relatedAccounts(c: any, id: number) {
  const rel: Array<{id:number,email:string,reason:string}> = [];
  let acct: any = null;
  try { acct = await c.env.DB.prepare("SELECT signup_ip, stripe_customer_id FROM accounts WHERE id=?").bind(id).first() as any; } catch {}
  if (acct?.signup_ip) {
    try { const rows = await c.env.DB.prepare("SELECT id,email FROM accounts WHERE signup_ip=? AND id!=? LIMIT 5").bind(acct.signup_ip, id).all() as any; for (const r of (rows.results||[])) rel.push({ id: r.id, email: r.email, reason: "shared signup IP "+acct.signup_ip }); } catch {}
    try { const rows = await c.env.DB.prepare("SELECT DISTINCT account_id as id FROM sessions WHERE ip=? AND account_id!=? LIMIT 5").bind(acct.signup_ip, id).all() as any; for (const r of (rows.results||[])) { if (rel.find(x=>x.id===r.id)) continue; try { const e = await c.env.DB.prepare("SELECT email FROM accounts WHERE id=?").bind(r.id).first() as any; rel.push({ id: r.id, email: e?.email||String(r.id), reason: "shared session IP "+acct.signup_ip }); } catch {} } } catch {}
  }
  return rel.slice(0,8);
}

function staffHeader(staff: StaffIdentity): string {
  return `<header class="staff-top"><a class="staff-brand" href="/">blognice <span>staff</span></a><div class="staff-top-meta"><small>${esc(staff.email)} · ${esc(staff.role)}</small><a class="logout" href="/cdn-cgi/access/logout">Log out</a><button class="staff-menu-toggle" type="button" aria-controls="staff-sidebar" aria-expanded="false">Menu</button></div></header><div class="staff-shell"><aside class="staff-sidebar" id="staff-sidebar"><nav class="staff-nav" aria-label="Staff navigation"><a href="/dashboard" data-staff-nav>Dashboard</a><a href="/" data-staff-nav>Accounts</a><a href="/affiliate-payouts" data-staff-nav>Affiliate payouts</a><a href="/staff/experiments/affiliate-offer" data-staff-nav>Offer experiment</a><a href="/audit" data-staff-nav>Audit log</a><a href="/pronunciations" data-staff-nav>Pronunciation dictionary</a><a href="/tts-test" data-staff-nav>TTS test</a><a href="/email-preview" data-staff-nav>Email preview</a></nav></aside><div class="staff-content">`;
}

function billingPlan(account: any, c: any): string {
  if (!account.billing_status || !["active", "trialing", "past_due", "canceled"].includes(String(account.billing_status))) return "Free";
  const price = String(account.billing_price_id || "");
  if (c.env.STRIPE_YEARLY_PRICE_ID && price === c.env.STRIPE_YEARLY_PRICE_ID) return "Pro Yearly";
  if (c.env.STRIPE_MONTHLY_PRICE_ID && price === c.env.STRIPE_MONTHLY_PRICE_ID) return "Pro Monthly";
  return "Pro";
}

function staffPage(title: string, body: string): string {
  body = `<style>html{scrollbar-gutter:stable}body{overflow-y:scroll}.staff-content a:not(.btn){color:#1a8917;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px}.staff-content a:not(.btn):visited{color:#1a8917}.staff-content a:not(.btn):hover,.staff-content a:not(.btn):focus-visible{color:#0e5a0c}.staff-content a.btn,.staff-content a.btn:visited{color:#171914;text-decoration:none}</style>${body}`;
  // Normalize branding before the shell is assembled; the shell must not rewrite
  // arbitrary rendered values such as account emails, blog titles, or audit reasons.
  // Static staff copy is normalized at its source; do not rewrite rendered user data.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · blognice staff</title><style>
  :root{color-scheme:light;--ink:#171914;--muted:#687064;--rule:#dfe4da;--paper:#f7f8f3;--accent:#1a8917;--accent-soft:#eaf4e8;--card:#fff}*{box-sizing:border-box}html{scrollbar-gutter:stable}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}.wrap{max-width:none;margin:auto;padding:0}.staff-top{height:68px;display:flex;align-items:center;justify-content:space-between;padding:0 32px;background:var(--card);border-bottom:1px solid var(--rule)}.staff-brand{font-size:1.2rem;font-weight:800;letter-spacing:-.02em;color:var(--ink);text-decoration:none}.staff-brand span{font-weight:500;color:var(--muted)}.staff-top-meta{display:flex;align-items:center;gap:14px}.staff-top-meta small{color:var(--muted)}.logout{font-size:.86rem;color:var(--muted);border:1px solid var(--rule);padding:6px 10px;border-radius:7px;text-decoration:none}.logout:hover,.logout:focus-visible{color:var(--ink);border-color:var(--accent)}.staff-menu-toggle{display:none;border:1px solid var(--rule);background:var(--card);border-radius:7px;padding:6px 10px;font:inherit;cursor:pointer}.staff-shell{display:flex;min-height:calc(100vh - 68px)}.staff-sidebar{width:236px;flex:0 0 236px;background:var(--card);border-right:1px solid var(--rule);padding:24px 14px}.staff-nav{display:flex;flex-direction:column;gap:4px}.staff-nav a{color:var(--muted);text-decoration:none;padding:10px 12px;border-radius:7px}.staff-nav a:hover,.staff-nav a:focus-visible{color:var(--ink);background:var(--paper)}.staff-nav a.active{color:#165c13;background:var(--accent-soft);font-weight:650}.staff-content{width:min(1120px,100%);margin:0 auto;padding:32px}.top{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid var(--rule);padding-bottom:18px;margin-bottom:18px}.top h1{font-size:1.25rem;margin:0}.top small{color:var(--muted)}h2{font-size:1.6rem;margin:0 0 8px}.muted{color:var(--muted)}.search{display:flex;gap:8px;margin:20px 0}.search input{flex:1;padding:10px 12px;border:1px solid var(--rule);border-radius:6px;font:inherit;background:#fff}.btn{border:1px solid var(--rule);background:#fff;border-radius:6px;padding:9px 13px;font:inherit;cursor:pointer}.btn:hover,.btn:focus-visible{border-color:var(--accent)}.btn-danger{color:#8d241b}.dashboard-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.dashboard-stats .card{margin:0}.dashboard-stats strong{display:block;font-size:2rem;margin-top:4px}.card{background:var(--card);border:1px solid var(--rule);border-radius:9px;margin:14px 0;padding:18px}.card-head{display:flex;justify-content:space-between;gap:16px;align-items:center}.badge{display:inline-block;border-radius:999px;padding:3px 9px;font-size:.78rem;background:var(--accent-soft);color:#20611e}.badge.suspended{background:#fae7e4;color:#8d241b}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--rule);vertical-align:top}th{font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.actions form{display:inline-flex;gap:6px}.actions input{min-width:190px;padding:8px;border:1px solid var(--rule);border-radius:5px}.notice{padding:12px;border-radius:6px;background:#fff4d6;margin:12px 0}.empty{padding:28px;text-align:center;color:var(--muted)}.staff-footer{padding:1.2rem 32px 2rem;border-top:1px solid var(--rule);display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;color:var(--muted);font-size:.82rem}.staff-footer nav{display:flex;gap:1rem;margin:0;flex-wrap:wrap}.staff-footer a{color:inherit;text-decoration:none}.staff-footer a:hover,.staff-footer a:focus-visible{color:var(--accent);text-decoration:underline}@media(max-width:760px){.dashboard-stats{grid-template-columns:1fr}.staff-top{padding:0 18px}.staff-top-meta small{display:none}.staff-menu-toggle{display:block}.staff-sidebar{visibility:hidden;position:fixed;z-index:10;top:68px;bottom:0;left:0;transform:translateX(-100%);transition:transform .18s ease;box-shadow:12px 0 28px rgba(23,25,20,.1)}.staff-sidebar.open{transform:translateX(0);visibility:visible}.staff-content{padding:24px 18px}.staff-footer{padding-left:18px;padding-right:18px}}
  </style></head><body><main class="wrap">${body}</div></div></main><footer class="staff-footer"><span><strong>blognice</strong> · © 2026 Pragmatic Online Co., Ltd.</span><nav aria-label="Legal"><a href="https://www.blognice.com/policies">Policies</a></nav></footer><script>(function(){var path=location.pathname;document.querySelectorAll('[data-staff-nav]').forEach(function(link){var target=link.getAttribute('href')||'/';var isAccounts=target==='/'&&(path==='/'||path.indexOf('/accounts/')===0);if(isAccounts||(target!=='/'&&path.indexOf(target)===0))link.classList.add('active');});var toggle=document.querySelector('.staff-menu-toggle'),sidebar=document.getElementById('staff-sidebar');if(toggle&&sidebar){toggle.addEventListener('click',function(){var open=sidebar.classList.toggle('open');toggle.setAttribute('aria-expanded',String(open));});document.addEventListener('click',function(event){if(sidebar.classList.contains('open')&&!sidebar.contains(event.target)&&event.target!==toggle){sidebar.classList.remove('open');toggle.setAttribute('aria-expanded','false');}});document.addEventListener('keydown',function(event){if(event.key==='Escape'&&sidebar.classList.contains('open')){sidebar.classList.remove('open');toggle.setAttribute('aria-expanded','false');toggle.focus();}});}})();</script></body></html>`;
}

const app = new Hono<{ Bindings: StaffBindings; Variables: { staff: StaffIdentity } }>();

app.get("/health", (c) => c.json({ ok: true, service: "blognice-staff" }));

app.use("*", async (c, next) => {
  const staff = await resolveStaff(c);
  if (!staff) return c.json({ error: "staff authorization required" }, 403);
  c.set("staff", staff);
  await next();
});

app.get("/api/accounts", async (c) => {
  const q = String(c.req.query("q") || "").trim().slice(0, 100);
  const page = boundedPage(c.req.query("page"));
  const limit = 50;
  const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const where = q ? "WHERE a.email LIKE ? ESCAPE '\\' OR CAST(a.id AS TEXT) LIKE ? ESCAPE '\\' OR COALESCE(a.signup_ip,'') LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM memberships sm JOIN tenants st ON st.id = sm.tenant_id WHERE sm.account_id = a.id AND (st.title LIKE ? ESCAPE '\\' OR st.slug LIKE ? ESCAPE '\\' OR st.custom_domain LIKE ? ESCAPE '\\' OR st.public_id LIKE ? ESCAPE '\\' OR COALESCE(sm.display_name,'') LIKE ? ESCAPE '\\')) OR EXISTS (SELECT 1 FROM sessions sess WHERE sess.account_id=a.id AND COALESCE(sess.ip,'') LIKE ? ESCAPE '\\')" : "";
  const params = q ? [pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern] : [];
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.email, COALESCE(a.status, 'active') AS status, a.created_at,
            (SELECT COUNT(*) FROM memberships m WHERE m.account_id = a.id) AS blog_count
       FROM accounts a ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`
  ).bind(...params, limit, (page - 1) * limit).all();
  return c.json({ page, limit, accounts: rows.results });
});

app.get("/api/accounts/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id < 1) return c.json({ error: "invalid account" }, 400);
  const account = await accountById(c, id);
  if (!account) return c.json({ error: "account not found" }, 404);
  const blogs = await c.env.DB.prepare(
    `SELECT t.id, t.public_id, t.slug, t.title, m.role, m.created_at
       FROM memberships m JOIN tenants t ON t.id = m.tenant_id
      WHERE m.account_id = ? ORDER BY m.created_at DESC`
  ).bind(id).all();
  return c.json({ account, blogs: blogs.results });
});

app.get("/api/accounts/:id/affiliate", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id < 1) return c.json({ error: "invalid account" }, 400);
  const summary = await getAffiliateSupportSummaryInDb(c.env.DB, id, Math.floor(Date.now() / 1000));
  if (!summary) return c.json({ error: "affiliate profile not found" }, 404);
  const activity = await getAffiliateSupportActivityInDb(c.env.DB, id);
  return c.json({ affiliate: summary, activity });
});

app.post("/api/accounts/:id/affiliate-status", async (c) => {
  const staff = c.get("staff") as StaffIdentity;
  if (!canAdmin(staff)) return c.json({ error: "admin role required for affiliate status changes" }, 403);
  if (!sameOrigin(c)) return c.json({ error: "same-origin request required" }, 403);
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id < 1) return c.json({ error: "invalid account" }, 400);
  const body = await c.req.json<{ status?: unknown; reason?: unknown }>().catch(() => ({} as { status?: unknown; reason?: unknown }));
  const status = String(body.status || "").trim();
  const reason = String(body.reason || "").trim().slice(0, 500);
  if (status !== "active" && status !== "suspended") return c.json({ error: "status must be active or suspended" }, 400);
  if (!reason) return c.json({ error: "a reason is required" }, 400);
  const before = await c.env.DB.prepare("SELECT status FROM affiliate_profiles WHERE account_id = ?").bind(id).first<{ status: string }>();
  if (!before) return c.json({ error: "affiliate profile not found" }, 404);
  if (before.status === status) return c.json({ error: `affiliate is already ${status}` }, 409);
  if (before.status !== "active" && before.status !== "suspended") {
    return c.json({ error: `affiliate status ${before.status} cannot be changed here` }, 409);
  }
  const changed = await c.env.DB.prepare(
    "UPDATE affiliate_profiles SET status = ? WHERE account_id = ? AND status = ?",
  ).bind(status, id, before.status).run();
  if (changed.meta.changes !== 1) return c.json({ error: "affiliate status changed concurrently" }, 409);
  await audit(c, staff, {
    action: "affiliate-status-change", targetType: "affiliate_profile",
    targetId: String(id), reason, result: "success",
    before: { status: before.status }, after: { status },
  });
  return c.json({ changed: true, account_id: id, status });
});

app.post("/api/accounts/:id/affiliate-related-account", async (c) => {
  const staff = c.get("staff") as StaffIdentity;
  if (!canAdmin(staff)) return c.json({ error: "admin role required for affiliate relationship changes" }, 403);
  if (!sameOrigin(c)) return c.json({ error: "same-origin request required" }, 403);
  const affiliateId = Number(c.req.param("id"));
  if (!Number.isSafeInteger(affiliateId) || affiliateId < 1) return c.json({ error: "invalid affiliate account" }, 400);
  const body = await c.req.json<{ related_account_id?: unknown; relationship_kind?: unknown; reason?: unknown }>()
    .catch(() => ({} as { related_account_id?: unknown; relationship_kind?: unknown; reason?: unknown }));
  const relatedAccountId = Number(body.related_account_id);
  const relationshipKind = String(body.relationship_kind || "").trim();
  const reason = String(body.reason || "").trim().slice(0, 500);
  if (!Number.isSafeInteger(relatedAccountId) || relatedAccountId < 1 || relatedAccountId === affiliateId) {
    return c.json({ error: "a different related account is required" }, 400);
  }
  if (!(["same_person", "same_organization", "controlled_account"] as string[]).includes(relationshipKind)) {
    return c.json({ error: "relationship_kind is invalid" }, 400);
  }
  if (!reason) return c.json({ error: "a reason is required" }, 400);
  const profile = await c.env.DB.prepare("SELECT 1 FROM affiliate_profiles WHERE account_id = ?").bind(affiliateId).first();
  if (!profile) return c.json({ error: "affiliate profile not found" }, 404);
  const recordedAt = Math.floor(Date.now() / 1000);
  const result = await recordAffiliateAccountRelationshipInDb(c.env.DB, {
    affiliateId, relatedAccountId,
    relationshipKind: relationshipKind as "same_person" | "same_organization" | "controlled_account",
    actorSubject: staff.subject, actorRole: "admin", reason, recordedAt,
  });
  if (!result.recorded) return c.json({ error: "relationship already exists or account was not found" }, 409);
  await audit(c, staff, {
    action: "affiliate-related-account", targetType: "affiliate_profile",
    targetId: String(affiliateId), reason, result: "recorded",
    after: { related_account_id: relatedAccountId, relationship_kind: relationshipKind },
  });
  return c.json({ recorded: true, affiliate_id: affiliateId, related_account_id: relatedAccountId, affiliate_status: "suspended" });
});

app.post("/api/accounts/:id/affiliate-adjustment", async (c) => {
  const staff = c.get("staff") as StaffIdentity;
  if (!canAdmin(staff)) return c.json({ error: "admin role required for affiliate adjustments" }, 403);
  if (!sameOrigin(c)) return c.json({ error: "same-origin request required" }, 403);
  const affiliateId = Number(c.req.param("id"));
  if (!Number.isSafeInteger(affiliateId) || affiliateId < 1) return c.json({ error: "invalid affiliate account" }, 400);
  const body = await c.req.json<{ occurrence_id?: unknown; source_key?: unknown; amount_minor?: unknown; reason?: unknown }>()
    .catch(() => ({} as { occurrence_id?: unknown; source_key?: unknown; amount_minor?: unknown; reason?: unknown }));
  const occurrenceId = String(body.occurrence_id || "").trim();
  const sourceKey = String(body.source_key || "").trim();
  const amountMinor = Number(body.amount_minor);
  const reason = String(body.reason || "").trim().slice(0, 500);
  if (!occurrenceId || occurrenceId.length > 200) return c.json({ error: "a valid occurrence_id is required" }, 400);
  if (!sourceKey || sourceKey.length > 200) return c.json({ error: "a unique source_key is required" }, 400);
  if (!Number.isSafeInteger(amountMinor) || amountMinor === 0) return c.json({ error: "amount_minor must be a non-zero integer" }, 400);
  if (!reason) return c.json({ error: "a reason is required" }, 400);
  const occurrence = await c.env.DB.prepare(
    "SELECT affiliate_id, currency FROM affiliate_revenue_occurrences WHERE id = ?",
  ).bind(occurrenceId).first<{ affiliate_id: number; currency: string }>();
  if (!occurrence || occurrence.affiliate_id !== affiliateId) return c.json({ error: "affiliate revenue occurrence not found" }, 404);
  if (occurrence.currency !== "usd") return c.json({ error: "manual adjustments require a USD occurrence" }, 409);
  const result = await recordManualAffiliateAdjustmentInDb(c.env.DB, {
    occurrenceId, sourceKey, amountMinor, actorSubject: staff.subject,
    actorRole: "admin", reason, recordedAt: Math.floor(Date.now() / 1000),
  });
  if (!result.recorded) return c.json({ error: "source_key already recorded" }, 409);
  await audit(c, staff, {
    action: "affiliate-manual-adjustment", targetType: "affiliate_profile",
    targetId: String(affiliateId), reason, result: "recorded",
    after: { occurrence_id: occurrenceId, source_key: sourceKey, amount_minor: amountMinor, currency: "usd" },
  });
  return c.json({ recorded: true, affiliate_id: affiliateId, occurrence_id: occurrenceId, amount_minor: amountMinor });
});

app.get("/api/affiliate-payouts", async (c) => {
  const requested = String(c.req.query("status") || "all");
  if (requested !== "all" && requested !== "prepared" && requested !== "reconciliation") {
    return c.json({ error: "status must be prepared, reconciliation, or all" }, 400);
  }
  const payouts = await getAffiliatePayoutQueueInDb(c.env.DB, requested);
  return c.json({ payouts });
});

app.post("/api/affiliate-payouts/:id/reconcile", async (c) => {
  const staff = c.get("staff") as StaffIdentity;
  if (!canAdmin(staff)) return c.json({ error: "admin role required for payout reconciliation" }, 403);
  if (!sameOrigin(c)) return c.json({ error: "same-origin request required" }, 403);
  const payoutId = String(c.req.param("id") || "").trim();
  const body = await c.req.json<{
    decision?: unknown;
    evidence?: unknown;
    external_reference?: unknown;
  }>().catch(() => ({} as {
    decision?: unknown;
    evidence?: unknown;
    external_reference?: unknown;
  }));
  const decision = String(body.decision || "").trim();
  const evidence = String(body.evidence || "").trim().slice(0, 2000);
  const externalReference = String(body.external_reference || "").trim().slice(0, 255);
  if (decision !== "confirm_paid" && decision !== "cancel") {
    return c.json({ error: "decision must be confirm_paid or cancel" }, 400);
  }
  if (!evidence) return c.json({ error: "evidence is required" }, 400);
  if (decision === "confirm_paid" && !externalReference) {
    return c.json({ error: "external_reference is required when confirming payment" }, 400);
  }
  if (decision === "cancel" && externalReference) {
    return c.json({ error: "external_reference must be empty when cancelling" }, 400);
  }
  const reconciledAt = Math.floor(Date.now() / 1000);
  const result = await reconcilePayoutInDb(c.env.DB, decision === "confirm_paid" ? {
    payoutId, decision, actorSubject: staff.subject, actorRole: "admin",
    evidence, externalReference, reconciledAt,
  } : {
    payoutId, decision, actorSubject: staff.subject, actorRole: "admin",
    evidence, externalReference: null, reconciledAt,
  });
  if (!result.reconciled) return c.json({ error: "payout is not awaiting reconciliation" }, 409);
  if (c.env.EMAIL_QUEUE) {
    c.executionCtx.waitUntil(relayAffiliateEmailOutboxInDb(c.env.DB, c.env.EMAIL_QUEUE));
  }
  await audit(c, staff, {
    action: "affiliate-payout-reconcile", targetType: "affiliate_payout",
    targetId: payoutId, reason: evidence, result: decision,
    before: { status: "reconciliation" },
    after: { status: decision === "confirm_paid" ? "paid" : "cancelled", external_reference: externalReference || null },
  });
  return c.json({ reconciled: true, payout_id: payoutId, status: decision === "confirm_paid" ? "paid" : "cancelled" });
});

app.post("/api/affiliate-payouts/:id/approve", async (c) => {
  const staff = c.get("staff") as StaffIdentity;
  if (!canAdmin(staff)) return c.json({ error: "admin role required for payout approval" }, 403);
  if (!sameOrigin(c)) return c.json({ error: "same-origin request required" }, 403);
  const payoutId = String(c.req.param("id") || "").trim();
  const body = await c.req.json<{ reason?: unknown }>().catch(() => ({} as { reason?: unknown }));
  const reason = String(body.reason || "").trim().slice(0, 500);
  if (!reason) return c.json({ error: "a reason is required" }, 400);
  const approvedAt = Math.floor(Date.now() / 1000);
  const result = await approveAffiliatePayoutInDb(c.env.DB, {
    payoutId, actorSubject: staff.subject, actorRole: "admin", reason, approvedAt,
  });
  if (!result.approved) return c.json({ error: "payout is not awaiting this approval" }, 409);
  await audit(c, staff, {
    action: "affiliate-payout-approve", targetType: "affiliate_payout",
    targetId: payoutId, reason, result: "approved",
    before: { approval: null }, after: { approved_at: approvedAt },
  });
  return c.json({ approved: true, payout_id: payoutId });
});

app.post("/api/affiliate-payouts/:id/dispatch", async (c) => {
  const staff = c.get("staff") as StaffIdentity;
  if (!canAdmin(staff)) return c.json({ error: "admin role required for payout dispatch" }, 403);
  if (!sameOrigin(c)) return c.json({ error: "same-origin request required" }, 403);
  const payoutId = String(c.req.param("id") || "").trim();
  const body = await c.req.json<{ reason?: unknown }>().catch(() => ({} as { reason?: unknown }));
  const reason = String(body.reason || "").trim().slice(0, 500);
  if (!reason) return c.json({ error: "a reason is required" }, 400);
  const countryConfig = parseAffiliateStripeConnectCountries(c.env.AFFILIATE_STRIPE_CONNECT_COUNTRIES);
  if (!countryConfig.configured) {
    return c.json({ error: "payout country configuration is invalid" }, 503);
  }
  const dispatch = await loadStripePayoutDispatchInDb(c.env.DB, payoutId, countryConfig.countries);
  if (!dispatch.dispatchable) return c.json({ error: "payout is not dispatchable through Stripe" }, 409);
  const dualControl = parsePayoutDualControlThreshold(c.env.AFFILIATE_PAYOUT_DUAL_CONTROL_THRESHOLD_MINOR);
  if (!dualControl.configured) {
    return c.json({ error: "payout dual-control configuration is invalid" }, 503);
  }
  if (dispatch.amountMinor >= dualControl.thresholdMinor
      && !(await hasIndependentPayoutApprovalInDb(c.env.DB, dispatch.payoutId, staff.subject))) {
    return c.json({ error: "independent admin approval required for this payout" }, 409);
  }
  const idempotencyKey = `affiliate-payout:${dispatch.payoutId}`;
  const recordedAt = Math.floor(Date.now() / 1000);
  let transfer: Awaited<ReturnType<typeof createAffiliateTransfer>>;
  try {
    transfer = await createAffiliateTransfer(c.env, {
      payoutId: dispatch.payoutId,
      connectedAccountId: dispatch.connectedAccountId,
      amountMinor: dispatch.amountMinor,
      currency: dispatch.currency,
    });
  } catch (error) {
    const result = await recordPayoutDispatchResultInDb(c.env.DB, {
      payoutId: dispatch.payoutId,
      provider: "stripe",
      idempotencyKey,
      outcome: "ambiguous",
      externalReference: null,
      actorSubject: staff.subject,
      actorRole: "admin",
      reason,
      recordedAt,
    });
    await audit(c, staff, {
      action: "affiliate-payout-dispatch",
      targetType: "affiliate_payout",
      targetId: dispatch.payoutId,
      reason,
      result: "reconciliation",
      before: { status: "prepared", amount_minor: dispatch.amountMinor, currency: dispatch.currency },
      after: { status: result.payoutStatus, error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) },
    });
    return c.json({ accepted: true, reconciliation_required: true, payout_id: dispatch.payoutId }, 202);
  }
  const result = await recordPayoutDispatchResultInDb(c.env.DB, {
    payoutId: dispatch.payoutId,
    provider: "stripe",
    idempotencyKey,
    outcome: "paid",
    externalReference: transfer.transferId,
    actorSubject: staff.subject,
    actorRole: "admin",
    reason,
    recordedAt,
  });
  await audit(c, staff, {
    action: "affiliate-payout-dispatch",
    targetType: "affiliate_payout",
    targetId: dispatch.payoutId,
    reason,
    result: result.recorded ? "paid" : result.payoutStatus,
    before: { status: "prepared", amount_minor: dispatch.amountMinor, currency: dispatch.currency },
    after: { status: result.payoutStatus, stripe_transfer_id: transfer.transferId },
  });
  if (!result.recorded) return c.json({ error: "payout state changed before dispatch was recorded" }, 409);
  if (c.env.EMAIL_QUEUE) c.executionCtx.waitUntil(relayAffiliateEmailOutboxInDb(c.env.DB, c.env.EMAIL_QUEUE));
  return c.json({ paid: true, payout_id: dispatch.payoutId, stripe_transfer_id: transfer.transferId });
});

async function mutateAccount(c: any, action: string, id: number, reason: string) {
  const staff = c.get("staff") as StaffIdentity;
  if (!canMutate(staff)) return c.json({ error: "staff role cannot perform this action" }, 403);
  if (!sameOrigin(c)) return c.json({ error: "same-origin request required" }, 403);
  const before = await accountById(c, id);
  if (!before) return c.json({ error: "account not found" }, 404);
  if (!reason.trim()) return c.json({ error: "a reason is required" }, 400);
  const now = Math.floor(Date.now() / 1000);
  const statements: D1PreparedStatement[] = [];
  let after: Record<string, unknown> = { status: before.status, has_api_key: before.has_api_key };
  if (action === "suspend") {
    // Staff reason is user-visible to the account holder; cap at 500 to bound UI/storage.
    statements.push(c.env.DB.prepare("UPDATE accounts SET status = 'suspended', status_reason = ?, status_changed_at = ? WHERE id = ?").bind(reason.trim().slice(0, 500), now, id));
    statements.push(c.env.DB.prepare("DELETE FROM sessions WHERE account_id = ?").bind(id));
    after = { status: "suspended", status_reason: reason.trim().slice(0, 500), status_changed_at: now };
  } else if (action === "reactivate") {
    statements.push(c.env.DB.prepare("UPDATE accounts SET status = 'active', status_reason = ?, status_changed_at = ? WHERE id = ?").bind(reason.trim().slice(0, 500), now, id));
    after = { status: "active", status_reason: reason.trim().slice(0, 500), status_changed_at: now };
  } else if (action === "revoke-sessions") {
    statements.push(c.env.DB.prepare("DELETE FROM sessions WHERE account_id = ?").bind(id));
    after = { sessions_revoked: true };
  } else if (action === "revoke-api-key") {
    statements.push(c.env.DB.prepare("UPDATE accounts SET api_key_hash = NULL, api_key_created_at = NULL WHERE id = ?").bind(id));
    after = { has_api_key: false };
  } else {
    return c.json({ error: "unknown action" }, 400);
  }
  const auditStmt = c.env.DB.prepare(
    `INSERT INTO staff_audit_events
      (id, occurred_at, subject, email, role, action, target_type, target_id,
       reason, result, request_id, before_json, after_json)
     VALUES (?, ?, ?, ?, ?, ?, 'account', ?, ?, 'success', ?, ?, ?)`
  ).bind(crypto.randomUUID(), now, staff.subject, staff.email, staff.role, action, String(id), reason.trim().slice(0, 500), requestId(c), JSON.stringify({ status: before.status, has_api_key: before.has_api_key, active_sessions: before.active_sessions }), JSON.stringify(after));
  statements.push(auditStmt);
  await c.env.DB.batch(statements);
  return c.json({ ok: true, account: await accountById(c, id) });
}

app.post("/api/accounts/:id/suspend", async (c) => mutateAccount(c, "suspend", Number(c.req.param("id")), String((await c.req.json().catch(() => ({}))).reason || "")));
app.post("/api/accounts/:id/reactivate", async (c) => mutateAccount(c, "reactivate", Number(c.req.param("id")), String((await c.req.json().catch(() => ({}))).reason || "")));
app.post("/api/accounts/:id/revoke-sessions", async (c) => mutateAccount(c, "revoke-sessions", Number(c.req.param("id")), String((await c.req.json().catch(() => ({}))).reason || "")));
app.post("/api/accounts/:id/revoke-api-key", async (c) => mutateAccount(c, "revoke-api-key", Number(c.req.param("id")), String((await c.req.json().catch(() => ({}))).reason || "")));
app.post("/api/accounts/:id/force-verify", async (c) => {
  const staff = c.get("staff") as StaffIdentity; if (!canMutate(staff)) return c.json({ error: "staff role cannot perform this action" }, 403);
  if (!sameOrigin(c)) return c.json({ error: "same-origin request required" }, 403);
  const id = Number(c.req.param("id")); const input = await c.req.json().catch(()=>({})) as any; const reason = String(input.reason||"force email verification").trim().slice(0,500);
  const before: any = await accountById(c, id); if (!before) return c.json({ error: "account not found" }, 404);
  const now = Math.floor(Date.now()/1000);
  try { await c.env.DB.prepare("UPDATE accounts SET email_verified=1, email_verified_at=? WHERE id=?").bind(now, id).run(); } catch { return c.json({ error: "email verification column not available" }, 500); }
  await audit(c, staff, { action: "force-verify", targetType: "account", targetId: String(id), reason, result: "success", before: { email_verified: before.email_verified }, after: { email_verified: 1 } });
  return c.json({ ok: true, account: await accountById(c, id) });
});
app.post("/api/accounts/:id/lock", async (c) => {
  const staff = c.get("staff") as StaffIdentity; if (!canMutate(staff)) return c.json({ error: "staff role cannot perform this action" }, 403);
  if (!sameOrigin(c)) return c.json({ error: "same-origin request required" }, 403);
  const id = Number(c.req.param("id")); const body = await c.req.json().catch(()=>({})) as any; const r = String(body.reason||"").trim(); if (!r) return c.json({ error: "a reason is required" }, 400);
  const d = Math.max(1, Math.min(365, Number(body.days||30)));
  const before: any = await accountById(c, id); if (!before) return c.json({ error: "account not found" }, 404);
  const now = Math.floor(Date.now()/1000); const until = now + d*86400;
  try { await c.env.DB.prepare("UPDATE accounts SET locked_until=?, status='suspended', status_reason=?, status_changed_at=? WHERE id=?").bind(until, r.slice(0,500), now, id).run(); await c.env.DB.prepare("DELETE FROM sessions WHERE account_id=?").bind(id).run(); } catch { await c.env.DB.prepare("UPDATE accounts SET status='suspended', status_reason=?, status_changed_at=? WHERE id=?").bind(r.slice(0,500), now, id).run(); }
  await audit(c, staff, { action: "lock", targetType: "account", targetId: String(id), reason: r.slice(0,500), result: "success", before: { status: before.status }, after: { status: "suspended", locked_until: until } });
  return c.json({ ok: true, account: await accountById(c, id) });
});
app.post("/api/accounts/:id/unlock", async (c) => {
  const staff = c.get("staff") as StaffIdentity; if (!canMutate(staff)) return c.json({ error: "staff role cannot perform this action" }, 403);
  if (!sameOrigin(c)) return c.json({ error: "same-origin request required" }, 403);
  const id = Number(c.req.param("id")); const body = await c.req.json().catch(()=>({})) as any; const r = String(body.reason||"").trim(); if (!r) return c.json({ error: "a reason is required" }, 400);
  const before: any = await accountById(c, id); if (!before) return c.json({ error: "account not found" }, 404);
  const now = Math.floor(Date.now()/1000);
  try { await c.env.DB.prepare("UPDATE accounts SET locked_until=NULL, status='active', status_reason=?, status_changed_at=? WHERE id=?").bind(r.slice(0,500), now, id).run(); } catch { await c.env.DB.prepare("UPDATE accounts SET status='active', status_reason=?, status_changed_at=? WHERE id=?").bind(r.slice(0,500), now, id).run(); }
  await audit(c, staff, { action: "unlock", targetType: "account", targetId: String(id), reason: r.slice(0,500), result: "success", before: { status: before.status }, after: { status: "active" } });
  return c.json({ ok: true, account: await accountById(c, id) });
});
app.post("/api/accounts/:id/delete", async (c) => {
  const staff = c.get("staff") as StaffIdentity; if (!canAdmin(staff)) return c.json({ error: "only admin can delete accounts" }, 403);
  if (!sameOrigin(c)) return c.json({ error: "same-origin request required" }, 403);
  const id = Number(c.req.param("id")); const body = await c.req.json().catch(()=>({})) as any; const r = String(body.reason||"").trim(); if (!r) return c.json({ error: "a reason is required" }, 400);
  if (String(body.confirm) !== String(id) && String(body.confirm) !== "DELETE") return c.json({ error: "type account ID or DELETE to confirm" }, 400);
  const before: any = await accountById(c, id); if (!before) return c.json({ error: "account not found" }, 404);
  const delStmts: D1PreparedStatement[] = [];
  delStmts.push(c.env.DB.prepare("DELETE FROM sessions WHERE account_id=?").bind(id));
  delStmts.push(c.env.DB.prepare("DELETE FROM memberships WHERE account_id=?").bind(id));
  try { delStmts.push(c.env.DB.prepare("DELETE FROM account_notes WHERE account_id=?").bind(id)); } catch {}
  try { delStmts.push(c.env.DB.prepare("DELETE FROM account_activity WHERE account_id=?").bind(id)); } catch {}
  try { delStmts.push(c.env.DB.prepare("DELETE FROM staff_impersonation_tokens WHERE account_id=?").bind(id)); } catch {}
  delStmts.push(c.env.DB.prepare("DELETE FROM accounts WHERE id=?").bind(id));
  try { await c.env.DB.batch(delStmts); } catch (e) { await audit(c, staff, { action: "delete-account", targetType: "account", targetId: String(id), reason: r.slice(0,500), result: "failure", before, after: { error: String(e) } }); return c.json({ error: "delete failed" }, 500); }
  await audit(c, staff, { action: "delete-account", targetType: "account", targetId: String(id), reason: r.slice(0,500), result: "success", before });
  return c.json({ ok: true, deleted: id });
});
app.get("/api/accounts/:id/export", async (c) => {
  const id = Number(c.req.param("id")); const acct: any = await accountById(c, id); if (!acct) return c.json({ error: "account not found" }, 404);
  const staff = c.get("staff") as StaffIdentity;
  const blogs = await c.env.DB.prepare("SELECT t.public_id, t.slug, t.title, t.custom_domain, m.role FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.account_id=? ORDER BY t.created_at DESC").bind(id).all().catch(()=>({results:[]} as any)) as any;
  const sessions = await fetchSessions(c, id, 100);
  const notes = await fetchNotes(c, id);
  const activity = await fetchActivity(c, id);
  await audit(c, staff, { action: "export-user-data", targetType: "account", targetId: String(id), result: "success" });
  return c.json({ account: acct, blogs: blogs.results, sessions: (sessions as any).results, notes: (notes as any).results, activity, exported_at: Math.floor(Date.now()/1000) });
});
app.post("/api/accounts/:id/impersonate", async (c) => {
  const staff = c.get("staff") as StaffIdentity; if (!canAdmin(staff)) return c.json({ error: "only admin can impersonate" }, 403);
  if (!sameOrigin(c)) return c.json({ error: "same-origin request required" }, 403);
  const id = Number(c.req.param("id")); const body = await c.req.json().catch(()=>({})) as any; const r = String(body.reason||"").trim(); if (!r) return c.json({ error: "a reason is required" }, 400);
  const acct = await c.env.DB.prepare("SELECT id,email FROM accounts WHERE id=?").bind(id).first() as any; if (!acct) return c.json({ error: "account not found" }, 404);
  const now = Math.floor(Date.now()/1000); const token = crypto.randomUUID().replace(/-/g,"") + crypto.randomUUID().replace(/-/g,"");
  const tokenHash = await sha256hex(token);
  try { await c.env.DB.prepare("INSERT INTO staff_impersonation_tokens (token, account_id, issued_by_subject, issued_by_email, reason, created_at, expires_at) VALUES (?,?,?,?,?,?,?)").bind(tokenHash, id, staff.subject, staff.email, r.slice(0,500), now, now+600).run(); } catch { return c.json({ error: "impersonation table not available — run migration 052" }, 500); }
  await audit(c, staff, { action: "impersonate", targetType: "account", targetId: String(id), reason: r.slice(0,500), result: "success", after: { token_issued: true } });
  const url = `https://www.blognice.com/admin/impersonate?token=${encodeURIComponent(token)}`;
  return c.json({ ok: true, token, url, expires_in: 600 });
});
app.post("/api/accounts/:id/notes", async (c) => {
  const staff = c.get("staff") as StaffIdentity; if (!canMutate(staff)) return c.json({ error: "staff role cannot add notes" }, 403);
  if (!sameOrigin(c)) return c.json({ error: "same-origin request required" }, 403);
  const id = Number(c.req.param("id")); const body = await c.req.json().catch(()=>({})) as any; const n = String(body.note||"").trim(); if (!n || n.length>4000) return c.json({ error: "note must be 1..4000 characters" }, 400);
  const now = Math.floor(Date.now()/1000); const nid = crypto.randomUUID();
  try { await c.env.DB.prepare("INSERT INTO account_notes (id, account_id, author_subject, author_email, note, created_at) VALUES (?,?,?,?,?,?)").bind(nid, id, staff.subject, staff.email, n, now).run(); } catch { return c.json({ error: "notes table not available — run migration 052" }, 500); }
  await audit(c, staff, { action: "add-note", targetType: "account", targetId: String(id), result: "success", after: { note_id: nid } });
  return c.json({ ok: true, id: nid });
});
app.delete("/api/notes/:id", async (c) => {
  const staff = c.get("staff") as StaffIdentity; if (!canMutate(staff)) return c.json({ error: "staff role cannot delete notes" }, 403);
  if (!sameOrigin(c)) return c.json({ error: "same-origin request required" }, 403);
  const nid = String(c.req.param("id")); try { await c.env.DB.prepare("DELETE FROM account_notes WHERE id=?").bind(nid).run(); } catch {}
  await audit(c, staff, { action: "delete-note", targetType: "note", targetId: nid, result: "success" });
  return c.json({ ok: true });
});
app.post("/api/notes/:id/delete", async (c) => {
  const staff = c.get("staff") as StaffIdentity; if (!canMutate(staff)) return c.json({ error: "staff role cannot delete notes" }, 403);
  if (!sameOrigin(c)) return c.json({ error: "same-origin request required" }, 403);
  const nid = String(c.req.param("id")); try { await c.env.DB.prepare("DELETE FROM account_notes WHERE id=?").bind(nid).run(); } catch {}
  await audit(c, staff, { action: "delete-note", targetType: "note", targetId: nid, result: "success" });
  if (!String(c.req.header("Accept")||"").includes("application/json")) return c.redirect(c.req.header("Referer")||"/", 303);
  return c.json({ ok: true });
});
app.get("/api/accounts/:id/activity", async (c) => {
  const id = Number(c.req.param("id")); const activity = await fetchActivity(c, id); return c.json({ activity });
});
app.get("/api/accounts/:id/sessions", async (c) => {
  const id = Number(c.req.param("id")); const s = await fetchSessions(c, id, 100); return c.json({ sessions: (s as any).results });
});
app.get("/api/accounts/:id/related", async (c) => {
  const id = Number(c.req.param("id")); const rel = await relatedAccounts(c, id); return c.json({ related: rel });
});
app.post("/api/accounts/:id/rate-limit", async (c) => {
  const staff = c.get("staff") as StaffIdentity; if (!canAdmin(staff)) return c.json({ error: "only admin can change rate limits" }, 403);
  if (!sameOrigin(c)) return c.json({ error: "same-origin request required" }, 403);
  const id = Number(c.req.param("id")); const body = await c.req.json().catch(()=>({})) as any;
  const now = Math.floor(Date.now()/1000);
  try {
    await c.env.DB.prepare("INSERT INTO staff_rate_limit_overrides (account_id, max_logins_per_hour, max_api_per_minute, note, updated_by_subject, updated_by_email, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET max_logins_per_hour=excluded.max_logins_per_hour, max_api_per_minute=excluded.max_api_per_minute, note=excluded.note, updated_by_subject=excluded.updated_by_subject, updated_by_email=excluded.updated_by_email, updated_at=excluded.updated_at").bind(id, body.max_logins_per_hour ?? null, body.max_api_per_minute ?? null, String(body.note||"").slice(0,500), staff.subject, staff.email, now).run();
  } catch { return c.json({ error: "rate limit table not available — run migration 052" }, 500); }
  await audit(c, staff, { action: "rate-limit-override", targetType: "account", targetId: String(id), result: "success", after: { max_logins_per_hour: body.max_logins_per_hour, max_api_per_minute: body.max_api_per_minute } });
  return c.json({ ok: true });
});
app.delete("/api/accounts/:id/rate-limit", async (c) => {
  const staff = c.get("staff") as StaffIdentity; if (!canAdmin(staff)) return c.json({ error: "only admin can change rate limits" }, 403);
  if (!sameOrigin(c)) return c.json({ error: "same-origin request required" }, 403);
  const id = Number(c.req.param("id")); try { await c.env.DB.prepare("DELETE FROM staff_rate_limit_overrides WHERE account_id=?").bind(id).run(); } catch {}
  await audit(c, staff, { action: "rate-limit-clear", targetType: "account", targetId: String(id), result: "success" });
  return c.json({ ok: true });
});
app.post("/api/accounts/:id/rate-limit/clear", async (c) => {
  const staff = c.get("staff") as StaffIdentity; if (!canAdmin(staff)) return c.json({ error: "only admin can change rate limits" }, 403);
  if (!sameOrigin(c)) return c.json({ error: "same-origin request required" }, 403);
  const id = Number(c.req.param("id")); try { await c.env.DB.prepare("DELETE FROM staff_rate_limit_overrides WHERE account_id=?").bind(id).run(); } catch {}
  await audit(c, staff, { action: "rate-limit-clear", targetType: "account", targetId: String(id), result: "success" });
  return c.json({ ok: true });
});


app.post("/api/accounts/:id/send-password-reset", async (c) => {
  const staff = c.get("staff") as StaffIdentity;
  const id = Number(c.req.param("id"));
  if (!canMutate(staff)) return c.json({ error: "staff role cannot send password reset emails" }, 403);
  if (!sameOrigin(c)) return c.json({ error: "same-origin request required" }, 403);
  const input = await c.req.json().catch(() => ({})) as { reason?: string };
  const reason = String(input.reason || "").trim();
  if (!reason) return c.json({ error: "a reason is required" }, 400);
  const account = await c.env.DB.prepare("SELECT id, email FROM accounts WHERE id = ? AND COALESCE(status, 'active') = 'active'").bind(id).first<{ id: number; email: string }>();
  if (!account) return c.json({ error: "active account not found" }, 404);
  const now = Math.floor(Date.now() / 1000);
  const recent = await c.env.DB.prepare("SELECT 1 FROM password_resets WHERE account_id = ? AND created_at > ? AND used = 0 LIMIT 1").bind(id, now - 300).first();
  if (recent) return c.json({ error: "A reset email was already issued for this account recently." }, 429);
  const rawToken = generateResetToken();
  const tokenHash = await sha256hex(rawToken);
  await c.env.DB.prepare("DELETE FROM password_resets WHERE account_id = ? OR expires_at < ?").bind(id, now).run();
  await c.env.DB.prepare("INSERT INTO password_resets (token_hash, account_id, created_at, expires_at, used) VALUES (?, ?, ?, ?, 0)").bind(tokenHash, id, now, now + 3600).run();
  const resetUrl = `https://www.blognice.com/admin/reset?token=${encodeURIComponent(rawToken)}`;
  const result = await sendEmailDetailed(c.env, {
    to: account.email,
    subject: "Reset your blognice password",
    plainText: `We received a request to reset your blognice password.\n\nReset it here: ${resetUrl}\n\nThis link expires in one hour. If you did not request this, you can ignore this email.`,
    html: `<p>We received a request to reset your blognice password.</p><p><a href="${resetUrl}">Reset your password</a></p><p style="color:#687064;font-size:13px">This link expires in one hour. If you did not request this, you can ignore this email.</p>`,
    emailKind: "password-reset",
    senderName: "blognice",
  });
  await audit(c, staff, { action: "send-password-reset", targetType: "account", targetId: String(id), reason: reason.slice(0, 500), result: result.ok ? "success" : "failure", after: { recipient: account.email, detail: result.detail || null } });
  if (!result.ok) return c.json({ error: result.detail || "Password reset email could not be sent." }, 502);
  return c.json({ ok: true, recipient: account.email });
});

app.post("/api/test-email", async (c) => {
  const staff = c.get("staff") as StaffIdentity;
  if (!canMutate(staff)) return c.json({ error: "staff role cannot send test email" }, 403);
  if (!sameOrigin(c)) return c.json({ error: "same-origin request required" }, 403);
  const input = await c.req.json().catch(() => ({})) as { to?: string; type?: string };
  const to = String(input.to || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || to.length > 254) return c.json({ error: "Enter a valid recipient email address." }, 400);
  const type = input.type as TestEmailType;
  if (!["registration", "subscription-active", "subscriber-confirmation", "subscriber-welcome", "new-post", "password-reset"].includes(type)) return c.json({ error: "Choose a valid email type." }, 400);
  const blogTitle = "Example Blog";
  const origin = "https://example.blognice.com";
  const unsubscribe = `${origin}/unsubscribe/test-token`;
  const registration = registrationWelcomeEmail({ signInUrl: "https://www.blognice.com/admin", greeting: "Hi there," });
  const templates: Record<TestEmailType, { subject: string; plainBody: string; html: string; headers?: Record<string, string> }> = {
    registration: {
      subject: registration.subject,
      plainBody: registration.plainText,
      html: registration.html,
    },
    "subscription-active": (() => { const email = subscriptionActiveEmail({ billingUrl: "https://www.blognice.com/admin/billing", plan: "yearly" }); return { subject: email.subject, plainBody: email.plainText, html: email.html }; })(),
    "subscriber-confirmation": (() => { const email = subscriberConfirmationEmail({ blogTitle, confirmUrl: `${origin}/subscribe/confirm?token=staff-preview-token` }); return { subject: email.subject, plainBody: email.plainText, html: email.html }; })(),
    "subscriber-welcome": (() => { const email = subscriberWelcomeEmail({ blogTitle, unsubscribeUrl: unsubscribe, manageUrl: `${origin}/manage-subscriptions/test-token` }); return { subject: email.subject, plainBody: email.plainText, html: email.html, headers: email.headers }; })(),
    "new-post": (() => { const email = postNotificationEmail({ blogTitle, postTitle: "A sample new post", postUrl: `${origin}/sample-post`, imageUrl: "https://blognice.blognice.com/media/1/1786199075885-baa60ce1-ai.jpg", authorLabel: "By The blognice team", publishedLabel: "Aug 8, 2026", readingMinutes: 2, excerpt: "A sample new post, written and published on blognice.", unsubscribeUrl: unsubscribe, manageUrl: `${origin}/manage-subscriptions/test-token` }); return { subject: email.subject, plainBody: email.plainText, html: email.html, headers: email.headers }; })(),
    "password-reset": (() => { const email = passwordResetEmail({ resetUrl: "https://www.blognice.com/admin/reset?token=staff-email-preview-token" }); return { subject: email.subject, plainBody: email.plainText, html: email.html }; })(),
  };
  const template = templates[type];
  const result = await sendEmailDetailed(c.env, {
    to,
    subject: template.subject,
    plainText: template.plainBody,
    html: template.html,
    headers: template.headers,
    emailKind: type === "subscriber-confirmation" ? "subscriber-confirmation" : type === "subscriber-welcome" ? "subscription-welcome" : type === "subscription-active" ? "subscription-active" : type === "new-post" ? "post-notification" : type === "password-reset" ? "password-reset" : undefined,
    senderName: type === "subscriber-confirmation" || type === "subscriber-welcome" || type === "new-post" ? blogTitle : "blognice",
  });
  await audit(c, staff, {
    action: "send-test-email",
    targetType: "email_preview",
    targetId: "staff-dashboard",
    reason: "Staff email integration test",
    result: result.ok ? "success" : "failure",
    after: { recipient: to, type, detail: result.detail || null },
  });
  if (!result.ok) return c.json({ error: result.detail || "Test email could not be sent." }, 502);
  return c.json({ ok: true, recipient: to, type });
});

app.get("/pronunciations", async (c) => {
  const staff = c.get("staff") as StaffIdentity;
  const { results } = await c.env.DB.prepare(
    "SELECT id, term, spoken, enabled, updated_at FROM pronunciation_overrides ORDER BY term COLLATE NOCASE"
  ).all<{ id: number; term: string; spoken: string; enabled: number; updated_at: number }>();
  const rows = results.map((row) => `<tr><td><code>${esc(row.term)}</code></td><td>${esc(row.spoken)}</td><td>${row.enabled ? "Enabled" : "Disabled"}</td><td><form method="post" action="/api/pronunciations/${row.id}/delete" style="display:inline" onsubmit="return confirm('Delete this pronunciation entry?')"><button class="btn btn-danger" type="submit">Delete</button></form></td></tr>`).join("");
  const editor = canMutate(staff)
    ? `<div class="card"><h2>Add pronunciation</h2><p class="muted">Use an exact term and the way it should be spoken. Entries apply to future narration jobs; existing audio is unchanged.</p><form id="pronunciation-form"><label>Term <input name="term" required maxlength="80" placeholder="UI" style="padding:9px;border:1px solid var(--rule);border-radius:5px;margin:0 8px 0 4px"></label><label>Spoken as <input name="spoken" required maxlength="160" placeholder="U I" style="padding:9px;border:1px solid var(--rule);border-radius:5px;margin:0 8px 0 4px"></label><button class="btn" type="submit">Save pronunciation</button></form><p id="pronunciation-status" class="muted" aria-live="polite"></p></div><script>(function(){var form=document.getElementById('pronunciation-form');var status=document.getElementById('pronunciation-status');form.addEventListener('submit',async function(event){event.preventDefault();var button=form.querySelector('button');button.disabled=true;status.textContent='Saving…';var response=await fetch('/api/pronunciations',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({term:form.elements.term.value,spoken:form.elements.spoken.value})});var data=await response.json().catch(function(){return {}});if(response.ok)location.reload();else{button.disabled=false;status.textContent=data.error||'Could not save pronunciation.';}});})();</script>`
    : `<div class="notice">Your role is read-only. Support or admin staff can edit this dictionary.</div>`;
  return c.html(staffPage("Pronunciation dictionary", `${staffHeader(staff)}<h2>Pronunciation dictionary</h2><p class="muted">Global substitutions used when preparing blognice narration. For example, <code>UI</code> becomes <code>U I</code>.</p>${editor}<div class="card"><table><thead><tr><th>Term</th><th>Spoken form</th><th>Status</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="empty">No custom entries yet.</td></tr>`}</tbody></table></div>`));
});

app.get("/tts-test", async (c) => {
  const staff = c.get("staff") as StaffIdentity;
  const editor = canMutate(staff)
    ? `<div class="card"><h2>Short TTS test</h2><p class="muted">Generate a short sample without creating a post or consuming a customer’s AI allowance. Try variants such as <code>ay eye</code>, <code>eigh eye</code>, or <code>A, I</code>.</p><form id="tts-test-form"><label>Text <input name="text" required maxlength="240" value="AI is useful." style="padding:9px;border:1px solid var(--rule);border-radius:5px;min-width:360px"></label> <button class="btn" type="submit">Generate sample</button></form><p id="tts-test-status" class="muted" aria-live="polite"></p><audio id="tts-test-audio" controls hidden style="width:min(100%,520px)"></audio></div><script>(function(){var form=document.getElementById('tts-test-form');var status=document.getElementById('tts-test-status');var audio=document.getElementById('tts-test-audio');form.addEventListener('submit',async function(event){event.preventDefault();var button=form.querySelector('button');button.disabled=true;audio.hidden=true;status.textContent='Generating…';try{var response=await fetch('/api/tts-test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:form.elements.text.value})});if(!response.ok){var data=await response.json().catch(function(){return {}});throw new Error(data.error||'Could not generate sample.');}var blob=await response.blob();if(audio.dataset.url)URL.revokeObjectURL(audio.dataset.url);audio.dataset.url=URL.createObjectURL(blob);audio.src=audio.dataset.url;audio.hidden=false;status.textContent='Sample ready.';await audio.play().catch(function(){});}catch(error){status.textContent=error.message||'Could not generate sample.';}finally{button.disabled=false;}});})();</script>`
    : `<div class="notice">Your role is read-only. TTS testing requires support or admin access.</div>`;
  return c.html(staffPage("TTS test", `${staffHeader(staff)}<h2>TTS test</h2><p class="muted">Use this for quick pronunciation experiments before regenerating a full article.</p>${editor}`));
});

app.post("/api/tts-test", async (c) => {
  const staff = c.get("staff") as StaffIdentity;
  if (!canMutate(staff)) return c.json({ error: "staff role cannot run TTS tests" }, 403);
  if (!sameOrigin(c)) return c.json({ error: "same-origin request required" }, 403);
  if (!c.env.AI) return c.json({ error: "Workers AI is not configured on the staff Worker." }, 503);
  const input = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const text = String(input.text || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 240);
  if (!text) return c.json({ error: "Enter a short phrase first." }, 400);
  try {
    const generated = await ttsTestWithRetry(c.env.AI, text);
    await audit(c, staff, { action: "tts-test", targetType: "tts", targetId: TTS_MODEL, reason: "Generate short pronunciation sample", result: "success", after: { characters: text.length, attempts: generated.attempts, retries: generated.retries } });
    return new Response(generated.bytes, { headers: { "content-type": "audio/wav", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch (error) {
    const info = (error as { ttsErrorInfo?: ReturnType<typeof classifyTtsError> })?.ttsErrorInfo || classifyTtsError(error);
    const retries = (error as { ttsRetries?: unknown })?.ttsRetries;
    await audit(c, staff, { action: "tts-test", targetType: "tts", targetId: TTS_MODEL, reason: "Generate short pronunciation sample", result: "failure", after: { characters: text.length, error: info.category, code: info.code, transient: info.transient, retries: Array.isArray(retries) ? retries : [] } });
    return c.json({ error: "TTS sample generation failed." }, 502);
  }
});

app.post("/api/pronunciations", async (c) => {
  const staff = c.get("staff") as StaffIdentity;
  if (!canMutate(staff)) return c.json({ error: "staff role cannot edit pronunciations" }, 403);
  if (!sameOrigin(c)) return c.json({ error: "same-origin request required" }, 403);
  const input = await c.req.json().catch(() => ({})) as { term?: string; spoken?: string };
  const term = String(input.term || "").trim().replace(/\s+/g, " ");
  const spoken = String(input.spoken || "").trim().replace(/\s+/g, " ");
  if (!term || term.length > 80 || spoken.length < 1 || spoken.length > 160 || /[\u0000-\u001f\u007f]/.test(term + spoken)) return c.json({ error: "Enter a term and spoken form within the allowed lengths." }, 400);
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(`INSERT INTO pronunciation_overrides (term, spoken, enabled, created_at, updated_at) VALUES (?, ?, 1, ?, ?) ON CONFLICT(term) DO UPDATE SET spoken = excluded.spoken, enabled = 1, updated_at = excluded.updated_at`).bind(term, spoken, now, now).run();
  await audit(c, staff, { action: "upsert-pronunciation", targetType: "pronunciation", targetId: term, reason: "Update narration pronunciation dictionary", result: "success", after: { term, spoken } });
  return c.json({ ok: true, term, spoken });
});

async function deletePronunciation(c: any) {
  const staff = c.get("staff") as StaffIdentity;
  if (!canMutate(staff)) return c.json({ error: "staff role cannot edit pronunciations" }, 403);
  if (!sameOrigin(c)) return c.json({ error: "same-origin request required" }, 403);
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id < 1) return c.json({ error: "invalid pronunciation" }, 400);
  const row = await c.env.DB.prepare("SELECT term, spoken FROM pronunciation_overrides WHERE id = ?").bind(id).first() as { term: string; spoken: string } | null;
  if (!row) return c.json({ error: "pronunciation not found" }, 404);
  await c.env.DB.prepare("DELETE FROM pronunciation_overrides WHERE id = ?").bind(id).run();
  await audit(c, staff, { action: "delete-pronunciation", targetType: "pronunciation", targetId: String(id), reason: "Remove narration pronunciation dictionary entry", result: "success", before: row });
  if (!String(c.req.header("Accept") || "").includes("application/json")) return c.redirect("/pronunciations", 303);
  return c.json({ ok: true });
}

app.delete("/api/pronunciations/:id", deletePronunciation);
app.post("/api/pronunciations/:id/delete", deletePronunciation);

app.get("/affiliate-payouts", async (c) => {
  const staff = c.get("staff") as StaffIdentity;
  const payouts = await getAffiliatePayoutQueueInDb(c.env.DB, "all");
  const canOperate = canAdmin(staff);
  const renderAmount = (minor: number) => `$${(minor / 100).toFixed(2)}`;
  const renderAffiliate = (payout: typeof payouts[number]) =>
    `<a href="/accounts/${payout.affiliateId}">${esc(payout.affiliateEmail)}</a><br><small>${esc(payout.referralCode)}</small>`;
  const prepared = payouts.filter((payout) => payout.status === "prepared").map((payout) => {
    const destination = payout.connectedAccountId
      ? `<a href="https://dashboard.stripe.com/connect/accounts/${encodeURIComponent(payout.connectedAccountId)}" target="_blank" rel="noopener noreferrer"><code>${esc(payout.connectedAccountId)}</code> ↗</a>`
      : `<span class="badge suspended">Not connected</span>`;
    const approval = payout.latestApproverSubject
      ? `<p><span class="badge">Approved</span> by <code>${esc(payout.latestApproverSubject)}</code><br><small>${esc(payout.latestApprovalReason || "")} · ${payout.latestApprovedAt ? new Date(payout.latestApprovedAt * 1000).toISOString().replace("T", " ").slice(0, 19) : "unknown time"}${payout.approvalCount > 1 ? ` · ${payout.approvalCount} approvals` : ""}</small></p>`
      : `<p><span class="badge suspended">No approval recorded</span></p>`;
    const action = canOperate
      ? `${approval}<form class="payout-action" data-payout-action="/api/affiliate-payouts/${encodeURIComponent(payout.payoutId)}/approve"><input name="reason" required maxlength="500" aria-label="Approval reason" placeholder="Independent review evidence"><button class="btn" type="submit">Approve payout</button></form><form class="payout-action" data-payout-action="/api/affiliate-payouts/${encodeURIComponent(payout.payoutId)}/dispatch"><input name="reason" required maxlength="500" aria-label="Dispatch reason" placeholder="Reason for dispatch"><button class="btn" type="submit">Dispatch through Stripe</button></form>`
      : `<span class="muted">Admin role required</span>`;
    return `<tr><td>${renderAffiliate(payout)}</td><td>${renderAmount(payout.amountMinor)} ${esc(payout.currency.toUpperCase())}</td><td>${destination}</td><td>${new Date(payout.createdAt * 1000).toISOString().slice(0, 10)}</td><td>${action}</td></tr>`;
  }).join("");
  const reconciliation = payouts.filter((payout) => payout.status === "reconciliation").map((payout) => {
    const attempt = `${esc(payout.latestAttemptOutcome || "unknown")} · ${payout.latestAttemptAt ? new Date(payout.latestAttemptAt * 1000).toISOString().replace("T", " ").slice(0, 19) : "unknown time"}${payout.latestDispatchActorSubject ? `<br><small>Dispatched by <code>${esc(payout.latestDispatchActorSubject)}</code> · ${esc(payout.latestDispatchReason || "")}</small>` : ""}`;
    const action = canOperate ? `<form class="payout-action reconcile" data-payout-action="/api/affiliate-payouts/${encodeURIComponent(payout.payoutId)}/reconcile"><label>Evidence<textarea name="evidence" required maxlength="2000" placeholder="What Stripe shows and how it was verified"></textarea></label><label>Stripe transfer ID<input name="external_reference" maxlength="255" placeholder="tr_… (required to confirm)"></label><div><button class="btn" type="submit" name="decision" value="confirm_paid">Confirm paid</button> <button class="btn danger" type="submit" name="decision" value="cancel">Cancel payout</button></div></form>` : `<span class="muted">Admin role required</span>`;
    return `<tr><td>${renderAffiliate(payout)}</td><td>${renderAmount(payout.amountMinor)} ${esc(payout.currency.toUpperCase())}</td><td>${attempt}</td><td>${action}</td></tr>`;
  }).join("");
  const script = canOperate ? `<script>document.querySelectorAll('.payout-action').forEach(function(form){form.addEventListener('submit',async function(event){event.preventDefault();var submitter=event.submitter,decision=submitter&&submitter.name==='decision'?submitter.value:null;if(decision==='cancel'&&!confirm('Cancel this payout and release its ledger allocations?'))return;var body={reason:this.elements.reason?this.elements.reason.value:undefined,evidence:this.elements.evidence?this.elements.evidence.value:undefined,external_reference:this.elements.external_reference?this.elements.external_reference.value:undefined,decision:decision||undefined};submitter.disabled=true;try{var response=await fetch(this.dataset.payoutAction,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),data=await response.json();if(!response.ok){alert(data.error||'Payout action failed');return}location.reload()}finally{submitter.disabled=false}})})</script>` : "";
  return c.html(staffPage("Affiliate payouts", `${staffHeader(staff)}<h2>Affiliate payout operations</h2><p class="muted">Stripe Connect is the only payout rail. Review the destination and evidence before changing financial state. Payouts at or above the configured dual-control threshold must be approved and dispatched by different admins.</p><div class="card"><div class="card-head"><h2>Prepared for dispatch</h2><span class="badge">${payouts.filter((payout) => payout.status === "prepared").length}</span></div><table><thead><tr><th>Affiliate</th><th>Amount</th><th>Stripe destination</th><th>Prepared</th><th>Action</th></tr></thead><tbody>${prepared || `<tr><td colspan="5" class="empty">No payouts are ready to dispatch.</td></tr>`}</tbody></table></div><div class="card"><div class="card-head"><h2>Awaiting reconciliation</h2><span class="badge suspended">${payouts.filter((payout) => payout.status === "reconciliation").length}</span></div><table><thead><tr><th>Affiliate</th><th>Amount</th><th>Latest attempt</th><th>Decision</th></tr></thead><tbody>${reconciliation || `<tr><td colspan="4" class="empty">No payouts need reconciliation.</td></tr>`}</tbody></table></div>${script}`));
});

app.get("/dashboard", async (c) => {
  const staff = c.get("staff") as StaffIdentity;
  const now = Math.floor(Date.now() / 1000);
  const [accounts, blogs, pro, recent] = await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) AS count FROM accounts").first() as Promise<{ count: number } | null>,
    c.env.DB.prepare("SELECT COUNT(*) AS count FROM tenants").first() as Promise<{ count: number } | null>,
    c.env.DB.prepare("SELECT COUNT(*) AS count FROM accounts WHERE billing_status IN ('active', 'trialing', 'past_due') OR COALESCE(crypto_paid_through, 0) > ?").bind(now).first() as Promise<{ count: number } | null>,
    c.env.DB.prepare("SELECT occurred_at, email, action, target_type, target_id, result FROM staff_audit_events WHERE occurred_at >= ? ORDER BY occurred_at DESC LIMIT 8").bind(now - 86400).all<{ occurred_at: number; email: string; action: string; target_type: string; target_id: string; result: string }>(),
  ]);
  const activity = recent.results.map((row) => `<tr><td>${new Date(row.occurred_at * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC")}</td><td>${esc(row.email)}</td><td><strong>${esc(row.action)}</strong><br><small>${esc(row.target_type)}:${esc(row.target_id)}</small></td><td><span class="badge ${row.result === "success" ? "" : "suspended"}">${esc(row.result)}</span></td></tr>`).join("");
  const stats = `<div class="dashboard-stats"><div class="card"><small class="muted">Accounts</small><strong>${Number(accounts?.count || 0)}</strong></div><div class="card"><small class="muted">Blogs</small><strong>${Number(blogs?.count || 0)}</strong></div><div class="card"><small class="muted">Active Pro accounts</small><strong>${Number(pro?.count || 0)}</strong></div></div>`;
  return c.html(staffPage("Dashboard", `${staffHeader(staff)}<h2>Dashboard</h2><p class="muted">A quick operational view of Blognice. Counts are live from the index database.</p>${stats}<div class="card"><div class="card-head"><h2>Recent staff activity</h2><a class="btn" href="/audit">View full audit log</a></div><table><thead><tr><th>When</th><th>Staff member</th><th>Action</th><th>Result</th></tr></thead><tbody>${activity || `<tr><td colspan="4" class="empty">No staff activity in the last 24 hours.</td></tr>`}</tbody></table></div>`));
});

app.get("/audit", async (c) => {
  const staff = c.get("staff") as StaffIdentity;
  const page = boundedPage(c.req.query("page"));
  const limit = 50;
  const offset = (page - 1) * limit;
  const rows = await c.env.DB.prepare(
    `SELECT occurred_at, email, role, action, target_type, target_id, reason, result, request_id
       FROM staff_audit_events ORDER BY occurred_at DESC LIMIT ? OFFSET ?`
  ).bind(limit + 1, offset).all<{ occurred_at: number; email: string; role: string; action: string; target_type: string; target_id: string; reason: string | null; result: string; request_id: string }>();
  const hasMore = rows.results.length > limit;
  const slice = hasMore ? rows.results.slice(0, limit) : rows.results;
  const body = slice.map((row) => `<tr><td>${new Date(row.occurred_at * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC")}</td><td>${esc(row.email)}<br><small>${esc(row.role)}</small></td><td><strong>${esc(row.action)}</strong><br><small>${esc(row.target_type)}:${esc(row.target_id)}</small></td><td>${esc(row.reason || "—")}</td><td><span class="badge ${row.result === "success" ? "" : "suspended"}">${esc(row.result)}</span></td><td><code>${esc(row.request_id)}</code></td></tr>`).join("");
  const pageLinks = `<p class="pagination" style="display:flex;align-items:center;gap:10px;justify-content:flex-end"><span>Page ${page}</span>${page > 1 ? `<a class="btn" href="/audit?page=${page - 1}">← Previous</a>` : ""}${hasMore ? `<a class="btn" href="/audit?page=${page + 1}">Next →</a>` : ""}</p>`;
  return c.html(staffPage("Staff audit log", `${staffHeader(staff)}<h2>Staff audit log</h2><p class="muted">Showing ${slice.length} events — page ${page}${hasMore ? " (more available)" : ""}</p><div class="card"><table><thead><tr><th>When</th><th>Staff member</th><th>Action</th><th>Reason</th><th>Result</th><th>Request</th></tr></thead><tbody>${body || `<tr><td colspan="6" class="empty">No staff actions recorded yet.</td></tr>`}</tbody></table></div>${pageLinks}`));
});

function emailPreviewPanel(staff: StaffIdentity): string { return canMutate(staff) ? `<div class="card" id="email-preview"><h2>Email preview</h2><p class="muted">Send a production-format sample to any address you control. This tool uses the same branded delivery wrapper as live email. Preview links are non-functional.</p><form id="test-email-form"><label>To <input name="to" type="email" required placeholder="you@example.com" style="padding:8px;border:1px solid var(--rule);border-radius:5px;min-width:280px"></label> <label>Type <select name="type" style="padding:8px;border:1px solid var(--rule);border-radius:5px"><option value="registration">Registration</option><option value="subscription-active">Subscription active</option><option value="subscriber-confirmation">Confirm subscription</option><option value="subscriber-welcome">Subscriber welcome</option><option value="new-post">New-post notification</option><option value="password-reset">Password reset</option></select></label> <button class="btn" type="submit">Send test email</button></form><p id="test-email-status" class="muted" aria-live="polite"></p></div><script>document.getElementById('test-email-form').addEventListener('submit',async function(event){event.preventDefault();var form=this;var status=document.getElementById('test-email-status');if(!confirm('Send this email now?'))return;var button=form.querySelector('button');button.disabled=true;status.textContent='Sending…';var response=await fetch('/api/test-email',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({to:form.elements.to.value,type:form.elements.type.value})});var data=await response.json();button.disabled=false;status.textContent=response.ok?'Sent to '+data.recipient+'.':'Error: '+(data.error||'Test email failed.');})</script>` : `<p class="muted">Your role is read-only; email testing requires support or admin access.</p>`; }

app.post("/api/experiments/affiliate-offer/status", async (c) => {
  const staff = c.get("staff") as StaffIdentity;
  if (!canAdmin(staff)) return c.json({ error: "admin role required" }, 403);
  if (!sameOrigin(c)) return c.json({ error: "same-origin request required" }, 403);
  const body = await c.req.json().catch(() => ({})) as { status?: string; winner?: string; reason?: string };
  if (body.status !== "paused" && body.status !== "completed") return c.json({ error: "status must be paused or completed" }, 400);
  if (body.status === "completed" && body.winner !== "control" && body.winner !== "focused") return c.json({ error: "a valid winner is required" }, 400);
  const reason = String(body.reason || "").trim();
  if (reason.length < 10 || reason.length > 500) return c.json({ error: "a 10–500 character reason is required" }, 400);
  const before = await c.env.DB.prepare("SELECT status, winner_variant FROM funnel_experiments WHERE experiment_key = 'affiliate-offer-v1'").first();
  if (!before) return c.json({ error: "experiment not found" }, 404);
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare("UPDATE funnel_experiments SET status = ?, winner_variant = ?, stopped_at = ? WHERE experiment_key = 'affiliate-offer-v1' AND status = 'running'")
    .bind(body.status, body.status === "completed" ? body.winner : null, now).run();
  const after = await c.env.DB.prepare("SELECT status, winner_variant FROM funnel_experiments WHERE experiment_key = 'affiliate-offer-v1'").first();
  await audit(c, staff, { action: "affiliate-offer-experiment-status", targetType: "experiment", targetId: "affiliate-offer-v1", reason, result: "updated", before, after });
  return c.json({ updated: true, experiment: after });
});

function experimentTrendChart(rows: Array<{ date: string; variant: string; event: string; events: number }>): string {
  const wanted = rows.filter((row) => row.event === "affiliate_offer_exposure" || row.event === "affiliate_conversion");
  if (!wanted.length) return "";
  const dates = [...new Set(wanted.map((row) => row.date))].sort();
  const max = Math.max(1, ...wanted.map((row) => row.events));
  const series = [
    ["control", "affiliate_offer_exposure", "#687064", "Control exposures"],
    ["focused", "affiliate_offer_exposure", "#1a8917", "Focused exposures"],
    ["control", "affiliate_conversion", "#8259c8", "Control paid"],
    ["focused", "affiliate_conversion", "#dd6b20", "Focused paid"],
  ];
  const paths = series.map(([variant,event,color,label]) => {
    const values = new Map(wanted.filter((row) => row.variant === variant && row.event === event).map((row) => [row.date,row.events]));
    const points = dates.map((date,index) => `${40 + index * 620 / Math.max(1,dates.length-1)},${210 - 180 * Number(values.get(date)||0) / max}`).join(" ");
    return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="3"><title>${label}</title></polyline>`;
  }).join("");
  const legend = series.map(([, , color,label],i) => `<g transform="translate(${40+i*160} 238)"><line x2="18" stroke="${color}" stroke-width="3"/><text x="24" y="4">${label}</text></g>`).join("");
  return `<svg viewBox="0 0 700 255" role="img" aria-label="Approximate daily experiment exposures and paid conversions" style="width:100%;height:auto"><line x1="40" y1="30" x2="40" y2="210" stroke="#dfe4da"/><line x1="40" y1="210" x2="660" y2="210" stroke="#dfe4da"/>${paths}<g font-size="11" fill="#687064">${legend}</g></svg>`;
}

app.get("/staff/experiments/affiliate-offer", async (c) => {
  const staff = c.get("staff") as StaffIdentity;
  const report = await getFunnelExperimentReportInDb(c.env.DB, "affiliate-offer-v1", Math.floor(Date.now() / 1000));
  const trends = await experimentFunnelSeries(c.env as any, "affiliate-offer-v1", 42).catch(() => []);
  const percent = (n: number, d: number) => d ? `${(100 * n / d).toFixed(2)}%` : "—";
  const rows = (["control", "focused"] as const).map((variant) => {
    const t = report.variants[variant];
    return `<tr><th>${esc(variant)}</th><td>${t.exposures}</td><td>${t.ctaClicks} (${percent(t.ctaClicks,t.exposures)})</td><td>${t.signups} (${percent(t.signups,t.exposures)})</td><td>${t.checkoutStarts} (${percent(t.checkoutStarts,t.exposures)})</td><td>${t.conversions} (${percent(t.conversions,t.exposures)})</td><td>${t.annualConversions} / ${t.monthlyConversions}</td><td>$${(t.revenueMinor/100).toFixed(2)}</td></tr>`;
  }).join("");
  const trendRows = trends.map((row) => `<tr><td>${esc(row.date)}</td><td>${esc(row.variant)}</td><td>${esc(row.event)}</td><td>${row.events}</td></tr>`).join("");
  const trendChart = experimentTrendChart(trends);
  const interval = report.interval ? `${(report.interval.difference*100).toFixed(2)} points (95% CI ${(report.interval.lower*100).toFixed(2)} to ${(report.interval.upper*100).toFixed(2)})` : "Not available";
  const diagnosticRows = (["control", "focused"] as const).map((variant) => {
    const d = report.diagnostics[variant];
    const exposureShare = report.variants[variant].exposures ? percent(d.largestAffiliateExposures, report.variants[variant].exposures) : "—";
    return `<tr><th>${esc(variant)}</th><td>${d.paymentFailures}</td><td>${d.refundedConversions}</td><td>$${(d.refundedRevenueMinor/100).toFixed(2)}</td><td>${d.distinctAffiliates}</td><td>${d.largestAffiliateExposures} (${exposureShare})</td></tr>`;
  }).join("");
  const controls = canAdmin(staff) && report.experiment.status === "running" ? `<div class="card"><h2>Operational controls</h2><p class="notice">Pausing or completing stops new assignments. The production configuration must be changed separately and remains the release safety switch.</p><form id="experiment-status"><select name="status"><option value="paused">Pause</option><option value="completed">Complete</option></select><select name="winner"><option value="">No winner</option><option value="control">Control</option><option value="focused">Focused</option></select><input name="reason" required minlength="10" maxlength="500" placeholder="Decision evidence and reason"><button class="btn btn-danger">Apply</button></form><script>document.getElementById('experiment-status').addEventListener('submit',async function(e){e.preventDefault();if(!confirm('Apply this experiment status change?'))return;var r=await fetch('/api/experiments/affiliate-offer/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({status:this.elements.status.value,winner:this.elements.winner.value,reason:this.elements.reason.value})});var d=await r.json();if(!r.ok){alert(d.error||'Update failed');return}location.reload()})</script></div>` : "";
  const body = `${staffHeader(staff)}<div class="top"><h1>Affiliate offer experiment</h1><small>Exact operational totals · approximate trends</small></div><div class="card"><div class="card-head"><h2>${esc(report.experiment.experimentKey)}</h2><span class="badge">${esc(report.experiment.status)}</span></div><p><strong>Production switch:</strong> <code>${esc(c.env.AFFILIATE_OFFER_EXPERIMENT || "off")}</code> · <strong>Started:</strong> ${report.experiment.startedAt ? new Date(report.experiment.startedAt*1000).toISOString().slice(0,10) : "not started"} · <strong>Excluded:</strong> ${report.exclusions}</p><p class="notice"><strong>${report.decision.ready ? "Decision review ready" : "Inconclusive"}:</strong> ${esc(report.decision.reason)}</p><p><strong>Focused − control paid conversion:</strong> ${esc(interval)}</p></div><div class="card"><h2>Exact D1 funnel totals</h2><table><thead><tr><th>Variant</th><th>Exposures</th><th>CTA</th><th>Signups</th><th>Checkout</th><th>Paid</th><th>Annual / monthly</th><th>Eligible revenue</th></tr></thead><tbody>${rows}</tbody></table></div><div class="card"><h2>Decision diagnostics</h2><p class="muted">Review these exact operational measures before declaring a winner; the dashboard does not infer whether a difference is material.</p><table><thead><tr><th>Variant</th><th>Payment failures</th><th>Refunded sales</th><th>Refunded revenue</th><th>Affiliates represented</th><th>Largest affiliate share</th></tr></thead><tbody>${diagnosticRows}</tbody></table></div><div class="card"><h2>Approximate 42-day daily trends</h2><p class="muted">Analytics Engine estimates use sampling intervals. They are directional and never replace the exact totals above.</p>${trendChart}<table><thead><tr><th>Date</th><th>Variant</th><th>Event</th><th>Estimated events</th></tr></thead><tbody>${trendRows || `<tr><td colspan="4" class="empty">No trend data is available yet.</td></tr>`}</tbody></table></div>${controls}`;
  return c.html(staffPage("Affiliate offer experiment", body));
});

app.get("/email-preview", async (c) => {
  const staff = c.get("staff") as StaffIdentity;
  return c.html(staffPage("Email preview", `${staffHeader(staff)}${emailPreviewPanel(staff)}`));
});

app.get("/", async (c) => {
  const staff = c.get("staff") as StaffIdentity;
  const q = String(c.req.query("q") || "").trim().slice(0, 100);
  const page = boundedPage(c.req.query("page"));
  const limit = 50;
  const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const where = q ? "WHERE a.email LIKE ? ESCAPE '\\' OR CAST(a.id AS TEXT) LIKE ? ESCAPE '\\' OR COALESCE(a.signup_ip,'') LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM memberships sm JOIN tenants st ON st.id = sm.tenant_id WHERE sm.account_id = a.id AND (st.title LIKE ? ESCAPE '\\' OR st.slug LIKE ? ESCAPE '\\' OR st.custom_domain LIKE ? ESCAPE '\\' OR st.public_id LIKE ? ESCAPE '\\' OR COALESCE(sm.display_name,'') LIKE ? ESCAPE '\\')) OR EXISTS (SELECT 1 FROM sessions sess WHERE sess.account_id=a.id AND COALESCE(sess.ip,'') LIKE ? ESCAPE '\\')" : "";
  const accounts = await c.env.DB.prepare(
    `SELECT a.id, a.email, COALESCE(a.status, 'active') AS status, a.created_at,
            (SELECT COUNT(*) FROM memberships m WHERE m.account_id = a.id) AS blog_count
       FROM accounts a ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`
  ).bind(...(q ? [pattern, pattern, pattern, pattern, pattern, pattern, limit, (page - 1) * limit] : [limit, (page - 1) * limit])).all<{ id: number; email: string; status: string; created_at: number; blog_count: number }>();
  const rows = accounts.results.map((account) => `<tr><td><a href="/accounts/${account.id}">${esc(account.email)}</a><br><small>#${account.id}</small></td><td><span class="badge ${account.status === "suspended" ? "suspended" : ""}">${esc(account.status)}</span></td><td>${account.blog_count}</td><td>${new Date(account.created_at * 1000).toISOString().slice(0, 10)}</td></tr>`).join("");
  const pageLinks = `<p class="pagination" style="display:flex;align-items:center;gap:10px;justify-content:flex-end"><span>Page ${page}</span>${page > 1 ? `<a class="btn" href="/?q=${encodeURIComponent(q)}&page=${page - 1}">← Previous</a>` : ""}${accounts.results.length === limit ? `<a class="btn" href="/?q=${encodeURIComponent(q)}&page=${page + 1}">Next →</a>` : ""}</p>`;
  return c.html(staffPage("Accounts", `${staffHeader(staff)}<h2>Accounts</h2><p class="muted">Search by email, account ID, blog title, Blognice address, or custom domain.</p><form class="search" method="get"><input name="q" value="${esc(q)}" placeholder="Search accounts, blogs, or domains"><button class="btn" type="submit">Search</button></form><div class="card"><table><thead><tr><th>Account</th><th>Status</th><th>Blogs</th><th>Created</th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="empty">No accounts found.</td></tr>`}</tbody></table></div>${pageLinks}`));
});

app.get("/accounts/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id < 1) return c.text("Invalid account", 400);
  const account: any = await accountById(c, id);
  if (!account) return c.text("Account not found", 404);
  const blogs = await c.env.DB.prepare("SELECT t.public_id, t.slug, t.title, t.custom_domain, m.role, d.status AS domain_status FROM memberships m JOIN tenants t ON t.id = m.tenant_id LEFT JOIN domains d ON d.tenant_id = t.id AND d.hostname = t.custom_domain WHERE m.account_id = ? ORDER BY t.created_at DESC").bind(id).all<{ public_id: string; slug: string; title: string; custom_domain: string | null; role: string; domain_status: string | null }>();
  const staff = c.get("staff") as StaffIdentity;
  const sessions = await fetchSessions(c, id, 20);
  const notes = await fetchNotes(c, id);
  const activity = await fetchActivity(c, id);
  const related = await relatedAccounts(c, id);
  const affiliateSummary = await getAffiliateSupportSummaryInDb(c.env.DB, id, Math.floor(Date.now() / 1000));
  const affiliateActivity = affiliateSummary ? await getAffiliateSupportActivityInDb(c.env.DB, id) : null;
  let rateLimit: any = null; try { rateLimit = await c.env.DB.prepare("SELECT * FROM staff_rate_limit_overrides WHERE account_id=?").bind(id).first() as any; } catch {}
  const isLocked = account.locked_until && Number(account.locked_until) > Math.floor(Date.now()/1000);
  const signupInfo = `<p class="muted">Created ${new Date(account.created_at * 1000).toISOString().slice(0,10)}${account.signup_ip ? ` · IP ${esc(account.signup_ip)}` : ""}${account.signup_country ? ` · ${esc(account.signup_country)}` : ""}${account.signup_referer ? ` · ref ${esc(String(account.signup_referer).slice(0,80))}` : ""}${account.signup_ua ? `<br><small>${esc(String(account.signup_ua).slice(0,120))}</small>` : ""}</p>`;
  const verifyBadge = account.email_verified ? `<span class="badge">verified</span>` : `<span class="badge suspended">unverified</span>`;
  const actions = canMutate(staff) ? `<div class="actions"><form data-action="/api/accounts/${id}/${account.status === "suspended" ? "reactivate" : "suspend"}"><input name="reason" required placeholder="Reason"><button class="btn ${account.status === "suspended" ? "" : "btn-danger"}" type="submit">${account.status === "suspended" ? "Reactivate account" : "Suspend account"}</button></form><form data-action="/api/accounts/${id}/revoke-sessions"><input name="reason" required placeholder="Reason"><button class="btn" type="submit">Revoke sessions</button></form><form data-action="/api/accounts/${id}/revoke-api-key"><input name="reason" required placeholder="Reason"><button class="btn" type="submit">Revoke API key</button></form><form data-action="/api/accounts/${id}/send-password-reset"><input name="reason" required placeholder="Reason"><button class="btn" type="submit">Send password reset email</button></form><form data-action="/api/accounts/${id}/force-verify"><input name="reason" required placeholder="Reason"><button class="btn" type="submit">Force email verification</button></form><form data-action="/api/accounts/${id}/${isLocked ? "unlock" : "lock"}"><input name="reason" required placeholder="Reason"><input name="days" type="number" min="1" max="365" value="30" style="width:70px" ${isLocked ? "hidden" : ""}><button class="btn ${isLocked ? "" : "btn-danger"}" type="submit">${isLocked ? "Unlock account" : "Lock account"}</button></form>${canAdmin(staff) ? `<form data-action="/api/accounts/${id}/impersonate"><input name="reason" required placeholder="Reason for impersonation"><button class="btn" type="submit">Impersonate / Log in as user</button></form><form data-action="/api/accounts/${id}/delete"><input name="reason" required placeholder="Reason"><input name="confirm" required placeholder="Type ${id} to confirm" style="width:130px"><button class="btn btn-danger" type="submit">Delete account</button></form>` : ""}<a class="btn" href="/api/accounts/${id}/export" target="_blank">Export user data (index DB)</a></div><script>document.querySelectorAll('form[data-action]').forEach(function(form){form.addEventListener('submit',async function(event){event.preventDefault();if(!confirm('Confirm this support action?'))return;var r=form.elements.reason?form.elements.reason.value:"";var extra={};if(form.elements.days) extra.days=form.elements.days.value; if(form.elements.confirm) extra.confirm=form.elements.confirm.value; var body=JSON.stringify(Object.assign({reason:r},extra));var response=await fetch(form.dataset.action,{method:'POST',headers:{'content-type':'application/json'},body:body});var data=await response.json();if(!response.ok){alert(data.error||'Action failed');return}if(data.url){prompt('Impersonation link (10 min):',data.url)} else if(data.recipient){alert('Reset email sent to '+data.recipient+'.');} else if(data.deleted){alert('Account deleted');location.href='/'} else {alert('Action complete.')}location.reload()})})</script>` : `<p class="muted">Your role is read-only.</p>`;
  const blogRows = blogs.results.map((blog) => { const host = blog.custom_domain || `${blog.slug}.${c.env.ROOT_DOMAIN || "blognice.com"}`; const domain = blog.custom_domain ? `${esc(blog.custom_domain)} <small>(${esc(blog.domain_status || "pending")})</small>` : "None"; return `<tr><td>${esc(blog.title)}</td><td><a href="https://${esc(host)}" target="_blank" rel="noopener noreferrer">${esc(host)}</a></td><td>${esc(blog.role)}</td><td>${domain}</td></tr>`; }).join("");
  const plan = billingPlan(account, c);
  const billingStatus = String(account.billing_status || "inactive");
  const stripeLink = account.stripe_customer_id ? ` <a href="https://dashboard.stripe.com/customers/${encodeURIComponent(account.stripe_customer_id)}" target="_blank" rel="noopener noreferrer">Open in Stripe ↗</a>` : "";
  const billingCard = `<div class="card"><h2>Billing</h2><p><strong>Plan:</strong> ${esc(plan)}<br><strong>Payment status:</strong> ${esc(billingStatus)}${account.billing_cancel_at_period_end ? " (cancels at period end)" : ""}${account.billing_period_end ? `<br><strong>Period end:</strong> ${new Date(Number(account.billing_period_end) * 1000).toISOString().slice(0, 10)}` : ""}${stripeLink}</p><p class="muted">Billing actions remain in Stripe; this panel is read-only.</p></div>`;
  const sessionRows = (sessions as any).results.map((s:any)=>`<tr><td><code>${esc(String(s.created_via||"session"))}</code></td><td>${esc(s.ip||"—")}</td><td>${esc((s.user_agent||"").slice(0,60) || "—")}</td><td>${new Date(s.created_at*1000).toISOString().slice(0,10)}</td><td>${new Date(s.expires_at*1000).toISOString().slice(0,10)}</td></tr>`).join("");
  const activityRows = activity.map((a:any)=>`<tr><td>${new Date(a.at*1000).toISOString().replace("T"," ").slice(0,19)}</td><td>${esc(a.kind)}</td><td>${esc(a.detail)}</td></tr>`).join("");
  const noteRows = (notes as any).results.map((n:any)=>`<tr><td>${new Date(n.created_at*1000).toISOString().slice(0,10)}</td><td>${esc(n.author_email)}</td><td>${esc(n.note)}</td><td><form method="post" action="/api/notes/${esc(n.id)}/delete" onsubmit="return confirm('Delete note?')"><button class="btn" type="submit">Delete</button></form></td></tr>`).join("");
  const relatedRows = related.map((r:any)=>`<tr><td><a href="/accounts/${r.id}">#${r.id} ${esc(r.email)}</a></td><td>${esc(r.reason)}</td></tr>`).join("");
  const affiliateCard = affiliateSummary && affiliateActivity ? (() => {
    const money = (minor: number, currency: string = affiliateSummary.currency) => `${minor < 0 ? "−" : ""}$${(Math.abs(minor) / 100).toFixed(2)} ${esc(currency.toUpperCase())}`;
    const connectAccount = affiliateSummary.stripeConnectedAccountId
      ? `<a href="https://dashboard.stripe.com/connect/accounts/${encodeURIComponent(affiliateSummary.stripeConnectedAccountId)}" target="_blank" rel="noopener noreferrer"><code>${esc(affiliateSummary.stripeConnectedAccountId)}</code> ↗</a>`
      : "Not connected";
    const attributionRows = affiliateActivity.attributions.map((row) => `<tr><td><a href="/accounts/${row.referredAccountId}">${esc(row.referredEmail)}</a><br><small>#${row.referredAccountId}</small></td><td>${esc(row.source)}</td><td>${new Date(row.capturedAt * 1000).toISOString().replace("T", " ").slice(0, 19)}</td><td><code>${esc(row.policyVersion)}</code></td></tr>`).join("");
    const ledgerRows = affiliateActivity.ledgerEntries.map((row) => `<tr><td>${new Date(row.createdAt * 1000).toISOString().slice(0, 10)}</td><td>${esc(row.entryKind)}</td><td>${esc(row.provider)}</td><td>${money(row.amountMinor, row.currency)}</td><td>${new Date(row.availableAt * 1000).toISOString().slice(0, 10)}</td><td><code>${esc(row.occurrenceId)}</code></td></tr>`).join("");
    const uncommissionedRows = affiliateActivity.uncommissionedOccurrences.map((row) => `<tr><td>${new Date(row.paidAt * 1000).toISOString().slice(0, 10)}</td><td>${esc(row.provider)}</td><td>${row.reason === "related_account" ? "Confirmed related account" : "Non-USD; FX policy unavailable"}</td><td>${(row.eligibleRevenueMinor / 100).toFixed(2)} ${esc(row.currency.toUpperCase())}</td><td>${(row.refundedEligibleRevenueMinor / 100).toFixed(2)} ${esc(row.currency.toUpperCase())}</td><td><a href="/accounts/${row.referredAccountId}">#${row.referredAccountId}</a></td><td><code>${esc(row.providerPaymentId || row.providerInvoiceId || row.id)}</code></td><td><code>${esc(row.policyVersion)}</code></td></tr>`).join("");
    const reserveRows = affiliateActivity.reserves.map((row) => `<tr><td>${esc(row.status)}</td><td>${esc(row.provider)}</td><td>${money(row.amountMinor, row.currency)}</td><td><code>${esc(row.disputeId)}</code></td><td>${new Date(row.openedAt * 1000).toISOString().slice(0, 10)}</td></tr>`).join("");
    const payoutRows = affiliateActivity.payouts.map((row) => `<tr><td>${new Date(row.createdAt * 1000).toISOString().slice(0, 10)}</td><td>${esc(row.status)}</td><td>${money(row.amountMinor, row.currency)}</td><td>${row.externalReference ? `<code>${esc(row.externalReference)}</code>` : "—"}</td></tr>`).join("");
    const statusToggle = canAdmin(staff) && (affiliateSummary.status === "active" || affiliateSummary.status === "suspended")
      ? `<form id="affiliate-status-form" data-action="/api/accounts/${id}/affiliate-status"><input type="hidden" name="status" value="${affiliateSummary.status === "active" ? "suspended" : "active"}"><input name="reason" required maxlength="500" placeholder="Reason"><button class="btn ${affiliateSummary.status === "active" ? "btn-danger" : ""}" type="submit">${affiliateSummary.status === "active" ? "Suspend affiliate" : "Reactivate affiliate"}</button></form><script>document.getElementById('affiliate-status-form').addEventListener('submit',async function(event){event.preventDefault();if(!confirm('Confirm this affiliate status change?'))return;var response=await fetch(this.dataset.action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({status:this.elements.status.value,reason:this.elements.reason.value})}),data=await response.json();if(!response.ok){alert(data.error||'Status change failed');return}location.reload()})</script>`
      : "";
    const relationshipControl = canAdmin(staff)
      ? `<h3>Confirm related account</h3><p class="muted">Use only after a documented identity or control review. IP and device matches alone are not proof.</p><form id="affiliate-relationship-form" data-action="/api/accounts/${id}/affiliate-related-account"><input name="related_account_id" type="number" min="1" required placeholder="Related account ID"><select name="relationship_kind"><option value="same_person">Same person</option><option value="same_organization">Same organization</option><option value="controlled_account">Controlled account</option></select><input name="reason" required maxlength="500" placeholder="Review evidence and reason"><button class="btn btn-danger" type="submit">Record relationship</button></form><script>document.getElementById('affiliate-relationship-form').addEventListener('submit',async function(event){event.preventDefault();if(!confirm('Confirm this account relationship? Future attribution from this account to the Affiliate will be blocked.'))return;var response=await fetch(this.dataset.action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({related_account_id:Number(this.elements.related_account_id.value),relationship_kind:this.elements.relationship_kind.value,reason:this.elements.reason.value})}),data=await response.json();if(!response.ok){alert(data.error||'Relationship could not be recorded');return}location.reload()})</script>`
      : "";
    const adjustmentControl = canAdmin(staff)
      ? `<h3>Record commission correction</h3><p class="muted">Append a signed USD correction to an existing revenue occurrence. Use a stable source key so retries cannot duplicate it.</p><form id="affiliate-adjustment-form" data-action="/api/accounts/${id}/affiliate-adjustment"><input name="occurrence_id" required maxlength="200" placeholder="Revenue occurrence ID"><input name="source_key" required maxlength="200" placeholder="Case or correction source key"><input name="amount_minor" type="number" step="1" required placeholder="Signed cents"><input name="reason" required maxlength="500" placeholder="Correction evidence and reason"><button class="btn btn-danger" type="submit">Record correction</button></form><script>document.getElementById('affiliate-adjustment-form').addEventListener('submit',async function(event){event.preventDefault();if(!confirm('Append this immutable commission correction?'))return;var response=await fetch(this.dataset.action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({occurrence_id:this.elements.occurrence_id.value,source_key:this.elements.source_key.value,amount_minor:Number(this.elements.amount_minor.value),reason:this.elements.reason.value})}),data=await response.json();if(!response.ok){alert(data.error||'Correction could not be recorded');return}location.reload()})</script>`
      : "";
    const statusControl = statusToggle + relationshipControl + adjustmentControl;
    return `<div class="card"><div class="card-head"><h2>Affiliate program</h2><span class="badge ${affiliateSummary.status === "active" ? "" : "suspended"}">${esc(affiliateSummary.status)}</span></div><p><strong>Referral code:</strong> <code>${esc(affiliateSummary.referralCode)}</code> · <strong>Attributions:</strong> ${affiliateSummary.attributionCount}<br><strong>Terms:</strong> ${esc(affiliateSummary.termsVersion)} accepted ${new Date(affiliateSummary.termsAcceptedAt * 1000).toISOString().slice(0, 10)} · <strong>Policy:</strong> ${esc(affiliateSummary.policyVersion)}<br><strong>Stripe Connect:</strong> ${esc(affiliateSummary.stripeConnectStatus)}${affiliateSummary.stripeConnectPayoutsEnabled ? " · payouts enabled" : " · payouts disabled"}${affiliateSummary.stripeConnectCountry ? ` · ${esc(affiliateSummary.stripeConnectCountry)}` : ""} · ${connectAccount}</p>${statusControl}<div class="dashboard-stats"><div><small class="muted">Ledger balance</small><br><strong>${money(affiliateSummary.ledgerBalanceMinor)}</strong></div><div><small class="muted">Matured balance</small><br><strong>${money(affiliateSummary.maturedBalanceMinor)}</strong></div><div><small class="muted">Open reserve</small><br><strong>${money(affiliateSummary.openReserveMinor)}</strong></div><div><small class="muted">Paid payouts</small><br><strong>${money(affiliateSummary.paidPayoutMinor)}</strong></div></div><h3>Referral attributions</h3><table><thead><tr><th>Referred account</th><th>Source</th><th>Captured</th><th>Policy</th></tr></thead><tbody>${attributionRows || `<tr><td colspan="4" class="empty">No attributions.</td></tr>`}</tbody></table><h3>Uncommissioned revenue reconciliation</h3><p class="muted">Provider facts excluded by currency policy or a confirmed account relationship remain visible for reconciliation.</p><table><thead><tr><th>Paid</th><th>Provider</th><th>Reason</th><th>Revenue</th><th>Refunded</th><th>Account</th><th>Provider reference</th><th>Policy</th></tr></thead><tbody>${uncommissionedRows || `<tr><td colspan="8" class="empty">No uncommissioned revenue.</td></tr>`}</tbody></table><h3>Commission ledger</h3><table><thead><tr><th>Created</th><th>Kind</th><th>Provider</th><th>Amount</th><th>Available</th><th>Occurrence</th></tr></thead><tbody>${ledgerRows || `<tr><td colspan="6" class="empty">No ledger entries.</td></tr>`}</tbody></table><h3>Reserves</h3><table><thead><tr><th>Status</th><th>Provider</th><th>Amount</th><th>Dispute</th><th>Opened</th></tr></thead><tbody>${reserveRows || `<tr><td colspan="5" class="empty">No reserves.</td></tr>`}</tbody></table><h3>Payout history</h3><table><thead><tr><th>Created</th><th>Status</th><th>Amount</th><th>External reference</th></tr></thead><tbody>${payoutRows || `<tr><td colspan="4" class="empty">No payouts.</td></tr>`}</tbody></table></div>`;
  })() : `<div class="card"><h2>Affiliate program</h2><p class="muted">This account has not enabled the Affiliate Program.</p></div>`;
  const notesCard = `<div class="card"><h2>Account notes</h2><p class="muted">Internal admin-only notes. Not visible to the user.</p><form data-action="/api/accounts/${id}/notes" style="display:flex;gap:8px;margin:10px 0"><input name="note" required placeholder="Add internal note" style="flex:1;padding:8px;border:1px solid var(--rule);border-radius:5px"><button class="btn" type="submit">Add note</button></form><table><thead><tr><th>Date</th><th>Author</th><th>Note</th><th></th></tr></thead><tbody>${noteRows || `<tr><td colspan="4" class="empty">No notes.</td></tr>`}</tbody></table><script>document.querySelector('form[data-action="/api/accounts/${id}/notes"]').addEventListener('submit',async function(e){e.preventDefault();var note=this.elements.note.value;var r=await fetch(this.dataset.action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({note:note})});var d=await r.json();if(!r.ok){alert(d.error||'Failed');return}location.reload()})</script></div>`;
  const rateCard = `<div class="card"><h2>Rate-limit / restriction controls</h2><p class="muted">Override signup/login limits (admin only). Empty = global default. Wired to signup checks.</p>${rateLimit ? `<p>Current: logins/hr ${rateLimit.max_logins_per_hour ?? "—"} · api/min ${rateLimit.max_api_per_minute ?? "—"}<br><small>${esc(rateLimit.note||"")}</small></p>` : `<p class="muted">No overrides set.</p>`}${canAdmin(staff) ? `<form data-action="/api/accounts/${id}/rate-limit" style="display:flex;gap:8px;flex-wrap:wrap"><input name="max_logins_per_hour" type="number" placeholder="logins/hr" style="width:120px;padding:8px;border:1px solid var(--rule);border-radius:5px"><input name="max_api_per_minute" type="number" placeholder="api/min" style="width:120px;padding:8px;border:1px solid var(--rule);border-radius:5px"><input name="note" placeholder="Reason" style="flex:1;min-width:160px;padding:8px;border:1px solid var(--rule);border-radius:5px"><button class="btn" type="submit">Save</button><button class="btn" type="button" onclick="fetch('/api/accounts/${id}/rate-limit/clear',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(()=>location.reload())">Clear</button></form><script>document.querySelector('form[data-action="/api/accounts/${id}/rate-limit"]').addEventListener('submit',async function(e){e.preventDefault();var b={max_logins_per_hour:this.elements.max_logins_per_hour.value?Number(this.elements.max_logins_per_hour.value):null,max_api_per_minute:this.elements.max_api_per_minute.value?Number(this.elements.max_api_per_minute.value):null,note:this.elements.note.value};var r=await fetch(this.dataset.action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});var d=await r.json();if(!r.ok){alert(d.error);return}location.reload()})</script>` : `<p class="muted">Read-only role.</p>`}</div>`;
  return c.html(staffPage(`Account ${id}`, `${staffHeader(staff)}<p><a href="/">← All accounts</a></p><div class="card"><div class="card-head"><div><h2>${esc(account.email)} ${verifyBadge}</h2><p class="muted">Account #${id} · created ${new Date(account.created_at * 1000).toISOString().slice(0, 10)} ${isLocked ? `<span class="badge suspended">locked until ${new Date(Number(account.locked_until)*1000).toISOString().slice(0,10)}</span>` : ""}</p>${signupInfo}</div><span class="badge ${account.status === "suspended" ? "suspended" : ""}">${esc(account.status)}</span></div><p>Blogs: ${account.blog_count} · Active sessions: ${account.active_sessions} · API key: ${account.has_api_key ? "present" : "not present"}</p>${account.status_reason ? `<p class="notice">Status reason: ${esc(account.status_reason)}</p>` : ""}${actions}</div>${billingCard}${affiliateCard}<div class="card"><h2>Blogs</h2><table><thead><tr><th>Title</th><th>View live blog</th><th>Role</th><th>Custom domain</th></tr></thead><tbody>${blogRows || `<tr><td colspan="4" class="empty">No blogs.</td></tr>`}</tbody></table></div><div class="card"><h2>IP / device / session history</h2><p class="muted">Search also covers IP: try an address in the accounts search.</p><table><thead><tr><th>Token</th><th>IP</th><th>Device</th><th>Created</th><th>Expires</th></tr></thead><tbody>${sessionRows || `<tr><td colspan="5" class="empty">No sessions.</td></tr>`}</tbody></table></div><div class="card"><h2>User activity / history</h2><p class="muted">Logins, posts, comments, domain changes, API usage, billing events.</p><table><thead><tr><th>When</th><th>Kind</th><th>Detail</th></tr></thead><tbody>${activityRows || `<tr><td colspan="3" class="empty">No activity yet.</td></tr>`}</tbody></table></div>${notesCard}<div class="card"><h2>Related accounts</h2><p class="muted">Accounts sharing signup/session IPs (payment/domain signals coming soon).</p><table><thead><tr><th>Account</th><th>Reason</th></tr></thead><tbody>${relatedRows || `<tr><td colspan="2" class="empty">No related accounts found.</td></tr>`}</tbody></table></div>${rateCard}`));
});


export default app;
