import { Hono } from "hono";
import { esc } from "./render";

type StaffRole = "read_only" | "support" | "admin";
type StaffIdentity = { subject: string; email: string; role: StaffRole };

type StaffBindings = {
  DB: D1Database;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  STAFF_ALLOWED_EMAILS?: string;
};

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
  :root{color-scheme:light;--ink:#171914;--muted:#687064;--rule:#dfe4da;--paper:#f7f8f3;--accent:#1a8917}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}.wrap{max-width:1120px;margin:auto;padding:28px}.top{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid var(--rule);padding-bottom:18px;margin-bottom:24px}.top h1{font-size:1.25rem;margin:0}.top small{color:var(--muted)}h2{font-size:1.6rem;margin:0 0 8px}.muted{color:var(--muted)}.search{display:flex;gap:8px;margin:20px 0}.search input{flex:1;padding:10px 12px;border:1px solid var(--rule);border-radius:6px;font:inherit;background:#fff}.btn{border:1px solid var(--rule);background:#fff;border-radius:6px;padding:9px 13px;font:inherit;cursor:pointer}.btn:hover,.btn:focus-visible{border-color:var(--accent)}.btn-danger{color:#8d241b}.card{background:#fff;border:1px solid var(--rule);border-radius:9px;margin:14px 0;padding:18px}.card-head{display:flex;justify-content:space-between;gap:16px;align-items:center}.badge{display:inline-block;border-radius:999px;padding:3px 9px;font-size:.78rem;background:#eaf4e8;color:#20611e}.badge.suspended{background:#fae7e4;color:#8d241b}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--rule);vertical-align:top}th{font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.actions form{display:inline-flex;gap:6px}.actions input{min-width:190px;padding:8px;border:1px solid var(--rule);border-radius:5px}.notice{padding:12px;border-radius:6px;background:#fff4d6;margin:12px 0}.empty{padding:28px;text-align:center;color:var(--muted)}
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
  return c.html(staffPage("Accounts", `<header class="top"><h1>BlogNice staff</h1><small>${esc(staff.email)} · ${esc(staff.role)}</small></header><h2>Accounts</h2><p class="muted">Read-only account overview. Account actions require a support or admin role.</p><form class="search" method="get"><input name="q" value="${esc(q)}" placeholder="Search by email"><button class="btn" type="submit">Search</button></form><div class="card"><table><thead><tr><th>Account</th><th>Status</th><th>Blogs</th><th>Created</th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="empty">No accounts found.</td></tr>`}</tbody></table></div>`));
});

app.get("/accounts/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id < 1) return c.text("Invalid account", 400);
  const account: any = await accountById(c, id);
  if (!account) return c.text("Account not found", 404);
  const blogs = await c.env.DB.prepare("SELECT t.public_id, t.slug, t.title, m.role FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.account_id = ? ORDER BY t.created_at DESC").bind(id).all<{ public_id: string; slug: string; title: string; role: string }>();
  const staff = c.get("staff") as StaffIdentity;
  const actions = canMutate(staff) ? `<div class="actions"><form data-action="/api/accounts/${id}/${account.status === "suspended" ? "reactivate" : "suspend"}"><input name="reason" required placeholder="Reason"><button class="btn ${account.status === "suspended" ? "" : "btn-danger"}" type="submit">${account.status === "suspended" ? "Reactivate account" : "Suspend account"}</button></form><form data-action="/api/accounts/${id}/revoke-sessions"><input name="reason" required placeholder="Reason"><button class="btn" type="submit">Revoke sessions</button></form><form data-action="/api/accounts/${id}/revoke-api-key"><input name="reason" required placeholder="Reason"><button class="btn" type="submit">Revoke API key</button></form></div><script>document.querySelectorAll('form[data-action]').forEach(function(form){form.addEventListener('submit',async function(event){event.preventDefault();if(!confirm('Confirm this support action?'))return;var reason=form.elements.reason.value;var response=await fetch(form.dataset.action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reason:reason})});var data=await response.json();if(!response.ok){alert(data.error||'Action failed');return}location.reload()})})</script>` : `<p class="muted">Your role is read-only.</p>`;
  const blogRows = blogs.results.map((blog) => `<tr><td>${esc(blog.title)}</td><td><code>${esc(blog.slug)}</code></td><td>${esc(blog.role)}</td></tr>`).join("");
  return c.html(staffPage(`Account ${id}`, `<header class="top"><h1><a href="/">BlogNice staff</a></h1><small>${esc(staff.email)} · ${esc(staff.role)}</small></header><p><a href="/">← All accounts</a></p><div class="card"><div class="card-head"><div><h2>${esc(account.email)}</h2><p class="muted">Account #${id} · created ${new Date(account.created_at * 1000).toISOString().slice(0, 10)}</p></div><span class="badge ${account.status === "suspended" ? "suspended" : ""}">${esc(account.status)}</span></div><p>Blogs: ${account.blog_count} · Active sessions: ${account.active_sessions} · API key: ${account.has_api_key ? "present" : "not present"}</p>${account.status_reason ? `<p class="notice">Status reason: ${esc(account.status_reason)}</p>` : ""}${actions}</div><div class="card"><h2>Blogs</h2><table><thead><tr><th>Title</th><th>Address</th><th>Role</th></tr></thead><tbody>${blogRows || `<tr><td colspan="3" class="empty">No blogs.</td></tr>`}</tbody></table></div>`));
});

export default app;
