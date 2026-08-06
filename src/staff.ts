import { Hono } from "hono";
import { esc } from "./render";
import { sendMailNice } from "./mailnice";
import { generateResetToken, sha256hex } from "./auth";
import { ttsBytes, TTS_MODEL } from "./tts";

type StaffRole = "read_only" | "support" | "admin";
type StaffIdentity = { subject: string; email: string; role: StaffRole };

type StaffBindings = {
  DB: D1Database;
  AI?: Ai;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  STAFF_ALLOWED_EMAILS?: string;
  MAILNICE_API_KEY?: string;
  EMAIL_FROM?: string;
};

type TestEmailType = "registration" | "subscriber-welcome" | "new-post" | "password-reset";

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

function sameOrigin(c: any): boolean {
  const origin = c.req.header("Origin");
  return !!origin && origin === new URL(c.req.url).origin;
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
            a.api_key_hash IS NOT NULL AS has_api_key,
            (SELECT COUNT(*) FROM sessions s WHERE s.account_id = a.id AND s.expires_at > ?) AS active_sessions,
            (SELECT COUNT(*) FROM memberships m WHERE m.account_id = a.id) AS blog_count
       FROM accounts a WHERE a.id = ?`
  ).bind(Math.floor(Date.now() / 1000), id).first();
}

function staffPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · BlogNice Staff</title><style>
  :root{color-scheme:light;--ink:#171914;--muted:#687064;--rule:#dfe4da;--paper:#f7f8f3;--accent:#1a8917}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}.wrap{max-width:1120px;margin:auto;padding:28px}.top{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid var(--rule);padding-bottom:18px;margin-bottom:24px}.top h1{font-size:1.25rem;margin:0}.top small{color:var(--muted)}nav{display:flex;gap:16px;margin-bottom:24px;font-size:.92rem}nav a{color:var(--muted)}nav a:hover{color:var(--ink)}h2{font-size:1.6rem;margin:0 0 8px}.muted{color:var(--muted)}.search{display:flex;gap:8px;margin:20px 0}.search input{flex:1;padding:10px 12px;border:1px solid var(--rule);border-radius:6px;font:inherit;background:#fff}.btn{border:1px solid var(--rule);background:#fff;border-radius:6px;padding:9px 13px;font:inherit;cursor:pointer}.btn:hover,.btn:focus-visible{border-color:var(--accent)}.btn-danger{color:#8d241b}.card{background:#fff;border:1px solid var(--rule);border-radius:9px;margin:14px 0;padding:18px}.card-head{display:flex;justify-content:space-between;gap:16px;align-items:center}.badge{display:inline-block;border-radius:999px;padding:3px 9px;font-size:.78rem;background:#eaf4e8;color:#20611e}.badge.suspended{background:#fae7e4;color:#8d241b}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--rule);vertical-align:top}th{font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.actions form{display:inline-flex;gap:6px}.actions input{min-width:190px;padding:8px;border:1px solid var(--rule);border-radius:5px}.notice{padding:12px;border-radius:6px;background:#fff4d6;margin:12px 0}.empty{padding:28px;text-align:center;color:var(--muted)}
  </style></head><body><main class="wrap">${body}</main></body></html>`;
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
  const page = Math.max(1, Number(c.req.query("page") || 1) || 1);
  const limit = 50;
  const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const where = q ? "WHERE a.email LIKE ? ESCAPE '\\'" : "";
  const params = q ? [pattern] : [];
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.email, COALESCE(a.status, 'active') AS status, a.created_at,
            (SELECT COUNT(*) FROM memberships m WHERE m.account_id = a.id) AS blog_count
       FROM accounts a ${where} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`
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
  const resetUrl = `https://blognice.com/admin/reset?token=${encodeURIComponent(rawToken)}`;
  const result = await sendMailNice(c.env, {
    to: account.email,
    subject: "Reset your Blog Nice password",
    plainBody: `We received a request to reset your Blog Nice password.\n\nReset it here: ${resetUrl}\n\nThis link expires in one hour. If you did not request this, you can ignore this email.`,
    html: `<p>We received a request to reset your Blog Nice password.</p><p><a href="${resetUrl}">Reset your password</a></p><p style="color:#687064;font-size:13px">This link expires in one hour. If you did not request this, you can ignore this email.</p>`,
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
  if (!["registration", "subscriber-welcome", "new-post", "password-reset"].includes(type)) return c.json({ error: "Choose a valid email type." }, 400);
  const blogTitle = "Example Blog";
  const origin = "https://example.blognice.com";
  const unsubscribe = `${origin}/unsubscribe/test-token`;
  const templates: Record<TestEmailType, { subject: string; plainBody: string; html: string; headers?: Record<string, string> }> = {
    registration: {
      subject: "Welcome to Blog Nice",
      plainBody: "Welcome to Blog Nice!\n\nYour account is ready. Sign in to create and publish your first blog.",
      html: "<h2>Welcome to Blog Nice!</h2><p>Your account is ready. Sign in to create and publish your first blog.</p>",
    },
    "subscriber-welcome": {
      subject: `You're subscribed to ${blogTitle}`,
      plainBody: `Thanks for subscribing to ${blogTitle}. You'll get new posts by email.\n\nUnsubscribe: ${unsubscribe}`,
      html: `<p>Thanks for subscribing to <strong>${esc(blogTitle)}</strong>. You'll get new posts by email.</p><hr><p><a href="${unsubscribe}">Unsubscribe</a> anytime.</p>`,
      headers: { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    },
    "new-post": {
      subject: `A new post on ${blogTitle}`,
      plainBody: `New post on ${blogTitle}:\n\nA sample new post\n${origin}/sample-post\n\nUnsubscribe: ${unsubscribe}`,
      html: `<p>New post on <strong>${esc(blogTitle)}</strong>:</p><h2><a href="${origin}/sample-post">A sample new post</a></h2><p><a href="${origin}/sample-post">Read it →</a></p><hr><p>You're subscribed to ${esc(blogTitle)}. <a href="${unsubscribe}">Unsubscribe</a>.</p>`,
      headers: { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    },
    "password-reset": {
      subject: "Reset your Blog Nice password",
      plainBody: "We received a request to reset your Blog Nice password.\n\nReset it here: https://blognice.com/admin/reset?token=staff-email-preview-token\n\nThis link expires in one hour. If you did not request this, you can ignore this email.",
      html: "<p>We received a request to reset your Blog Nice password.</p><p><a href=\"https://blognice.com/admin/reset?token=staff-email-preview-token\">Reset your password</a></p><p style=\"color:#687064;font-size:13px\">This link expires in one hour. If you did not request this, you can ignore this email.</p>",
    },
  };
  const template = templates[type];
  const result = await sendMailNice(c.env, {
    to,
    ...template,
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
  const rows = results.map((row) => `<tr><td><code>${esc(row.term)}</code></td><td>${esc(row.spoken)}</td><td>${row.enabled ? "Enabled" : "Disabled"}</td><td><button class="btn btn-danger" type="button" data-delete="${row.id}">Delete</button></td></tr>`).join("");
  const editor = canMutate(staff)
    ? `<div class="card"><h2>Add pronunciation</h2><p class="muted">Use an exact term and the way it should be spoken. Entries apply to future narration jobs; existing audio is unchanged.</p><form id="pronunciation-form"><label>Term <input name="term" required maxlength="80" placeholder="UI" style="padding:9px;border:1px solid var(--rule);border-radius:5px;margin:0 8px 0 4px"></label><label>Spoken as <input name="spoken" required maxlength="160" placeholder="U I" style="padding:9px;border:1px solid var(--rule);border-radius:5px;margin:0 8px 0 4px"></label><button class="btn" type="submit">Save pronunciation</button></form><p id="pronunciation-status" class="muted" aria-live="polite"></p></div><script>(function(){var form=document.getElementById('pronunciation-form');var status=document.getElementById('pronunciation-status');form.addEventListener('submit',async function(event){event.preventDefault();var button=form.querySelector('button');button.disabled=true;status.textContent='Saving…';var response=await fetch('/api/pronunciations',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({term:form.elements.term.value,spoken:form.elements.spoken.value})});var data=await response.json();if(response.ok)location.reload();else{button.disabled=false;status.textContent=data.error||'Could not save pronunciation.';}});document.querySelectorAll('[data-delete]').forEach(function(button){button.addEventListener('click',async function(){if(!confirm('Delete this pronunciation?'))return;button.disabled=true;var response=await fetch('/api/pronunciations/'+button.dataset.delete,{method:'DELETE'});if(response.ok)location.reload();else{button.disabled=false;alert('Could not delete pronunciation.');}});});})();</script>`
    : `<div class="notice">Your role is read-only. Support or admin staff can edit this dictionary.</div>`;
  return c.html(staffPage("Pronunciation dictionary", `<header class="top"><h1><a href="/">BlogNice staff</a></h1><small>${esc(staff.email)} · ${esc(staff.role)}</small></header><nav><a href="/">Accounts</a><a href="/pronunciations">Pronunciation dictionary</a><a href="/tts-test">TTS test</a></nav><h2>Pronunciation dictionary</h2><p class="muted">Global substitutions used when preparing Blog Nice narration. For example, <code>UI</code> becomes <code>U I</code>.</p>${editor}<div class="card"><table><thead><tr><th>Term</th><th>Spoken form</th><th>Status</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="empty">No custom entries yet.</td></tr>`}</tbody></table></div>`));
});

app.get("/tts-test", async (c) => {
  const staff = c.get("staff") as StaffIdentity;
  const editor = canMutate(staff)
    ? `<div class="card"><h2>Short TTS test</h2><p class="muted">Generate a short sample without creating a post or consuming a customer’s AI allowance. Try variants such as <code>ay eye</code>, <code>eigh eye</code>, or <code>A, I</code>.</p><form id="tts-test-form"><label>Text <input name="text" required maxlength="240" value="AI is useful." style="padding:9px;border:1px solid var(--rule);border-radius:5px;min-width:360px"></label> <button class="btn" type="submit">Generate sample</button></form><p id="tts-test-status" class="muted" aria-live="polite"></p><audio id="tts-test-audio" controls hidden style="width:min(100%,520px)"></audio></div><script>(function(){var form=document.getElementById('tts-test-form');var status=document.getElementById('tts-test-status');var audio=document.getElementById('tts-test-audio');form.addEventListener('submit',async function(event){event.preventDefault();var button=form.querySelector('button');button.disabled=true;audio.hidden=true;status.textContent='Generating…';try{var response=await fetch('/api/tts-test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:form.elements.text.value})});if(!response.ok){var data=await response.json().catch(function(){return {}});throw new Error(data.error||'Could not generate sample.');}var blob=await response.blob();if(audio.dataset.url)URL.revokeObjectURL(audio.dataset.url);audio.dataset.url=URL.createObjectURL(blob);audio.src=audio.dataset.url;audio.hidden=false;status.textContent='Sample ready.';await audio.play().catch(function(){});}catch(error){status.textContent=error.message||'Could not generate sample.';}finally{button.disabled=false;}});})();</script>`
    : `<div class="notice">Your role is read-only. TTS testing requires support or admin access.</div>`;
  return c.html(staffPage("TTS test", `<header class="top"><h1><a href="/">BlogNice staff</a></h1><small>${esc(staff.email)} · ${esc(staff.role)}</small></header><nav><a href="/">Accounts</a><a href="/pronunciations">Pronunciation dictionary</a><a href="/tts-test">TTS test</a></nav><h2>TTS test</h2><p class="muted">Use this for quick pronunciation experiments before regenerating a full article.</p>${editor}`));
});

app.post("/api/tts-test", async (c) => {
  const staff = c.get("staff") as StaffIdentity;
  if (!canMutate(staff)) return c.json({ error: "staff role cannot run TTS tests" }, 403);
  if (!c.env.AI) return c.json({ error: "Workers AI is not configured on the staff Worker." }, 503);
  const input = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const text = String(input.text || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 240);
  if (!text) return c.json({ error: "Enter a short phrase first." }, 400);
  try {
    const generated = await c.env.AI.run(TTS_MODEL, { prompt: text, lang: "en" }) as Uint8Array | { audio: string };
    const bytes = ttsBytes(generated);
    if (!bytes.length) return c.json({ error: "The model returned no audio." }, 502);
    await audit(c, staff, { action: "tts-test", targetType: "tts", targetId: TTS_MODEL, reason: "Generate short pronunciation sample", result: "success", after: { characters: text.length } });
    return new Response(bytes, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch (error) {
    await audit(c, staff, { action: "tts-test", targetType: "tts", targetId: TTS_MODEL, reason: "Generate short pronunciation sample", result: "failure", after: { error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) } });
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

app.delete("/api/pronunciations/:id", async (c) => {
  const staff = c.get("staff") as StaffIdentity;
  if (!canMutate(staff)) return c.json({ error: "staff role cannot edit pronunciations" }, 403);
  if (!sameOrigin(c)) return c.json({ error: "same-origin request required" }, 403);
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id < 1) return c.json({ error: "invalid pronunciation" }, 400);
  const row = await c.env.DB.prepare("SELECT term, spoken FROM pronunciation_overrides WHERE id = ?").bind(id).first<{ term: string; spoken: string }>();
  if (!row) return c.json({ error: "pronunciation not found" }, 404);
  await c.env.DB.prepare("DELETE FROM pronunciation_overrides WHERE id = ?").bind(id).run();
  await audit(c, staff, { action: "delete-pronunciation", targetType: "pronunciation", targetId: String(id), reason: "Remove narration pronunciation dictionary entry", result: "success", before: row });
  return c.json({ ok: true });
});

app.get("/", async (c) => {
  const staff = c.get("staff") as StaffIdentity;
  const q = String(c.req.query("q") || "").trim().slice(0, 100);
  const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const where = q ? "WHERE a.email LIKE ? ESCAPE '\\'" : "";
  const accounts = await c.env.DB.prepare(
    `SELECT a.id, a.email, COALESCE(a.status, 'active') AS status, a.created_at,
            (SELECT COUNT(*) FROM memberships m WHERE m.account_id = a.id) AS blog_count
       FROM accounts a ${where} ORDER BY a.created_at DESC LIMIT 50`
  ).bind(...(q ? [pattern] : [])).all<{ id: number; email: string; status: string; created_at: number; blog_count: number }>();
  const rows = accounts.results.map((account) => `<tr><td><a href="/accounts/${account.id}">${esc(account.email)}</a><br><small>#${account.id}</small></td><td><span class="badge ${account.status === "suspended" ? "suspended" : ""}">${esc(account.status)}</span></td><td>${account.blog_count}</td><td>${new Date(account.created_at * 1000).toISOString().slice(0, 10)}</td></tr>`).join("");
  const emailPreview = canMutate(staff) ? `<div class="card"><h2>Email preview</h2><p class="muted">Send a production-format sample to any address you control. This tool is independent of an account. The password-reset sample uses a non-functional preview link.</p><form id="test-email-form"><label>To <input name="to" type="email" required placeholder="you@example.com" style="padding:8px;border:1px solid var(--rule);border-radius:5px;min-width:280px"></label> <label>Type <select name="type" style="padding:8px;border:1px solid var(--rule);border-radius:5px"><option value="registration">Registration</option><option value="subscriber-welcome">Subscriber welcome</option><option value="new-post">New-post notification</option><option value="password-reset">Password reset</option></select></label> <button class="btn" type="submit">Send test email</button></form><p id="test-email-status" class="muted" aria-live="polite"></p></div><script>document.getElementById('test-email-form').addEventListener('submit',async function(event){event.preventDefault();var form=this;var status=document.getElementById('test-email-status');if(!confirm('Send this email now?'))return;var button=form.querySelector('button');button.disabled=true;status.textContent='Sending…';var response=await fetch('/api/test-email',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({to:form.elements.to.value,type:form.elements.type.value})});var data=await response.json();button.disabled=false;status.textContent=response.ok?'Sent to '+data.recipient+'.':'Error: '+(data.error||'Test email failed.');})</script>` : `<p class="muted">Your role is read-only; email testing requires support or admin access.</p>`;
  return c.html(staffPage("Accounts", `<header class="top"><h1>BlogNice staff</h1><small>${esc(staff.email)} · ${esc(staff.role)}</small></header>${emailPreview}<h2>Accounts</h2><p class="muted">Read-only account overview. Account actions require a support or admin role.</p><form class="search" method="get"><input name="q" value="${esc(q)}" placeholder="Search by email"><button class="btn" type="submit">Search</button></form><div class="card"><table><thead><tr><th>Account</th><th>Status</th><th>Blogs</th><th>Created</th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="empty">No accounts found.</td></tr>`}</tbody></table></div>`));
});

app.get("/accounts/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id < 1) return c.text("Invalid account", 400);
  const account: any = await accountById(c, id);
  if (!account) return c.text("Account not found", 404);
  const blogs = await c.env.DB.prepare("SELECT t.public_id, t.slug, t.title, m.role FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.account_id = ? ORDER BY t.created_at DESC").bind(id).all<{ public_id: string; slug: string; title: string; role: string }>();
  const staff = c.get("staff") as StaffIdentity;
  const actions = canMutate(staff) ? `<div class="actions"><form data-action="/api/accounts/${id}/${account.status === "suspended" ? "reactivate" : "suspend"}"><input name="reason" required placeholder="Reason"><button class="btn ${account.status === "suspended" ? "" : "btn-danger"}" type="submit">${account.status === "suspended" ? "Reactivate account" : "Suspend account"}</button></form><form data-action="/api/accounts/${id}/revoke-sessions"><input name="reason" required placeholder="Reason"><button class="btn" type="submit">Revoke sessions</button></form><form data-action="/api/accounts/${id}/revoke-api-key"><input name="reason" required placeholder="Reason"><button class="btn" type="submit">Revoke API key</button></form><form data-action="/api/accounts/${id}/send-password-reset"><input name="reason" required placeholder="Reason"><button class="btn" type="submit">Send password reset email</button></form></div><script>document.querySelectorAll('form[data-action]').forEach(function(form){form.addEventListener('submit',async function(event){event.preventDefault();if(!confirm('Confirm this support action?'))return;var reason=form.elements.reason.value;var response=await fetch(form.dataset.action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reason:reason})});var data=await response.json();if(!response.ok){alert(data.error||'Action failed');return}alert(data.recipient?'Reset email sent to '+data.recipient+'.':'Action complete.');location.reload()})})</script>` : `<p class="muted">Your role is read-only.</p>`;
  const blogRows = blogs.results.map((blog) => `<tr><td>${esc(blog.title)}</td><td><code>${esc(blog.slug)}</code></td><td>${esc(blog.role)}</td></tr>`).join("");
  return c.html(staffPage(`Account ${id}`, `<header class="top"><h1><a href="/">BlogNice staff</a></h1><small>${esc(staff.email)} · ${esc(staff.role)}</small></header><p><a href="/">← All accounts</a></p><div class="card"><div class="card-head"><div><h2>${esc(account.email)}</h2><p class="muted">Account #${id} · created ${new Date(account.created_at * 1000).toISOString().slice(0, 10)}</p></div><span class="badge ${account.status === "suspended" ? "suspended" : ""}">${esc(account.status)}</span></div><p>Blogs: ${account.blog_count} · Active sessions: ${account.active_sessions} · API key: ${account.has_api_key ? "present" : "not present"}</p>${account.status_reason ? `<p class="notice">Status reason: ${esc(account.status_reason)}</p>` : ""}${actions}</div><div class="card"><h2>Blogs</h2><table><thead><tr><th>Title</th><th>Address</th><th>Role</th></tr></thead><tbody>${blogRows || `<tr><td colspan="3" class="empty">No blogs.</td></tr>`}</tbody></table></div>`));
});

export default app;
