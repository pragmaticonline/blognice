import { currentAccount, sha256hex, type Account } from "./auth";

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlEncodeString(str: string): string {
  return b64urlEncode(new TextEncoder().encode(str));
}

export async function pkceS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64urlEncode(new Uint8Array(digest));
}

export function generateOAuthToken(prefix = "bnk_"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${prefix}${b64urlEncode(bytes)}`;
}

export async function hashToken(token: string): Promise<string> {
  return sha256hex(token);
}

export async function accountFromOAuthToken(db: D1Database, token: string): Promise<Account | null> {
  if (!token) return null;
  const now = Math.floor(Date.now() / 1000);
  const hash = await sha256hex(token);
  // Try hashed lookup first, fallback to plain for legacy
  let row: any = null;
  try {
    row = await db.prepare(
      `SELECT a.id, a.email, COALESCE(a.status,'active') AS status, a.status_reason, a.status_changed_at,
              COALESCE(a.billing_status,'inactive') AS billing_status,
              COALESCE(a.billing_cancel_at_period_end,0) AS billing_cancel_at_period_end,
              a.crypto_paid_through, a.vip_granted_at, a.vip_expires_at, a.max_blogs_override
         FROM oauth_access_tokens t JOIN accounts a ON a.id = t.account_id
        WHERE (t.access_token = ? OR t.access_token = ?) AND t.expires_at > ? AND t.revoked = 0`
    ).bind(token, hash, now).first();
  } catch {
    row = await db.prepare(
      `SELECT a.id, a.email, COALESCE(a.status,'active') AS status FROM oauth_access_tokens t JOIN accounts a ON a.id = t.account_id WHERE t.access_token = ? AND t.expires_at > ? AND t.revoked = 0`
    ).bind(token, now).first();
  }
  return row as Account | null;
}

export function oauthAuthorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    scopes_supported: ["blog:read", "blog:write"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

export function oauthProtectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: ["blog:read", "blog:write"],
    bearer_methods_supported: ["header"],
  };
}

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function handleOAuthAuthorize(c: any): Promise<Response> {
  const url = new URL(c.req.url);
  const origin = `${url.protocol}//${url.host}`;
  const params = url.searchParams;
  const response_type = params.get("response_type");
  const client_id = params.get("client_id") || "";
  const redirect_uri = params.get("redirect_uri") || "";
  const scope = params.get("scope") || "";
  const state = params.get("state") || "";
  const code_challenge = params.get("code_challenge") || "";
  const code_challenge_method = params.get("code_challenge_method") || "";

  if (response_type !== "code") return c.text("unsupported_response_type: only code is supported", 400);
  if (!client_id) return c.text("invalid_request: client_id required", 400);
  if (!redirect_uri) return c.text("invalid_request: redirect_uri required", 400);
  try { const ru = new URL(redirect_uri); if (ru.protocol !== "https:" && ru.hostname !== "localhost" && ru.hostname !== "127.0.0.1") return c.text("invalid_request: redirect_uri must be https", 400); } catch { return c.text("invalid_request: redirect_uri invalid", 400); }
  if (!code_challenge) return c.text("invalid_request: code_challenge required (PKCE S256)", 400);
  if (code_challenge_method !== "S256") return c.text("invalid_request: only S256 is supported", 400);
  if (code_challenge.length < 43 || code_challenge.length > 128) return c.text("invalid_request: code_challenge invalid length", 400);

  const account = await currentAccount(c);
  if (!account) {
    const loginUrl = new URL(`${origin}/login`);
    loginUrl.searchParams.set("return", c.req.url);
    return c.redirect(loginUrl.toString(), 302);
  }

  // Render consent page
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize — Blognice</title><style>body{font-family:system-ui,sans-serif;max-width:560px;margin:3rem auto;padding:1.5rem} .card{border:1px solid #dfe4da;border-radius:12px;padding:1.5rem} .btn{padding:.6rem 1rem;border-radius:8px;border:1px solid #1a8917;background:#1a8917;color:#fff;cursor:pointer} .btn secondary{background:#fff;color:#1a8917} </style></head><body><div class="card"><h1>Connect to Blognice?</h1><p><strong>${esc(client_id)}</strong> wants to access your blogs.</p><p>Scope: ${esc(scope || "blog:read blog:write")}</p><p>Signed in as ${esc(account.email)}</p><form method="post" action="/oauth/authorize"><input type="hidden" name="response_type" value="code"><input type="hidden" name="client_id" value="${esc(client_id)}"><input type="hidden" name="redirect_uri" value="${esc(redirect_uri)}"><input type="hidden" name="scope" value="${esc(scope)}"><input type="hidden" name="state" value="${esc(state)}"><input type="hidden" name="code_challenge" value="${esc(code_challenge)}"><input type="hidden" name="code_challenge_method" value="S256"><button class="btn" name="decision" value="allow" type="submit">Allow</button> <button class="btn" name="decision" value="deny" type="submit" style="background:#fff;color:#1a8917">Deny</button></form></div></body></html>`;
  return c.html(html);
}

export async function handleOAuthAuthorizePost(c: any): Promise<Response> {
  const form = await c.req.parseBody();
  const decision = String(form.decision || "");
  const client_id = String(form.client_id || "");
  const redirect_uri = String(form.redirect_uri || "");
  const scope = String(form.scope || "");
  const state = String(form.state || "");
  const code_challenge = String(form.code_challenge || "");
  const code_challenge_method = String(form.code_challenge_method || "S256");

  if (decision === "deny") {
    const u = new URL(redirect_uri);
    u.searchParams.set("error", "access_denied");
    if (state) u.searchParams.set("state", state);
    return c.redirect(u.toString(), 302);
  }
  if (decision !== "allow") return c.text("invalid_request", 400);
  if (code_challenge_method !== "S256") return c.text("PKCE S256 required", 400);

  const account = await currentAccount(c);
  if (!account) return c.text("unauthorized", 401);

  const code = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const now = Math.floor(Date.now() / 1000);
  const expires_at = now + 600;
  try {
    await c.env.DB.prepare(
      `INSERT INTO oauth_authorization_codes (code, client_id, redirect_uri, account_id, scope, code_challenge, code_challenge_method, created_at, expires_at, used) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).bind(code, client_id, redirect_uri, account.id, scope, code_challenge, "S256", now, expires_at).run();
  } catch (e: any) {
    return c.text("server error: " + String(e?.message || e), 500);
  }
  const u = new URL(redirect_uri);
  u.searchParams.set("code", code);
  if (state) u.searchParams.set("state", state);
  return c.redirect(u.toString(), 302);
}

export async function handleOAuthToken(c: any): Promise<Response> {
  let body: Record<string, string> = {};
  const ct = String(c.req.header("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    try { body = await c.req.json(); } catch { body = {}; }
  } else if (ct.includes("application/x-www-form-urlencoded")) {
    const text = await c.req.text();
    for (const part of text.split("&")) {
      const [k, v] = part.split("=");
      if (k) body[decodeURIComponent(k)] = decodeURIComponent(v || "");
    }
  } else {
    try { const parsed = await c.req.parseBody(); for (const [k, v] of Object.entries(parsed)) body[k] = String(v); } catch { body = {}; }
  }

  const grant_type = String(body.grant_type || "");
  if (grant_type === "authorization_code") {
    const code = String(body.code || "");
    const redirect_uri = String(body.redirect_uri || "");
    const client_id = String(body.client_id || "");
    const code_verifier = String(body.code_verifier || "");
    if (!code || !code_verifier) return c.json({ error: "invalid_request", error_description: "code and code_verifier required" }, 400);

    const row: any = await c.env.DB.prepare(`SELECT * FROM oauth_authorization_codes WHERE code = ?`).bind(code).first();
    if (!row) return c.json({ error: "invalid_grant", error_description: "code not found" }, 400);
    if (row.used) return c.json({ error: "invalid_grant", error_description: "code already used" }, 400);
    const now = Math.floor(Date.now() / 1000);
    if (row.expires_at < now) return c.json({ error: "invalid_grant", error_description: "code expired" }, 400);
    if (row.redirect_uri !== redirect_uri) return c.json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
    if (row.client_id !== client_id) return c.json({ error: "invalid_grant", error_description: "client_id mismatch" }, 400);

    // PKCE verification S256
    const expected = await pkceS256(code_verifier);
    if (expected !== row.code_challenge) return c.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);

    await c.env.DB.prepare(`UPDATE oauth_authorization_codes SET used = 1 WHERE code = ?`).bind(code).run();

    const access_token = generateOAuthToken("bn_oa_");
    const refresh_token = generateOAuthToken("bn_or_");
    const accessHash = await sha256hex(access_token);
    const refreshHash = await sha256hex(refresh_token);
    const expires_in = 3600;
    const expires_at = now + expires_in;
    // Store hashed tokens
    await c.env.DB.prepare(
      `INSERT INTO oauth_access_tokens (access_token, refresh_token, client_id, account_id, scope, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
    ).bind(accessHash, refreshHash, client_id, row.account_id, row.scope, now, expires_at).run();

    return c.json({
      access_token,
      token_type: "Bearer",
      expires_in,
      refresh_token,
      scope: row.scope,
    });
  } else if (grant_type === "refresh_token") {
    const refresh_token = String(body.refresh_token || "");
    const client_id = String(body.client_id || "");
    if (!refresh_token) return c.json({ error: "invalid_request" }, 400);
    const hash = await sha256hex(refresh_token);
    const row: any = await c.env.DB.prepare(`SELECT * FROM oauth_access_tokens WHERE refresh_token = ? OR refresh_token = ?`).bind(refresh_token, hash).first();
    if (!row || row.revoked) return c.json({ error: "invalid_grant" }, 400);
    if (client_id && row.client_id !== client_id) return c.json({ error: "invalid_grant" }, 400);
    const now = Math.floor(Date.now() / 1000);
    if (row.expires_at < now - 86400 * 30) return c.json({ error: "invalid_grant", error_description: "refresh expired" }, 400);

    const newAccess = generateOAuthToken("bn_oa_");
    const newRefresh = generateOAuthToken("bn_or_");
    const newAccessHash = await sha256hex(newAccess);
    const newRefreshHash = await sha256hex(newRefresh);
    const expires_in = 3600;
    const expires_at = now + expires_in;
    await c.env.DB.prepare(`UPDATE oauth_access_tokens SET revoked = 1 WHERE refresh_token = ? OR refresh_token = ?`).bind(refresh_token, hash).run();
    await c.env.DB.prepare(
      `INSERT INTO oauth_access_tokens (access_token, refresh_token, client_id, account_id, scope, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
    ).bind(newAccessHash, newRefreshHash, row.client_id, row.account_id, row.scope, now, expires_at).run();

    return c.json({
      access_token: newAccess,
      token_type: "Bearer",
      expires_in,
      refresh_token: newRefresh,
      scope: row.scope,
    });
  } else {
    return c.json({ error: "unsupported_grant_type" }, 400);
  }
}
