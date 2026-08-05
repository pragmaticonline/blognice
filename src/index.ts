import { Hono } from "hono";
import { Marked } from "marked";
import {
  esc,
  renderHome,
  renderPost,
  renderNotFound,
  renderSimplePage,
  type Post,
  type Tenant,
} from "./render";
import { sendEmail, emailEnabled } from "./email";
import {
  createCustomHostname,
  getCustomHostname,
  findCustomHostname,
  deleteCustomHostname,
  isActive,
  instructions,
} from "./cloudflare";
import {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  currentAccount,
  setSessionCookie,
  clearSessionCookie,
  getSessionToken,
  generateApiKey,
  sha256hex,
  accountFromApiKey,
  type Account,
} from "./auth";
import {
  loginPage,
  postListPage,
  editorPage,
  signupPage,
  domainsPage,
  blogListPage,
  newBlogPage,
  settingsPage,
  subscribersPage,
  apiKeyPage,
  mediaPage,
  metricsPage,
  shell,
  type MediaItem,
} from "./admin";
import { tenantDb } from "./db";
import homepage from "../homepage.html";
import faviconSvg from "../favicon.svg";
import { findMediaUse, mediaKey, mediaUrl, validLibraryFile } from "./media";
import {
  AI_BRIEF_MODEL,
  AI_IMAGE_MODEL,
  buildFallbackBrief,
  buildImagePrompt,
  buildSourceContext,
  type ImageContextMode,
  type ImageStyle,
} from "./ai-image";
import { applyPronunciations, mergeWav, narrationChunks, narrationSections, pronunciationReplacements, ttsBytes, wavAssembly, TTS_HARD_PAUSE, TTS_MODEL, TTS_PUNCTUATION_PAUSE_SECONDS, TTS_SOFT_PAUSE, TTS_STRUCTURE_PAUSE_SECONDS, TTS_TEXT_MAX, TTS_TITLE_PAUSE_SECONDS } from "./tts";
import {
  archivePreviousDay,
  archivePreviousDayEvents,
  metricsConfigured,
  metricsReport,
  recordPageView,
  recordCustomEvent,
} from "./metrics";

type Bindings = {
  DB: D1Database; // index database: tenants, users, sessions, domains
  POSTS: D1Database; // posts database: post bodies (routed via tenantDb)
  MEDIA: R2Bucket; // image uploads and generated narration
  AI: Ai; // Cloudflare Workers AI image and speech generation
  AUDIO_QUEUE: Queue<AudioJobMessage | ImageJobMessage>; // queued AI media jobs
  METRICS: AnalyticsEngineDataset; // anonymous public page-view events
  EVENTS: AnalyticsEngineDataset; // audio engagement events
  METRICS_ARCHIVE: R2Bucket; // aggregate daily metrics retained beyond 90 days
  ROOT_DOMAIN: string; // e.g. "blognice.com"
  API_TOKEN: string; // secret; authorizes the /api routes
  DEV_TENANT?: string; // dev only: force a tenant regardless of Host

  // Cloudflare for SaaS (custom domains). See src/cloudflare.ts.
  CF_API_TOKEN: string; // secret
  CF_ZONE_ID: string; // var
  CNAME_TARGET: string; // var, e.g. "cname.blognice.com"
  CF_ACCOUNT_ID?: string; // var; required to query metrics
  CF_ANALYTICS_TOKEN?: string; // secret; Account Analytics Read

  // Optional email (Resend). See src/email.ts. Unset = subscriptions still
  // work as capture-only (no emails sent).
  RESEND_API_KEY?: string; // secret
  EMAIL_FROM?: string; // var, e.g. "Blog Nice <hello@blognice.com>"
};

const app = new Hono<{ Bindings: Bindings }>();

// Markdown → HTML. Adds heading `id` slugs (via slugify, defined below) so
// in-page anchor links — a table of contents like [Tables](#tables) — jump.
// A fresh slug counter per call keeps duplicate headings unique (foo, foo-1…).
function renderMarkdown(md: string): string {
  const seen = new Map<string, number>();
  const m = new Marked({ gfm: true, breaks: false });
  m.use({
    renderer: {
      heading(this: any, { tokens, depth }: any): string {
        const html = this.parser.parseInline(tokens);
        const plain = html.replace(/<[^>]+>/g, "");
        let slug = slugify(plain) || "section";
        const n = seen.get(slug) ?? 0;
        seen.set(slug, n + 1);
        const id = n === 0 ? slug : `${slug}-${n}`;
        return `<h${depth} id="${id}">${html}</h${depth}>\n`;
      },
      // Give each divider a class based on the marker typed (--- / *** / ___),
      // so the three can be styled differently. A private convention: other
      // Markdown tools render all three identically.
      hr({ raw }: any): string {
        const ch = (raw || "").trim()[0];
        const cls =
          ch === "*" ? "rule-star" : ch === "_" ? "rule-line" : "rule-dash";
        return `<hr class="${cls}">\n`;
      },
    },
  });
  return sanitizeRenderedHtml(m.parse(md, { async: false }) as string);
}

