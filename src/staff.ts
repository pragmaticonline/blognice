import { Hono } from "hono";
import { esc } from "./render";
import { sendEmailDetailed, registrationWelcomeEmail, subscriptionActiveEmail, subscriberConfirmationEmail, passwordResetEmail, subscriberWelcomeEmail, postNotificationEmail } from "./email";
import { generateResetToken, sha256hex } from "./auth";
import { classifyTtsError, ttsBytes, TTS_MODEL, TTS_RETRY_DELAYS } from "./tts";

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
  return c.env.DB.prepare(
    `SELECT a.id, a.email, COALESCE(a.status, 'active') AS status,
            a.status_reason, a.status_changed_at, a.created_at,
            a.stripe_customer_id, a.billing_status, a.billing_price_id,
            a.billing_period_end, a.billing_cancel_at_period_end,
            a.api_key_hash IS NOT NULL AS has_api_key,
            (SELECT COUNT(*) FROM sessions s WHERE s.account_id = a.id AND s.expires_at > ?) AS active_sessions,
            (SELECT COUNT(*) FROM memberships m WHERE m.account_id = a.id) AS blog_count
       FROM accounts a WHERE a.id = ?`
  ).bind(Math.floor(Date.now() / 1000), id).first();
}

function staffHeader(staff: StaffIdentity): string {
  return `<header class="staff-top"><a class="staff-brand" href="/">blognice <span>staff</span></a><div class="staff-top-meta"><small>${esc(staff.email)} · ${esc(staff.role)}</small><a class="logout" href="/cdn-cgi/access/logout">Log out</a><button class="staff-menu-toggle" type="button" aria-controls="staff-sidebar" aria-expanded="false">Menu</button></div></header><div class="staff-shell"><aside class="staff-sidebar" id="staff-sidebar"><nav class="staff-nav" aria-label="Staff navigation"><a href="/dashboard" data-staff-nav>Dashboard</a><a href="/" data-staff-nav>Accounts</a><a href="/audit" data-staff-nav>Audit log</a><a href="/pronunciations" data-staff-nav>Pronunciation dictionary</a><a href="/tts-test" data-staff-nav>TTS test</a><a href="/email-preview" data-staff-nav>Email preview</a></nav></aside><div class="staff-content">`;
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
  const where = q ? "WHERE a.email LIKE ? ESCAPE '\\' OR CAST(a.id AS TEXT) LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM memberships sm JOIN tenants st ON st.id = sm.tenant_id WHERE sm.account_id = a.id AND (st.title LIKE ? ESCAPE '\\' OR st.slug LIKE ? ESCAPE '\\' OR st.custom_domain LIKE ? ESCAPE '\\' OR st.public_id LIKE ? ESCAPE '\\'))" : "";
  const params = q ? [pattern, pattern, pattern, pattern, pattern, pattern] : [];
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
  const where = q ? "WHERE a.email LIKE ? ESCAPE '\\' OR CAST(a.id AS TEXT) LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM memberships sm JOIN tenants st ON st.id = sm.tenant_id WHERE sm.account_id = a.id AND (st.title LIKE ? ESCAPE '\\' OR st.slug LIKE ? ESCAPE '\\' OR st.custom_domain LIKE ? ESCAPE '\\' OR st.public_id LIKE ? ESCAPE '\\'))" : "";
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
  const actions = canMutate(staff) ? `<div class="actions"><form data-action="/api/accounts/${id}/${account.status === "suspended" ? "reactivate" : "suspend"}"><input name="reason" required placeholder="Reason"><button class="btn ${account.status === "suspended" ? "" : "btn-danger"}" type="submit">${account.status === "suspended" ? "Reactivate account" : "Suspend account"}</button></form><form data-action="/api/accounts/${id}/revoke-sessions"><input name="reason" required placeholder="Reason"><button class="btn" type="submit">Revoke sessions</button></form><form data-action="/api/accounts/${id}/revoke-api-key"><input name="reason" required placeholder="Reason"><button class="btn" type="submit">Revoke API key</button></form><form data-action="/api/accounts/${id}/send-password-reset"><input name="reason" required placeholder="Reason"><button class="btn" type="submit">Send password reset email</button></form></div><script>document.querySelectorAll('form[data-action]').forEach(function(form){form.addEventListener('submit',async function(event){event.preventDefault();if(!confirm('Confirm this support action?'))return;var reason=form.elements.reason.value;var response=await fetch(form.dataset.action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reason:reason})});var data=await response.json();if(!response.ok){alert(data.error||'Action failed');return}alert(data.recipient?'Reset email sent to '+data.recipient+'.':'Action complete.');location.reload()})})</script>` : `<p class="muted">Your role is read-only.</p>`;
  const blogRows = blogs.results.map((blog) => { const host = blog.custom_domain || `${blog.slug}.${c.env.ROOT_DOMAIN || "blognice.com"}`; const domain = blog.custom_domain ? `${esc(blog.custom_domain)} <small>(${esc(blog.domain_status || "pending")})</small>` : "None"; return `<tr><td>${esc(blog.title)}</td><td><a href="https://${esc(host)}" target="_blank" rel="noopener noreferrer">${esc(host)}</a></td><td>${esc(blog.role)}</td><td>${domain}</td></tr>`; }).join("");
  const plan = billingPlan(account, c);
  const billingStatus = String(account.billing_status || "inactive");
  const stripeLink = account.stripe_customer_id ? ` <a href="https://dashboard.stripe.com/customers/${encodeURIComponent(account.stripe_customer_id)}" target="_blank" rel="noopener noreferrer">Open in Stripe ↗</a>` : "";
  const billingCard = `<div class="card"><h2>Billing</h2><p><strong>Plan:</strong> ${esc(plan)}<br><strong>Payment status:</strong> ${esc(billingStatus)}${account.billing_cancel_at_period_end ? " (cancels at period end)" : ""}${account.billing_period_end ? `<br><strong>Period end:</strong> ${new Date(Number(account.billing_period_end) * 1000).toISOString().slice(0, 10)}` : ""}${stripeLink}</p><p class="muted">Billing actions remain in Stripe; this panel is read-only.</p></div>`;
  return c.html(staffPage(`Account ${id}`, `${staffHeader(staff)}<p><a href="/">← All accounts</a></p><div class="card"><div class="card-head"><div><h2>${esc(account.email)}</h2><p class="muted">Account #${id} · created ${new Date(account.created_at * 1000).toISOString().slice(0, 10)}</p></div><span class="badge ${account.status === "suspended" ? "suspended" : ""}">${esc(account.status)}</span></div><p>Blogs: ${account.blog_count} · Active sessions: ${account.active_sessions} · API key: ${account.has_api_key ? "present" : "not present"}</p>${account.status_reason ? `<p class="notice">Status reason: ${esc(account.status_reason)}</p>` : ""}${actions}</div>${billingCard}<div class="card"><h2>Blogs</h2><table><thead><tr><th>Title</th><th>View live blog</th><th>Role</th><th>Custom domain</th></tr></thead><tbody>${blogRows || `<tr><td colspan="4" class="empty">No blogs.</td></tr>`}</tbody></table></div>`));
});

export default app;