// Markdown is authored by collaborators, so raw HTML must not become a stored
// XSS vector. Keep harmless formatting while removing executable/embed content
// and event/javascript URLs. This intentionally stays dependency-free for the
// Worker bundle; Markdown links and images are still supported.
function sanitizeRenderedHtml(html: string): string {
  const safeTags = new Set([
    "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em",
    "del", "s", "u", "blockquote", "pre", "code", "ul", "ol", "li", "a",
    "img", "table", "thead", "tbody", "tr", "th", "td",
  ]);
  const safeAttrs = new Set(["href", "src", "alt", "title", "id", "class", "target", "rel", "colspan", "rowspan"]);
  const withoutDangerousBlocks = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe|object|embed|form|input|button|textarea|select|link|meta|svg|math|video|audio|canvas)[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?(script|style|iframe|object|embed|form|input|button|textarea|select|link|meta|svg|math|video|audio|canvas)[^>]*>/gi, "");
  return withoutDangerousBlocks.replace(/<\/?[a-z][^>]*>/gi, (raw) => {
    const closing = /^<\//.test(raw);
    const name = (raw.match(/^<\/?\s*([a-z0-9]+)/i)?.[1] || "").toLowerCase();
    if (!safeTags.has(name)) return "";
    if (closing) return `</${name}>`;
    const attrs = raw.replace(/^<\s*[a-z0-9]+|\/?>$/gi, "");
    const rendered: string[] = [];
    const attrRe = /([a-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gi;
    let match: RegExpExecArray | null;
    while ((match = attrRe.exec(attrs))) {
      const attr = match[1].toLowerCase();
      if (!safeAttrs.has(attr)) continue;
      const value = match[2] ?? match[3] ?? match[4] ?? "";
      if (attr === "href" || attr === "src") {
        // Reject protocol-relative URLs and control-character obfuscation.
        // Relative paths, fragments, HTTPS/HTTP, and mail links are the only
        // schemes needed by the editor (mailto is valid for href, not src).
        const compact = value.trim().replace(/[\u0000-\u0020\u007f]/g, "");
        const allowed = attr === "href"
          ? /^(?:https?:\/\/|\/(?!\/)|#|mailto:)/i
          : /^(?:https?:\/\/|\/(?!\/))/i;
        if (!allowed.test(compact)) continue;
      }
      if (attr === "target" && value !== "_blank") continue;
      if ((attr === "colspan" || attr === "rowspan") && !/^\d{1,3}$/.test(value)) continue;
      const escaped = esc(value);
      rendered.push(` ${attr}="${escaped}"`);
    }
    if (name === "a" && rendered.some((attr) => attr === ' target="_blank"') && !rendered.some((attr) => attr.startsWith(" rel="))) {
      rendered.push(' rel="noopener noreferrer"');
    }
    return `<${name}${rendered.join("")}>`;
  });
}

// ---------------------------------------------------------------------------
// Tenant resolution: figure out which blog a request is for, from the Host.
// ---------------------------------------------------------------------------
async function resolveTenant(
  env: Bindings,
  hostHeader: string
): Promise<Tenant | null> {
  // Dev shortcut so you can browse at http://localhost:8787 without headers.
  if (env.DEV_TENANT) {
    return env.DB.prepare("SELECT * FROM tenants WHERE slug = ?")
      .bind(env.DEV_TENANT)
      .first<Tenant>();
  }

  const host = (hostHeader || "").split(":")[0].toLowerCase();
  if (!host) return null;

  // 1) A customer's own domain, connected + verified via Cloudflare for SaaS.
  const managed = await env.DB.prepare(
    `SELECT t.* FROM tenants t
       JOIN domains d ON d.tenant_id = t.id
      WHERE d.hostname = ? AND d.status = 'active'`
  )
    .bind(host)
    .first<Tenant>();
  if (managed) return managed;

  // 2) A custom domain set manually on the tenant row (simple single-domain case).
  const byDomain = await env.DB.prepare(
    "SELECT * FROM tenants WHERE custom_domain = ?"
  )
    .bind(host)
    .first<Tenant>();
  if (byDomain) return byDomain;

  // 3) A subdomain of the platform (<slug>.blognice.com).
  const root = env.ROOT_DOMAIN.toLowerCase();
  if (host.endsWith("." + root)) {
    const slug = host.slice(0, host.length - root.length - 1);
    if (slug && !slug.includes(".")) {
      return env.DB.prepare("SELECT * FROM tenants WHERE slug = ?")
        .bind(slug)
        .first<Tenant>();
    }
  }

  return null;
}

function originOf(c: { req: { url: string } }): string {
  const u = new URL(c.req.url);
  return `${u.protocol}//${u.host}`;
}

// ---------------------------------------------------------------------------
// Edge caching. Reads are cached at the edge; writes purge the affected URLs.
// TTL is short so content stays fresh even if a purge is ever missed.
// ---------------------------------------------------------------------------
async function serveCached(
  c: any,
  build: () => Promise<Response>
): Promise<Response> {
  const cache = caches.default;
  // Bump this when public shell markup/CSS changes so old edge HTML cannot
  // hide newly shipped controls until the normal five-minute TTL expires.
  const cacheUrl = new URL(c.req.url);
  cacheUrl.searchParams.set("_bn_shell", "20260805-7");
  const key = new Request(cacheUrl.toString(), { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit;

  const res = await build();
  if (res.status === 200) {
    res.headers.set("Cache-Control", "public, max-age=60, s-maxage=300");
    c.executionCtx.waitUntil(cache.put(key, res.clone()));
  }
  return res;
}

async function purge(c: any, paths: string[]): Promise<void> {
  const cache = caches.default;
  const origin = originOf(c);
  await Promise.all(
    paths.map((p) => cache.delete(new Request(origin + p, { method: "GET" })))
  );
}

// Purge pages served on a specific customer hostname (used when a domain
// activates, since those pages live under a different origin than the API).
async function purgeHost(hostname: string, paths: string[]): Promise<void> {
  const cache = caches.default;
  await Promise.all(
    paths.map((p) =>
      cache.delete(new Request(`https://${hostname}${p}`, { method: "GET" }))
    )
  );
}

// Shared bearer-token check for the /api routes.
function authorized(c: any): boolean {
  return (c.req.header("authorization") || "") === `Bearer ${c.env.API_TOKEN}`;
}

// Basic hostname sanity check before we hand it to Cloudflare.
function validHostname(h: string, root: string): boolean {
  const host = h.toLowerCase();
  return (
    /^[a-z0-9.-]+$/.test(host) &&
    host.includes(".") &&
    !host.startsWith(".") &&
    !host.endsWith(".") &&
    host !== root &&
    !host.endsWith("." + root) // subdomains of your own zone don't need this flow
  );
}

// Turn a title into a URL-safe slug.
function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// Subdomains we must never hand out as a tenant slug (they collide with our own
// hostnames/routes or are conventionally reserved).
const RESERVED_SLUGS = new Set([
  "www", "api", "admin", "signup", "login", "logout", "app", "apps", "mail",
  "email", "smtp", "imap", "pop", "ftp", "ns", "ns1", "ns2", "dns", "cname",
  "mx", "cdn", "static", "assets", "img", "images", "media", "files",
  "download", "downloads", "help", "support", "status", "dashboard", "account",
  "accounts", "billing", "blog", "blogs", "home", "root", "test", "dev",
  "staging", "demo", "cpanel", "webmail", "autoconfig", "autodiscover",
  "about", "contact", "terms", "privacy", "security", "abuse", "postmaster",
]);

// Validate a user-chosen blog address (the subdomain slug).
function validateSlug(s: string): string | null {
  if (!/^[a-z0-9-]+$/.test(s))
    return "Address may use only lowercase letters, numbers, and hyphens.";
  if (s.length < 3 || s.length > 40)
    return "Address must be between 3 and 40 characters.";
  if (s.startsWith("-") || s.endsWith("-") || s.includes("--"))
    return "Address can't start or end with a hyphen, or contain two in a row.";
  if (RESERVED_SLUGS.has(s)) return "That address is reserved.";
  return null;
}

// All public hostnames a tenant is served on: its subdomain plus any active
// custom domains. Used to purge the right edge caches after an edit.
async function tenantHosts(
  env: Bindings,
  tenant: Tenant
): Promise<string[]> {
  const hosts = [`${tenant.slug}.${env.ROOT_DOMAIN}`];
  const { results } = await env.DB.prepare(
    "SELECT hostname FROM domains WHERE tenant_id = ? AND status = 'active'"
  )
    .bind(tenant.id)
    .all<{ hostname: string }>();
  for (const r of results) hosts.push(r.hostname);
  return hosts;
}

async function purgeTenant(
  env: Bindings,
  tenant: Tenant,
  paths: string[]
): Promise<void> {
  const cache = caches.default;
  const hosts = await tenantHosts(env, tenant);
  const jobs: Promise<boolean>[] = [];
  const purgePaths = Array.from(new Set([...paths, "/rss.xml"]));
  for (const host of hosts)
    for (const p of purgePaths)
      jobs.push(cache.delete(new Request(`https://${host}${p}`, { method: "GET" })));
  await Promise.all(jobs);
}

// Purge the home page, sitemap, AND every post page for a blog. Used when
// something that appears on all posts changes (the byline: blog title, avatar).
async function purgeTenantEverywhere(
  env: Bindings,
  tenant: Tenant
): Promise<void> {
  const { results } = await tenantDb(env, tenant)
    .prepare("SELECT slug FROM posts WHERE tenant_id = ?")
    .bind(tenant.id)
    .all<{ slug: string }>();
  const paths = ["/", "/sitemap.xml", "/rss.xml", ...results.map((r) => "/" + r.slug)];
  await purgeTenant(env, tenant, paths);
}

// A blog's canonical public origin (its custom domain if set, else subdomain).
// Used for email links, which must point at the reader-facing host.
function publicOrigin(env: Bindings, tenant: Tenant): string {
  return `https://${tenant.custom_domain || `${tenant.slug}.${env.ROOT_DOMAIN}`}`;
}

async function tenantById(env: Bindings, id: number | string): Promise<Tenant | null> {
  return (await env.DB.prepare("SELECT * FROM tenants WHERE id = ?")
    .bind(id)
    .first()) as Tenant | null;
}

// Email every subscriber about a newly published post (no-op if email is off).
async function notifySubscribers(
  env: Bindings,
  tenant: Tenant,
  post: { slug: string; title: string }
): Promise<void> {
  if (!emailEnabled(env)) return;
  const origin = publicOrigin(env, tenant);
  const postUrl = `${origin}/${post.slug}`;
  const { results } = await env.DB.prepare(
    "SELECT email, token FROM subscribers WHERE tenant_id = ?"
  )
    .bind(tenant.id)
    .all<{ email: string; token: string }>();

  await Promise.all(
    results.map((s) => {
      const unsub = `${origin}/unsubscribe/${s.token}`;
      const html = `<p>New post on <strong>${esc(tenant.title)}</strong>:</p>
        <h2 style="font-family:sans-serif"><a href="${postUrl}">${esc(post.title)}</a></h2>
        <p><a href="${postUrl}">Read it &rarr;</a></p>
        <hr><p style="color:#888;font-size:13px">You're subscribed to ${esc(tenant.title)}.
        <a href="${unsub}">Unsubscribe</a>.</p>`;
      return sendEmail(env, {
        to: s.email,
        subject: post.title,
        html,
        headers: {
          "List-Unsubscribe": `<${unsub}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });
    })
  );
}

// ---------------------------------------------------------------------------
// Routes. Static paths are registered before the /:slug catch-all.
// ---------------------------------------------------------------------------

// Keep the apex domain as a canonical redirect to the public www homepage and
// admin host. DNS can resolve an apex, but only HTTP can preserve the path and
// tell browsers to use the canonical hostname.
app.use("*", async (c, next) => {
  const requestUrl = new URL(c.req.url);
  const host = requestUrl.hostname.toLowerCase();
  if (host === c.env.ROOT_DOMAIN.toLowerCase()) {
    return c.redirect(
      `https://www.${c.env.ROOT_DOMAIN}${requestUrl.pathname}${requestUrl.search}`,
      301
    );
  }
  return next();
});

app.get("/robots.txt", (c) => {
  const body = `User-agent: *\nAllow: /\nSitemap: ${originOf(c)}/sitemap.xml\n`;
  return c.text(body);
});

app.get("/favicon.svg", async (c) => {
  const tenant = await resolveTenant(c.env, c.req.header("host") || "");
  if (!tenant?.favicon_key) return new Response(faviconSvg, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" } });
  const object = await c.env.MEDIA.get(tenant.favicon_key);
  if (!object) return new Response(faviconSvg, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" } });
  return new Response(object.body, { headers: { "content-type": object.httpMetadata?.contentType || "image/svg+xml", "cache-control": "public, max-age=3600" } });
});

app.get("/favicon.ico", async (c) => {
  const tenant = await resolveTenant(c.env, c.req.header("host") || "");
  if (!tenant?.favicon_key) return new Response(faviconSvg, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" } });
  const object = await c.env.MEDIA.get(tenant.favicon_key);
  if (!object) return new Response(faviconSvg, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" } });
  return new Response(object.body, { headers: { "content-type": object.httpMetadata?.contentType || "image/svg+xml", "cache-control": "public, max-age=3600" } });
});

function clientCategory(request: Request): { device: string; browser: string } {
  const ua = request.headers.get("user-agent") || "";
  const mobileHint = request.headers.get("sec-ch-ua-mobile");
  const device = /iPad|Tablet|Android(?!.*Mobile)/i.test(ua)
    ? "Tablet"
    : mobileHint === "?1" || /Mobile|iPhone|iPod|Android/i.test(ua)
      ? "Mobile"
      : "Desktop";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\/|FxiOS\//.test(ua)
      ? "Firefox"
      : /OPR\/|Opera/.test(ua)
        ? "Opera"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Other";
  return { device, browser };
}

function normalizeTopics(input: string): { topics: string[]; error?: string } {
  const topics = input.split(/[\n,]+/).map((topic) => topic.trim().replace(/^#+/, "").toLowerCase()).filter(Boolean);
  const unique = [...new Set(topics)];
  if (unique.length > 50) return { topics: [], error: "Use 50 topics or fewer." };
  if (unique.some((topic) => topic.length > 40 || !/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(topic)))
    return { topics: [], error: "Topics must be 40 characters or fewer and contain only letters, numbers, spaces, hyphens, or underscores." };
  return { topics: unique };
}

function normalizePostTags(input: string): { tags: string[]; error?: string } {
  const tags = input.split(/[\n,]+/).map((tag) => tag.trim().replace(/^#+/, "").toLowerCase()).filter(Boolean);
  const unique = [...new Set(tags)];
  if (unique.length > 20) return { tags: [], error: "Use 20 post tags or fewer." };
  if (unique.some((tag) => tag.length > 40 || !/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(tag)))
    return { tags: [], error: "Post tags must be 40 characters or fewer and contain only letters, numbers, spaces, hyphens, or underscores." };
  return { tags: unique };
}

async function legacySlugRedirect(c: any): Promise<Response | null> {
  const host = (c.req.header("host") || "").split(":")[0].toLowerCase();
  const root = c.env.ROOT_DOMAIN.toLowerCase();
  if (!host.endsWith("." + root) || host === `www.${root}`) return null;
  const slug = host.slice(0, -root.length - 1);
  if (!slug || slug.includes(".")) return null;
  let alias: { slug: string } | null = null;
  try {
    alias = await c.env.DB.prepare(
      `SELECT t.slug FROM tenant_slug_aliases a JOIN tenants t ON t.id = a.tenant_id WHERE a.old_slug = ?`
    ).bind(slug).first() as { slug: string } | null;
  } catch {
    // Keep the worker usable during a rolling deploy before migration 008 is applied.
    return null;
  }
  if (!alias) return null;
  const url = new URL(c.req.url);
  url.hostname = `${alias.slug}.${root}`;
  return c.redirect(url.toString(), 301);
}

async function tenantByPublicId(env: Bindings, publicId: string): Promise<Tenant | null> {
  return (await env.DB.prepare("SELECT * FROM tenants WHERE public_id = ?")
    .bind(publicId)
    .first()) as Tenant | null;
}

function newPublicId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 16);
}

function adminOriginOf(c: { env: Bindings; req: { url: string } }): string {
  const u = new URL(c.req.url);
  return c.env.DEV_TENANT || u.hostname === "localhost" || u.hostname === "127.0.0.1"
    ? u.origin
    : `${u.protocol}//www.${c.env.ROOT_DOMAIN}`;
}

// A same-origin beacon keeps counting independently of the cached HTML routes.
// It deliberately records no IP address, user agent, query string, or raw
// referrer URL.
app.post("/_blognice/metrics", async (c) => {
  const length = Number(c.req.header("content-length") || "0");
  if (length > 2048) return c.body(null, 413);
  const origin = c.req.header("origin");
  if (origin && new URL(c.req.url).origin !== origin) return c.body(null, 403);

  let body: { path?: unknown; referrer?: unknown; visitor?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.body(null, 400);
  }
  const path = typeof body.path === "string" ? body.path : "";
  const visitor = typeof body.visitor === "string" ? body.visitor : "";
  if (!/^\/(?:$|[^?#]{1,300}$)/.test(path) || !/^[0-9a-f-]{36}$/i.test(visitor)) {
    return c.body(null, 400);
  }
  const tenant = await resolveTenant(c.env, c.req.header("host") || "");
  if (!tenant) return c.body(null, 404);

  let referrer = "";
  if (typeof body.referrer === "string" && body.referrer.length <= 1000) {
    try {
      const hostname = new URL(body.referrer).hostname.toLowerCase();
      if (hostname !== new URL(c.req.url).hostname.toLowerCase()) referrer = hostname.slice(0, 253);
    } catch {
      // Invalid referrers are treated as direct traffic.
    }
  }
  const country = String(c.req.raw.cf?.country || "").slice(0, 2).toUpperCase();
  const { device, browser } = clientCategory(c.req.raw);
  recordPageView(c.env, tenant.id, { path, referrer, country, visitor, device, browser });
  return c.body(null, 204);
});

app.post("/_blognice/events", async (c) => {
  const length = Number(c.req.header("content-length") || "0");
  if (length > 2048) return c.body(null, 413);
  const origin = c.req.header("origin");
  if (origin && new URL(c.req.url).origin !== origin) return c.body(null, 403);
  let body: { event?: unknown; path?: unknown; visitor?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.body(null, 400);
  }
  const name = body.event;
  const path = typeof body.path === "string" ? body.path : "";
  const visitor = typeof body.visitor === "string" ? body.visitor : "";
  if ((name !== "audio_start" && name !== "audio_complete") ||
      !/^\/(?:$|[^?#]{1,300}$)/.test(path) ||
      !/^[0-9a-f-]{36}$/i.test(visitor)) return c.body(null, 400);
  const tenant = await resolveTenant(c.env, c.req.header("host") || "");
  if (!tenant) return c.body(null, 404);
  const country = String(c.req.raw.cf?.country || "").slice(0, 2).toUpperCase();
  const { device, browser } = clientCategory(c.req.raw);
  recordCustomEvent(c.env, tenant.id, { name, path, visitor, country, device, browser });
  return c.body(null, 204);
});

// Public post HTML is edge-cached, so it cannot safely vary by login cookie.
// This uncached endpoint lets the page reveal its edit link only after checking
// both the current session and membership of the requested blog.
app.get("/_blognice/edit-link", async (c) => {
  const tenantParam = c.req.query("tenant") || "";
  const postParam = c.req.query("post") || "";
  const requestOrigin = new URL(c.req.url).origin;
  const origin = c.req.header("origin");
  const headers: Record<string, string> = {
    "cache-control": "private, no-store",
    "content-type": "application/json; charset=utf-8",
    vary: "Origin, Cookie",
  };
  const reply = (body: object, status = 200) =>
    new Response(JSON.stringify(body), { status, headers });

  if (!/^[a-z0-9]{12,32}$/i.test(tenantParam) || !/^\d+$/.test(postParam))
    return reply({ error: "Invalid request." }, 400);

  const tenant = await tenantByPublicId(c.env, tenantParam);
  if (!tenant) return reply({ error: "Blog not found." }, 404);

  if (origin && origin !== requestOrigin) {
    let originHost = "";
    try {
      const parsed = new URL(origin);
      if (parsed.protocol === "https:" || parsed.protocol === "http:")
        originHost = parsed.hostname.toLowerCase();
    } catch {
      // Invalid origins remain disallowed.
    }
    const platformHost = `${tenant.slug}.${c.env.ROOT_DOMAIN}`.toLowerCase();
    const customHost = (tenant.custom_domain || "").toLowerCase();
    const managedDomain = originHost
      ? await c.env.DB.prepare(
          "SELECT 1 FROM domains WHERE tenant_id = ? AND hostname = ? AND status = 'active'"
        ).bind(tenant.id, originHost).first()
      : null;
    if (originHost !== platformHost && originHost !== customHost && !managedDomain)
      return reply({ error: "Forbidden." }, 403);
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-credentials"] = "true";
  }

  const account = await currentAccount(c);
  if (!account) return reply({ error: "Signed out." }, 401);
  const membership = await c.env.DB.prepare(
    "SELECT 1 FROM memberships WHERE tenant_id = ? AND account_id = ?"
  ).bind(tenant.id, account.id).first();
  if (!membership) return reply({ error: "Forbidden." }, 403);

  const post = await tenantDb(c.env, tenant).prepare(
    "SELECT id FROM posts WHERE id = ? AND tenant_id = ?"
  ).bind(postParam, tenant.id).first();
  if (!post) return reply({ error: "Post not found." }, 404);

  return reply({ url: `${requestOrigin}/admin/b/${tenant.public_id}/edit/${postParam}` });
});

app.get("/_blognice/blog-edit-link", async (c) => {
  const tenant = await tenantByPublicId(c.env, c.req.query("tenant") || "");
  const account = await currentAccount(c);
  if (!tenant || !account) return new Response(JSON.stringify({ error: "Forbidden." }), { status: 403, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
  const membership = await c.env.DB.prepare("SELECT role FROM memberships WHERE tenant_id = ? AND account_id = ?").bind(tenant.id, account.id).first<{ role: MembershipRole }>();
  if (!membership || membership.role !== "owner") return new Response(JSON.stringify({ error: "Forbidden." }), { status: 403, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
  return new Response(JSON.stringify({ url: `${adminOriginOf(c)}/admin/b/${tenant.public_id}/settings` }), { headers: { "content-type": "application/json", "cache-control": "private, no-store", vary: "Cookie" } });
});

app.get("/sitemap.xml", async (c) => {
  return serveCached(c, async () => {
    const tenant = await resolveTenant(c.env, c.req.header("host") || "");
    if (!tenant) return new Response("Not found", { status: 404 });

    const origin = originOf(c);
    const { results } = await tenantDb(c.env, tenant).prepare(
      "SELECT slug, updated_at FROM posts WHERE tenant_id = ? AND published = 1 ORDER BY created_at DESC"
    )
      .bind(tenant.id)
      .all<{ slug: string; updated_at: number }>();

    const urls = [
      `<url><loc>${esc(origin)}/</loc></url>`,
      ...results.map(
        (r) =>
          `<url><loc>${esc(origin)}/${esc(r.slug)}</loc>` +
          `<lastmod>${new Date(r.updated_at * 1000).toISOString()}</lastmod></url>`
      ),
    ].join("");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
    return new Response(xml, {
      status: 200,
      headers: { "content-type": "application/xml; charset=utf-8" },
    });
  });
});

function rssText(markdown: string, max = 320): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

app.get("/rss.xml", async (c) => {
  return serveCached(c, async () => {
    const tenant = await resolveTenant(c.env, c.req.header("host") || "");
    if (!tenant) return new Response("Not found", { status: 404 });
    const origin = originOf(c);
    const { results } = await tenantDb(c.env, tenant).prepare(
      "SELECT id, slug, title, body_md, created_at, updated_at FROM posts WHERE tenant_id = ? AND published = 1 ORDER BY created_at DESC LIMIT 50"
    ).bind(tenant.id).all<{ id: number; slug: string; title: string; body_md: string; created_at: number; updated_at: number }>();
    const items = results.map((post) => {
      const url = `${origin}/${post.slug}`;
      const description = rssText(post.body_md);
      return `<item><title>${esc(post.title)}</title><link>${esc(url)}</link><guid isPermaLink="true">${esc(url)}</guid><pubDate>${new Date(post.created_at * 1000).toUTCString()}</pubDate><description>${esc(description)}</description></item>`;
    }).join("");
    const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${esc(tenant.title)}</title><link>${esc(origin + "/")}</link><description>${esc(tenant.description || tenant.title)}</description><language>en-us</language>${items}</channel></rss>`;
    return new Response(xml, { headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=300" } });
  });
});

app.get("/tag/:tag", async (c) => {
  const tenant = await resolveTenant(c.env, c.req.header("host") || "");
  if (!tenant) return c.text("Not found", 404);
  const tag = String(c.req.param("tag") || "").trim().toLowerCase();
  const { results } = await tenantDb(c.env, tenant).prepare(
    "SELECT slug, title, body_md, created_at, tags_json FROM posts WHERE tenant_id = ? AND published = 1 ORDER BY created_at DESC LIMIT 200"
  ).bind(tenant.id).all<{ slug: string; title: string; body_md: string; created_at: number; tags_json: string | null }>();
  const posts = results.filter((post) => {
    try { return JSON.parse(post.tags_json || "[]").includes(tag); } catch { return false; }
  });
  const inner = posts.length
    ? `<ul class="feed">${posts.map((post) => `<li><h2><a href="/${esc(post.slug)}">${esc(post.title)}</a></h2><p>${esc(post.body_md.replace(/[#>*_`~]/g, " ").replace(/\s+/g, " ").trim().slice(0, 220))}</p><small>${new Date(post.created_at * 1000).toLocaleDateString("en-US", { timeZone: "UTC" })}</small></li>`).join("")}</ul>`
    : `<p>No published posts use this tag yet.</p>`;
  return c.html(renderSimplePage(tenant, `#${tag}`, inner));
});

// Create a post. Auth: Authorization: Bearer <API_TOKEN>.
// Body (JSON): { tenant_slug, slug, title, body_md, published? }
app.post("/api/posts", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);

  let payload: any;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const { tenant_slug, slug, title, body_md } = payload ?? {};
  const published = payload?.published === false ? 0 : 1;
  if (!tenant_slug || !slug || !title || !body_md) {
    return c.json(
      { error: "tenant_slug, slug, title and body_md are required" },
      400
    );
  }

  const tenant = await c.env.DB.prepare("SELECT * FROM tenants WHERE slug = ?")
    .bind(tenant_slug)
    .first<Tenant>();
  if (!tenant) return c.json({ error: "unknown tenant" }, 404);

  const hasFeaturedImage = Object.prototype.hasOwnProperty.call(payload ?? {}, "featured_image_key");
  let featuredImageKey: string | null;
  try {
    featuredImageKey = hasFeaturedImage
      ? await checkedFeaturedImage(c.env, tenant.id, payload.featured_image_key)
      : null;
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  try {
    await tenantDb(c.env, tenant).prepare(
      `INSERT INTO posts (tenant_id, slug, title, featured_image_key, body_md, published, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, slug)
       DO UPDATE SET title = excluded.title,
                     featured_image_key = CASE WHEN ? = 1 THEN excluded.featured_image_key ELSE posts.featured_image_key END,
                     body_md = excluded.body_md,
                     published = excluded.published, updated_at = excluded.updated_at`
    )
      .bind(tenant.id, slug, title, featuredImageKey, body_md, published, now, now, hasFeaturedImage ? 1 : 0)
      .run();
  } catch (e: any) {
    return c.json({ error: "db error", detail: String(e?.message ?? e) }, 500);
  }

  // Invalidate the pages this post affects.
  await purge(c, ["/", "/" + slug, "/sitemap.xml"]);

  return c.json({ ok: true, slug, published: !!published });
});

// ---------------------------------------------------------------------------
// Per-account API (v1). Auth: Authorization: Bearer <the account's API key>.
// Everything is scoped to blogs the account owns (membership check).
// ---------------------------------------------------------------------------

async function apiAccount(c: any): Promise<Account | null> {
  const m = (c.req.header("authorization") || "").match(/^Bearer\s+(.+)$/i);
  return m ? accountFromApiKey(c.env.DB, m[1].trim()) : null;
}

async function ownedTenantById(
  env: Bindings,
  accountId: number,
  blogId: string | number
): Promise<Tenant | null> {
  return (await env.DB.prepare(
    `SELECT t.* FROM tenants t
       JOIN memberships m ON m.tenant_id = t.id
      WHERE t.public_id = ? AND m.account_id = ?`
  )
    .bind(blogId, accountId)
    .first<Tenant>()) ?? null;
}

// Who am I + which blogs do I own.
app.get("/api/v1/me", async (c) => {
  const account = await apiAccount(c);
  if (!account) return c.json({ error: "unauthorized" }, 401);
  const { results } = await c.env.DB.prepare(
    `SELECT t.public_id, t.slug, t.title FROM tenants t
       JOIN memberships m ON m.tenant_id = t.id
      WHERE m.account_id = ? ORDER BY t.created_at`
  )
    .bind(account.id)
    .all();
  return c.json({ id: account.id, email: account.email, blogs: results });
});

// List a blog's posts.
app.get("/api/v1/blogs/:blogId/posts", async (c) => {
  const account = await apiAccount(c);
  if (!account) return c.json({ error: "unauthorized" }, 401);
  const tenant = await ownedTenantById(c.env, account.id, c.req.param("blogId"));
  if (!tenant) return c.json({ error: "blog not found" }, 404);
  const { results } = await tenantDb(c.env, tenant).prepare(
    `SELECT id, slug, title, featured_image_key, published, created_at, updated_at
       FROM posts WHERE tenant_id = ? ORDER BY created_at DESC`
  )
    .bind(tenant.id)
    .all();
  return c.json({ posts: results });
});

// Fetch one post (including its Markdown body).
app.get("/api/v1/blogs/:blogId/posts/:id", async (c) => {
  const account = await apiAccount(c);
  if (!account) return c.json({ error: "unauthorized" }, 401);
  const tenant = await ownedTenantById(c.env, account.id, c.req.param("blogId"));
  if (!tenant) return c.json({ error: "blog not found" }, 404);
  const post = await tenantDb(c.env, tenant).prepare(
    "SELECT * FROM posts WHERE id = ? AND tenant_id = ?"
  )
    .bind(c.req.param("id"), tenant.id)
    .first();
  if (!post) return c.json({ error: "post not found" }, 404);
  return c.json({ post });
});

// Create a post. Body (JSON): { title, body_md, slug?, published? }
app.post("/api/v1/blogs/:blogId/posts", async (c) => {
  const account = await apiAccount(c);
  if (!account) return c.json({ error: "unauthorized" }, 401);
  const tenant = await ownedTenantById(c.env, account.id, c.req.param("blogId"));
  if (!tenant) return c.json({ error: "blog not found" }, 404);
  const role = await membershipRoleFor(c.env, account.id, tenant.id);
  if (!role || !can(role, "posts.create")) return c.json({ error: "forbidden" }, 403);

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const title = String(body?.title ?? "").trim();
  const body_md = String(body?.body_md ?? "");
  if (!title || !body_md)
    return c.json({ error: "title and body_md are required" }, 400);
  const slug = (String(body?.slug ?? "").trim() || slugify(title)).slice(0, 80);
  const published = body?.published === false ? 0 : 1;
  if (published && !can(role, "posts.publish")) return c.json({ error: "publishing is not permitted for this role" }, 403);
  let featuredImageKey: string | null;
  try {
    featuredImageKey = await checkedFeaturedImage(c.env, tenant.id, body?.featured_image_key);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
  const now = Math.floor(Date.now() / 1000);

  const pdb = tenantDb(c.env, tenant);
  const exists = await pdb
    .prepare("SELECT 1 FROM posts WHERE tenant_id = ? AND slug = ?")
    .bind(tenant.id, slug)
    .first();
  if (exists)
    return c.json({ error: `a post with slug "${slug}" already exists` }, 409);

  const res = await pdb.prepare(
    `INSERT INTO posts (tenant_id, slug, title, featured_image_key, body_md, published, created_at, updated_at, author_account_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(tenant.id, slug, title, featuredImageKey, body_md, published, now, now, account.id)
    .run();
  c.executionCtx.waitUntil(
    purgeTenant(c.env, tenant, ["/", "/" + slug, "/sitemap.xml"])
  );
  return c.json({ post: { id: res.meta.last_row_id, slug, title, featured_image_key: featuredImageKey, published: !!published } }, 201);
});

// Update a post. Body (JSON): any of { title, body_md, slug, published }
app.patch("/api/v1/blogs/:blogId/posts/:id", async (c) => {
  const account = await apiAccount(c);
  if (!account) return c.json({ error: "unauthorized" }, 401);
  const tenant = await ownedTenantById(c.env, account.id, c.req.param("blogId"));
  if (!tenant) return c.json({ error: "blog not found" }, 404);
  const role = await membershipRoleFor(c.env, account.id, tenant.id);
  if (!role || (!can(role, "posts.edit.any") && !can(role, "posts.edit.own"))) return c.json({ error: "forbidden" }, 403);

  const pdb = tenantDb(c.env, tenant);
  const post = await pdb
    .prepare("SELECT * FROM posts WHERE id = ? AND tenant_id = ?")
    .bind(c.req.param("id"), tenant.id)
    .first<any>();
  if (!post) return c.json({ error: "post not found" }, 404);
  if (!can(role, "posts.edit.any") && post.author_account_id !== account.id)
    return c.json({ error: "forbidden" }, 403);

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const title = body?.title !== undefined ? String(body.title).trim() : post.title;
  const body_md = body?.body_md !== undefined ? String(body.body_md) : post.body_md;
  const slug = (body?.slug !== undefined ? String(body.slug).trim() : post.slug).slice(0, 80);
  const published =
    body?.published !== undefined ? (body.published ? 1 : 0) : post.published;
  if (published && !can(role, "posts.publish")) return c.json({ error: "publishing is not permitted for this role" }, 403);
  let featuredImageKey = post.featured_image_key as string | null;
  if (body?.featured_image_key !== undefined) {
    try {
      featuredImageKey = await checkedFeaturedImage(c.env, tenant.id, body.featured_image_key);
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  }
  const now = Math.floor(Date.now() / 1000);

  if (slug !== post.slug) {
    const clash = await pdb
      .prepare("SELECT 1 FROM posts WHERE tenant_id = ? AND slug = ? AND id <> ?")
      .bind(tenant.id, slug, post.id)
      .first();
    if (clash) return c.json({ error: `slug "${slug}" already in use` }, 409);
  }

  await pdb.prepare(
    `UPDATE posts SET title = ?, featured_image_key = ?, body_md = ?, slug = ?, published = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?`
  )
    .bind(title, featuredImageKey, body_md, slug, published, now, post.id, tenant.id)
    .run();
  c.executionCtx.waitUntil(
    purgeTenant(c.env, tenant, ["/", "/" + post.slug, "/" + slug, "/sitemap.xml"])
  );
  return c.json({ post: { id: post.id, slug, title, featured_image_key: featuredImageKey, published: !!published } });
});

// Delete a post.
app.delete("/api/v1/blogs/:blogId/posts/:id", async (c) => {
  const account = await apiAccount(c);
  if (!account) return c.json({ error: "unauthorized" }, 401);
  const tenant = await ownedTenantById(c.env, account.id, c.req.param("blogId"));
  if (!tenant) return c.json({ error: "blog not found" }, 404);
  const role = await membershipRoleFor(c.env, account.id, tenant.id);
  if (!role || !can(role, "posts.delete")) return c.json({ error: "forbidden" }, 403);
  const pdb = tenantDb(c.env, tenant);
  const post = await pdb
    .prepare("SELECT slug FROM posts WHERE id = ? AND tenant_id = ?")
    .bind(c.req.param("id"), tenant.id)
    .first<{ slug: string }>();
  if (!post) return c.json({ error: "post not found" }, 404);
  await pdb.prepare("DELETE FROM posts WHERE id = ? AND tenant_id = ?")
    .bind(c.req.param("id"), tenant.id)
    .run();
  c.executionCtx.waitUntil(
    purgeTenant(c.env, tenant, ["/", "/" + post.slug, "/sitemap.xml"])
  );
  return c.json({ ok: true });
});

// Queue AI image generation for an account-owned blog. Body:
// { prompt?, style?, post_id? }. If post_id is supplied, the result becomes
// that post's featured image when the job completes.
app.post("/api/v1/blogs/:blogId/images/generations", async (c) => {
  const account = await apiAccount(c);
  if (!account) return c.json({ error: "unauthorized" }, 401);
  const tenant = await ownedTenantById(c.env, account.id, c.req.param("blogId"));
  if (!tenant) return c.json({ error: "blog not found" }, 404);
  const role = await membershipRoleFor(c.env, account.id, tenant.id);
  if (!role || !can(role, "media.upload")) return c.json({ error: "forbidden" }, 403);
  if (oversizedAiRequest(c.req.raw)) return c.json({ error: "request too large" }, 413);
  let input: { prompt?: unknown; style?: unknown; post_id?: unknown };
  try { input = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
  const userPrompt = String(input.prompt ?? "").trim();
  if (userPrompt.length > 1200) return c.json({ error: "prompt must be 1,200 characters or fewer" }, 400);
  const style: ImageStyle = IMAGE_STYLES.has(input.style as ImageStyle) ? input.style as ImageStyle : "auto";
  let postId: number | undefined;
  let postTitle = "";
  let postBody = "";
  if (input.post_id !== undefined && input.post_id !== null && String(input.post_id) !== "") {
    postId = Number(input.post_id);
    if (!Number.isInteger(postId) || postId < 1) return c.json({ error: "post_id must be a valid post id" }, 400);
    const post = await tenantDb(c.env, tenant).prepare("SELECT title, body_md FROM posts WHERE id = ? AND tenant_id = ?")
      .bind(postId, tenant.id).first<{ title: string; body_md: string }>();
    if (!post) return c.json({ error: "post not found" }, 404);
    postTitle = post.title; postBody = post.body_md;
  }
  if (!userPrompt && !postId) return c.json({ error: "prompt or post_id is required" }, 400);
  const source = buildSourceContext({
    prompt: userPrompt, mode: userPrompt ? "prompt" : "post",
    blogTitle: tenant.title, blogDescription: tenant.description,
    postTitle: postTitle.slice(0, 500), postBody: postBody.slice(0, 20_000),
  });
  const jobId = crypto.randomUUID();
  const jobKey = `${tenant.id}/.image-jobs/${jobId}.json`;
  const job: ImageJobManifest = { tenantId: tenant.id, postId, source, style, status: "queued" };
  await writeImageJob(c.env, jobKey, job);
  await c.env.AUDIO_QUEUE.send({ kind: "image", jobKey, tenantId: tenant.id });
  return c.json({ job_id: jobId, status: job.status, status_url: `/api/v1/blogs/${tenant.public_id}/images/generations/${jobId}` }, 202);
});

app.get("/api/v1/blogs/:blogId/images/generations/:jobId", async (c) => {
  const account = await apiAccount(c);
  if (!account) return c.json({ error: "unauthorized" }, 401);
  const tenant = await ownedTenantById(c.env, account.id, c.req.param("blogId"));
  if (!tenant) return c.json({ error: "blog not found" }, 404);
  const jobId = c.req.param("jobId");
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return c.json({ error: "image job not found" }, 404);
  try {
    const job = await readImageJob(c.env, `${tenant.id}/.image-jobs/${jobId}.json`);
    if (job.tenantId !== tenant.id) return c.json({ error: "image job not found" }, 404);
    return c.json({ job_id: jobId, status: job.status, url: job.url, key: job.key, markdown: job.markdown, attached_post_id: job.postId, brief_fallback: job.briefFallback, error: job.error });
  } catch { return c.json({ error: "image job not found" }, 404); }
});

app.post("/api/v1/blogs/:blogId/posts/:id/audio/generations", async (c) => {
  const account = await apiAccount(c);
  if (!account) return c.json({ error: "unauthorized" }, 401);
  const tenant = await ownedTenantById(c.env, account.id, c.req.param("blogId"));
  if (!tenant) return c.json({ error: "blog not found" }, 404);
  const role = await membershipRoleFor(c.env, account.id, tenant.id);
  if (!role || !can(role, "media.upload")) return c.json({ error: "forbidden" }, 403);
  const post = await tenantDb(c.env, tenant).prepare("SELECT id, slug, title, body_md, audio_key FROM posts WHERE id = ? AND tenant_id = ?")
    .bind(c.req.param("id"), tenant.id).first<Pick<Post, "id" | "slug" | "title" | "body_md" | "audio_key">>();
  if (!post) return c.json({ error: "post not found" }, 404);
  if (post.audio_key) return c.json({ error: "remove the existing narration before generating a new version" }, 409);
  try {
    const job = await createAudioJob(c.env, tenant, post);
    return c.json({ job_id: job.jobId, status: "queued", segments: job.segments, status_url: `/api/v1/blogs/${tenant.public_id}/audio/generations/${job.jobId}` }, 202);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

app.get("/api/v1/blogs/:blogId/audio/generations/:jobId", async (c) => {
  const account = await apiAccount(c);
  if (!account) return c.json({ error: "unauthorized" }, 401);
  const tenant = await ownedTenantById(c.env, account.id, c.req.param("blogId"));
  if (!tenant) return c.json({ error: "blog not found" }, 404);
  const jobId = c.req.param("jobId");
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return c.json({ error: "audio job not found" }, 404);
  try {
    const job = await readAudioJob(c.env, `${tenant.id}/.audio-jobs/${jobId}.json`);
    if (job.tenantId !== tenant.id) return c.json({ error: "audio job not found" }, 404);
    return c.json({ job_id: jobId, post_id: job.postId, status: job.status, completed: job.completed, segments: job.prompts.length, url: job.audioKey ? `/media/${job.audioKey}` : undefined, error: job.error });
  } catch { return c.json({ error: "audio job not found" }, 404); }
});

// ---------------------------------------------------------------------------
// Custom domain onboarding (Cloudflare for SaaS). All require the API token.
// ---------------------------------------------------------------------------

// Connect a customer's domain to a tenant. Registers the hostname with
// Cloudflare and returns the DNS records the customer needs to add.
// Body (JSON): { tenant_slug, hostname }
app.post("/api/domains", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);

  let payload: any;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const tenant_slug = String(payload?.tenant_slug ?? "");
  const hostname = String(payload?.hostname ?? "")
    .trim()
    .toLowerCase();

  if (!tenant_slug || !hostname)
    return c.json({ error: "tenant_slug and hostname are required" }, 400);
  if (!validHostname(hostname, c.env.ROOT_DOMAIN.toLowerCase()))
    return c.json(
      {
        error:
          "invalid hostname. Use a subdomain like blog.theircompany.com, not your own zone.",
      },
      400
    );

  const tenant = await c.env.DB.prepare("SELECT * FROM tenants WHERE slug = ?")
    .bind(tenant_slug)
    .first<Tenant>();
  if (!tenant) return c.json({ error: "unknown tenant" }, 404);

  // Is this hostname already claimed by a different tenant?
  const existing = await c.env.DB.prepare(
    "SELECT tenant_id FROM domains WHERE hostname = ?"
  )
    .bind(hostname)
    .first<{ tenant_id: number }>();
  if (existing && existing.tenant_id !== tenant.id)
    return c.json({ error: "hostname already connected to another blog" }, 409);

  // Register with Cloudflare (or fetch the existing registration).
  let created = await createCustomHostname(c.env, hostname);
  if (!created.ok) {
    const found = await findCustomHostname(c.env, hostname);
    const hit = Array.isArray(found.result) ? found.result[0] : null;
    if (hit) created = { ...created, ok: true, result: hit };
    else
      return c.json(
        { error: "cloudflare rejected the hostname", detail: created.errors },
        502
      );
  }

  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    `INSERT INTO domains (hostname, tenant_id, cf_hostname_id, status, created_at)
     VALUES (?, ?, ?, 'pending', ?)
     ON CONFLICT (hostname)
     DO UPDATE SET cf_hostname_id = excluded.cf_hostname_id`
  )
    .bind(hostname, tenant.id, created.result?.id ?? null, now)
    .run();

  return c.json(instructions(c.env, hostname, created.result));
});

// Check verification status; flips the domain live once Cloudflare reports it
// active. Poll this from your onboarding UI until { active: true }.
app.get("/api/domains/:hostname", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);

  const hostname = c.req.param("hostname").toLowerCase();
  const row = await c.env.DB.prepare(
    "SELECT * FROM domains WHERE hostname = ?"
  )
    .bind(hostname)
    .first<{ tenant_id: number; cf_hostname_id: string; status: string }>();
  if (!row) return c.json({ error: "hostname not found" }, 404);

  const cfRes = row.cf_hostname_id
    ? await getCustomHostname(c.env, row.cf_hostname_id)
    : await findCustomHostname(c.env, hostname);
  const result = Array.isArray(cfRes.result) ? cfRes.result[0] : cfRes.result;
  if (!result) return c.json({ error: "not found at cloudflare" }, 404);

  // Activate on first confirmed success.
  if (isActive(result) && row.status !== "active") {
    await c.env.DB.prepare(
      "UPDATE domains SET status = 'active' WHERE hostname = ?"
    )
      .bind(hostname)
      .run();
    // Convenience mirror for the simple single-domain case.
    await c.env.DB.prepare(
      "UPDATE tenants SET custom_domain = ? WHERE id = ?"
    )
      .bind(hostname, row.tenant_id)
      .run();
    c.executionCtx.waitUntil(purgeHost(hostname, ["/", "/sitemap.xml"]));
  }

  return c.json(instructions(c.env, hostname, result));
});

// Disconnect a domain.
app.delete("/api/domains/:hostname", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);

  const hostname = c.req.param("hostname").toLowerCase();
  const row = await c.env.DB.prepare(
    "SELECT cf_hostname_id, tenant_id FROM domains WHERE hostname = ?"
  )
    .bind(hostname)
    .first<{ cf_hostname_id: string; tenant_id: number }>();
  if (!row) return c.json({ error: "hostname not found" }, 404);

  if (row.cf_hostname_id)
    await deleteCustomHostname(c.env, row.cf_hostname_id);

  await c.env.DB.prepare("DELETE FROM domains WHERE hostname = ?")
    .bind(hostname)
    .run();
  await c.env.DB.prepare(
    "UPDATE tenants SET custom_domain = NULL WHERE custom_domain = ?"
  )
    .bind(hostname)
    .run();

  return c.json({ ok: true, hostname, removed: true });
});

// ---------------------------------------------------------------------------
// Accounts (platform token). Create/reset a login and grant it a blog.
// Body (JSON): { tenant_slug, email, password }
// If the email already exists, its password is reset and it's given access to
// the blog (so this doubles as "add an owner to a blog").
// ---------------------------------------------------------------------------
app.post("/api/users", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);

  let payload: any;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const tenant_slug = String(payload?.tenant_slug ?? "");
  const email = String(payload?.email ?? "").trim().toLowerCase();
  const password = String(payload?.password ?? "");
  if (!tenant_slug || !email || password.length < 8)
    return c.json(
      { error: "tenant_slug, email and a password (8+ chars) are required" },
      400
    );

  const tenant = await c.env.DB.prepare("SELECT * FROM tenants WHERE slug = ?")
    .bind(tenant_slug)
    .first<Tenant>();
  if (!tenant) return c.json({ error: "unknown tenant" }, 404);

  const pw_hash = await hashPassword(password);
  const now = Math.floor(Date.now() / 1000);

  // Upsert the account (reset password if it already exists).
  await c.env.DB.prepare(
    `INSERT INTO accounts (email, pw_hash, created_at) VALUES (?, ?, ?)
     ON CONFLICT (email) DO UPDATE SET pw_hash = excluded.pw_hash`
  )
    .bind(email, pw_hash, now)
    .run();
  const account = await c.env.DB.prepare("SELECT id FROM accounts WHERE email = ?")
    .bind(email)
    .first<{ id: number }>();

  // Grant access to the blog (no-op if already granted).
  await c.env.DB.prepare(
    `INSERT INTO memberships (account_id, tenant_id, role, created_at)
     VALUES (?, ?, 'owner', ?) ON CONFLICT (account_id, tenant_id) DO NOTHING`
  )
    .bind(account!.id, tenant.id, now)
    .run();

  return c.json({ ok: true, email, tenant: tenant_slug });
});

// ---------------------------------------------------------------------------
// Admin UI. Session-cookie auth. An account can manage several blogs; every
// blog-scoped route resolves the blog from the URL and verifies membership.
// ---------------------------------------------------------------------------

// The blog identified by :blogId, but ONLY if the logged-in account owns it.
// Returns null if there's no session, or the account doesn't have access.
async function ownedBlog(c: any, account: Account): Promise<Tenant | null> {
  return (await c.env.DB.prepare(
    `SELECT t.*, m.role AS membership_role FROM tenants t
       JOIN memberships m ON m.tenant_id = t.id
      WHERE t.public_id = ? AND m.account_id = ?`
  )
    .bind(c.req.param("blogId"), account.id)
    .first()) as (Tenant & { membership_role: MembershipRole }) | null;
}

async function membershipRoleFor(
  env: Bindings,
  accountId: number,
  tenantId: number
): Promise<MembershipRole | null> {
  const row = await env.DB.prepare(
    "SELECT role FROM memberships WHERE tenant_id = ? AND account_id = ?"
  ).bind(tenantId, accountId).first<{ role: MembershipRole }>();
  return row?.role ?? null;
}

async function postAuthors(env: Bindings, tenant: Tenant): Promise<Array<{ id: number; label: string; email: string; displayName: string | null }>> {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.email, m.role, m.display_name FROM memberships m
       JOIN accounts a ON a.id = m.account_id
      WHERE m.tenant_id = ?
      ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, a.email`
  ).bind(tenant.id).all<{ id: number; email: string; role: MembershipRole; display_name: string | null }>();
  return results.map((author) => ({
    id: author.id,
    email: author.email,
    displayName: author.display_name,
    label: `${author.display_name || author.email} — ${author.role}`,
  }));
}

// Resolve { account, tenant } for a blog-scoped route, or an appropriate
// redirect: to login if signed out, to the blog list if the blog isn't theirs.
async function blogContext(
  c: any
): Promise<
  { account: Account; tenant: Tenant; role: MembershipRole } | { redirect: string }
> {
  const account = await currentAccount(c);
  if (!account) return { redirect: "/admin/login" };
  const tenant = await ownedBlog(c, account);
  if (!tenant) return { redirect: "/admin" };
  return { account, tenant, role: (tenant as Tenant & { membership_role: MembershipRole }).membership_role };
}

function requireBlogCapability(
  c: any,
  ctx: { role: MembershipRole },
  capability: Capability
): Response | null {
  if (can(ctx.role, capability)) return null;
  return c.text("You do not have permission to perform this action.", 403);
}

async function checkedFeaturedImage(
  env: Bindings,
  tenantId: number,
  value: unknown
): Promise<string | null> {
  const key = String(value ?? "").trim();
  if (!key) return null;
  const prefix = `${tenantId}/`;
  const file = key.startsWith(prefix) ? key.slice(prefix.length) : "";
  if (!file || !validLibraryFile(file) || key !== mediaKey(tenantId, file))
    throw new Error("Invalid featured image.");
  if (!(await env.MEDIA.head(key))) throw new Error("Featured image not found.");
  return key;
}

app.get("/admin/login", async (c) => {
  if (await currentAccount(c)) return c.redirect("/admin");
  return c.html(loginPage());
});

// --- API key management (session-authenticated) ----------------------------

async function accountBlogsForDocs(env: Bindings, account: Account): Promise<Array<{ public_id: string; title: string; slug: string }>> {
  const { results } = await env.DB.prepare(
    `SELECT t.public_id, t.title, t.slug FROM tenants t
       JOIN memberships m ON m.tenant_id = t.id
      WHERE m.account_id = ? ORDER BY t.title`
  ).bind(account.id).all<{ public_id: string; title: string; slug: string }>();
  return results;
}

app.get("/admin/api-key", async (c) => {
  const account = await currentAccount(c);
  if (!account) return c.redirect("/admin/login");
  const row = await c.env.DB.prepare(
    "SELECT api_key_created_at FROM accounts WHERE id = ?"
  )
    .bind(account.id)
    .first<{ api_key_created_at: number | null }>();
  return c.html(
    apiKeyPage(account, c.env.ROOT_DOMAIN, {
      createdAt: row?.api_key_created_at ?? null,
      blogs: await accountBlogsForDocs(c.env, account),
    })
  );
});

app.post("/admin/api-key/regenerate", async (c) => {
  const account = await currentAccount(c);
  if (!account) return c.redirect("/admin/login");
  const key = generateApiKey();
  const hash = await sha256hex(key);
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    "UPDATE accounts SET api_key_hash = ?, api_key_created_at = ? WHERE id = ?"
  )
    .bind(hash, now, account.id)
    .run();
  // Show the key exactly once.
  return c.html(
    apiKeyPage(account, c.env.ROOT_DOMAIN, { createdAt: now, newKey: key, blogs: await accountBlogsForDocs(c.env, account) })
  );
});

app.post("/admin/api-key/revoke", async (c) => {
  const account = await currentAccount(c);
  if (!account) return c.redirect("/admin/login");
  await c.env.DB.prepare(
    "UPDATE accounts SET api_key_hash = NULL, api_key_created_at = NULL WHERE id = ?"
  )
    .bind(account.id)
    .run();
  return c.redirect("/admin/api-key");
});

app.post("/admin/login", async (c) => {
  const form = await c.req.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");

  const account = await c.env.DB.prepare(
    "SELECT id, pw_hash FROM accounts WHERE email = ?"
  )
    .bind(email)
    .first<{ id: number; pw_hash: string }>();

  const ok = account ? await verifyPassword(password, account.pw_hash) : false;
  if (!ok) return c.html(loginPage("Wrong email or password."), 401);

  const token = await createSession(c.env.DB, account!.id);
  setSessionCookie(c, token);
  return c.redirect("/admin");
});

app.post("/admin/logout", async (c) => {
  const token = getSessionToken(c);
  if (token) await destroySession(c.env.DB, token);
  clearSessionCookie(c);
  return c.redirect("/admin/login");
});

// Account home: the list of this account's blogs.
app.get("/admin", async (c) => {
  const account = await currentAccount(c);
  if (!account) return c.redirect("/admin/login");
  const { results } = await c.env.DB.prepare(
    `SELECT t.public_id, t.slug, t.title, m.role FROM tenants t
       JOIN memberships m ON m.tenant_id = t.id
      WHERE m.account_id = ? ORDER BY t.title`
  )
    .bind(account.id)
    .all<{ public_id: string; slug: string; title: string; role: MembershipRole }>();
  const owned = results.filter((blog) => blog.role === "owner");
  const collaborations = results.filter((blog) => blog.role !== "owner");
  // With exactly one blog, jump straight in — unless the list was asked for
  // explicitly (the "Blogs" nav link), so that link always shows the picker.
  const forceList = c.req.query("list");
  if (!forceList && owned.length === 1 && collaborations.length === 0)
    return c.redirect(`/admin/b/${owned[0].public_id}`);
  return c.html(blogListPage(account, owned, collaborations, c.env.ROOT_DOMAIN));
});

app.get("/admin/blogs.json", async (c) => {
  const account = await currentAccount(c);
  if (!account) return c.json({ error: "Signed out." }, 401);
  const { results } = await c.env.DB.prepare(
    `SELECT t.public_id, t.slug, t.title, m.role FROM tenants t
       JOIN memberships m ON m.tenant_id = t.id
      WHERE m.account_id = ? ORDER BY t.title`
  ).bind(account.id).all<{ public_id: string; slug: string; title: string; role: MembershipRole }>();
  return c.json({ blogs: results });
});

// Create another blog for the logged-in account.
app.get("/admin/new-blog", async (c) => {
  const account = await currentAccount(c);
  if (!account) return c.redirect("/admin/login");
  return c.html(newBlogPage(account, c.env.ROOT_DOMAIN));
});

app.post("/admin/new-blog", async (c) => {
  const account = await currentAccount(c);
  if (!account) return c.redirect("/admin/login");

  const form = await c.req.formData();
  const slug = String(form.get("slug") ?? "").trim().toLowerCase();
  const title = String(form.get("title") ?? "").trim();
  const values = { slug, title };
  const fail = (msg: string, status: 400 | 409 = 400) =>
    c.html(newBlogPage(account, c.env.ROOT_DOMAIN, values, msg), status);

  const ownedCount = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM memberships WHERE account_id = ? AND role = 'owner'"
  ).bind(account.id).first<{ count: number }>();
  if ((ownedCount?.count ?? 0) >= 5)
    return fail("Your account can own up to five blogs. Collaborations do not count toward this limit.", 409);

  const slugError = validateSlug(slug);
  if (slugError) return fail(slugError);
  if (!title) return fail("Please enter a blog title.");
  if (await c.env.DB.prepare("SELECT 1 FROM tenants WHERE slug = ?").bind(slug).first())
    return fail("That address is already taken.", 409);

  const now = Math.floor(Date.now() / 1000);
  let blogId: number;
  const publicId = newPublicId();
  try {
    const res = await c.env.DB.prepare(
      "INSERT INTO tenants (public_id, slug, title, description, shard, created_at) VALUES (?, ?, ?, '', 'primary', ?)"
    )
      .bind(publicId, slug, title, now)
      .run();
    blogId = res.meta.last_row_id as number;
  } catch {
    return fail("That address is already taken.", 409);
  }
  await c.env.DB.prepare(
    "INSERT INTO memberships (account_id, tenant_id, role, created_at) VALUES (?, ?, 'owner', ?)"
  )
    .bind(account.id, blogId, now)
    .run();

  return c.redirect(`/admin/b/${publicId}`);
});

// Live Markdown preview (account-scoped; blog-agnostic).
app.post("/admin/preview", async (c) => {
  if (!(await currentAccount(c))) return c.text("", 401);
  const md = await c.req.text();
  return c.html(renderMarkdown(md));
});

// --- Blog-scoped post routes: /admin/b/:blogId/... -------------------------

// Post list for a blog.
app.get("/admin/b/:blogId", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.redirect(ctx.redirect);
  const { results } = await tenantDb(c.env, ctx.tenant).prepare(
    "SELECT * FROM posts WHERE tenant_id = ? ORDER BY created_at DESC"
  )
    .bind(ctx.tenant.id)
    .all<Post>();
  return c.html(postListPage(ctx.account, ctx.tenant, results, c.env.ROOT_DOMAIN));
});

// --- Collaborators --------------------------------------------------------
// Owners can invite an existing BlogNice account by email. The generated
// one-time link is shown to the owner so this works even when email delivery
// is not configured; the accepting account must have the invited email.
const COLLAB_ROLES = new Set<MembershipRole>(["editor", "author", "contributor"]);
function collaboratorPage(account: Account, tenant: Tenant, members: Array<{ account_id: number; email: string; role: string; display_name: string | null }>, invite?: string, error?: string): string {
  const rows = members.map((m) => `<tr><td>${esc(m.email)}</td><td>${esc(m.role)}</td><td><form method="post" style="display:flex;gap:.5rem;align-items:center"><input type="hidden" name="action" value="save-display-name"><input type="hidden" name="account_id" value="${m.account_id}"><input name="display_name" type="text" maxlength="120" value="${esc(m.display_name || "")}" placeholder="Public author name" aria-label="Public author name for ${esc(m.email)}"><button class="btn ghost" type="submit">Save</button></form></td></tr>`).join("");
  return shell("Collaborators", `<main class="page"><p class="breadcrumb"><a href="/admin/b/${esc(tenant.public_id)}">Posts</a> › Collaborators</p><h1>Collaborators</h1><p style="color:var(--muted);margin:-.8rem 0 1.6rem">Invite people to help write, edit, and publish posts according to their role.</p><div class="notice" style="margin-bottom:1.4rem"><strong>Author names</strong><br>Set a public author name for each person. This is what readers see next to <em>Author:</em> on published posts. It can differ from their login email and is specific to this blog; email addresses remain private.</div>${error ? `<div class="error">${esc(error)}</div>` : ""}<form method="post"><label for="collab-email">Email</label><input id="collab-email" type="email" name="email" required><label for="collab-role">Role</label><select id="collab-role" name="role"><option value="editor">Editor</option><option value="author">Author</option><option value="contributor">Contributor</option></select><div class="actions"><button class="btn" type="submit">Generate invite link</button></div></form>${invite ? `<div class="notice"><strong>Invite link generated</strong><br>Share this one-time link with the collaborator:<br><a href="${esc(invite)}">${esc(invite)}</a></div>` : ""}<h2>Current access</h2><table class="metrics"><thead><tr><th>Email</th><th>Role</th><th>Public author name</th></tr></thead><tbody>${rows}</tbody></table></main>`, account, tenant);
}

app.get("/admin/b/:blogId/authors", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.redirect(ctx.redirect);
  if (!can(ctx.role, "members.manage")) return c.text("You do not have permission to manage collaborators.", 403);
  const { results } = await c.env.DB.prepare(`SELECT m.account_id, a.email, m.role, m.display_name FROM memberships m JOIN accounts a ON a.id = m.account_id WHERE m.tenant_id = ? ORDER BY m.role, a.email`).bind(ctx.tenant.id).all<{ account_id: number; email: string; role: string; display_name: string | null }>();
  return c.html(collaboratorPage(ctx.account, ctx.tenant, results));
});

app.post("/admin/b/:blogId/authors", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.redirect(ctx.redirect);
  if (!can(ctx.role, "members.manage")) return c.text("You do not have permission to manage collaborators.", 403);
  const form = await c.req.formData();
  if (String(form.get("action") ?? "") === "save-display-name") {
    const accountId = Number(form.get("account_id") ?? 0);
    const displayName = String(form.get("display_name") ?? "").trim().slice(0, 120) || null;
    if (!Number.isInteger(accountId) || accountId < 1)
      return c.text("Invalid collaborator.", 400);
    await c.env.DB.prepare("UPDATE memberships SET display_name = ? WHERE tenant_id = ? AND account_id = ?")
      .bind(displayName, ctx.tenant.id, accountId).run();
    return c.redirect(`/admin/b/${ctx.tenant.public_id}/authors`);
  }
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const role = String(form.get("role") ?? "") as MembershipRole;
  const { results } = await c.env.DB.prepare(`SELECT m.account_id, a.email, m.role, m.display_name FROM memberships m JOIN accounts a ON a.id = m.account_id WHERE m.tenant_id = ? ORDER BY m.role, a.email`).bind(ctx.tenant.id).all<{ account_id: number; email: string; role: string; display_name: string | null }>();
  if (!/^\S+@\S+\.\S+$/.test(email) || !COLLAB_ROLES.has(role)) return c.html(collaboratorPage(ctx.account, ctx.tenant, results, undefined, "Enter a valid email and role."), 400);
  const account = await c.env.DB.prepare("SELECT id FROM accounts WHERE email = ?").bind(email).first<{ id: number }>();
  if (account) {
    const existing = await c.env.DB.prepare("SELECT 1 FROM memberships WHERE tenant_id = ? AND account_id = ?").bind(ctx.tenant.id, account.id).first();
    if (existing) return c.html(collaboratorPage(ctx.account, ctx.tenant, results, undefined, "That account already has access to this blog."), 409);
  }
  const token = crypto.randomUUID() + crypto.randomUUID().replaceAll("-", "");
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare("INSERT INTO blog_invitations (tenant_id,email,role,token_hash,invited_by,expires_at,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(ctx.tenant.id, email, role, await sha256hex(token), ctx.account.id, now + 7 * 86400, now).run();
  const origin = new URL(c.req.url).origin;
  return c.html(collaboratorPage(ctx.account, ctx.tenant, results, `${origin}/admin/invite/${token}`));
});

app.get("/admin/invite/:token", async (c) => {
  const account = await currentAccount(c);
  if (!account) return c.redirect(`/signup?invite=${encodeURIComponent(c.req.param("token"))}`);
  const tokenHash = await sha256hex(c.req.param("token"));
  const now = Math.floor(Date.now() / 1000);
  const invite = await c.env.DB.prepare("SELECT i.*, t.title FROM blog_invitations i JOIN tenants t ON t.id = i.tenant_id WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?").bind(tokenHash, now).first<{ id: number; tenant_id: number; email: string; role: MembershipRole; title: string }>();
  if (!invite) return c.text("This invitation is invalid or has expired.", 410);
  if (invite.email !== account.email) return c.text(`This invitation is for ${invite.email}. Sign in with that email to accept it.`, 403);
  await c.env.DB.prepare("INSERT INTO memberships (account_id, tenant_id, role, created_at) VALUES (?,?,?,?) ON CONFLICT(account_id,tenant_id) DO UPDATE SET role=excluded.role").bind(account.id, invite.tenant_id, invite.role, now).run();
  await c.env.DB.prepare("UPDATE blog_invitations SET accepted_at = ? WHERE id = ?").bind(now, invite.id).run();
  const tenant = await c.env.DB.prepare("SELECT public_id FROM tenants WHERE id = ?").bind(invite.tenant_id).first<{ public_id: string }>();
  return c.redirect(`/admin/b/${tenant?.public_id ?? ""}`);
});

app.get("/admin/b/:blogId/metrics", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.redirect(ctx.redirect);
  const requestedDays = Number(c.req.query("days") || "30");
  const days = [7, 30, 90].includes(requestedDays) ? requestedDays : 30;
  if (!metricsConfigured(c.env)) {
    return c.html(metricsPage(ctx.account, ctx.tenant, null, { days, configured: false }));
  }
  try {
    return c.html(
      metricsPage(ctx.account, ctx.tenant, await metricsReport(c.env, ctx.tenant.id, days))
    );
  } catch (error) {
    console.error(JSON.stringify({
      message: "metrics report failed",
      tenantId: ctx.tenant.id,
      error: error instanceof Error ? error.message : String(error),
    }));
    return c.html(metricsPage(ctx.account, ctx.tenant, null, { days }), 502);
  }
});

app.get("/admin/b/:blogId/new", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.redirect(ctx.redirect);
  const denied = requireBlogCapability(c, ctx, "posts.create");
  if (denied) return denied;
  return c.html(editorPage(ctx.account, ctx.tenant, c.env.ROOT_DOMAIN, null, undefined, can(ctx.role, "posts.edit.any") ? await postAuthors(c.env, ctx.tenant) : []));
});

app.get("/admin/b/:blogId/edit/:id", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.redirect(ctx.redirect);
  const post = await tenantDb(c.env, ctx.tenant).prepare(
    "SELECT * FROM posts WHERE id = ? AND tenant_id = ?"
  )
    .bind(c.req.param("id"), ctx.tenant.id)
    .first<Post>();
  if (!post) return c.redirect(`/admin/b/${ctx.tenant.public_id}`);
  if (!can(ctx.role, "posts.edit.any") &&
      !(can(ctx.role, "posts.edit.own") && post.author_account_id === ctx.account.id))
    return c.text("You do not have permission to edit this post.", 403);
  return c.html(editorPage(ctx.account, ctx.tenant, c.env.ROOT_DOMAIN, post, undefined, can(ctx.role, "posts.edit.any") ? await postAuthors(c.env, ctx.tenant) : []));
});

// Create or update a post. Scoped to the blog (which is ownership-checked).
app.post("/admin/b/:blogId/save", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.redirect(ctx.redirect);

  const form = await c.req.formData();
  const idParam = c.req.query("id");
  const stayInEditor = String(form.get("save") ?? "close") === "continue";
  const title = String(form.get("title") ?? "").trim();
  let slug = slugify(String(form.get("slug") ?? ""));
  const body_md = String(form.get("body_md") ?? "");
  const normalizedTags = normalizePostTags(String(form.get("tags") ?? ""));
  const requestedAuthorId = Number(form.get("author_account_id") ?? ctx.account.id);
  const requestedAuthorName = String(form.get("author_name") ?? "").trim().slice(0, 120);
  const requestedAuthorVisible = String(form.get("author_visibility") ?? "author") !== "none";
  const authors = can(ctx.role, "posts.edit.any") ? await postAuthors(c.env, ctx.tenant) : [];
  const selectedAuthor = authors.find((author) => author.id === requestedAuthorId);
  const authorAccountId = can(ctx.role, "posts.edit.any") && selectedAuthor ? requestedAuthorId : ctx.account.id;
  const authorName = requestedAuthorName || selectedAuthor?.displayName || ctx.tenant.title;
  const published = form.get("published") ? 1 : 0;
  if (!idParam && !can(ctx.role, "posts.create")) return c.text("You do not have permission to create posts.", 403);
  if (published && !can(ctx.role, "posts.publish")) return c.text("You do not have permission to publish posts.", 403);
  let featuredImageKey: string | null;
  try {
    featuredImageKey = await checkedFeaturedImage(c.env, ctx.tenant.id, form.get("featured_image_key"));
  } catch (e: any) {
    return c.html(editorPage(ctx.account, ctx.tenant, c.env.ROOT_DOMAIN,
      { id: idParam ? Number(idParam) : undefined, title, slug, body_md, published, featured_image_key: null },
      e.message), 400);
  }
  if (!slug) slug = slugify(title);

  if (!title || !slug)
    return c.html(
      editorPage(
        ctx.account,
        ctx.tenant,
        c.env.ROOT_DOMAIN,
        { id: idParam ? Number(idParam) : undefined, title, slug, body_md, published, featured_image_key: featuredImageKey },
        "A title is required (and it must produce a valid slug)."
      ),
      400
    );
  if (normalizedTags.error)
    return c.html(editorPage(ctx.account, ctx.tenant, c.env.ROOT_DOMAIN,
      { id: idParam ? Number(idParam) : undefined, title, slug, body_md, published, featured_image_key: featuredImageKey, tags_json: JSON.stringify(normalizedTags.tags) },
      normalizedTags.error), 400);

  const now = Math.floor(Date.now() / 1000);
  const pdb = tenantDb(c.env, ctx.tenant);
  let savedId = idParam ? Number(idParam) : undefined;
  let wasPublished = 0;
  if (idParam) {
    const prev = await pdb
      .prepare("SELECT published, author_account_id, author_name FROM posts WHERE id = ? AND tenant_id = ?")
      .bind(idParam, ctx.tenant.id)
      .first<{ published: number; author_account_id: number | null; author_name: string | null }>();
    if (!prev) return c.text("Post not found.", 404);
    if (!can(ctx.role, "posts.edit.any") &&
        !(can(ctx.role, "posts.edit.own") && prev.author_account_id === ctx.account.id))
      return c.text("You do not have permission to edit this post.", 403);
    wasPublished = prev?.published ?? 0;
  }
  try {
    if (idParam) {
      const update = can(ctx.role, "posts.edit.any")
        ? pdb.prepare(`UPDATE posts SET slug = ?, title = ?, featured_image_key = ?, body_md = ?, tags_json = ?, published = ?, updated_at = ?, author_account_id = ?, author_name = ?, author_visible = ? WHERE id = ? AND tenant_id = ?`)
            .bind(slug, title, featuredImageKey, body_md, JSON.stringify(normalizedTags.tags), published, now, authorAccountId, authorName, requestedAuthorVisible ? 1 : 0, idParam, ctx.tenant.id)
        : pdb.prepare(`UPDATE posts SET slug = ?, title = ?, featured_image_key = ?, body_md = ?, tags_json = ?, published = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`)
            .bind(slug, title, featuredImageKey, body_md, JSON.stringify(normalizedTags.tags), published, now, idParam, ctx.tenant.id);
      await update.run();
    } else {
      const inserted = await pdb.prepare(
        `INSERT INTO posts (tenant_id, slug, title, featured_image_key, body_md, tags_json, published, created_at, updated_at, author_account_id, author_name, author_visible)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(ctx.tenant.id, slug, title, featuredImageKey, body_md, JSON.stringify(normalizedTags.tags), published, now, now, authorAccountId, authorName, requestedAuthorVisible ? 1 : 0)
        .run();
      savedId = Number(inserted.meta.last_row_id);
    }
  } catch (e: any) {
    return c.html(
      editorPage(
        ctx.account,
        ctx.tenant,
        c.env.ROOT_DOMAIN,
        { id: idParam ? Number(idParam) : undefined, title, slug, body_md, published, featured_image_key: featuredImageKey },
        "Couldn't save — is that slug already used by another post?"
      ),
      400
    );
  }

  c.executionCtx.waitUntil(
    purgeTenant(c.env, ctx.tenant, ["/", "/" + slug, "/sitemap.xml"])
  );
  // Email subscribers when a post first goes live (draft/new -> published).
  if (published === 1 && wasPublished === 0)
    c.executionCtx.waitUntil(notifySubscribers(c.env, ctx.tenant, { slug, title }));
  return c.redirect(
    stayInEditor && savedId
      ? `/admin/b/${ctx.tenant.public_id}/edit/${savedId}`
      : `/admin/b/${ctx.tenant.public_id}`
  );
});

app.post("/admin/b/:blogId/delete/:id", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.redirect(ctx.redirect);
  const denied = requireBlogCapability(c, ctx, "posts.delete");
  if (denied) return denied;
  const pdb = tenantDb(c.env, ctx.tenant);
  const post = await pdb.prepare(
    "SELECT slug, audio_key FROM posts WHERE id = ? AND tenant_id = ?"
  )
    .bind(c.req.param("id"), ctx.tenant.id)
    .first<{ slug: string; audio_key: string | null }>();
  if (post) {
    await pdb.prepare("DELETE FROM posts WHERE id = ? AND tenant_id = ?")
      .bind(c.req.param("id"), ctx.tenant.id)
      .run();
    if (post.audio_key) await c.env.MEDIA.delete(post.audio_key);
    c.executionCtx.waitUntil(
      purgeTenant(c.env, ctx.tenant, ["/", "/" + post.slug, "/sitemap.xml"])
    );
  }
  return c.redirect(`/admin/b/${ctx.tenant.public_id}`);
});

// Image upload → R2. Auth + ownership via blogContext. The client downscales
// before sending, but we re-validate type and size here.
const ALLOWED_IMAGE = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
]);
const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
};
const MAX_UPLOAD = 15 * 1024 * 1024; // 15 MB ceiling (uploads are pre-shrunk)

async function listMedia(env: Bindings, tenantId: number): Promise<MediaItem[]> {
  const prefix = `${tenantId}/`;
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.MEDIA.list({ prefix, limit: 1000, cursor, include: ["customMetadata"] });
    objects.push(...listed.objects);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return objects
    .filter((obj) => !obj.key.slice(prefix.length).startsWith("avatar-"))
    .filter((obj) => !obj.key.slice(prefix.length).startsWith(".audio-checkpoints/"))
    .filter((obj) => !obj.key.slice(prefix.length).startsWith(".audio-jobs/"))
    .filter((obj) => !obj.key.slice(prefix.length).startsWith(".image-jobs/"))
    .filter((obj) => !obj.key.endsWith("-tts.mp3") && !obj.key.endsWith("-tts.wav"))
    .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())
    .map((obj) => ({
      key: obj.key,
      name: obj.customMetadata?.originalName || obj.key.slice(prefix.length),
      url: `/media/${obj.key}`,
      size: obj.size,
      uploaded: obj.uploaded.toISOString(),
    }));
}

app.get("/admin/b/:blogId/media", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.redirect(ctx.redirect);
  return c.html(mediaPage(ctx.account, ctx.tenant, await listMedia(c.env, ctx.tenant.id)));
});

app.get("/admin/b/:blogId/media.json", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.json({ error: "unauthorized" }, 401);
  return c.json({ items: await listMedia(c.env, ctx.tenant.id) });
});

app.post("/admin/b/:blogId/upload", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.json({ error: "unauthorized" }, 401);
  if (!can(ctx.role, "media.upload")) return c.json({ error: "forbidden" }, 403);

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "no file" }, 400);

  const type = file.type;
  if (!ALLOWED_IMAGE.has(type))
    return c.json({ error: "unsupported image type" }, 400);
  if (file.size > MAX_UPLOAD) return c.json({ error: "image too large" }, 413);

  const rand = crypto.randomUUID().slice(0, 8);
  const key = `${ctx.tenant.id}/${Date.now()}-${rand}.${EXT[type]}`;
  await c.env.MEDIA.put(key, await file.arrayBuffer(), {
    httpMetadata: {
      contentType: type,
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: { originalName: file.name.slice(0, 200) },
  });

  const url = `/media/${key}`;
  return c.json({ key, url, markdown: `![](${url})` });
});

// Generate narration once, persist it to R2, and attach it to a saved post.
// Regeneration is deliberately a remove-then-generate flow, preventing an
// accidental click from replacing approved narration or consuming AI usage.
async function generateSpeechWithRetry(ai: Ai, prompt: string): Promise<Uint8Array> {
  // Longer spacing helps a retry escape the same temporarily unhealthy model
  // instance instead of exhausting every attempt in one short burst.
  // 3043 is an intermittent upstream failure. Keep the retry window focused
  // (rather than sleeping for one long interval) so capacity can recover.
  const retryDelays = [250, 500, 1_000, 1_500, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000];
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      const generated = await ai.run(TTS_MODEL, { prompt, lang: "en" });
      const bytes = ttsBytes(generated);
      if (!bytes.byteLength) throw new Error("The model returned no audio.");
      return bytes;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (/3036/.test(message)) throw new Error("Workers AI narration quota reached (3036). Please try again after the daily limit resets or upgrade your Workers AI plan.");
      const transient = /3040|3043|internal server error|temporar|timeout|overload|unavailable/i.test(message);
      if (!transient || attempt === retryDelays.length) throw error;
      console.warn(JSON.stringify({
        message: "Transient MeloTTS failure; retrying",
        error: message,
        attempt: attempt + 1,
      }));
      const jitter = Math.floor(Math.random() * 250);
      await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt] + jitter));
    }
  }
  throw lastError;
}

function splitSpeechPrompt(prompt: string): [string, string] | null {
  const midpoint = Math.floor(prompt.length / 2);
  const candidates = [...prompt.matchAll(/[.!?;:,]\s+/g)].map((match) => (match.index ?? 0) + match[0].length);
  const boundary = candidates
    .filter((position) => position > Math.floor(prompt.length * 0.3) && position < Math.ceil(prompt.length * 0.7))
    .sort((a, b) => Math.abs(a - midpoint) - Math.abs(b - midpoint))[0];
  const cut = boundary ?? prompt.lastIndexOf(" ", midpoint);
  if (cut < 1 || cut >= prompt.length - 1) return null;
  const first = prompt.slice(0, cut).trim();
  const second = prompt.slice(cut).trim();
  return first && second ? [first, second] : null;
}

// A single malformed or overloaded MeloTTS request should not discard an
// otherwise valid long narration. If the model still returns a transient 3043
// after normal retries, split that segment at a natural boundary and assemble
// the two successful WAV responses. This is deliberately bounded to avoid
// hiding permanent model failures or creating unbounded recursive work.
async function generateSpeechWithRecovery(ai: Ai, prompt: string, depth = 0): Promise<Uint8Array> {
  try {
    return await generateSpeechWithRetry(ai, prompt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const parts = depth < 3 && prompt.length >= 240 && /3040|3043|internal server error|temporar|timeout|overload|unavailable/i.test(message)
      ? splitSpeechPrompt(prompt)
      : null;
    if (!parts) throw error;
    const first = await generateSpeechWithRecovery(ai, parts[0], depth + 1);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const second = await generateSpeechWithRecovery(ai, parts[1], depth + 1);
    return mergeWav([first, second]);
  }
}

async function readAudioJob(env: Bindings, jobKey: string): Promise<AudioJobManifest> {
  const object = await env.MEDIA.get(jobKey);
  if (!object) throw new Error("Audio job manifest not found.");
  return JSON.parse(await object.text()) as AudioJobManifest;
}

async function writeAudioJob(env: Bindings, jobKey: string, job: AudioJobManifest): Promise<void> {
  await env.MEDIA.put(jobKey, JSON.stringify(job), {
    httpMetadata: { contentType: "application/json", cacheControl: "private, max-age=60" },
    customMetadata: { job: "audio" },
  });
}

async function processAudioJob(env: Bindings, jobKey: string): Promise<void> {
  const job = await readAudioJob(env, jobKey);
  if (job.status === "complete") return;
  const tenant = await tenantById(env, job.tenantId);
  if (!tenant) throw new Error("Audio job blog no longer exists.");
  const pdb = tenantDb(env, tenant);
  const post = await pdb.prepare("SELECT id, slug, audio_key FROM posts WHERE id = ? AND tenant_id = ?")
    .bind(job.postId, job.tenantId).first<{ id: number; slug: string; audio_key: string | null }>();
  if (!post) throw new Error("Audio job post no longer exists.");

  job.status = "generating";
  await writeAudioJob(env, jobKey, job);
  const parts: Uint8Array[] = [];
  try {
    for (let index = 0; index < job.prompts.length; index++) {
      const checkpointKey = job.checkpointKeys[index];
      const cached = await env.MEDIA.get(checkpointKey);
      let bytes: Uint8Array;
      if (cached) bytes = new Uint8Array(await cached.arrayBuffer());
      else {
        if (index > 0) await new Promise((resolve) => setTimeout(resolve, 350));
        bytes = await generateSpeechWithRecovery(env.AI, job.prompts[index].text);
        await env.MEDIA.put(checkpointKey, bytes, {
          httpMetadata: { contentType: "audio/wav", cacheControl: "private, max-age=3600" },
          customMetadata: { postId: String(job.postId), checkpoint: "tts" },
        });
      }
      parts.push(bytes);
      job.completed = index + 1;
      await writeAudioJob(env, jobKey, job);
    }

    const assembly = wavAssembly(parts, job.prompts.map((prompt) => prompt.pauseAfter));
    if (!assembly.size) throw new Error("The model returned no audio.");
    const audioKey = `${tenant.id}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}-tts.wav`;
    const fixed = new FixedLengthStream(assembly.size);
    const upload = env.MEDIA.put(audioKey, fixed.readable, {
      httpMetadata: { contentType: "audio/wav", cacheControl: "public, max-age=31536000, immutable" },
      customMetadata: { originalName: `${job.postSlug} narration.wav`, generatedBy: TTS_MODEL, postId: String(job.postId) },
    });
    const writer = fixed.writable.getWriter();
    try {
      await writer.write(assembly.header);
      for (const samples of assembly.samples) await writer.write(samples);
      await writer.close();
      await upload;
    } catch (error) {
      await writer.abort(error).catch(() => undefined);
      throw error;
    }
    await pdb.prepare("UPDATE posts SET audio_key = ?, updated_at = ? WHERE id = ? AND tenant_id = ?")
      .bind(audioKey, Math.floor(Date.now() / 1000), job.postId, job.tenantId).run();
    await env.MEDIA.delete(job.checkpointKeys);
    job.status = "complete";
    job.audioKey = audioKey;
    await writeAudioJob(env, jobKey, job);
    await purgeTenant(env, tenant, ["/" + post.slug]);
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    await writeAudioJob(env, jobKey, job);
    throw error;
  }
}

async function preparePronunciations(ai: Ai, text: string) {
  try {
    const result = await ai.run(AI_BRIEF_MODEL, {
      messages: [
        {
          role: "system",
          content: `Identify only words or short expressions that an English text-to-speech system is likely to mispronounce: uncommon proper names and places, foreign terms, acronyms not already spaced into letters, and unusually formatted numbers or symbols. Return JSON only in this exact shape: {"replacements":[{"original":"exact text from input","spoken":"ordinary English phonetic spelling"}]}. The original must be copied exactly. Never replace an ordinary lowercase English word. Do not rewrite prose, correct grammar, add pauses, or include ordinary words. Use an empty array when no replacement is genuinely needed.`,
        },
        { role: "user", content: text },
      ],
      max_tokens: 900,
      temperature: 0,
    });
    const replacements = pronunciationReplacements(String(result.response || ""), text);
    return replacements;
  } catch (error) {
    console.warn(JSON.stringify({
      message: "Pronunciation preprocessing failed; using original narration",
      error: error instanceof Error ? error.message : String(error),
    }));
    return [];
  }
}

async function createAudioJob(env: Bindings, tenant: Tenant, post: Pick<Post, "id" | "slug" | "title" | "body_md">) {
  const sections = narrationSections(post.title, post.body_md);
  const text = [sections.title, sections.body].filter(Boolean).join(" ... ");
  if (!text) throw new Error("Add some post text before generating audio.");
  if (text.length > TTS_TEXT_MAX)
    throw new Error(`This post is too long for narration (${text.length.toLocaleString()} characters; maximum ${TTS_TEXT_MAX.toLocaleString()}).`);
  const replacements = await preparePronunciations(env.AI, text.replaceAll(TTS_HARD_PAUSE, "\n\n").replaceAll(TTS_SOFT_PAUSE, " "));
  const preparedTitle = applyPronunciations(sections.title, replacements).replaceAll(TTS_SOFT_PAUSE, " ");
  const preparedBody = applyPronunciations(sections.body, replacements);
  const prompts: Array<{ text: string; pauseAfter: number }> = [{ text: preparedTitle, pauseAfter: TTS_TITLE_PAUSE_SECONDS }];
  const structuralParts = preparedBody.split(TTS_HARD_PAUSE);
  for (let partIndex = 0; partIndex < structuralParts.length; partIndex++) {
    const punctuationParts = structuralParts[partIndex].split(TTS_SOFT_PAUSE);
    for (let punctuationIndex = 0; punctuationIndex < punctuationParts.length; punctuationIndex++) {
      const chunks = narrationChunks(punctuationParts[punctuationIndex].trim());
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const isLastChunk = chunkIndex === chunks.length - 1;
        const isLastPunctuationPart = punctuationIndex === punctuationParts.length - 1;
        prompts.push({ text: chunks[chunkIndex], pauseAfter: isLastChunk && !isLastPunctuationPart ? TTS_PUNCTUATION_PAUSE_SECONDS : isLastChunk && partIndex < structuralParts.length - 1 ? TTS_STRUCTURE_PAUSE_SECONDS : 0 });
      }
    }
  }
  const jobId = crypto.randomUUID();
  const jobKey = `${tenant.id}/.audio-jobs/${jobId}.json`;
  const checkpointHash = await sha256hex(`${TTS_MODEL}\n${preparedTitle}\n${preparedBody}`);
  const checkpointPrefix = `${tenant.id}/.audio-checkpoints/${post.id}-${checkpointHash}`;
  const job: AudioJobManifest = { tenantId: tenant.id, postId: post.id, postSlug: post.slug, prompts, checkpointKeys: prompts.map((_, index) => `${checkpointPrefix}/${index}.wav`), status: "queued", completed: 0 };
  await writeAudioJob(env, jobKey, job);
  await env.AUDIO_QUEUE.send({ jobKey, tenantId: tenant.id, postId: post.id });
  return { jobId, segments: prompts.length };
}

app.get("/admin/b/:blogId/audio/:id/status", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.json({ error: "unauthorized" }, 401);
  const jobId = c.req.query("job");
  if (!jobId || !/^[0-9a-f-]{36}$/i.test(jobId)) return c.json({ error: "Audio job not found." }, 404);
  try {
    const job = await readAudioJob(c.env, `${ctx.tenant.id}/.audio-jobs/${jobId}.json`);
    if (job.tenantId !== ctx.tenant.id || String(job.postId) !== String(c.req.param("id"))) return c.json({ error: "Audio job not found." }, 404);
    return c.json({ status: job.status, completed: job.completed, segments: job.prompts.length, url: job.audioKey ? `/media/${job.audioKey}` : undefined, error: job.error });
  } catch {
    return c.json({ error: "Audio job not found." }, 404);
  }
});

app.post("/admin/b/:blogId/audio/:id", async (c) => {
  const ctxResult = await blogContext(c);
  if ("redirect" in ctxResult) return c.json({ error: "unauthorized" }, 401);
  const ctx = ctxResult;
  if (!can(ctx.role, "media.upload")) return c.json({ error: "forbidden" }, 403);
  const pdb = tenantDb(c.env, ctx.tenant);
  const post = await pdb.prepare(
    "SELECT id, slug, title, body_md, audio_key FROM posts WHERE id = ? AND tenant_id = ?"
  ).bind(c.req.param("id"), ctx.tenant.id)
    .first<Pick<Post, "id" | "slug" | "title" | "body_md" | "audio_key">>() as Pick<Post, "id" | "slug" | "title" | "body_md" | "audio_key">;
  if (!post) return c.json({ error: "Post not found." }, 404);
  if (post.audio_key)
    return c.json({ error: "Remove the existing narration before generating a new version." }, 409);

  const sections = narrationSections(post.title, post.body_md);
  const text = [sections.title, sections.body].filter(Boolean).join(" ... ");
  if (!text) return c.json({ error: "Add some post text before generating audio." }, 400);
  if (text.length > TTS_TEXT_MAX)
    return c.json({ error: `This post is too long for narration (${text.length.toLocaleString()} characters; maximum ${TTS_TEXT_MAX.toLocaleString()}).` }, 400);

  // Long narration is queued so the browser is never responsible for keeping
  // one Worker invocation alive while dozens of model calls run.
  const replacements = await preparePronunciations(c.env.AI, text.replaceAll(TTS_HARD_PAUSE, "\n\n").replaceAll(TTS_SOFT_PAUSE, " "));
  const preparedTitle = applyPronunciations(sections.title, replacements).replaceAll(TTS_SOFT_PAUSE, " ");
  const preparedBody = applyPronunciations(sections.body, replacements);
  const prompts: Array<{ text: string; pauseAfter: number }> = [{ text: preparedTitle, pauseAfter: TTS_TITLE_PAUSE_SECONDS }];
  const structuralParts = preparedBody.split(TTS_HARD_PAUSE);
  for (let partIndex = 0; partIndex < structuralParts.length; partIndex++) {
    const punctuationParts = structuralParts[partIndex].split(TTS_SOFT_PAUSE);
    for (let punctuationIndex = 0; punctuationIndex < punctuationParts.length; punctuationIndex++) {
      const chunks = narrationChunks(punctuationParts[punctuationIndex].trim());
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const isLastChunk = chunkIndex === chunks.length - 1;
        const isLastPunctuationPart = punctuationIndex === punctuationParts.length - 1;
        prompts.push({
          text: chunks[chunkIndex],
          pauseAfter: isLastChunk && !isLastPunctuationPart
            ? TTS_PUNCTUATION_PAUSE_SECONDS
            : isLastChunk && partIndex < structuralParts.length - 1
              ? TTS_STRUCTURE_PAUSE_SECONDS : 0,
        });
      }
    }
  }
  const jobId = crypto.randomUUID();
  const jobKey = `${ctx.tenant.id}/.audio-jobs/${jobId}.json`;
  const checkpointHash = await sha256hex(`${TTS_MODEL}\n${preparedTitle}\n${preparedBody}`);
  const checkpointPrefix = `${ctx.tenant.id}/.audio-checkpoints/${post.id}-${checkpointHash}`;
  const job: AudioJobManifest = {
    tenantId: ctx.tenant.id, postId: post.id, postSlug: post.slug, prompts,
    checkpointKeys: prompts.map((_, index) => `${checkpointPrefix}/${index}.wav`),
    status: "queued", completed: 0,
  };
  await writeAudioJob(c.env, jobKey, job);
  await c.env.AUDIO_QUEUE.send({ jobKey, tenantId: ctx.tenant.id, postId: post.id });
  return c.json({ queued: true, jobId, status: job.status, segments: prompts.length });

  const encoder = new TextEncoder();
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      // Send response headers immediately instead of leaving a long request
      // completely idle while several speech-model calls run in sequence.
      controller.enqueue(encoder.encode("\n"));
    },
  });
  const heartbeat = setInterval(() => {
    try { streamController.enqueue(encoder.encode("\n")); } catch { /* stream closed */ }
  }, 10_000);

  const generation = (async () => {
    let generationStage = "preparing narration";
    try {
    const audioParts: Uint8Array[] = [];
    generationStage = "preparing difficult pronunciations";
    const replacements = await preparePronunciations(c.env.AI, text.replaceAll(TTS_HARD_PAUSE, "\n\n").replaceAll(TTS_SOFT_PAUSE, " "));
    const preparedTitle = applyPronunciations(sections.title, replacements).replaceAll(TTS_SOFT_PAUSE, " ");
    const preparedBody = applyPronunciations(sections.body, replacements);
    // Generate the title independently for a short, neutral delivery, then add
    // body segments. The WAV assembler inserts a deterministic pause between them.
    const prompts: Array<{ text: string; pauseAfter: number }> = [
      { text: preparedTitle, pauseAfter: TTS_TITLE_PAUSE_SECONDS },
    ];
    const structuralParts = preparedBody.split(TTS_HARD_PAUSE);
    for (let partIndex = 0; partIndex < structuralParts.length; partIndex++) {
      const punctuationParts = structuralParts[partIndex].split(TTS_SOFT_PAUSE);
      for (let punctuationIndex = 0; punctuationIndex < punctuationParts.length; punctuationIndex++) {
        const chunks = narrationChunks(punctuationParts[punctuationIndex].trim());
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
          const isLastChunk = chunkIndex === chunks.length - 1;
          const isLastPunctuationPart = punctuationIndex === punctuationParts.length - 1;
          prompts.push({
            text: chunks[chunkIndex],
            pauseAfter: isLastChunk && !isLastPunctuationPart
              ? TTS_PUNCTUATION_PAUSE_SECONDS
              : isLastChunk && partIndex < structuralParts.length - 1
                ? TTS_STRUCTURE_PAUSE_SECONDS
                : 0,
          });
        }
      }
    }
    // Persist each completed segment under a key derived from the exact
    // narration text and model. A later attempt can resume instead of
    // regenerating the earlier segments of a long article.
    const checkpointHash = await sha256hex(`${TTS_MODEL}\n${preparedTitle}\n${preparedBody}`);
    const checkpointPrefix = `${ctx.tenant.id}/.audio-checkpoints/${post.id}-${checkpointHash}`;
    const checkpointKeys = prompts.map((_, index) => `${checkpointPrefix}/${index}.wav`);
    for (let index = 0; index < prompts.length; index++) {
      const prompt = prompts[index].text;
      generationStage = index === 0 ? "reading the title" : `reading article segment ${index}`;
      const checkpoint = await c.env.MEDIA.get(checkpointKeys[index]);
      if (checkpoint) {
        audioParts.push(new Uint8Array(await checkpoint.arrayBuffer()));
        continue;
      }
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, 350));
      const generated = await generateSpeechWithRecovery(c.env.AI, prompt);
      await c.env.MEDIA.put(checkpointKeys[index], generated, {
        httpMetadata: { contentType: "audio/wav", cacheControl: "private, max-age=3600" },
        customMetadata: { postId: String(post.id), checkpoint: "tts" },
      });
      audioParts.push(generated);
    }
    generationStage = "assembling the audio";
    const assembly = wavAssembly(audioParts, prompts.map((prompt) => prompt.pauseAfter));
    if (!assembly.size) throw new Error("The model returned no audio.");
    const key = `${ctx.tenant.id}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}-tts.wav`;
    const fixed = new FixedLengthStream(assembly.size);
    generationStage = "saving the audio";
    const upload = c.env.MEDIA.put(key, fixed.readable, {
      httpMetadata: {
        contentType: "audio/wav",
        cacheControl: "public, max-age=31536000, immutable",
      },
      customMetadata: {
        originalName: `${post.title.slice(0, 160)} narration.wav`,
        generatedBy: TTS_MODEL,
        postId: String(post.id),
      },
    });
    const writer = fixed.writable.getWriter();
    try {
      await writer.write(assembly.header);
      for (const samples of assembly.samples) await writer.write(samples);
      await writer.close();
      await upload;
    } catch (error) {
      await writer.abort(error).catch(() => undefined);
      throw error;
    }
    try {
      await pdb.prepare("UPDATE posts SET audio_key = ?, updated_at = ? WHERE id = ? AND tenant_id = ?")
        .bind(key, Math.floor(Date.now() / 1000), post.id, ctx.tenant.id)
        .run();
    } catch (error) {
      await c.env.MEDIA.delete(key);
      throw error;
    }
    await c.env.MEDIA.delete(checkpointKeys);
    c.executionCtx.waitUntil(purgeTenant(c.env, ctx.tenant, ["/" + post.slug]));
      streamController.enqueue(encoder.encode(JSON.stringify({
        key,
        url: `/media/${key}`,
        segments: prompts.length,
        pronunciationReplacements: replacements.length,
      })));
    } catch (error) {
      console.error(JSON.stringify({
        message: "AI narration generation failed",
        error: error instanceof Error ? error.message : String(error),
        tenantId: ctx.tenant.id,
        postId: post.id,
      }));
      const detail = error instanceof Error ? error.message : String(error);
      streamController.enqueue(encoder.encode(JSON.stringify({
        error: `Audio generation failed while ${generationStage}: ${detail}`,
      })));
    } finally {
      clearInterval(heartbeat);
      streamController.close();
    }
  })();
  c.executionCtx.waitUntil(generation);
  return new Response(stream, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});

app.delete("/admin/b/:blogId/audio/:id", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.json({ error: "unauthorized" }, 401);
  if (!can(ctx.role, "media.delete")) return c.json({ error: "forbidden" }, 403);
  const pdb = tenantDb(c.env, ctx.tenant);
  const post = await pdb.prepare(
    "SELECT id, slug, audio_key FROM posts WHERE id = ? AND tenant_id = ?"
  ).bind(c.req.param("id"), ctx.tenant.id)
    .first<Pick<Post, "id" | "slug" | "audio_key">>();
  if (!post) return c.json({ error: "Post not found." }, 404);
  if (!post.audio_key) return c.json({ ok: true });

  await pdb.prepare("UPDATE posts SET audio_key = NULL, updated_at = ? WHERE id = ? AND tenant_id = ?")
    .bind(Math.floor(Date.now() / 1000), post.id, ctx.tenant.id)
    .run();
  await c.env.MEDIA.delete(post.audio_key);
  c.executionCtx.waitUntil(purgeTenant(c.env, ctx.tenant, ["/" + post.slug]));
  return c.json({ ok: true });
});

type AiBriefRequest = {
  mode?: unknown;
  prompt?: unknown;
  postTitle?: unknown;
  postBody?: unknown;
};

type MembershipRole = "owner" | "editor" | "author" | "contributor";
type Capability =
  | "posts.create"
  | "posts.edit.any"
  | "posts.edit.own"
  | "posts.publish"
  | "posts.delete"
  | "media.upload"
  | "media.delete"
  | "settings.manage"
  | "members.manage";

const ROLE_CAPABILITIES: Record<MembershipRole, ReadonlySet<Capability>> = {
  owner: new Set([
    "posts.create", "posts.edit.any", "posts.publish", "posts.delete",
    "media.upload", "media.delete", "settings.manage", "members.manage",
  ]),
  editor: new Set([
    "posts.create", "posts.edit.any", "posts.publish", "posts.delete",
    "media.upload", "media.delete",
  ]),
  author: new Set(["posts.create", "posts.edit.own", "posts.publish", "media.upload"]),
  contributor: new Set(["posts.create", "posts.edit.own", "media.upload"]),
};

function can(role: MembershipRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role]?.has(capability) ?? false;
}

type AudioJobMessage = { jobKey: string; tenantId: number; postId: number };
type ImageJobMessage = { kind: "image"; jobKey: string; tenantId: number };
type AudioJobManifest = {
  tenantId: number;
  postId: number;
  postSlug: string;
  prompts: Array<{ text: string; pauseAfter: number }>;
  checkpointKeys: string[];
  status: "queued" | "generating" | "complete" | "failed";
  completed: number;
  audioKey?: string;
  error?: string;
};
type ImageJobManifest = {
  tenantId: number;
  postId?: number;
  source: string;
  style: ImageStyle;
  status: "queued" | "generating" | "complete" | "failed";
  key?: string;
  url?: string;
  markdown?: string;
  briefFallback?: boolean;
  error?: string;
};

const AI_REQUEST_MAX = 64 * 1024;
const IMAGE_STYLES = new Set<ImageStyle>([
  "editorial-photo", "editorial-illustration", "cinematic", "child-crayon", "arcade-action", "risograph", "paper-collage", "watercolor", "minimal", "auto",
]);

function oversizedAiRequest(request: Request): boolean {
  const length = Number(request.headers.get("content-length") || 0);
  return Number.isFinite(length) && length > AI_REQUEST_MAX;
}

async function blogImageContext(env: Bindings, tenant: Tenant) {
  const result = await tenantDb(env, tenant).prepare(
    `SELECT title, substr(body_md, 1, 500) AS body_md
       FROM posts WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT 100`
  ).bind(tenant.id).all<{ title: string; body_md: string }>();
  return result.results;
}

async function createVisualBrief(env: Bindings, source: string, tenantId: number) {
  try {
    const result = await env.AI.run(AI_BRIEF_MODEL, {
      messages: [
        {
          role: "system",
          content: `You are an art director writing a prompt for FLUX.2. Produce one concise visual brief of 80–160 words using this order: Subject and action, Style, Composition, Context. Put the main subject and action first. Translate titles into visual concepts; never turn the title into visible lettering. Choose concrete, specific visual details and a subject-appropriate physical scene or visual metaphor. Make the image work as a 16:9 editorial thumbnail with one dominant focal subject. Do not propose screens, browser windows, websites, article pages, documents, books, signs, posters, charts, logos, or interface mockups. Return only the brief, without headings or commentary.`,
        },
        { role: "user", content: source },
      ],
      max_tokens: 220,
      temperature: 0.35,
    });
    const brief = String(result.response || "").trim();
    if (!brief) throw new Error("The prompt model returned no brief.");
    return { brief: brief.slice(0, 1800), fallback: false };
  } catch (error) {
    console.warn(JSON.stringify({
      message: "AI visual brief generation failed; using fallback",
      error: error instanceof Error ? error.message : String(error),
      tenantId,
    }));
    return { brief: buildFallbackBrief(source), fallback: true };
  }
}

async function runFlux2Klein(ai: Ai, prompt: string) {
  const form = new FormData();
  form.append("prompt", prompt);
  form.append("width", "1024");
  form.append("height", "576");
  const serialized = new Response(form);
  const body = serialized.body;
  const contentType = serialized.headers.get("content-type");
  if (!body || !contentType) throw new Error("Could not prepare the image request.");
  return ai.run(AI_IMAGE_MODEL, {
    multipart: { body, contentType },
  });
}

async function generateImageAsset(env: Bindings, tenant: Tenant, source: string, style: ImageStyle) {
  const visualBrief = await createVisualBrief(env, source, tenant.id);
  const prompt = buildImagePrompt(visualBrief.brief, style);
  const generated = await runFlux2Klein(env.AI, prompt);
  if (!generated.image) throw new Error("The model returned no image.");
  const bytes = Uint8Array.from(atob(generated.image), (char) => char.charCodeAt(0));
  const key = `${tenant.id}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}-ai.jpg`;
  await env.MEDIA.put(key, bytes, {
    httpMetadata: { contentType: "image/jpeg", cacheControl: "public, max-age=31536000, immutable" },
    customMetadata: { originalName: "AI generated image.jpg", generatedBy: AI_IMAGE_MODEL },
  });
  const url = `/media/${key}`;
  return { key, url, markdown: `![Generated image](${url})`, generated: true, briefFallback: visualBrief.fallback };
}

async function writeImageJob(env: Bindings, jobKey: string, job: ImageJobManifest): Promise<void> {
  await env.MEDIA.put(jobKey, JSON.stringify(job), {
    httpMetadata: { contentType: "application/json", cacheControl: "private, max-age=30" },
    customMetadata: { job: "image" },
  });
}

async function readImageJob(env: Bindings, jobKey: string): Promise<ImageJobManifest> {
  const object = await env.MEDIA.get(jobKey);
  if (!object) throw new Error("Image job not found.");
  return JSON.parse(await object.text()) as ImageJobManifest;
}

async function processImageJob(env: Bindings, jobKey: string): Promise<void> {
  const job = await readImageJob(env, jobKey);
  if (job.status === "complete") return;
  const tenant = await tenantById(env, job.tenantId);
  if (!tenant) throw new Error("Image job blog no longer exists.");
  job.status = "generating";
  await writeImageJob(env, jobKey, job);
  try {
    const result = await generateImageAsset(env, tenant, job.source, job.style);
    job.status = "complete";
    job.key = result.key;
    job.url = result.url;
    job.markdown = result.markdown;
    job.briefFallback = result.briefFallback;
    if (job.postId != null) {
      const pdb = tenantDb(env, tenant);
      const post = await pdb.prepare("SELECT slug FROM posts WHERE id = ? AND tenant_id = ?")
        .bind(job.postId, tenant.id).first<{ slug: string }>();
      if (post) {
        await pdb.prepare("UPDATE posts SET featured_image_key = ?, updated_at = ? WHERE id = ? AND tenant_id = ?")
          .bind(job.key, Math.floor(Date.now() / 1000), job.postId, tenant.id).run();
        await purgeTenant(env, tenant, ["/", "/" + post.slug]);
      }
    }
    await writeImageJob(env, jobKey, job);
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    await writeImageJob(env, jobKey, job);
    throw error;
  }
}

// Granite privately turns the selected content into a visual brief, then
// FLUX.1 Schnell generates and stores the image. The intermediate brief stays an
// implementation detail so the author gets a one-click workflow.
app.post("/admin/b/:blogId/media/generate", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.json({ error: "unauthorized" }, 401);
  if (!can(ctx.role, "media.upload")) return c.json({ error: "forbidden" }, 403);
  if (oversizedAiRequest(c.req.raw)) return c.json({ error: "request too large" }, 413);

  let input: AiBriefRequest & { style?: unknown };
  try {
    input = await c.req.json<AiBriefRequest & { style?: unknown }>();
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }
  const userPrompt = String(input.prompt ?? "").trim();
  const mode: ImageContextMode = userPrompt ? "prompt" : "post";
  if (userPrompt.length > 1200)
    return c.json({ error: "The creative direction must be 1,200 characters or fewer." }, 400);
  const style: ImageStyle = IMAGE_STYLES.has(input.style as ImageStyle)
    ? input.style as ImageStyle
    : "auto";

  const source = buildSourceContext({
    prompt: userPrompt,
    mode,
    blogTitle: ctx.tenant.title,
    blogDescription: ctx.tenant.description,
    postTitle: String(input.postTitle ?? "").slice(0, 500),
    postBody: String(input.postBody ?? "").slice(0, 20_000),
  });
  try {
    return c.json(await generateImageAsset(c.env, ctx.tenant, source, style));
  } catch (error) {
    console.error(JSON.stringify({
      message: "AI image generation failed",
      error: error instanceof Error ? error.message : String(error),
      tenantId: ctx.tenant.id,
    }));
    return c.json({ error: "Image generation failed. Please try again in a moment." }, 502);
  }
});

app.delete("/admin/b/:blogId/media/:file", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.json({ error: "unauthorized" }, 401);
  if (!can(ctx.role, "media.delete")) return c.json({ error: "forbidden" }, 403);

  const file = c.req.param("file");
  if (!validLibraryFile(file))
    return c.json({ error: "invalid media key" }, 400);
  const key = mediaKey(ctx.tenant.id, file);
  const url = mediaUrl(key);
  if (!(await c.env.MEDIA.head(key))) return c.json({ error: "image not found" }, 404);

  if (ctx.tenant.avatar_key === key)
    return c.json({ error: "This image is the blog profile photo and cannot be deleted here." }, 409);
  const usedBy = await findMediaUse(tenantDb(c.env, ctx.tenant), ctx.tenant.id, url);
  if (usedBy)
    return c.json({ error: `This image is used by “${usedBy.title}”. Remove it from the post before deleting it.`, postId: usedBy.id }, 409);

  await c.env.MEDIA.delete(key);
  await Promise.all([
    purgeTenant(c.env, ctx.tenant, [url]),
    caches.default.delete(new Request(new URL(url, c.req.url), { method: "GET" })),
  ]);
  return c.json({ ok: true });
});

// --- Blog settings (title, tagline, profile photo) -------------------------

app.get("/admin/b/:blogId/settings", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.redirect(ctx.redirect);
  const denied = requireBlogCapability(c, ctx, "settings.manage");
  if (denied) return denied;
  return c.html(settingsPage(ctx.account, ctx.tenant));
});

app.post("/admin/b/:blogId/settings", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.redirect(ctx.redirect);
  const denied = requireBlogCapability(c, ctx, "settings.manage");
  if (denied) return denied;

  const form = await c.req.formData();
  const slug = String(form.get("slug") ?? "").trim().toLowerCase();
  const title = String(form.get("title") ?? "").trim();
  const description = String(form.get("description") ?? "").trim();
  const accentColor = String(form.get("accent_color") ?? "").trim();
  const normalizedTopics = normalizeTopics(String(form.get("topics") ?? ""));
  const slugError = validateSlug(slug);
  if (slugError)
    return c.html(settingsPage(ctx.account, ctx.tenant, { error: slugError }), 400);
  if (slug !== ctx.tenant.slug) {
    const taken = await c.env.DB.prepare("SELECT 1 FROM tenants WHERE slug = ? UNION SELECT 1 FROM tenant_slug_aliases WHERE old_slug = ?")
      .bind(slug, slug).first();
    if (taken) return c.html(settingsPage(ctx.account, ctx.tenant, { error: "That blog address is already in use." }), 409);
  }
  if (!title)
    return c.html(settingsPage(ctx.account, ctx.tenant, { error: "A blog title is required." }), 400);
  if (normalizedTopics.error)
    return c.html(settingsPage(ctx.account, ctx.tenant, { error: normalizedTopics.error }), 400);
  if (!/^#[0-9a-f]{6}$/i.test(accentColor))
    return c.html(settingsPage(ctx.account, ctx.tenant, { error: "Brand colour must be a six-digit hex value, such as #1a8917." }), 400);

  const now = Math.floor(Date.now() / 1000);
  if (slug !== ctx.tenant.slug) {
    await c.env.DB.prepare("INSERT INTO tenant_slug_aliases (old_slug, tenant_id, created_at) VALUES (?, ?, ?)")
      .bind(ctx.tenant.slug, ctx.tenant.id, now).run();
  }
  await c.env.DB.prepare("UPDATE tenants SET slug = ?, title = ?, description = ?, accent_color = ?, topics_json = ? WHERE id = ?")
    .bind(slug, title, description, accentColor.toLowerCase(), JSON.stringify(normalizedTopics.topics), ctx.tenant.id)
    .run();

  c.executionCtx.waitUntil(purgeTenantEverywhere(c.env, ctx.tenant));
  const updated = { ...ctx.tenant, slug, title, description, accent_color: accentColor.toLowerCase(), topics_json: JSON.stringify(normalizedTopics.topics) };
  return c.html(settingsPage(ctx.account, updated, { notice: "Saved." }));
});

// Avatar upload → R2; stores the key on the blog. Client pre-shrinks it.
app.post("/admin/b/:blogId/avatar", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.json({ error: "unauthorized" }, 401);
  if (!can(ctx.role, "settings.manage")) return c.json({ error: "forbidden" }, 403);

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "no file" }, 400);
  if (!ALLOWED_IMAGE.has(file.type))
    return c.json({ error: "unsupported image type" }, 400);
  if (file.size > MAX_UPLOAD) return c.json({ error: "image too large" }, 413);

  const rand = crypto.randomUUID().slice(0, 8);
  const key = `${ctx.tenant.id}/avatar-${rand}.${EXT[file.type]}`;
  await c.env.MEDIA.put(key, await file.arrayBuffer(), {
    httpMetadata: {
      contentType: file.type,
      cacheControl: "public, max-age=31536000, immutable",
    },
  });

  // Delete the previous avatar object, if any, then point the blog at the new one.
  if (ctx.tenant.avatar_key)
    c.executionCtx.waitUntil(c.env.MEDIA.delete(ctx.tenant.avatar_key));
  await c.env.DB.prepare("UPDATE tenants SET avatar_key = ? WHERE id = ?")
    .bind(key, ctx.tenant.id)
    .run();

  c.executionCtx.waitUntil(purgeTenantEverywhere(c.env, ctx.tenant));
  return c.json({ url: `/media/${key}` });
});

app.post("/admin/b/:blogId/avatar/remove", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.json({ error: "unauthorized" }, 401);
  if (!can(ctx.role, "settings.manage")) return c.json({ error: "forbidden" }, 403);
  if (ctx.tenant.avatar_key) {
    c.executionCtx.waitUntil(c.env.MEDIA.delete(ctx.tenant.avatar_key));
    await c.env.DB.prepare("UPDATE tenants SET avatar_key = NULL WHERE id = ?")
      .bind(ctx.tenant.id)
      .run();
    c.executionCtx.waitUntil(purgeTenantEverywhere(c.env, ctx.tenant));
  }
  return c.json({ ok: true });
});

const FAVICON_TYPES = new Set(["image/png", "image/x-icon", "image/vnd.microsoft.icon"]);
app.post("/admin/b/:blogId/favicon", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.json({ error: "unauthorized" }, 401);
  if (!can(ctx.role, "settings.manage")) return c.json({ error: "forbidden" }, 403);
  const file = (await c.req.formData()).get("file");
  if (!(file instanceof File)) return c.json({ error: "no file" }, 400);
  if (!FAVICON_TYPES.has(file.type)) return c.json({ error: "Use a PNG or ICO favicon." }, 400);
  if (file.size > 1024 * 1024) return c.json({ error: "Favicon is too large (maximum 1 MB)." }, 413);
  const ext = file.type === "image/png" ? "png" : "ico";
  const key = `${ctx.tenant.id}/favicon-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  await c.env.MEDIA.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type, cacheControl: "public, max-age=3600" } });
  if (ctx.tenant.favicon_key) c.executionCtx.waitUntil(c.env.MEDIA.delete(ctx.tenant.favicon_key));
  await c.env.DB.prepare("UPDATE tenants SET favicon_key = ? WHERE id = ?").bind(key, ctx.tenant.id).run();
  c.executionCtx.waitUntil(purgeTenantEverywhere(c.env, ctx.tenant));
  return c.json({ ok: true });
});

app.post("/admin/b/:blogId/favicon/remove", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.json({ error: "unauthorized" }, 401);
  if (!can(ctx.role, "settings.manage")) return c.json({ error: "forbidden" }, 403);
  if (ctx.tenant.favicon_key) c.executionCtx.waitUntil(c.env.MEDIA.delete(ctx.tenant.favicon_key));
  await c.env.DB.prepare("UPDATE tenants SET favicon_key = NULL WHERE id = ?").bind(ctx.tenant.id).run();
  c.executionCtx.waitUntil(purgeTenantEverywhere(c.env, ctx.tenant));
  return c.json({ ok: true });
});

// --- Admin: subscribers ----------------------------------------------------

app.get("/admin/b/:blogId/subscribers", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.redirect(ctx.redirect);
  const denied = requireBlogCapability(c, ctx, "settings.manage");
  if (denied) return denied;
  const { results } = await c.env.DB.prepare(
    "SELECT email, created_at FROM subscribers WHERE tenant_id = ? ORDER BY created_at DESC"
  )
    .bind(ctx.tenant.id)
    .all<{ email: string; created_at: number }>();
  return c.html(subscribersPage(ctx.account, ctx.tenant, results, emailEnabled(c.env)));
});

app.post("/admin/b/:blogId/subscribers/remove", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.redirect(ctx.redirect);
  const denied = requireBlogCapability(c, ctx, "settings.manage");
  if (denied) return denied;
  const form = await c.req.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  await c.env.DB.prepare("DELETE FROM subscribers WHERE tenant_id = ? AND email = ?")
    .bind(ctx.tenant.id, email)
    .run();
  return c.redirect(`/admin/b/${ctx.tenant.public_id}/subscribers`);
});

app.get("/admin/b/:blogId/subscribers.csv", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.redirect(ctx.redirect);
  const denied = requireBlogCapability(c, ctx, "settings.manage");
  if (denied) return denied;
  const { results } = await c.env.DB.prepare(
    "SELECT email, created_at FROM subscribers WHERE tenant_id = ? ORDER BY created_at DESC"
  )
    .bind(ctx.tenant.id)
    .all<{ email: string; created_at: number }>();
  const rows = ["email,subscribed_at"].concat(
    results.map((r) => `${r.email},${new Date(r.created_at * 1000).toISOString()}`)
  );
  return new Response(rows.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="subscribers-${ctx.tenant.slug}.csv"`,
    },
  });
});

// ---------------------------------------------------------------------------
// Public self-service signup: visitor -> their own blog, logged in.
// ---------------------------------------------------------------------------
app.get("/signup", async (c) => {
  if (await currentAccount(c)) return c.redirect("/admin");
  return c.html(signupPage(c.env.ROOT_DOMAIN, undefined, undefined, c.req.query("invite") || undefined));
});

app.post("/signup", async (c) => {
  if (await currentAccount(c)) return c.redirect("/admin");

  const form = await c.req.formData();
  const slug = String(form.get("slug") ?? "").trim().toLowerCase();
  const title = String(form.get("title") ?? "").trim();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  const inviteToken = String(form.get("invite") ?? "").trim();
  const values = { slug, title, email };
  const fail = (msg: string, status: 400 | 409 = 400) =>
    c.html(signupPage(c.env.ROOT_DOMAIN, values, msg, inviteToken || undefined), status);

  type SignupInvite = { id: number; tenant_id: number; email: string; role: MembershipRole };
  let invite: SignupInvite | null = null;
  if (inviteToken) {
    const now = Math.floor(Date.now() / 1000);
    invite = await c.env.DB.prepare("SELECT id, tenant_id, email, role FROM blog_invitations WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?")
      .bind(await sha256hex(inviteToken), now).first<SignupInvite>();
    if (!invite) return fail("This invitation is invalid or has expired.", 400);
    if (invite.email !== email) return fail(`Use the invited email address: ${invite.email}`, 400);
  }

  if (!invite) {
    const slugError = validateSlug(slug);
    if (slugError) return fail(slugError);
    if (!title) return fail("Please enter a blog title.");
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return fail("Please enter a valid email address.");
  if (password.length < 8)
    return fail("Password must be at least 8 characters.");

  // Pre-check uniqueness for friendly errors (DB constraints are the backstop).
  if (!invite && await c.env.DB.prepare("SELECT 1 FROM tenants WHERE slug = ?").bind(slug).first())
    return fail("That address is already taken.", 409);
  if (await c.env.DB.prepare("SELECT 1 FROM accounts WHERE email = ?").bind(email).first())
    return fail("That email already has an account.", 409);

  const now = Math.floor(Date.now() / 1000);

  // Create the account first; if the email raced us, stop before making a blog.
  let accountId: number;
  try {
    const pw_hash = await hashPassword(password);
    const res = await c.env.DB.prepare(
      "INSERT INTO accounts (email, pw_hash, created_at) VALUES (?, ?, ?)"
    )
      .bind(email, pw_hash, now)
      .run();
    accountId = res.meta.last_row_id as number;
  } catch {
    return fail("That email already has an account.", 409);
  }

  if (invite) {
    await c.env.DB.prepare("INSERT INTO memberships (account_id, tenant_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, tenant_id) DO UPDATE SET role = excluded.role")
      .bind(accountId, invite.tenant_id, invite.role, now).run();
    await c.env.DB.prepare("UPDATE blog_invitations SET accepted_at = ? WHERE id = ?").bind(now, invite.id).run();
    const tenant = await c.env.DB.prepare("SELECT public_id FROM tenants WHERE id = ?").bind(invite.tenant_id).first<{ public_id: string }>();
    const token = await createSession(c.env.DB, accountId);
    setSessionCookie(c, token);
    return c.redirect(`/admin/b/${tenant?.public_id ?? ""}`);
  }

  // Create the blog and link it to the account.
  let blogId: number;
  const publicId = newPublicId();
  try {
    const res = await c.env.DB.prepare(
      "INSERT INTO tenants (public_id, slug, title, description, shard, created_at) VALUES (?, ?, ?, '', 'primary', ?)"
    )
      .bind(publicId, slug, title, now)
      .run();
    blogId = res.meta.last_row_id as number;
  } catch {
    // Roll back the account so we don't leave one with no blog.
    await c.env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(accountId).run();
    return fail("That address is already taken.", 409);
  }
  await c.env.DB.prepare(
    "INSERT INTO memberships (account_id, tenant_id, role, created_at) VALUES (?, ?, 'owner', ?)"
  )
    .bind(accountId, blogId, now)
    .run();

  const token = await createSession(c.env.DB, accountId);
  setSessionCookie(c, token);
  return c.redirect(`/admin/b/${publicId}`);
  // TODO: before a public launch, add email verification here (send a confirm
  // link and gate the blog until confirmed) and rate-limit this endpoint.
});

// ---------------------------------------------------------------------------
// Self-service custom domains (inside the admin, scoped to the author's tenant).
// ---------------------------------------------------------------------------
async function loadDomains(c: any, tenantId: number) {
  const { results } = await c.env.DB.prepare(
    "SELECT hostname, status FROM domains WHERE tenant_id = ? ORDER BY created_at DESC"
  )
    .bind(tenantId)
    .all();
  return results as Array<{ hostname: string; status: string }>;
}

const domainCfg = (c: any) => ({
  cnameTarget: c.env.CNAME_TARGET,
  rootDomain: c.env.ROOT_DOMAIN,
});

app.get("/admin/b/:blogId/domains", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.redirect(ctx.redirect);
  const denied = requireBlogCapability(c, ctx, "settings.manage");
  if (denied) return denied;
  const domains = await loadDomains(c, ctx.tenant.id);
  return c.html(domainsPage(ctx.account, ctx.tenant, domains, domainCfg(c)));
});

app.post("/admin/b/:blogId/domains", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.redirect(ctx.redirect);
  const denied = requireBlogCapability(c, ctx, "settings.manage");
  if (denied) return denied;

  const form = await c.req.formData();
  const hostname = String(form.get("hostname") ?? "").trim().toLowerCase();
  const render = async (opts: any) =>
    c.html(
      domainsPage(ctx.account, ctx.tenant, await loadDomains(c, ctx.tenant.id), domainCfg(c), opts)
    );

  if (!validHostname(hostname, c.env.ROOT_DOMAIN.toLowerCase()))
    return render({ error: "Enter a valid subdomain, e.g. blog.yourcompany.com." });

  const existing = await c.env.DB.prepare(
    "SELECT tenant_id FROM domains WHERE hostname = ?"
  )
    .bind(hostname)
    .first<{ tenant_id: number }>();
  if (existing && existing.tenant_id !== ctx.tenant.id)
    return render({ error: "That domain is already connected to another blog." });

  let created = await createCustomHostname(c.env, hostname);
  if (!created.ok) {
    const found = await findCustomHostname(c.env, hostname);
    const hit = Array.isArray(found.result) ? found.result[0] : null;
    if (hit) created = { ...created, ok: true, result: hit };
    else {
      const detail = (created.errors || [])
        .map((e: any) => (e && e.message ? e.message : JSON.stringify(e)))
        .join("; ");
      // Also visible via `wrangler tail` / the observability logs.
      console.error(
        "custom hostname create failed",
        "status=" + created.status,
        "errors=" + JSON.stringify(created.errors)
      );
      const hint =
        created.status === 403 || created.status === 400
          ? " (check the CF_API_TOKEN secret and that it has SSL and Certificates: Edit)"
          : " (is Cloudflare for SaaS enabled on this zone?)";
      return render({
        error:
          "Couldn't register that domain with Cloudflare" +
          (detail ? ": " + detail : ` — HTTP ${created.status}`) +
          hint,
      });
    }
  }

  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    `INSERT INTO domains (hostname, tenant_id, cf_hostname_id, status, created_at)
     VALUES (?, ?, ?, 'pending', ?)
     ON CONFLICT (hostname) DO UPDATE SET cf_hostname_id = excluded.cf_hostname_id`
  )
    .bind(hostname, ctx.tenant.id, created.result?.id ?? null, now)
    .run();

  return render({ instructions: instructions(c.env, hostname, created.result) });
});

app.post("/admin/b/:blogId/domains/check", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.redirect(ctx.redirect);
  const denied = requireBlogCapability(c, ctx, "settings.manage");
  if (denied) return denied;

  const form = await c.req.formData();
  const hostname = String(form.get("hostname") ?? "").trim().toLowerCase();
  const render = async (opts: any) =>
    c.html(
      domainsPage(ctx.account, ctx.tenant, await loadDomains(c, ctx.tenant.id), domainCfg(c), opts)
    );

  const row = await c.env.DB.prepare(
    "SELECT cf_hostname_id, status FROM domains WHERE hostname = ? AND tenant_id = ?"
  )
    .bind(hostname, ctx.tenant.id)
    .first<{ cf_hostname_id: string; status: string }>();
  if (!row) return render({ error: "Domain not found." });

  const cfRes = row.cf_hostname_id
    ? await getCustomHostname(c.env, row.cf_hostname_id)
    : await findCustomHostname(c.env, hostname);
  const result = Array.isArray(cfRes.result) ? cfRes.result[0] : cfRes.result;
  if (!result) return render({ error: "Couldn't reach Cloudflare. Try again shortly." });

  if (isActive(result) && row.status !== "active") {
    await c.env.DB.prepare("UPDATE domains SET status = 'active' WHERE hostname = ?")
      .bind(hostname)
      .run();
    await c.env.DB.prepare("UPDATE tenants SET custom_domain = ? WHERE id = ?")
      .bind(hostname, ctx.tenant.id)
      .run();
    c.executionCtx.waitUntil(purgeHost(hostname, ["/", "/sitemap.xml"]));
  }

  return render({ instructions: instructions(c.env, hostname, result) });
});

app.post("/admin/b/:blogId/domains/remove", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.redirect(ctx.redirect);
  const denied = requireBlogCapability(c, ctx, "settings.manage");
  if (denied) return denied;

  const form = await c.req.formData();
  const hostname = String(form.get("hostname") ?? "").trim().toLowerCase();

  const row = await c.env.DB.prepare(
    "SELECT cf_hostname_id FROM domains WHERE hostname = ? AND tenant_id = ?"
  )
    .bind(hostname, ctx.tenant.id)
    .first<{ cf_hostname_id: string }>();
  if (row) {
    if (row.cf_hostname_id) await deleteCustomHostname(c.env, row.cf_hostname_id);
    await c.env.DB.prepare("DELETE FROM domains WHERE hostname = ? AND tenant_id = ?")
      .bind(hostname, ctx.tenant.id)
      .run();
    await c.env.DB.prepare(
      "UPDATE tenants SET custom_domain = NULL WHERE id = ? AND custom_domain = ?"
    )
      .bind(ctx.tenant.id, hostname)
      .run();
  }
  return c.redirect(`/admin/b/${ctx.tenant.public_id}/domains`);
});

// Serve an uploaded image from R2. Public, cached hard at the edge (keys are
// unique, so images are immutable). Key is <blogId>/<file>.
app.get("/media/:blogId/:file", async (c) => {
  const key = `${c.req.param("blogId")}/${c.req.param("file")}`;
  const cache = caches.default;
  const cacheKey = new Request(c.req.url, { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const obj = await c.env.MEDIA.get(key);
  if (!obj) return new Response("Not found", { status: 404 });

  const res = new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
      etag: obj.httpEtag,
    },
  });
  c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
});

// --- Subscriptions ---------------------------------------------------------

// A reader subscribes to this blog (resolved by host).
app.post("/subscribe", async (c) => {
  const tenant = await resolveTenant(c.env, c.req.header("host") || "");
  if (!tenant) return c.json({ error: "no blog here" }, 404);

  const form = await c.req.formData().catch(() => null);
  const email = String(form?.get("email") ?? "").trim().toLowerCase();
  const navigate = c.req.header("sec-fetch-mode") === "navigate";
  const ok = (already: boolean) =>
    navigate
      ? c.html(
          renderSimplePage(
            tenant,
            "Subscribed",
            already
              ? `<p>You're already subscribed to ${esc(tenant.title)}.</p>`
              : `<p>Thanks — you're subscribed to ${esc(tenant.title)}. New posts will arrive in your inbox.</p>`
          )
        )
      : c.json({ ok: true, already });

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return navigate
      ? c.html(renderSimplePage(tenant, "Subscribe", `<p>Please enter a valid email address.</p>`), 400)
      : c.json({ error: "Please enter a valid email address." }, 400);

  const existing = await c.env.DB.prepare(
    "SELECT 1 FROM subscribers WHERE tenant_id = ? AND email = ?"
  )
    .bind(tenant.id, email)
    .first();
  if (existing) return ok(true);

  const token = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    "INSERT INTO subscribers (tenant_id, email, token, created_at) VALUES (?, ?, ?, ?)"
  )
    .bind(tenant.id, email, token, now)
    .run();

  // Optional welcome email with a one-click unsubscribe link.
  if (emailEnabled(c.env)) {
    const origin = publicOrigin(c.env, tenant);
    const unsub = `${origin}/unsubscribe/${token}`;
    c.executionCtx.waitUntil(
      sendEmail(c.env, {
        to: email,
        subject: `You're subscribed to ${tenant.title}`,
        html: `<p>Thanks for subscribing to <strong>${esc(tenant.title)}</strong>. You'll get new posts by email.</p>
          <hr><p style="color:#888;font-size:13px"><a href="${unsub}">Unsubscribe</a> anytime.</p>`,
        headers: {
          "List-Unsubscribe": `<${unsub}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }).then(() => {})
    );
  }

  return ok(false);
});

// Unsubscribe: GET shows a confirm page; POST (also one-click) removes.
app.get("/unsubscribe/:token", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT tenant_id, email FROM subscribers WHERE token = ?"
  )
    .bind(c.req.param("token"))
    .first<{ tenant_id: number; email: string }>();
  if (!row) {
    const t = await resolveTenant(c.env, c.req.header("host") || "");
    const body = `<p>This unsubscribe link is invalid or already used.</p>`;
    return t
      ? c.html(renderSimplePage(t, "Unsubscribe", body), 404)
      : c.text("Invalid unsubscribe link", 404);
  }
  const tenant = (await tenantById(c.env, row.tenant_id))!;
  return c.html(
    renderSimplePage(
      tenant,
      "Unsubscribe",
      `<p>Unsubscribe <strong>${esc(row.email)}</strong> from ${esc(tenant.title)}?</p>
       <form method="post" action="/unsubscribe/${esc(c.req.param("token"))}" style="margin-top:1rem">
         <button type="submit" style="font:inherit;background:var(--accent);color:#fff;border:none;border-radius:6px;padding:0.6rem 1.1rem;cursor:pointer">Unsubscribe</button>
       </form>`
    )
  );
});

app.post("/unsubscribe/:token", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT tenant_id FROM subscribers WHERE token = ?"
  )
    .bind(c.req.param("token"))
    .first<{ tenant_id: number }>();
  await c.env.DB.prepare("DELETE FROM subscribers WHERE token = ?")
    .bind(c.req.param("token"))
    .run();
  const tenant = row ? await tenantById(c.env, row.tenant_id) : null;
  if (!tenant) return c.text("You've been unsubscribed.", 200);
  return c.html(
    renderSimplePage(tenant, "Unsubscribed", `<p>You've been unsubscribed from ${esc(tenant.title)}. Sorry to see you go.</p>`)
  );
});

// Home page: list of published posts.
app.get("/", async (c) => {
  const host = (c.req.header("host") || "").split(":")[0].toLowerCase();
  if (host === `www.${c.env.ROOT_DOMAIN.toLowerCase()}`) {
    return new Response(homepage, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=300, s-maxage=3600",
      },
    });
  }
  const legacy = await legacySlugRedirect(c);
  if (legacy) return legacy;
  return serveCached(c, async () => {
    const tenant = await resolveTenant(c.env, c.req.header("host") || "");
    if (!tenant)
      return new Response(renderNotFound(null), {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" },
      });

    const { results } = await tenantDb(c.env, tenant).prepare(
      "SELECT * FROM posts WHERE tenant_id = ? AND published = 1 ORDER BY created_at DESC"
    )
      .bind(tenant.id)
      .all<Post>();

    return new Response(renderHome(tenant, results, originOf(c)), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });
});

// A single post: /<slug>. This is the catch-all, so it goes last.
app.get("/:slug", async (c) => {
  const legacy = await legacySlugRedirect(c);
  if (legacy) return legacy;
  return serveCached(c, async () => {
    const tenant = await resolveTenant(c.env, c.req.header("host") || "");
    if (!tenant)
      return new Response(renderNotFound(null), {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" },
      });

    const post = await tenantDb(c.env, tenant).prepare(
      "SELECT * FROM posts WHERE tenant_id = ? AND slug = ? AND published = 1"
    )
      .bind(tenant.id, c.req.param("slug"))
      .first<Post>();

    if (!post)
      return new Response(renderNotFound(tenant), {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" },
      });

    const htmlBody = renderMarkdown(post.body_md);

    return new Response(renderPost(tenant, post, htmlBody, originOf(c), adminOriginOf(c)), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });
});

export default {
  fetch: app.fetch,
  async queue(batch, env) {
    for (const message of batch.messages) {
      const jobMessage = message.body as AudioJobMessage | ImageJobMessage;
      try {
        if ("kind" in jobMessage && jobMessage.kind === "image") await processImageJob(env, jobMessage.jobKey);
        else await processAudioJob(env, jobMessage.jobKey);
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({
          message: "Queued audio job failed; retrying",
          jobKey: jobMessage.jobKey,
          error: error instanceof Error ? error.message : String(error),
        }));
        message.retry();
      }
    }
  },
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      Promise.all([archivePreviousDay(env), archivePreviousDayEvents(env)]).catch((error) => {
        console.error(JSON.stringify({
          message: "metrics archive failed",
          error: error instanceof Error ? error.message : String(error),
        }));
      })
    );
  },
} satisfies ExportedHandler<Bindings>;
