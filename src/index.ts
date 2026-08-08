import { Hono, type Context } from "hono";
import { verifyPlatformBearer } from "./platform-auth";
import {
  esc,
  renderHome,
  renderPost,
  renderNotFound,
  renderSimplePage,
  type Post,
  type Tenant,
} from "./render";
import { sendEmail, sendEmailDetailed, emailEnabled } from "./email";
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
  generateResetToken,
  sha256hex,
  accountFromApiKey,
  accountHasPaidPlan,
  type Account,
} from "./auth";
import {
  loginPage,
  forgotPasswordPage,
  resetPasswordPage,
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
  auditPage,
  shell,
  type MediaItem,
} from "./admin";
import { tenantDb } from "./db";
import homepage from "../homepage.html";
import privacyPage from "../privacy.html";
import termsPage from "../terms.html";
import cookiesPage from "../cookies.html";
import securityPage from "../security.html";
import algorithmsPage from "../algorithms.html";
import policiesPage from "../policies.html";
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
  auditReport,
  recordPageView,
  recordCustomEvent,
  recordAuditEvent,
  analyticsConsentRequired,
  ANALYTICS_CONSENT_VERSION,
} from "./metrics";
import { checkoutSubscriptionDecision, createCheckoutSession, createPortalSession, retrieveSubscription, stripeConfigured, subscriptionEventMatchesCurrent, verifyStripeSignature } from "./stripe";
import { createAnnualInvoice, getPayment, isTerminalPaidStatus, nowPaymentsConfigured, verifyNowPaymentsIpn, NOWPAYMENTS_ANNUAL_SECONDS, NOWPAYMENTS_ANNUAL_USD } from "./nowpayments";
import { renderMarkdown as renderMarkdownSafe } from "./markdown";
import { buildSitemapIndexXml, cacheVariants, CACHE_VERSION, customDomainRedirectUrl, indexNowKey } from "./indexing";
import { applySubscriberConfirmation, requestSubscriberConfirmation } from "./subscriber-optin";
import { refreshPostPopularity } from "./popularity";


type Bindings = {
  DB: D1Database; // index database: tenants, users, sessions, domains
  POSTS: D1Database; // posts database: post bodies (routed via tenantDb)
  MEDIA: R2Bucket; // image uploads and generated narration
  AI: Ai; // Cloudflare Workers AI image and speech generation
  AUDIO_QUEUE: Queue<AudioJobMessage | ImageJobMessage>; // queued AI media jobs
  INDEXNOW_QUEUE?: Queue<IndexNowMessage>; // search-engine discovery notifications
  EMAIL_QUEUE?: Queue<EmailJobMessage | EmailFanoutMessage>; // queued transactional email jobs
  METRICS: AnalyticsEngineDataset; // anonymous public page-view events
  EVENTS: AnalyticsEngineDataset; // audio engagement events
  METRICS_ARCHIVE: R2Bucket; // aggregate daily metrics retained beyond 90 days
  ROOT_DOMAIN: string; // e.g. "blognice.com"
  API_TOKEN?: string; // secret; authorizes the /api routes
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
  MAILNICE_API_KEY?: string; // secret
  EMAIL_FROM?: string; // var, e.g. "Blog Nice <hello@blognice.com>"
  STRIPE_SECRET_KEY?: string; // secret
  STRIPE_WEBHOOK_SECRET?: string; // secret
  STRIPE_PRICE_ID?: string; // var/secret
  STRIPE_MONTHLY_PRICE_ID?: string;
  STRIPE_YEARLY_PRICE_ID?: string;
  STRIPE_PORTAL_CONFIGURATION_ID?: string; // optional var
  NOWPAYMENTS_API_KEY?: string; // secret
  NOWPAYMENTS_IPN_SECRET?: string; // secret
  INDEXNOW_MASTER_SECRET?: string; // secret; derives per-host IndexNow keys
};

const app = new Hono<{ Bindings: Bindings }>();

// Keep every authenticated admin page and mutation on the canonical host.
// Tenant and custom-domain hosts remain public reader origins; they must not
// become alternate admin origins that share the session cookie.
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
    const host = url.hostname.toLowerCase();
    const canonical = `www.${c.env.ROOT_DOMAIN}`.toLowerCase();
    const local = host === "localhost" || host === "127.0.0.1";
    if (!local && host !== canonical) {
      url.protocol = "https:";
      url.hostname = canonical;
      if (c.req.method === "GET" || c.req.method === "HEAD") return c.redirect(url.toString(), 308);
      return c.json({ error: "canonical admin host required" }, 403);
    }
  }
  return next();
});

// Markdown → HTML. Adds heading `id` slugs (via slugify, defined below) so
// in-page anchor links — a table of contents like [Tables](#tables) — jump.
// A fresh slug counter per call keeps duplicate headings unique (foo, foo-1…).
function legacyRenderMarkdown(md: string): string {
  return renderMarkdownSafe(md);
}

/* Legacy regex sanitizer retained only as historical reference. The active
// renderer is the parser-based implementation in src/markdown.ts.
// Markdown is authored by collaborators, so raw HTML must not become a stored
// XSS vector. Keep harmless formatting while removing executable/embed content
// and event/javascript URLs. This historical implementation was dependency-free;
// it is inactive and retained only as a record of the former approach.
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
*/

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

function customDomainRedirect(c: any, tenant: Tenant): Response | null {
  const location = customDomainRedirectUrl(c.req.url, tenant, c.env.ROOT_DOMAIN);
  return location ? Response.redirect(location, 308) : null;
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
  cacheUrl.searchParams.set("_bn_shell", CACHE_VERSION);
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
    paths.flatMap((p) => cacheVariants(origin + p).map((url) => cache.delete(new Request(url, { method: "GET" }))))
  );
}

// Purge pages served on a specific customer hostname (used when a domain
// activates, since those pages live under a different origin than the API).
async function purgeHost(hostname: string, paths: string[]): Promise<void> {
  const cache = caches.default;
  await Promise.all(
    paths.flatMap((p) => cacheVariants(`https://${hostname}${p}`).map((url) =>
      cache.delete(new Request(url, { method: "GET" }))
    ))
  );
}

// Shared bearer-token check for the /api routes.
function authorized(c: any): boolean {
  return verifyPlatformBearer(c.req.header("authorization"), c.env.API_TOKEN);
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
      for (const url of cacheVariants(`https://${host}${p}`))
        jobs.push(cache.delete(new Request(url, { method: "GET" })));
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

function queueIndexNow(c: any, tenant: Tenant, paths: string[]): void {
  if (!c.env.INDEXNOW_QUEUE || !c.env.INDEXNOW_MASTER_SECRET) return;
  const origin = publicOrigin(c.env, tenant);
  const urls = Array.from(new Set(paths.map((path) => `${origin}${path.startsWith("/") ? path : `/${path}`}`)));
  c.executionCtx.waitUntil(c.env.INDEXNOW_QUEUE.send({ kind: "indexnow", urls }));
}

async function processIndexNow(env: Bindings, job: IndexNowMessage): Promise<void> {
  if (!env.INDEXNOW_MASTER_SECRET || !job.urls.length) return;
  const grouped = new Map<string, string[]>();
  for (const value of job.urls) {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const list = grouped.get(host) || [];
    list.push(url.toString());
    grouped.set(host, list);
  }
  for (const [host, urls] of grouped) {
    const key = await indexNowKey(env.INDEXNOW_MASTER_SECRET, host);
    const response = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host, key, keyLocation: `https://${host}/.well-known/indexnow/${key}`, urlList: Array.from(new Set(urls)).slice(0, 10_000) }),
    });
    if (!response.ok && response.status !== 202) throw new Error(`IndexNow returned HTTP ${response.status}.`);
  }
}

// The parser-based renderer is the only renderer used by public pages and the
// live preview. The legacy implementation remains temporarily for comparison
// while deployments roll over, but is intentionally unreachable.
function renderMarkdown(md: string): string {
  return renderMarkdownSafe(md);
}

function subscriptionManageUrl(env: Bindings, token: string): string {
  return `https://www.${env.ROOT_DOMAIN}/manage-subscriptions/${encodeURIComponent(token)}`;
}

async function subscriptionManageToken(env: Bindings, email: string): Promise<string> {
  const existing = await env.DB.prepare("SELECT token FROM subscription_manage_tokens WHERE email = ?")
    .bind(email).first<{ token: string }>();
  if (existing) return existing.token;
  const token = crypto.randomUUID();
  try {
    await env.DB.prepare("INSERT INTO subscription_manage_tokens (email, token, created_at) VALUES (?, ?, ?)")
      .bind(email, token, Math.floor(Date.now() / 1000)).run();
    return token;
  } catch {
    const raced = await env.DB.prepare("SELECT token FROM subscription_manage_tokens WHERE email = ?")
      .bind(email).first<{ token: string }>();
    if (!raced) throw new Error("Unable to create subscription management token");
    return raced.token;
  }
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
  if (env.EMAIL_QUEUE) await env.EMAIL_QUEUE.send({ kind: "email-fanout", campaignId: crypto.randomUUID(), tenantId: tenant.id, postSlug: post.slug, postTitle: post.title, afterId: 0 } satisfies EmailFanoutMessage);
}

// Claim and queue the one notification allowed for a post. The conditional
// update makes editor/API races idempotent; failed queue submission releases
// the claim so a later publish attempt can retry.
async function queueSubscriberNotificationOnce(env: Bindings, tenant: Tenant, postId: number, post: { slug: string; title: string }): Promise<boolean> {
  if (!emailEnabled(env) || !env.EMAIL_QUEUE) return false;
  const result = await tenantDb(env, tenant).prepare(
    "UPDATE posts SET subscriber_notification_sent = 1 WHERE id = ? AND tenant_id = ? AND published = 1 AND subscriber_notification_sent = 0"
  ).bind(postId, tenant.id).run();
  if (result.meta.changes !== 1) return false;
  try {
    await notifySubscribers(env, tenant, post);
    return true;
  } catch (error) {
    await tenantDb(env, tenant).prepare("UPDATE posts SET subscriber_notification_sent = 0 WHERE id = ? AND tenant_id = ? AND subscriber_notification_sent = 1").bind(postId, tenant.id).run();
    throw error;
  }
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
  if (!host.startsWith("www.")) {
    const tenant = await resolveTenant(c.env, host);
    const redirect = tenant ? customDomainRedirect(c, tenant) : null;
    if (redirect) return redirect;
  }
  return next();
});

app.get("/.well-known/indexnow/:key", async (c) => {
  const secret = c.env.INDEXNOW_MASTER_SECRET;
  const host = new URL(c.req.url).hostname.toLowerCase();
  const tenant = await resolveTenant(c.env, host);
  if (!secret || !tenant) return c.text("Not found", 404);
  const expected = await indexNowKey(secret, host);
  if (c.req.param("key") !== expected) return c.text("Not found", 404);
  return c.text(expected, { headers: { "cache-control": "public, max-age=86400, immutable" } });
});

app.get("/robots.txt", (c) => {
  const host = new URL(c.req.url).hostname.toLowerCase();
  const sitemap = host === `www.${c.env.ROOT_DOMAIN}`.toLowerCase() ? "/sitemap-index.xml" : "/sitemap.xml";
  const body = `User-agent: *\nAllow: /\nSitemap: ${originOf(c)}${sitemap}\n`;
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

/** Normalize the JSON-friendly tag form accepted by the public API. */
function normalizeApiPostTags(value: unknown): { tags: string[]; error?: string } {
  if (value === undefined) return { tags: [] };
  const input = Array.isArray(value) ? value.map(String).join(",") : String(value ?? "");
  return normalizePostTags(input);
}

function storedPostTags(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch { return []; }
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
  if (!origin || new URL(c.req.url).origin !== origin) return c.body(null, 403);

  let body: { path?: unknown; referrer?: unknown; visitor?: unknown; consent?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.body(null, 400);
  }
  if (body.consent !== ANALYTICS_CONSENT_VERSION || c.req.header("x-blognice-consent") !== ANALYTICS_CONSENT_VERSION) return c.body(null, 403);
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
  if (!origin || new URL(c.req.url).origin !== origin) return c.body(null, 403);
  let body: { event?: unknown; path?: unknown; visitor?: unknown; consent?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.body(null, 400);
  }
  if (body.consent !== ANALYTICS_CONSENT_VERSION || c.req.header("x-blognice-consent") !== ANALYTICS_CONSENT_VERSION) return c.body(null, 403);
  const name = body.event;
  const path = typeof body.path === "string" ? body.path : "";
  const visitor = typeof body.visitor === "string" ? body.visitor : "";
  if ((name !== "audio_start" && name !== "audio_complete" && name !== "engaged_read") ||
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

  // Keep authenticated admin pages on the canonical host. Returning the
  // tenant/custom-domain origin would make the browser send the admin
  // request from a host that the protected AI endpoint must reject.
  return reply({ url: `${adminOriginOf(c)}/admin/b/${tenant.public_id}/edit/${postParam}` });
});

app.get("/_blognice/blog-edit-link", async (c) => {
  const tenant = await tenantByPublicId(c.env, c.req.query("tenant") || "");
  const account = await currentAccount(c);
  if (!tenant || !account) return new Response(JSON.stringify({ error: "Forbidden." }), { status: 403, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
  const membership = await c.env.DB.prepare("SELECT role FROM memberships WHERE tenant_id = ? AND account_id = ?").bind(tenant.id, account.id).first<{ role: MembershipRole }>();
  if (!membership || membership.role !== "owner") return new Response(JSON.stringify({ error: "Forbidden." }), { status: 403, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
  return new Response(JSON.stringify({ url: `${adminOriginOf(c)}/admin/b/${tenant.public_id}/settings` }), { headers: { "content-type": "application/json", "cache-control": "private, no-store", vary: "Cookie" } });
});

app.get("/sitemap-index.xml", async (c) => {
  const host = new URL(c.req.url).hostname.toLowerCase();
  if (host !== `www.${c.env.ROOT_DOMAIN}`.toLowerCase()) return c.text("Not found", 404);
  return serveCached(c, async () => {
    const { results } = await c.env.DB.prepare(
      "SELECT slug FROM tenants WHERE custom_domain IS NULL AND slug <> 'www' ORDER BY created_at"
    ).all<{ slug: string }>();
    const xml = buildSitemapIndexXml(results.map((tenant) => tenant.slug), c.env.ROOT_DOMAIN);
    return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=300" } });
  });
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

// Create or upsert a post. Auth: Authorization: Bearer <API_TOKEN>.
// Body (JSON): { tenant_slug, slug, title, body_md, published?, tags?, author_name?, author_visible?, featured_image_key? }
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
  const normalizedTags = normalizeApiPostTags(payload?.tags);
  if (normalizedTags.error) return c.json({ error: normalizedTags.error }, 400);
  const authorName = payload?.author_name === undefined || payload?.author_name === null
    ? null : String(payload.author_name).trim().slice(0, 120);
  if (payload?.author_name !== undefined && payload?.author_name !== null && String(payload.author_name).trim().length > 120)
    return c.json({ error: "author_name must be 120 characters or fewer" }, 400);
  const authorVisible = payload?.author_visible === undefined ? 1 : (payload.author_visible ? 1 : 0);

  const now = Math.floor(Date.now() / 1000);
  try {
    await tenantDb(c.env, tenant).prepare(
      `INSERT INTO posts (tenant_id, slug, title, featured_image_key, body_md, tags_json, published, created_at, updated_at, author_name, author_visible)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, slug)
       DO UPDATE SET title = excluded.title,
                     featured_image_key = CASE WHEN ? = 1 THEN excluded.featured_image_key ELSE posts.featured_image_key END,
                     body_md = excluded.body_md,
                     tags_json = excluded.tags_json,
                     author_name = excluded.author_name,
                     author_visible = excluded.author_visible,
                     published = excluded.published, updated_at = excluded.updated_at`
    )
      .bind(tenant.id, slug, title, featuredImageKey, body_md, JSON.stringify(normalizedTags.tags), published, now, now, authorName, authorVisible, hasFeaturedImage ? 1 : 0)
      .run();
  } catch (e: any) {
    return c.json({ error: "db error", detail: String(e?.message ?? e) }, 500);
  }
  const savedPost = await tenantDb(c.env, tenant).prepare("SELECT id FROM posts WHERE tenant_id = ? AND slug = ?").bind(tenant.id, slug).first<{ id: number }>();

  // Invalidate the pages this post affects.
  await purge(c, ["/", "/" + slug, "/sitemap.xml"]);
  if (published) {
    queueIndexNow(c, tenant, ["/", "/" + slug]);
    if (savedPost) c.executionCtx.waitUntil(queueSubscriberNotificationOnce(c.env, tenant, savedPost.id, { slug, title }));
  }

  return c.json({ ok: true, slug, tags: normalizedTags.tags, author_name: authorName, author_visible: !!authorVisible, published: !!published });
});

// ---------------------------------------------------------------------------
// Per-account API (v1). Auth: Authorization: Bearer <the account's API key>.
// Everything is scoped to blogs the account owns (membership check).
// ---------------------------------------------------------------------------

async function apiAccount(c: any): Promise<Account | null> {
  const m = (c.req.header("authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const account = await accountFromApiKey(c.env.DB, m[1].trim());
  return account && accountHasPaidPlan(account) ? account : null;
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

// Queue IndexNow notifications for already-published pages. Automatic
// notifications are sent when the API publishes or updates a post; this
// endpoint is for re-pinging a page after an external edit or a missed job.
// Body (JSON, optional): { post_ids?: number[], paths?: string[] }
app.post("/api/v1/blogs/:blogId/indexnow", async (c) => {
  const account = await apiAccount(c);
  if (!account) return c.json({ error: "unauthorized" }, 401);
  const tenant = await ownedTenantById(c.env, account.id, c.req.param("blogId"));
  if (!tenant) return c.json({ error: "blog not found" }, 404);
  const role = await membershipRoleFor(c.env, account.id, tenant.id);
  if (!role || !can(role, "posts.edit.any")) return c.json({ error: "forbidden" }, 403);
  if (!c.env.INDEXNOW_QUEUE || !c.env.INDEXNOW_MASTER_SECRET)
    return c.json({ error: "IndexNow is not configured" }, 503);

  let input: { post_ids?: unknown; paths?: unknown } = {};
  try {
    if (c.req.header("content-type")?.toLowerCase().includes("application/json"))
      input = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const requestedPaths = Array.isArray(input.paths)
    ? input.paths.map((path) => String(path).trim()).filter(Boolean)
    : [];
  const requestedIds = Array.isArray(input.post_ids) ? input.post_ids : [];
  if (requestedPaths.length > 1000 || requestedIds.length > 1000)
    return c.json({ error: "at most 1,000 paths or post_ids may be submitted" }, 400);

  const paths = new Set<string>();
  if (!requestedPaths.length && !requestedIds.length) {
    paths.add("/");
    paths.add("/sitemap.xml");
    paths.add("/rss.xml");
  }
  for (const path of requestedPaths) {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    if (!normalized || normalized.includes("?") || normalized.includes("#") || normalized.includes("//"))
      return c.json({ error: `invalid path: ${path}` }, 400);
    paths.add(normalized);
  }

  const specialPaths = new Set(["/", "/sitemap.xml", "/rss.xml"]);
  const postPaths = Array.from(paths).filter((path) => !specialPaths.has(path));
  if (postPaths.length) {
    const { results } = await tenantDb(c.env, tenant)
      .prepare("SELECT slug FROM posts WHERE tenant_id = ? AND published = 1")
      .bind(tenant.id)
      .all<{ slug: string }>();
    const publishedPaths = new Set(results.map((post) => `/${post.slug}`));
    const unknown = postPaths.filter((path) => !publishedPaths.has(path));
    if (unknown.length) return c.json({ error: "paths must refer to published posts or /, /sitemap.xml, /rss.xml", unknown_paths: unknown }, 400);
  }

  if (requestedIds.length) {
    const ids = requestedIds.map((id) => Number(id));
    if (ids.some((id) => !Number.isSafeInteger(id) || id < 1))
      return c.json({ error: "post_ids must contain positive integers" }, 400);
    const placeholders = ids.map(() => "?").join(",");
    const { results } = await tenantDb(c.env, tenant).prepare(
      `SELECT id, slug FROM posts WHERE tenant_id = ? AND published = 1 AND id IN (${placeholders})`
    ).bind(tenant.id, ...ids).all<{ id: number; slug: string }>();
    const found = new Set(results.map((post) => post.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) return c.json({ error: "post_ids must refer to published posts", missing_post_ids: missing }, 400);
    for (const post of results) paths.add(`/${post.slug}`);
  }

  const origin = publicOrigin(c.env, tenant);
  const urls = Array.from(paths).map((path) => `${origin}${path}`);
  c.executionCtx.waitUntil(c.env.INDEXNOW_QUEUE.send({ kind: "indexnow", urls }));
  return c.json({ queued: true, urls, count: urls.length }, 202);
});

// List a blog's posts.
app.get("/api/v1/blogs/:blogId/posts", async (c) => {
  const account = await apiAccount(c);
  if (!account) return c.json({ error: "unauthorized" }, 401);
  const tenant = await ownedTenantById(c.env, account.id, c.req.param("blogId"));
  if (!tenant) return c.json({ error: "blog not found" }, 404);
  const { results } = await tenantDb(c.env, tenant).prepare(
    `SELECT id, slug, title, featured_image_key, tags_json, author_name, author_visible, published, created_at, updated_at
       FROM posts WHERE tenant_id = ? ORDER BY created_at DESC`
  )
    .bind(tenant.id)
    .all();
  return c.json({ posts: results.map((post: any) => ({
    ...post,
    tags: storedPostTags(post.tags_json),
    tags_json: undefined,
  })) });
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
  return c.json({ post: {
    ...(post as any),
    tags: storedPostTags((post as any).tags_json),
    tags_json: undefined,
  } });
});

// Create a post. Body (JSON): { title, body_md, slug?, published?, tags?: string[], author_name?: string, author_visible?: boolean, featured_image_key?: string }
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
  const normalizedTags = normalizeApiPostTags(body?.tags);
  if (normalizedTags.error) return c.json({ error: normalizedTags.error }, 400);
  const authorName = body?.author_name === undefined || body?.author_name === null
    ? null : String(body.author_name).trim().slice(0, 120);
  if (body?.author_name !== undefined && String(body.author_name).trim().length > 120)
    return c.json({ error: "author_name must be 120 characters or fewer" }, 400);
  const authorVisible = body?.author_visible === undefined ? 1 : (body.author_visible ? 1 : 0);
  const now = Math.floor(Date.now() / 1000);

  const pdb = tenantDb(c.env, tenant);
  const exists = await pdb
    .prepare("SELECT 1 FROM posts WHERE tenant_id = ? AND slug = ?")
    .bind(tenant.id, slug)
    .first();
  if (exists)
    return c.json({ error: `a post with slug "${slug}" already exists` }, 409);

  const res = await pdb.prepare(
    `INSERT INTO posts (tenant_id, slug, title, featured_image_key, body_md, tags_json, published, created_at, updated_at, author_account_id, author_name, author_visible)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(tenant.id, slug, title, featuredImageKey, body_md, JSON.stringify(normalizedTags.tags), published, now, now, account.id, authorName, authorVisible)
    .run();
  c.executionCtx.waitUntil(
    purgeTenant(c.env, tenant, ["/", "/" + slug, "/sitemap.xml"])
  );
  if (published) {
    queueIndexNow(c, tenant, ["/", "/" + slug]);
    c.executionCtx.waitUntil(queueSubscriberNotificationOnce(c.env, tenant, Number(res.meta.last_row_id), { slug, title }));
  }
  return c.json({ post: { id: res.meta.last_row_id, slug, title, featured_image_key: featuredImageKey, tags: normalizedTags.tags, author_name: authorName, author_visible: !!authorVisible, published: !!published } }, 201);
});

// Update a post. Body (JSON): any of { title, body_md, slug, published, tags, author_name, author_visible, featured_image_key }
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
  const normalizedTags = body?.tags !== undefined
    ? normalizeApiPostTags(body.tags)
    : normalizeApiPostTags(post.tags_json || "[]");
  if (normalizedTags.error) return c.json({ error: normalizedTags.error }, 400);
  const authorName = body?.author_name !== undefined
    ? (body.author_name === null ? null : String(body.author_name).trim().slice(0, 120))
    : (post.author_name ?? null);
  if (body?.author_name !== undefined && body.author_name !== null && String(body.author_name).trim().length > 120)
    return c.json({ error: "author_name must be 120 characters or fewer" }, 400);
  const authorVisible = body?.author_visible !== undefined
    ? (body.author_visible ? 1 : 0) : (post.author_visible ?? 1);
  const now = Math.floor(Date.now() / 1000);

  if (slug !== post.slug) {
    const clash = await pdb
      .prepare("SELECT 1 FROM posts WHERE tenant_id = ? AND slug = ? AND id <> ?")
      .bind(tenant.id, slug, post.id)
      .first();
    if (clash) return c.json({ error: `slug "${slug}" already in use` }, 409);
  }

  await pdb.prepare(
    `UPDATE posts SET title = ?, featured_image_key = ?, body_md = ?, tags_json = ?, slug = ?, published = ?, updated_at = ?, author_name = ?, author_visible = ?
      WHERE id = ? AND tenant_id = ?`
  )
    .bind(title, featuredImageKey, body_md, JSON.stringify(normalizedTags.tags), slug, published, now, authorName, authorVisible, post.id, tenant.id)
    .run();
  c.executionCtx.waitUntil(
    purgeTenant(c.env, tenant, ["/", "/" + post.slug, "/" + slug, "/sitemap.xml"])
  );
  if (post.published || published) queueIndexNow(c, tenant, ["/", "/" + post.slug, "/" + slug]);
  if (!post.published && published)
    c.executionCtx.waitUntil(queueSubscriberNotificationOnce(c.env, tenant, post.id, { slug, title }));
  return c.json({ post: { id: post.id, slug, title, featured_image_key: featuredImageKey, tags: normalizedTags.tags, author_name: authorName, author_visible: !!authorVisible, published: !!published } });
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
    .prepare("SELECT slug, published FROM posts WHERE id = ? AND tenant_id = ?")
    .bind(c.req.param("id"), tenant.id)
    .first<{ slug: string; published: number }>();
  if (!post) return c.json({ error: "post not found" }, 404);
  await pdb.prepare("DELETE FROM posts WHERE id = ? AND tenant_id = ?")
    .bind(c.req.param("id"), tenant.id)
    .run();
  c.executionCtx.waitUntil(
    purgeTenant(c.env, tenant, ["/", "/" + post.slug, "/sitemap.xml"])
  );
  if (post.published) queueIndexNow(c, tenant, ["/", "/" + post.slug]);
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
  if (!(await tenantHasPaidPlan(c.env, tenant.id))) return c.json({ error: "AI image generation requires a paid plan." }, 402);
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
  let creditReservation: { accountId: number; period: string };
  try { creditReservation = await reserveAiCredits(c.env, tenant.id, AI_IMAGE_CREDITS); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : "AI credits unavailable" }, 402); }
  const jobId = crypto.randomUUID();
  const jobKey = `${tenant.id}/.image-jobs/${jobId}.json`;
  const job: ImageJobManifest = { tenantId: tenant.id, postId, source, style, status: "queued", creditCost: AI_IMAGE_CREDITS, creditAccountId: creditReservation.accountId, creditPeriod: creditReservation.period };
  try {
    await writeImageJob(c.env, jobKey, job);
    await c.env.AUDIO_QUEUE.send({ kind: "image", jobKey, tenantId: tenant.id });
  } catch (error) {
    await refundAiCredits(c.env, creditReservation.accountId, creditReservation.period, AI_IMAGE_CREDITS);
    throw error;
  }
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
  if (!(await tenantHasPaidPlan(c.env, tenant.id))) return c.json({ error: "AI narration requires a paid plan." }, 402);
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

async function tenantHasPaidPlan(env: Bindings, tenantId: number): Promise<boolean> {
  const owner = await env.DB.prepare(
    `SELECT COALESCE(a.billing_status, 'inactive') AS billing_status, a.crypto_paid_through
       FROM memberships m JOIN accounts a ON a.id = m.account_id
      WHERE m.tenant_id = ? AND m.role = 'owner' LIMIT 1`
  ).bind(tenantId).first<{ billing_status: string; crypto_paid_through?: number | null }>();
  return accountHasPaidPlan(owner || {});
}

function queueBlogAudit(c: any, tenantId: number, actorId: number, action: string, target = ""): void {
  c.executionCtx.waitUntil((async () => {
    if (!(await tenantHasPaidPlan(c.env, tenantId))) return;
    recordAuditEvent(c.env, tenantId, { action, target, actor: String(actorId) });
  })().catch((error) => console.error("audit event failed", error)));
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

async function forgotPasswordHandler(c: Context<{ Bindings: Bindings }>) {
  if (await currentAccount(c)) return c.redirect("/admin");
  return c.html(forgotPasswordPage());
}

app.get("/admin/forgot", forgotPasswordHandler);
app.get("/admin/forgot-password", (c) => c.redirect("/admin/forgot"));

async function sendForgotPasswordHandler(c: Context<{ Bindings: Bindings }>) {
  await c.env.DB.prepare("DELETE FROM password_resets WHERE expires_at < ?").bind(Math.floor(Date.now() / 1000)).run();
  const form = await c.req.formData();
  const email = String(form.get("email") || "").trim().toLowerCase();
  const generic = "If an account exists for that email, a password reset link is on its way.";
  if (email && email.length <= 320) {
    const account = await c.env.DB.prepare("SELECT id, email FROM accounts WHERE email = ? AND COALESCE(status, 'active') = 'active'")
      .bind(email).first<{ id: number; email: string }>();
    if (account) {
      const rawToken = generateResetToken();
      const tokenHash = await sha256hex(rawToken);
      const now = Math.floor(Date.now() / 1000);
      const recent = await c.env.DB.prepare("SELECT 1 FROM password_resets WHERE account_id = ? AND created_at > ? AND used = 0 LIMIT 1")
        .bind(account.id, now - 300).first();
      if (recent) return c.html(forgotPasswordPage(generic));
      await c.env.DB.prepare("DELETE FROM password_resets WHERE account_id = ?").bind(account.id).run();
      await c.env.DB.prepare("INSERT INTO password_resets (token_hash, account_id, created_at, expires_at, used) VALUES (?, ?, ?, ?, 0)")
        .bind(tokenHash, account.id, now, now + 3600).run();
      const resetUrl = `https://blognice.com/admin/reset?token=${encodeURIComponent(rawToken)}`;
      const job: EmailJobMessage = {
        kind: "email-delivery",
        emailKind: "password-reset",
        idempotencyKey: `password-reset:${tokenHash}`,
        to: account.email,
        subject: "Reset your blognice password",
        plainText: `We received a request to reset your blognice password.\n\nReset it here: ${resetUrl}\n\nThis link expires in one hour. If you did not request this, you can ignore this email.`,
        html: `<p>We received a request to reset your blognice password.</p><p><a href="${resetUrl}">Reset your password</a></p><p style="color:#687064;font-size:13px">This link expires in one hour. If you did not request this, you can ignore this email.</p>`,
      };
      if (emailEnabled(c.env) || c.env.MAILNICE_API_KEY || c.env.RESEND_API_KEY) {
        // Password resets are transactional and time-sensitive. Await the
        // provider request so a failed fetch cannot be lost with the response.
      const emailEnv = { ...c.env, EMAIL_FROM: c.env.EMAIL_FROM || "blognice <support@mailer.blognice.com>" };
        try {
          const result = await sendEmailDetailed(emailEnv, job);
          if (!result.ok) console.error("Password reset email provider rejected the message", {
            accountId: account.id,
            provider: result.provider,
            detail: result.detail,
          });
        } catch (error) {
          console.error("Password reset email delivery failed", error);
        }
      } else {
        console.info("Password reset link is unavailable because email delivery is not configured", {
          accountId: account.id,
          tokenHashPrefix: tokenHash.slice(0, 12),
        });
      }
    }
  }
  return c.html(forgotPasswordPage(generic));
}
app.post("/admin/forgot", sendForgotPasswordHandler);
app.post("/admin/forgot-password", sendForgotPasswordHandler);

async function resetPasswordFormHandler(c: Context<{ Bindings: Bindings }>) {
  const token = String(c.req.query("token") || "");
  if (!token || token.length > 200) return c.html(resetPasswordPage("", "This reset link is invalid or has expired."), 400);
  const row = await c.env.DB.prepare("SELECT token_hash FROM password_resets WHERE token_hash = ? AND used = 0 AND expires_at > ?")
    .bind(await sha256hex(token), Math.floor(Date.now() / 1000)).first();
  if (!row) return c.html(resetPasswordPage("", "This reset link is invalid or has expired."), 400);
  return c.html(resetPasswordPage(token));
}
app.get("/admin/reset", resetPasswordFormHandler);
app.get("/admin/reset-password", (c) => {
  const token = c.req.query("token");
  return c.redirect(`/admin/reset${token ? `?token=${encodeURIComponent(token)}` : ""}`);
});

async function applyPasswordResetHandler(c: Context<{ Bindings: Bindings }>) {
  const form = await c.req.formData();
  const token = String(form.get("token") || "");
  const password = String(form.get("password") || "");
  const confirm = String(form.get("confirm") || "");
  const tokenHash = await sha256hex(token);
  if (!token || password.length < 8 || password !== confirm) return c.html(resetPasswordPage(token, password !== confirm ? "The passwords do not match." : "Your password must be at least 8 characters."), 400);
  const now = Math.floor(Date.now() / 1000);
  const reset = await c.env.DB.prepare("SELECT account_id FROM password_resets WHERE token_hash = ? AND used = 0 AND expires_at > ?")
    .bind(tokenHash, now).first<{ account_id: number }>();
  if (!reset) return c.html(resetPasswordPage("", "This reset link is invalid or has expired."), 400);
  try {
    const hashStartedAt = Date.now();
    const pwHash = await hashPassword(password);
    console.info("Password hash completed", { algorithm: "scrypt", elapsedMs: Date.now() - hashStartedAt });
    const appliedAt = Math.floor(Date.now() / 1000);
    const writes = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE accounts SET pw_hash = ?
          WHERE id = ? AND EXISTS (
            SELECT 1 FROM password_resets
             WHERE token_hash = ? AND account_id = ? AND used = 0 AND expires_at > ?
          )`,
      ).bind(pwHash, reset.account_id, tokenHash, reset.account_id, appliedAt),
      c.env.DB.prepare(
        `DELETE FROM sessions
          WHERE account_id = ? AND EXISTS (
            SELECT 1 FROM password_resets
             WHERE token_hash = ? AND account_id = ? AND used = 0 AND expires_at > ?
          )`,
      ).bind(reset.account_id, tokenHash, reset.account_id, appliedAt),
      c.env.DB.prepare("UPDATE password_resets SET used = 1 WHERE token_hash = ? AND used = 0 AND expires_at > ?").bind(tokenHash, appliedAt),
    ]);
    if (!writes[0].meta.changes) {
      return c.html(resetPasswordPage("", "This reset link is invalid or has expired."), 400);
    }
    const session = await createSession(c.env.DB, reset.account_id);
    setSessionCookie(c, session);
    return c.redirect("/admin?message=Password%20updated");
  } catch (error) {
    console.error("Password reset application failed", error);
    return c.html(resetPasswordPage(token, "We couldn't apply that reset. Please try again or request a new link."), 500);
  }
}
app.post("/admin/reset", applyPasswordResetHandler);
app.post("/admin/reset-password", applyPasswordResetHandler);

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
  if (!accountHasPaidPlan(account)) return c.redirect("/admin/billing?message=API access is available on a paid plan.");
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
    `SELECT t.public_id, t.slug, t.title, t.description, t.avatar_key, t.topics_json, m.role FROM tenants t
       JOIN memberships m ON m.tenant_id = t.id
      WHERE m.account_id = ? ORDER BY t.title`
  )
    .bind(account.id)
    .all<{ public_id: string; slug: string; title: string; description: string | null; avatar_key: string | null; topics_json: string | null; role: MembershipRole }>();
  const owned = results.filter((blog) => blog.role === "owner");
  const collaborations = results.filter((blog) => blog.role !== "owner");
  // With exactly one blog, jump straight in — unless the list was asked for
  // explicitly (the "Blogs" nav link), so that link always shows the picker.
  // Keep a new/incomplete blog on this page so the setup checklist is visible.
  const firstBlogNeedsSetup = owned.length === 1 && (
    !owned[0].description?.trim() || !owned[0].avatar_key || !owned[0].topics_json || owned[0].topics_json === "[]"
  );
  const forceList = c.req.query("list");
  if (!forceList && !firstBlogNeedsSetup && owned.length === 1 && collaborations.length === 0)
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
  const maxBlogs = accountHasPaidPlan(account) ? 5 : 1;
  if ((ownedCount?.count ?? 0) >= maxBlogs)
    return fail(accountHasPaidPlan(account)
      ? "Your account can own up to five blogs. Collaborations do not count toward this limit."
      : "Free accounts can own one blog. Upgrade to add more blogs.", 409);

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
  if (!(await tenantHasPaidPlan(c.env, ctx.tenant.id))) return c.text("Collaborators are available on a paid plan.", 402);
  if (!can(ctx.role, "members.manage")) return c.text("You do not have permission to manage collaborators.", 403);
  const { results } = await c.env.DB.prepare(`SELECT m.account_id, a.email, m.role, m.display_name FROM memberships m JOIN accounts a ON a.id = m.account_id WHERE m.tenant_id = ? ORDER BY m.role, a.email`).bind(ctx.tenant.id).all<{ account_id: number; email: string; role: string; display_name: string | null }>();
  return c.html(collaboratorPage(ctx.account, ctx.tenant, results));
});

app.post("/admin/b/:blogId/authors", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.redirect(ctx.redirect);
  if (!(await tenantHasPaidPlan(c.env, ctx.tenant.id))) return c.text("Collaborators are available on a paid plan.", 402);
  if (!can(ctx.role, "members.manage")) return c.text("You do not have permission to manage collaborators.", 403);
  const form = await c.req.formData();
  if (String(form.get("action") ?? "") === "save-display-name") {
    const accountId = Number(form.get("account_id") ?? 0);
    const displayName = String(form.get("display_name") ?? "").trim().slice(0, 120) || null;
    if (!Number.isInteger(accountId) || accountId < 1)
      return c.text("Invalid collaborator.", 400);
    await c.env.DB.prepare("UPDATE memberships SET display_name = ? WHERE tenant_id = ? AND account_id = ?")
      .bind(displayName, ctx.tenant.id, accountId).run();
    queueBlogAudit(c, ctx.tenant.id, ctx.account.id, "author_name_updated", String(accountId));
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
  queueBlogAudit(c, ctx.tenant.id, ctx.account.id, "collaborator_invited", email);
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
  let previousSlug = "";
  if (idParam) {
    const prev = await pdb
      .prepare("SELECT slug, published, author_account_id, author_name FROM posts WHERE id = ? AND tenant_id = ?")
      .bind(idParam, ctx.tenant.id)
      .first<{ slug: string; published: number; author_account_id: number | null; author_name: string | null }>();
    if (!prev) return c.text("Post not found.", 404);
    if (!can(ctx.role, "posts.edit.any") &&
        !(can(ctx.role, "posts.edit.own") && prev.author_account_id === ctx.account.id))
      return c.text("You do not have permission to edit this post.", 403);
    wasPublished = prev?.published ?? 0;
    previousSlug = prev?.slug ?? "";
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
    purgeTenant(c.env, ctx.tenant, ["/", ...(previousSlug ? ["/" + previousSlug] : []), "/" + slug, "/sitemap.xml"])
  );
  if (published === 1 || wasPublished === 1) queueIndexNow(c, ctx.tenant, ["/", ...(previousSlug ? ["/" + previousSlug] : []), "/" + slug]);
  // Email subscribers when a post first goes live (draft/new -> published).
  if (published === 1 && wasPublished === 0 && savedId)
    c.executionCtx.waitUntil(queueSubscriberNotificationOnce(c.env, ctx.tenant, savedId, { slug, title }));
  queueBlogAudit(c, ctx.tenant.id, ctx.account.id, idParam ? "post_updated" : "post_created", slug);
  if (published === 1 && wasPublished === 0)
    queueBlogAudit(c, ctx.tenant.id, ctx.account.id, "post_published", slug);
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
    "SELECT slug, published, audio_key FROM posts WHERE id = ? AND tenant_id = ?"
  )
    .bind(c.req.param("id"), ctx.tenant.id)
    .first<{ slug: string; published: number; audio_key: string | null }>();
  if (post) {
    await pdb.prepare("DELETE FROM posts WHERE id = ? AND tenant_id = ?")
      .bind(c.req.param("id"), ctx.tenant.id)
      .run();
    if (post.audio_key) await c.env.MEDIA.delete(post.audio_key);
    c.executionCtx.waitUntil(
      purgeTenant(c.env, ctx.tenant, ["/", "/" + post.slug, "/sitemap.xml"])
    );
    if (post.published) queueIndexNow(c, ctx.tenant, ["/", "/" + post.slug]);
    queueBlogAudit(c, ctx.tenant.id, ctx.account.id, "post_deleted", post.slug);
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

async function detectedImageType(file: File): Promise<string | null> {
  const header = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const starts = (...values: number[]) => values.every((value, index) => header[index] === value);
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || starts(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50) return "image/webp";
  if (header.length >= 12 && header[4] === 0x66 && header[5] === 0x74 && header[6] === 0x79 && (header[8] === 0x61 || header[8] === 0x6d)) return "image/avif";
  return null;
}

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
    .filter((obj) => !obj.key.slice(prefix.length).startsWith("favicon-"))
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
  if (!ALLOWED_IMAGE.has(type) || (await detectedImageType(file)) !== type)
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
  queueBlogAudit(c, ctx.tenant.id, ctx.account.id, "media_uploaded", file.name);
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

async function loadPronunciationOverrides(env: Bindings): Promise<Array<{ original: string; spoken: string }>> {
  try {
    const { results } = await env.DB.prepare(
      "SELECT term AS original, spoken FROM pronunciation_overrides WHERE enabled = 1 ORDER BY length(term) DESC, term LIMIT 500"
    ).all<{ original: string; spoken: string }>();
    return results.filter((row) => row.original.trim() && row.spoken.trim());
  } catch {
    // Keep narration available while the optional staff dictionary migration
    // is being rolled out.
    return [];
  }
}

async function createAudioJob(env: Bindings, tenant: Tenant, post: Pick<Post, "id" | "slug" | "title" | "body_md">) {
  const sections = narrationSections(post.title, post.body_md, await loadPronunciationOverrides(env));
  const text = [sections.title, sections.body].filter(Boolean).join(" ... ");
  if (!text) throw new Error("Add some post text before generating audio.");
  if (text.length > TTS_TEXT_MAX)
    throw new Error(`This post is too long for narration (${text.length.toLocaleString()} characters; maximum ${TTS_TEXT_MAX.toLocaleString()}).`);
  const audioCost = audioCreditCost(text);
  const audioReservation = await reserveAiCredits(env, tenant.id, audioCost);
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
  const job: AudioJobManifest = { tenantId: tenant.id, postId: post.id, postSlug: post.slug, prompts, checkpointKeys: prompts.map((_, index) => `${checkpointPrefix}/${index}.wav`), status: "queued", completed: 0, creditCost: audioCost, creditAccountId: audioReservation.accountId, creditPeriod: audioReservation.period };
  try {
    await writeAudioJob(env, jobKey, job);
    await env.AUDIO_QUEUE.send({ jobKey, tenantId: tenant.id, postId: post.id });
  } catch (error) {
    await refundAiCredits(env, audioReservation.accountId, audioReservation.period, audioCost);
    throw error;
  }
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
  if (!(await tenantHasPaidPlan(c.env, ctx.tenant.id))) return c.json({ error: "AI narration is available on a paid plan." }, 402);
  if (!can(ctx.role, "media.upload")) return c.json({ error: "forbidden" }, 403);
  const pdb = tenantDb(c.env, ctx.tenant);
  const post = await pdb.prepare(
    "SELECT id, slug, title, body_md, audio_key FROM posts WHERE id = ? AND tenant_id = ?"
  ).bind(c.req.param("id"), ctx.tenant.id)
    .first<Pick<Post, "id" | "slug" | "title" | "body_md" | "audio_key">>() as Pick<Post, "id" | "slug" | "title" | "body_md" | "audio_key">;
  if (!post) return c.json({ error: "Post not found." }, 404);
  if (post.audio_key)
    return c.json({ error: "Remove the existing narration before generating a new version." }, 409);

  const sections = narrationSections(post.title, post.body_md, await loadPronunciationOverrides(c.env));
  const text = [sections.title, sections.body].filter(Boolean).join(" ... ");
  if (!text) return c.json({ error: "Add some post text before generating audio." }, 400);
  if (text.length > TTS_TEXT_MAX)
    return c.json({ error: `This post is too long for narration (${text.length.toLocaleString()} characters; maximum ${TTS_TEXT_MAX.toLocaleString()}).` }, 400);
  const audioCost = audioCreditCost(text);
  let audioReservation: { accountId: number; period: string };
  try { audioReservation = await reserveAiCredits(c.env, ctx.tenant.id, audioCost); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : "AI credits unavailable" }, 402); }

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
    creditCost: audioCost, creditAccountId: audioReservation.accountId, creditPeriod: audioReservation.period,
  };
  try {
    await writeAudioJob(c.env, jobKey, job);
    await c.env.AUDIO_QUEUE.send({ jobKey, tenantId: ctx.tenant.id, postId: post.id });
  } catch (error) {
    await refundAiCredits(c.env, audioReservation.accountId, audioReservation.period, audioCost);
    throw error;
  }
  queueBlogAudit(c, ctx.tenant.id, ctx.account.id, "audio_generation_requested", post.slug);
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
type IndexNowMessage = { kind: "indexnow"; urls: string[] };
type EmailJobMessage = {
  kind: "email-delivery";
  idempotencyKey: string;
  subscriberId?: number;
  emailKind?: "post-notification" | "subscription-welcome" | "password-reset" | "subscriber-confirmation";
  to: string;
  subject: string;
  plainText: string;
  html: string;
  headers?: Record<string, string>;
};
type EmailFanoutMessage = { kind: "email-fanout"; campaignId: string; tenantId: number; postSlug: string; postTitle: string; afterId: number };
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
  creditCost?: number;
  creditAccountId?: number;
  creditPeriod?: string;
  creditsRefunded?: boolean;
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
  creditCost?: number;
  creditAccountId?: number;
  creditPeriod?: string;
  creditsRefunded?: boolean;
};

const AI_MONTHLY_CREDITS = 1000;
const AI_IMAGE_CREDITS = 3;
const AI_AUDIO_WORDS_PER_CREDIT = 500;

function aiCreditPeriod(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7);
}

function audioCreditCost(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / AI_AUDIO_WORDS_PER_CREDIT));
}

async function reserveAiCredits(env: Bindings, tenantId: number, cost: number): Promise<{ accountId: number; period: string }> {
  const owner = await env.DB.prepare(`SELECT a.id FROM memberships m JOIN accounts a ON a.id = m.account_id WHERE m.tenant_id = ? AND m.role = 'owner' LIMIT 1`).bind(tenantId).first<{ id: number }>();
  if (!owner) throw new Error("Blog owner not found.");
  const period = aiCreditPeriod();
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO ai_credit_usage (account_id, period, credits_used, allowance) VALUES (?, ?, 0, ?)`)
      .bind(owner.id, period, AI_MONTHLY_CREDITS),
    env.DB.prepare(`UPDATE ai_credit_usage SET credits_used = credits_used + ? WHERE account_id = ? AND period = ? AND credits_used + ? <= allowance`)
      .bind(cost, owner.id, period, cost),
  ]);
  const changes = Number((result[1] as any)?.meta?.changes || 0);
  if (!changes) throw new Error(`AI credit limit reached. You have ${AI_MONTHLY_CREDITS} credits per month.`);
  return { accountId: owner.id, period };
}

async function refundAiCredits(env: Bindings, accountId: number, period: string, cost: number): Promise<void> {
  await env.DB.prepare(`UPDATE ai_credit_usage SET credits_used = MAX(0, credits_used - ?) WHERE account_id = ? AND period = ?`)
    .bind(cost, accountId, period).run();
}

async function refundTerminalAiJob(env: Bindings, jobKey: string, kind: "audio" | "image"): Promise<void> {
  const job = kind === "audio"
    ? await readAudioJob(env, jobKey)
    : await readImageJob(env, jobKey);
  if (job.status === "complete" || job.creditsRefunded || !job.creditAccountId || !job.creditPeriod || !job.creditCost) return;
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO ai_credit_refunds (job_key, account_id, period, credits, refunded_at) VALUES (?, ?, ?, ?, ?)").bind(jobKey, job.creditAccountId, job.creditPeriod, job.creditCost, now),
    env.DB.prepare("UPDATE ai_credit_usage SET credits_used = MAX(0, credits_used - ?) WHERE account_id = ? AND period = ? AND changes() > 0").bind(job.creditCost, job.creditAccountId, job.creditPeriod),
    env.DB.prepare("UPDATE ai_credit_refunds SET applied = 1 WHERE job_key = ? AND changes() > 0").bind(jobKey),
  ]);
  if (!Number((result[0] as any)?.meta?.changes || 0)) {
    job.creditsRefunded = true;
    return;
  }
  job.creditsRefunded = true;
  if (kind === "audio") await writeAudioJob(env, jobKey, job as AudioJobManifest);
  else await writeImageJob(env, jobKey, job as ImageJobManifest);
}

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
  const requestOrigin = c.req.header("origin");
  // This endpoint spends Workers AI credits. Require a browser same-origin
  // request in addition to the session and blog capability checks, so a
  // cross-site form cannot trigger generation using a user's cookie.
  const requestUrl = new URL(c.req.url);
  const requestUrlOrigin = requestUrl.origin;
  const localRequest = c.env.DEV_TENANT || requestUrl.hostname === "localhost" || requestUrl.hostname === "127.0.0.1";
  const allowedOrigins = new Set(localRequest ? [requestUrlOrigin] : [adminOriginOf(c)]);
  if (!requestOrigin || !allowedOrigins.has(requestOrigin))
    return c.json({ error: "same-origin request required" }, 403);
  if (!(await tenantHasPaidPlan(c.env, ctx.tenant.id))) return c.json({ error: "AI image generation is available on a paid plan." }, 402);
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
  let creditReservation: { accountId: number; period: string };
  try { creditReservation = await reserveAiCredits(c.env, ctx.tenant.id, AI_IMAGE_CREDITS); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : "AI credits unavailable" }, 402); }
  try {
    const result = await generateImageAsset(c.env, ctx.tenant, source, style);
    queueBlogAudit(c, ctx.tenant.id, ctx.account.id, "ai_image_generated", result.key);
    return c.json(result);
  } catch (error) {
    await refundAiCredits(c.env, creditReservation.accountId, creditReservation.period, AI_IMAGE_CREDITS);
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
  queueBlogAudit(c, ctx.tenant.id, ctx.account.id, "media_deleted", file);
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
  const footerName = String(form.get("footer_name") ?? "").trim().slice(0, 160);
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
  await c.env.DB.prepare("UPDATE tenants SET slug = ?, title = ?, description = ?, footer_name = ?, accent_color = ?, topics_json = ? WHERE id = ?")
    .bind(slug, title, description, footerName, accentColor.toLowerCase(), JSON.stringify(normalizedTopics.topics), ctx.tenant.id)
    .run();
  queueBlogAudit(c, ctx.tenant.id, ctx.account.id, "blog_settings_updated", "settings");

  c.executionCtx.waitUntil(purgeTenantEverywhere(c.env, ctx.tenant));
  const updated = { ...ctx.tenant, slug, title, description, footer_name: footerName, accent_color: accentColor.toLowerCase(), topics_json: JSON.stringify(normalizedTopics.topics) };
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
  if (!ALLOWED_IMAGE.has(file.type) || (await detectedImageType(file)) !== file.type)
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

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function isPngBytes(bytes: Uint8Array): boolean {
  return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}
function isIcoBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 6 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0 && bytes[4] !== 0 && bytes[5] !== 0;
}
function makeIco(pngs: Array<{ size: number; bytes: Uint8Array }>): Uint8Array {
  const headerSize = 6, entrySize = 16;
  const dataOffset = headerSize + entrySize * pngs.length;
  const total = dataOffset + pngs.reduce((sum, item) => sum + item.bytes.byteLength, 0);
  const output = new Uint8Array(total);
  const view = new DataView(output.buffer);
  view.setUint16(0, 0, true); view.setUint16(2, 1, true); view.setUint16(4, pngs.length, true);
  let offset = dataOffset;
  pngs.forEach((item, index) => {
    const entry = headerSize + index * entrySize;
    output[entry] = item.size >= 256 ? 0 : item.size;
    output[entry + 1] = item.size >= 256 ? 0 : item.size;
    view.setUint16(entry + 4, 1, true); view.setUint16(entry + 6, 32, true);
    view.setUint32(entry + 8, item.bytes.byteLength, true);
    view.setUint32(entry + 12, offset, true);
    output.set(item.bytes, offset); offset += item.bytes.byteLength;
  });
  return output;
}
app.post("/admin/b/:blogId/favicon", async (c) => {
  let stage = "checking access";
  let storedKey: string | null = null;
  try {
    const ctx = await blogContext(c);
    if ("redirect" in ctx) return c.json({ error: "unauthorized" }, 401);
    if (!(await tenantHasPaidPlan(c.env, ctx.tenant.id)) ) return c.json({ error: "Custom favicons are available on a paid plan." }, 402);
    if (!can(ctx.role, "settings.manage")) return c.json({ error: "forbidden" }, 403);
    stage = "reading the uploaded file";
    const form = await c.req.formData();
    const sizes = [16, 32, 48, 256] as const;
    const variantFiles = sizes.map((size) => form.get(`icon${size}`));
    let bytes: Uint8Array;
    let originalName = String(form.get("original_name") || "favicon").slice(0, 200);
    if (variantFiles.every((value): value is File => value instanceof File)) {
      const variants = [];
      for (let index = 0; index < sizes.length; index++) {
        const file = variantFiles[index];
        if (file.size > 1024 * 1024) return c.json({ error: "Favicon is too large (maximum 1 MB)." }, 413);
        const png = new Uint8Array(await file.arrayBuffer());
        if (!isPngBytes(png)) return c.json({ error: "The uploaded file is not a valid PNG or ICO." }, 400);
        variants.push({ size: sizes[index], bytes: png });
      }
      bytes = makeIco(variants);
    } else {
      const file = form.get("file");
      if (!(file instanceof File)) return c.json({ error: "No favicon file was received." }, 400);
      if (file.size > 1024 * 1024) return c.json({ error: "Favicon is too large (maximum 1 MB)." }, 413);
      originalName = file.name.slice(0, 200);
      const uploaded = new Uint8Array(await file.arrayBuffer());
      const isPng = isPngBytes(uploaded);
      const isIco = isIcoBytes(uploaded);
      const contentType = isPng ? "image/png" : "image/x-icon";
      if (!isPng && !isIco) return c.json({ error: "The uploaded file is not a valid PNG or ICO." }, 400);
      bytes = isPng ? makeIco([{ size: 256, bytes: uploaded }]) : uploaded;
    }
    const key = `${ctx.tenant.id}/favicon-${crypto.randomUUID().slice(0, 8)}.ico`;
    storedKey = key;
    stage = "saving the favicon to media storage";
    await c.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: "image/x-icon", cacheControl: "public, max-age=3600" }, customMetadata: { originalName } });
    if (ctx.tenant.favicon_key) c.executionCtx.waitUntil(c.env.MEDIA.delete(ctx.tenant.favicon_key));
    stage = "updating blog settings";
    await c.env.DB.prepare("UPDATE tenants SET favicon_key = ? WHERE id = ?").bind(key, ctx.tenant.id).run();
    queueBlogAudit(c, ctx.tenant.id, ctx.account.id, "favicon_updated", key);
    c.executionCtx.waitUntil(purgeTenantEverywhere(c.env, ctx.tenant));
    return c.json({ ok: true, format: "ico", sizes: [16, 32, 48, 256] });
  } catch (error) {
    if (storedKey) c.executionCtx.waitUntil(c.env.MEDIA.delete(storedKey));
    console.error("favicon upload failed", { stage, error: error instanceof Error ? error.message : String(error) });
    return c.json({ error: `Favicon upload failed while ${stage}.` }, 500);
  }
});

// Marketing images live in R2 rather than the Worker bundle. Keep this
// allowlist deliberately small: marketing files are public and immutable, but
// arbitrary R2 keys must never become publicly readable through this route.
const MARKETING_IMAGES = new Set([
  "writing.webp", "ceramics.webp", "night-train.webp", "travel-notebook.webp", "blogger.webp",
]);
app.get("/marketing-ai/:file", async (c) => {
  const file = c.req.param("file");
  if (!MARKETING_IMAGES.has(file)) return c.notFound();
  const cache = caches.default;
  const cacheKey = new Request(c.req.url, { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const object = await c.env.MEDIA.get(`marketing/${file}`);
  if (!object) return c.notFound();
  const response = new Response(object.body, { headers: {
    "content-type": object.httpMetadata?.contentType || "image/webp",
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    etag: object.httpEtag,
  } });
  c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
});

// The marketing voice sample uses the same MeloTTS model, language, retry
// policy, and audio conversion as customer narration. Cache the fixed phrase
// so repeated visitors do not trigger a new AI request at every edge.
app.get("/marketing-audio", async (c) => {
  const cacheKey = new Request(`https://${c.env.ROOT_DOMAIN}/marketing-audio`, { method: "GET" });
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;
  const assetKey = "marketing/ai-voice.wav";
  const stored = await c.env.MEDIA.get(assetKey);
  if (stored) {
    const response = new Response(stored.body, { headers: {
      "content-type": "audio/wav", "cache-control": "public, max-age=86400, s-maxage=86400, immutable", "x-content-type-options": "nosniff",
    } });
    c.executionCtx.waitUntil(caches.default.put(cacheKey, response.clone()));
    return response;
  }
  const now = Math.floor(Date.now() / 1000);
  const lock = await c.env.DB.prepare("INSERT OR IGNORE INTO marketing_audio_state (asset_key, generating_at) VALUES (?, ?)").bind(assetKey, now).run();
  if (!lock.meta.changes) {
    const current = await c.env.DB.prepare("SELECT generating_at FROM marketing_audio_state WHERE asset_key = ?").bind(assetKey).first<{ generating_at: number }>();
    if (current && now - current.generating_at < 300) return c.json({ error: "The voice sample is being prepared. Please try again shortly." }, 503);
    const reclaimed = await c.env.DB.prepare("UPDATE marketing_audio_state SET generating_at = ? WHERE asset_key = ? AND generating_at = ?").bind(now, assetKey, current?.generating_at || 0).run();
    if (!reclaimed.meta.changes) return c.json({ error: "The voice sample is being prepared. Please try again shortly." }, 503);
  }
  try {
    const bytes = await generateSpeechWithRecovery(c.env.AI, "Welcome to blognice. A nicer way to blog.");
    await c.env.MEDIA.put(assetKey, bytes, { httpMetadata: { contentType: "audio/wav", cacheControl: "public, max-age=31536000, immutable" } });
    await c.env.DB.prepare("DELETE FROM marketing_audio_state WHERE asset_key = ?").bind(assetKey).run();
    const response = new Response(bytes, {
      headers: {
        "content-type": "audio/wav",
        "cache-control": "public, max-age=86400, s-maxage=86400, immutable",
        "x-content-type-options": "nosniff",
      },
    });
    c.executionCtx.waitUntil(caches.default.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    await c.env.DB.prepare("DELETE FROM marketing_audio_state WHERE asset_key = ?").bind(assetKey).run().catch(() => undefined);
    console.error("marketing voice sample failed", error);
    return c.json({ error: "The voice sample is temporarily unavailable." }, 503);
  }
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
    c.executionCtx.waitUntil(sendEmail(c.env, {
      to: email,
      subject: "Welcome to blognice",
      plainText: "Welcome to blognice!\n\nYour account is ready. Sign in to create and publish your first blog.",
      html: "<h2>Welcome to blognice!</h2><p>Your account is ready. Sign in to create and publish your first blog.</p>",
    }));
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
  c.executionCtx.waitUntil(sendEmail(c.env, {
    to: email,
    subject: "Welcome to blognice",
    plainText: "Welcome to blognice!\n\nYour account is ready. Sign in to create and publish your first blog.",
    html: "<h2>Welcome to blognice!</h2><p>Your account is ready. Sign in to create and publish your first blog.</p>",
  }));

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
  if (!(await tenantHasPaidPlan(c.env, ctx.tenant.id))) return c.text("Custom domains are available on a paid plan.", 402);
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
  queueBlogAudit(c, ctx.tenant.id, ctx.account.id, "custom_domain_added", hostname);

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
    queueBlogAudit(c, ctx.tenant.id, ctx.account.id, "custom_domain_removed", hostname);
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
      "x-content-type-options": "nosniff",
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
  // Keep this response identical for new, pending, and existing addresses so
  // the endpoint cannot be used to enumerate a blog's subscribers.
  const ok = () =>
    navigate
      ? c.html(
          renderSimplePage(
            tenant,
            "Check your inbox",
            `<p>If that address can receive email, we'll send a confirmation link. Click it to start receiving posts from ${esc(tenant.title)}.</p>`
          )
        )
      : c.json({ ok: true });

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return navigate
      ? c.html(renderSimplePage(tenant, "Subscribe", `<p>Please enter a valid email address.</p>`), 400)
      : c.json({ error: "Please enter a valid email address." }, 400);

  const existing = await c.env.DB.prepare(
    "SELECT 1 FROM subscribers WHERE tenant_id = ? AND email = ? AND confirmed_at IS NOT NULL"
  )
    .bind(tenant.id, email)
    .first();
  if (existing) return ok();

  const now = Math.floor(Date.now() / 1000);
  // Keep a one-day suppression window after the 24-hour link expires. This
  // makes repeated requests for the same address unable to turn the form into
  // an email-spam primitive. Expired rows older than that window are disposable.
  await c.env.DB.prepare("DELETE FROM subscriber_confirmations WHERE expires_at <= ? AND sent_at <= ?")
    .bind(now - 86400, now - 86400).run();
  const pending = await c.env.DB.prepare(
    "SELECT sent_at FROM subscriber_confirmations WHERE tenant_id = ? AND email = ?"
  ).bind(tenant.id, email).first<{ sent_at: number }>();
  if (pending) return ok();

  const rawToken = crypto.randomUUID();
  const tokenHash = await sha256hex(rawToken);
  const origin = publicOrigin(c.env, tenant);
  const confirmUrl = `${origin}/subscribe/confirm?token=${encodeURIComponent(rawToken)}`;
  const job: EmailJobMessage = {
    kind: "email-delivery",
    emailKind: "subscriber-confirmation",
    idempotencyKey: `subscriber-confirmation:${tokenHash}`,
    to: email,
    subject: `Confirm your subscription to ${tenant.title}`,
    plainText: `Please confirm your subscription to ${tenant.title}.\n\nConfirm here: ${confirmUrl}\n\nThis link expires in 24 hours. If you did not request this, you can ignore this email.`,
    html: `<p>Please confirm your subscription to <strong>${esc(tenant.title)}</strong>.</p><p><a href="${confirmUrl}">Confirm subscription</a></p><p style="color:#687064;font-size:13px">This link expires in 24 hours. If you did not request this, you can ignore this email.</p>`,
  };
  const result = await requestSubscriberConfirmation({
    isConfirmed: async () => Boolean(existing),
    hasPending: async () => Boolean(pending),
    insert: async () => {
      const inserted = await c.env.DB.prepare(
        "INSERT OR IGNORE INTO subscriber_confirmations (tenant_id, email, token_hash, expires_at, sent_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(tenant.id, email, tokenHash, now + 86400, now).run();
      return inserted.meta.changes === 1;
    },
    deliver: async () => {
      if (!emailEnabled(c.env)) {
        console.info("Subscriber confirmation link is unavailable because email delivery is not configured", {
          tenantId: tenant.id,
          tokenHashPrefix: tokenHash.slice(0, 12),
        });
        return true;
      }
      if (c.env.EMAIL_QUEUE) {
        await c.env.EMAIL_QUEUE.send(job);
        return true;
      }
      return sendEmail(c.env, job);
    },
    remove: async () => {
      await c.env.DB.prepare("DELETE FROM subscriber_confirmations WHERE token_hash = ?").bind(tokenHash).run();
    },
  });
  if (result === "delivery-failed") {
    console.error("subscriber confirmation delivery failed", { tenantId: tenant.id, email });
    // Keep the response indistinguishable from existing/pending addresses;
    // delivery failures are logged and the row was removed for a later retry.
    return ok();
  }
  return ok();
});

app.get("/privacy", (c) => {
  return legalPage(c, privacyPage);
});

function legalPage(c: any, page: string): Response {
  const host = new URL(c.req.url).hostname.toLowerCase();
  if (host !== `www.${c.env.ROOT_DOMAIN}`.toLowerCase()) return c.redirect(`https://www.${c.env.ROOT_DOMAIN}${new URL(c.req.url).pathname}`, 301);
  const currentPath = new URL(c.req.url).pathname;
  const policyItems = [["/policies", "All policies"], ["/privacy", "Privacy"], ["/terms", "Terms"], ["/cookies", "Cookies"], ["/security", "Security"]] as const;
  const policyNav = `<nav class="policy-nav" aria-label="Policy pages">${policyItems.map(([href, label]) => `<a href="${href}"${currentPath === href ? ' aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
  const policyNavMarkup = policyItems.some(([href]) => href === currentPath) ? policyNav : "";
  const consistentTheme = page
    .replaceAll("https://www.blognice.com/", "/")
    .replace("</style>", ".theme-toggle{width:2.35rem;height:2.35rem;display:inline-flex;align-items:center;justify-content:center;border-radius:999px;padding:0;line-height:1}.theme-toggle .moon{display:none}html[data-theme=dark] .theme-toggle .sun{display:none}html[data-theme=dark] .theme-toggle .moon{display:inline}</style>")
    .replace('<button id="theme-toggle" type="button">◐ Theme</button>', '<button id="theme-toggle" class="theme-toggle" type="button" aria-label="Use dark theme" aria-pressed="false" title="Use dark theme"><span class="sun" aria-hidden="true">☀</span><span class="moon" aria-hidden="true">☾</span></button>')
    .replaceAll('href="mailto:security@blognice.com">Security', 'href="/security">Security')
    .replaceAll('href="mailto:privacy@blognice.com">Contact privacy', 'href="/privacy">Privacy')
    .replaceAll('href="mailto:privacy@blognice.com">Contact', 'href="/privacy">Privacy')
    .replace("</style>", ".policy-nav{display:flex;align-items:center;gap:.2rem;min-width:0;overflow-x:auto;scrollbar-width:none;margin:1rem 0 1.5rem;padding:0;font:14px/1.5 var(--sans)}.policy-nav::-webkit-scrollbar{display:none}.policy-nav a{flex:0 0 auto;padding:.5rem .75rem;border-radius:7px;color:var(--muted);font-weight:600;text-decoration:none;white-space:nowrap}.policy-nav a:hover,.policy-nav a:focus-visible{color:var(--ink);background:var(--bg)}.policy-nav a[aria-current=page]{color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent)}:root{--bg:#fdfdfc;--panel:#fff;--ink:#1a1a18;--muted:#6a6a66;--rule:#e4e3de;--accent:#146b54;--accent-ink:#fff;--sans:system-ui,-apple-system,\"Segoe UI\",Roboto,Helvetica,Arial,sans-serif}html[data-theme=dark]{--bg:#161614;--panel:#1e1e1b;--ink:#e9e8e3;--muted:#9a9a93;--rule:#302f2b;--accent:#6fc9a9;--accent-ink:#10241d}body{background:var(--bg);color:var(--ink);font:15px/1.5 var(--sans);-webkit-font-smoothing:antialiased}main,.wrap{width:min(760px,calc(100% - 2rem));max-width:none;margin:0 auto;padding:0 0 5rem}.top,.topbar{min-height:3.5rem;padding:.8rem max(1rem,calc((100vw - 760px)/2));margin-left:calc(50% - 50vw);margin-right:calc(50% - 50vw);border-bottom:1px solid var(--rule);background:var(--panel)}.top a,.topbar a{color:var(--accent)}.topbar + a.meta{display:none}h1,h2,h3{font-family:var(--sans);line-height:1.2}h1{font-size:clamp(2rem,4vw,2.8rem);margin:3rem 0 .8rem}h2{font-size:1.35rem;margin:2.25rem 0 .65rem}h3{font-size:1.05rem;margin:1.35rem 0 .45rem}p,li{max-width:54rem}a{color:var(--accent)}.footer{border-top:1px solid var(--rule);margin:2.5rem auto 0;padding:1.25rem 0 2rem;display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;color:var(--muted);font:13px/1.5 var(--sans)}.footer a{color:inherit}.footer a:hover,.footer a:focus-visible{color:var(--accent);text-decoration:underline}.footer-links{display:flex;gap:1rem;flex-wrap:wrap}@media(max-width:640px){main,.wrap{width:calc(100% - 2rem)}.footer{align-items:flex-start;flex-direction:column}.footer a{padding:.35rem 0}}</style>")
    .replace('<a href="/privacy">Privacy</a>', '')
    .replace('</nav><a href="https://www.blognice.com/" class="meta">', `</nav>${policyNavMarkup}<a href="https://www.blognice.com/" class="meta">`)
    .replace('</header><h1>Policies', `</header>${policyNavMarkup}<h1>Policies`)
    .replaceAll("© blognice · Pragmatic Online Co., Ltd.", "© 2026 blognice · Pragmatic Online Co., Ltd.")
    .replace("</nav></footer>", '<a href="/privacy#analytics-dialog">Analytics preferences</a></nav></footer>');
  const withPrivacyPreferences = page === privacyPage
    ? consistentTheme.replace("</body>", '<script>if(location.hash==="#analytics-dialog"){var analyticsDialog=document.getElementById("analytics-dialog");if(analyticsDialog)analyticsDialog.hidden=false}</script></body>')
    : consistentTheme;
  return new Response(withPrivacyPreferences, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store, max-age=0" } });
}

app.get("/terms", (c) => legalPage(c, termsPage));
app.get("/cookies", (c) => legalPage(c, cookiesPage));
app.get("/security", (c) => legalPage(c, securityPage));
app.get("/algorithms", (c) => legalPage(c, algorithmsPage));
app.get("/policies", (c) => legalPage(c, policiesPage));

app.get("/.well-known/security.txt", (c) => {
  const host = new URL(c.req.url).hostname.toLowerCase();
  if (host !== `www.${c.env.ROOT_DOMAIN}`.toLowerCase()) return c.redirect(`https://www.${c.env.ROOT_DOMAIN}/.well-known/security.txt`, 301);
  return c.text("Contact: mailto:security@blognice.com\nPolicy: https://www.blognice.com/security\nPreferred-Languages: en, th\nExpires: 2027-08-08T00:00:00Z\n", 200, { "cache-control": "public, max-age=86400" });
});

async function subscriberConfirmation(c: Context<{ Bindings: Bindings }>, rawToken: string) {
  if (!rawToken || rawToken.length > 100) return c.text("This confirmation link is invalid or has expired.", 400);
  const now = Math.floor(Date.now() / 1000);
  const row = await c.env.DB.prepare(
    "SELECT tenant_id, email FROM subscriber_confirmations WHERE token_hash = ? AND expires_at > ?"
  ).bind(await sha256hex(rawToken), now).first<{ tenant_id: number; email: string }>();
  if (!row) return c.text("This confirmation link is invalid or has expired.", 400);
  const tenant = await tenantById(c.env, row.tenant_id);
  if (!tenant) return c.text("This confirmation link is invalid or has expired.", 404);
  let unsubscribeToken = "";
  const confirmation = await applySubscriberConfirmation({
    method: c.req.method,
    lookup: async () => true,
    insert: async () => {
      unsubscribeToken = crypto.randomUUID();
      const inserted = await c.env.DB.prepare(
        "INSERT OR IGNORE INTO subscribers (tenant_id, email, token, created_at, confirmed_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(row.tenant_id, row.email, unsubscribeToken, now, now).run();
      return inserted.meta.changes === 1;
    },
    remove: async () => {
      await c.env.DB.prepare("DELETE FROM subscriber_confirmations WHERE token_hash = ?").bind(await sha256hex(rawToken)).run();
    },
  });
  if (confirmation === "preview") {
    return c.html(renderSimplePage(tenant, "Confirm subscription", `<p>Confirm that you want to receive new posts from ${esc(tenant.title)} by email.</p><form method="post" action="/subscribe/confirm"><input type="hidden" name="token" value="${esc(rawToken)}"><button type="submit" style="font:inherit;background:var(--accent);color:#fff;border:none;border-radius:6px;padding:.6rem 1.1rem;cursor:pointer">Confirm subscription</button></form>`));
  }
  if (confirmation === "confirmed") {
    const origin = publicOrigin(c.env, tenant);
    const unsub = `${origin}/unsubscribe/${unsubscribeToken}`;
    const manageUrl = subscriptionManageUrl(c.env, await subscriptionManageToken(c.env, row.email));
    const welcome: EmailJobMessage = {
      kind: "email-delivery",
      emailKind: "subscription-welcome",
      idempotencyKey: `subscriber-welcome:${tenant.id}:${row.email}`,
      to: row.email,
      subject: `You're subscribed to ${tenant.title}`,
      plainText: `Thanks for subscribing to ${tenant.title}. You'll get new posts by email.\n\nUnsubscribe: ${unsub}\nManage subscriptions: ${manageUrl}`,
      html: `<p>Thanks for subscribing to <strong>${esc(tenant.title)}</strong>. You'll get new posts by email.</p><hr><p style="color:#687064;font-size:13px"><a href="${unsub}">Unsubscribe</a> anytime · <a href="${manageUrl}">Manage subscriptions</a>.</p>`,
      headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    };
    if (emailEnabled(c.env) && c.env.EMAIL_QUEUE) c.executionCtx.waitUntil(c.env.EMAIL_QUEUE.send(welcome));
    else if (emailEnabled(c.env)) c.executionCtx.waitUntil(sendEmail(c.env, welcome).then(() => {}));
  }
  return c.html(renderSimplePage(tenant, "Subscription confirmed", `<p>You're now subscribed to ${esc(tenant.title)}. New posts will arrive in your inbox.</p>`));
}

app.get("/subscribe/confirm", (c) => subscriberConfirmation(c, String(c.req.query("token") || "")));
app.post("/subscribe/confirm", async (c) => {
  const form = await c.req.formData().catch(() => null);
  return subscriberConfirmation(c, String(form?.get("token") || ""));
});

function subscriptionManagePage(email: string, subscriptions: Array<{ id: number; title: string; slug: string; custom_domain?: string | null }>, token: string, message = ""): string {
  const rows = subscriptions.length
    ? subscriptions.map((subscription) => `<label style="display:block;padding:.7rem 0;border-bottom:1px solid #e3e7dd"><input type="checkbox" name="subscription" value="${subscription.id}" checked> <strong>${esc(subscription.title)}</strong><br><small style="color:#687064;margin-left:1.5rem">${esc(subscription.custom_domain || `${subscription.slug}.blognice.com`)}</small></label>`).join("")
    : `<p>You are not subscribed to any blognice blogs.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Manage subscriptions · blognice</title><style>body{margin:0;background:#f7f8f3;color:#171914;font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}.card{max-width:620px;margin:8vh auto;padding:2rem;background:#fff;border:1px solid #dfe4da;border-radius:10px}h1{margin-top:0}small,.muted{color:#687064}.btn{margin-top:1.2rem;padding:.65rem 1rem;border:1px solid #dfe4da;border-radius:6px;background:#171914;color:#fff;font:inherit;cursor:pointer}.notice{padding:.7rem;background:#eaf4e8;border-radius:6px}</style></head><body><main class="card"><p class="muted">blognice</p><h1>Manage subscriptions</h1><p>Subscriptions for <strong>${esc(email)}</strong></p>${message ? `<p class="notice">${esc(message)}</p>` : ""}<form method="post" action="/manage-subscriptions/${esc(token)}">${rows}${subscriptions.length ? `<button class="btn" type="submit">Save preferences</button>` : ""}</form></main></body></html>`;
}

async function processEmailFanout(env: Bindings, job: EmailFanoutMessage): Promise<void> {
  if (!env.EMAIL_QUEUE) throw new Error("Email queue is not configured.");
  const tenant = await tenantById(env, job.tenantId);
  if (!tenant) return;
  const subscribers = await env.DB.prepare("SELECT id, email, token FROM subscribers WHERE tenant_id = ? AND confirmed_at IS NOT NULL AND id > ? ORDER BY id LIMIT 100")
    .bind(job.tenantId, job.afterId).all<{ id: number; email: string; token: string }>();
  const origin = publicOrigin(env, tenant);
  const postUrl = `${origin}/${job.postSlug}`;
  const deliveries: EmailJobMessage[] = [];
  for (const subscriber of subscribers.results) {
    const unsub = `${origin}/unsubscribe/${subscriber.token}`;
    const manageUrl = subscriptionManageUrl(env, await subscriptionManageToken(env, subscriber.email));
    deliveries.push({
      kind: "email-delivery",
      idempotencyKey: `post:${job.campaignId}:${subscriber.id}`,
      subscriberId: subscriber.id,
      to: subscriber.email,
      subject: job.postTitle,
      plainText: `New post on ${tenant.title}:\n\n${job.postTitle}\n${postUrl}\n\nUnsubscribe: ${unsub}\nManage subscriptions: ${manageUrl}`,
      html: `<p>New post on <strong>${esc(tenant.title)}</strong>:</p><h2 style="font-family:sans-serif"><a href="${postUrl}">${esc(job.postTitle)}</a></h2><p><a href="${postUrl}">Read it &rarr;</a></p><hr><p style="color:#888;font-size:13px">You're subscribed to ${esc(tenant.title)}. <a href="${unsub}">Unsubscribe</a> · <a href="${manageUrl}">Manage subscriptions</a>.</p>`,
      headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
  }
  if (deliveries.length) await env.EMAIL_QUEUE.sendBatch(deliveries.map((body) => ({ body })));
  if (subscribers.results.length === 100) await env.EMAIL_QUEUE.send({ ...job, afterId: subscribers.results[subscribers.results.length - 1].id });
}

async function processEmailJob(env: Bindings, job: EmailJobMessage): Promise<void> {
  if (job.subscriberId != null) {
    const active = await env.DB.prepare("SELECT id FROM subscribers WHERE id = ? AND confirmed_at IS NOT NULL").bind(job.subscriberId).first();
    if (!active) return;
  }
  const existing = await env.DB.prepare("SELECT status FROM email_delivery_log WHERE idempotency_key = ?")
    .bind(job.idempotencyKey).first<{ status: string }>();
  if (existing?.status === "sent") return;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO email_delivery_log (idempotency_key, status, recipient, kind, created_at)
     VALUES (?, 'pending', ?, ?, ?)
     ON CONFLICT(idempotency_key) DO UPDATE SET status = 'pending'`
  ).bind(job.idempotencyKey, job.to, job.emailKind || "post-notification", now).run();
  if (!await sendEmail(env, job)) throw new Error("transactional email provider rejected the message");
  await env.DB.prepare("UPDATE email_delivery_log SET status = 'sent', sent_at = ? WHERE idempotency_key = ?")
    .bind(Math.floor(Date.now() / 1000), job.idempotencyKey).run();
}

app.get("/manage-subscriptions/:token", async (c) => {
  const token = c.req.param("token");
  const identity = await c.env.DB.prepare("SELECT email FROM subscription_manage_tokens WHERE token = ?")
    .bind(token).first<{ email: string }>();
  if (!identity) return c.html(subscriptionManagePage("unknown address", [], token, "This link is invalid or has expired."), 404);
  const subscriptions = await c.env.DB.prepare("SELECT s.id, t.title, t.slug, t.custom_domain FROM subscribers s JOIN tenants t ON t.id = s.tenant_id WHERE s.email = ? AND s.confirmed_at IS NOT NULL ORDER BY t.title")
    .bind(identity.email).all<{ id: number; title: string; slug: string; custom_domain?: string | null }>();
  return c.html(subscriptionManagePage(identity.email, subscriptions.results, token));
});

app.get("/admin/b/:blogId/audit", async (c) => {
  const ctx = await blogContext(c);
  if ("redirect" in ctx) return c.redirect(ctx.redirect);
  if (!(await tenantHasPaidPlan(c.env, ctx.tenant.id)))
    return c.html(auditPage(ctx.account, ctx.tenant, [], { paid: false }), 402);
  try {
    return c.html(auditPage(ctx.account, ctx.tenant, await auditReport(c.env, ctx.tenant.id, 90), { paid: true }));
  } catch (error) {
    console.error("audit report failed", error);
    return c.html(auditPage(ctx.account, ctx.tenant, null, { error: "Audit log could not be loaded. Please try again shortly.", paid: true }), 502);
  }
});

function billingPage(
  account: Account,
  billing: any,
  message = "",
  credits?: { used: number; allowance: number },
  prices?: { monthly?: string; yearly?: string },
  cryptoReady = false,
): string {
  const status = String(billing.billing_status || "inactive");
  const stripeActive = ["active", "trialing", "past_due"].includes(status);
  const cryptoActive = Number(billing.crypto_paid_through || 0) > Math.floor(Date.now() / 1000);
  const active = stripeActive || cryptoActive;
  const allowance = Math.max(0, Number(credits?.allowance || AI_MONTHLY_CREDITS));
  const used = Math.min(allowance, Math.max(0, Number(credits?.used || 0)));
  const remaining = allowance - used;
  const period = aiCreditPeriod();
  const [periodYear, periodMonth] = period.split("-").map(Number);
  const resetDate = Number.isFinite(periodYear) && Number.isFinite(periodMonth)
    ? new Date(Date.UTC(periodYear, periodMonth, 1)).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    : "the start of next month";
  const term = billing.billing_price_id === prices?.monthly ? "monthly" : billing.billing_price_id === prices?.yearly ? "yearly" : "";
  const renewal = billing.billing_period_end
    ? `${billing.billing_cancel_at_period_end ? "Ends" : "Renews"} ${new Date(Number(billing.billing_period_end) * 1000).toLocaleDateString()}`
    : "";
  const check = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="m5 13 4 4L19 7"/></svg>`;
  const freeFeatures = ["One blognice blog", "blognice subdomain", "Editor, publishing, and images", "RSS, themes, tags, and basic metrics"];
  // Free plan remains the default until a provider confirms payment.
  const proFeatures = ["Up to five blogs", "AI image generation and audio narration", "Collaborators and authors", "Custom domains and favicons", "API access"];
  const features = (items: string[]) => `<ul class="billing-features">${items.map((item) => `<li>${check}${esc(item)}</li>`).join("")}</ul>`;
  const checkout = (plan: "monthly" | "yearly", label: string, cls = "") => `<form method="post" action="/admin/billing/checkout"><input type="hidden" name="plan" value="${plan}"><button class="billing-btn ${cls}" type="submit">${label}</button></form>`;
  const portal = `<form method="post" action="/admin/billing/portal"><button class="billing-btn billing-btn-solid" type="submit">Manage billing in Stripe</button></form>`;
  const statusNotice = status === "past_due"
    ? `<div class="billing-alert"><strong>Payment needs attention.</strong> Your Pro features remain available temporarily, but update your payment method in Stripe to avoid interruption.${billing.stripe_customer_id ? `<div class="billing-alert-action">${portal.replace("Manage billing in Stripe", "Fix payment in Stripe")}</div>` : ""}</div>`
    : message ? `<div class="billing-notice">${esc(message)}</div>` : "";
  const cryptoExpiry = cryptoActive ? new Date(Number(billing.crypto_paid_through) * 1000).toLocaleDateString() : "";
  const billingAction = stripeActive ? portal : "";
  const usage = active ? `<section class="billing-section billing-usage"><div class="billing-section-head"><h2>AI usage</h2><span>Resets ${esc(resetDate)}</span></div><div class="billing-usage-stat"><div class="billing-usage-icon">✦</div><div><strong>${remaining.toLocaleString()} of ${allowance.toLocaleString()}</strong><span>credits remaining this month</span></div></div><div class="billing-track"><div style="width:${allowance ? Math.round(used / allowance * 100) : 0}%"></div></div><div class="billing-bar-labels"><span>${used.toLocaleString()} used</span><span>${remaining.toLocaleString()} remaining</span></div><p class="billing-muted">Images use 3 credits. Audio narration uses credits based on word count.</p></section>` : "";
  const freeCard = `<article class="billing-plan ${!active ? "billing-current" : ""}"><div class="billing-plan-name">Free</div><div class="billing-price">$0</div>${!active ? `<span class="billing-current-badge">${check} Current plan</span>` : ""}<div class="billing-includes">What's included</div>${features(freeFeatures)}${!active ? `<span class="billing-plan-foot">This is your plan today</span>` : ""}</article>`;
  const monthlyCard = `<article class="billing-plan ${stripeActive && term === "monthly" ? "billing-current" : ""}"><div class="billing-plan-name">blognice pro monthly</div><div class="billing-price">$5 <small>/ month</small></div><p class="billing-sub">Billed monthly, cancel any time</p><div class="billing-includes">Everything in Free, plus</div>${features(proFeatures)}${stripeActive && term === "monthly" ? `<span class="billing-plan-foot">${check} Current plan${renewal ? ` · ${esc(renewal)}` : ""}</span>` : stripeActive ? `<span class="billing-plan-foot">Plan changes are managed in Stripe</span>` : cryptoActive ? `<span class="billing-plan-foot">Available with your crypto plan</span>` : checkout("monthly", "Upgrade monthly", "billing-btn-dark")}</article>`;
  const yearlyCard = `<article class="billing-plan billing-featured ${stripeActive && term === "yearly" ? "billing-current" : ""}"><span class="billing-ribbon">Save 40%</span><div class="billing-plan-name">blognice pro yearly</div><div class="billing-price">$36 <small>/ year</small></div><p class="billing-sub">Just <b>$3/month</b>, billed annually</p><div class="billing-includes">Everything in Free, plus</div>${features(proFeatures)}${stripeActive && term === "yearly" ? `<span class="billing-plan-foot">${check} Current plan${renewal ? ` · ${esc(renewal)}` : ""}</span>` : stripeActive ? `<span class="billing-plan-foot">Plan changes are managed in Stripe</span>` : cryptoActive ? `<span class="billing-plan-foot">Available with your crypto plan</span>` : checkout("yearly", "Upgrade yearly", "billing-btn-green")}</article>`;
  const cryptoOption = cryptoActive
    ? `<div class="crypto-option crypto-option-active">${check} Crypto plan active · valid through ${esc(cryptoExpiry)}</div>`
    : stripeActive
      ? `<div class="crypto-option crypto-option-muted">Crypto payment is available after your current Stripe subscription ends.</div>`
      : cryptoReady
      ? `<div class="crypto-option"><div class="crypto-option-copy"><strong>Or pay for blognice pro yearly with crypto</strong><span>One year prepaid · no automatic renewal</span><div class="crypto-assets" aria-label="Supported crypto assets"><span role="img" aria-label="Bitcoin">₿</span><span role="img" aria-label="Ethereum">Ξ</span><span role="img" aria-label="Tron">TRX</span><span role="img" aria-label="Tether USDT">₮</span></div></div><form method="post" action="/admin/billing/crypto/checkout"><button class="billing-btn billing-btn-crypto" type="submit">Pay $36 with crypto</button></form></div>`
      : `<div class="crypto-option crypto-option-muted">Crypto payments are being configured.</div>`;
  const unknownPaid = stripeActive && !term ? `<div class="billing-notice">Your Stripe subscription is active. Use Manage billing in Stripe to view its current plan and renewal details.</div>` : "";
  const formerCustomer = !active && billing.stripe_customer_id ? `<div class="billing-history">Already subscribed before? ${portal.replace("Manage billing in Stripe", "View billing history in Stripe")}</div>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Billing · Blog Nice</title><style>
  :root{--bg:#f7f8f3;--card:#fff;--ink:#15170f;--soft:#5c6455;--faint:#8a9182;--green:#1a8917;--deep:#0e5a0c;--mist:#eef5ec;--rule:#e3e7dd}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:3.5rem 1.5rem}.billing-wrap{max-width:1040px;margin:auto}.billing-crumb{color:var(--deep);font-weight:650;text-decoration:none;display:inline-block;margin-bottom:1.8rem}.billing-h1{font-size:30px;margin:0 0 .35rem;letter-spacing:-.02em}.billing-account{color:var(--soft);margin:0 0 2.2rem}.billing-account b{color:var(--ink)}.billing-alert,.billing-notice{padding:.85rem 1rem;border-radius:10px;margin:0 0 1.2rem}.billing-alert{background:#fff4e5;border:1px solid #e8c58c;color:#6b4300}.billing-notice{background:var(--mist);border:1px solid #cfe6cb;color:var(--deep)}.billing-section{margin:0 0 2.4rem}.billing-section-head{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;margin-bottom:1rem}.billing-section-head h2{font-size:19px;margin:0}.billing-section-head span{font-size:13px;color:var(--faint)}.billing-usage{background:var(--card);border:1px solid var(--rule);border-radius:16px;padding:1.5rem 1.7rem}.billing-usage-stat{display:flex;align-items:center;gap:.8rem}.billing-usage-icon{width:2.4rem;height:2.4rem;border-radius:9px;background:var(--mist);color:var(--deep);display:grid;place-items:center;font-size:1.35rem}.billing-usage-stat strong{display:block;font-size:20px}.billing-usage-stat span{display:block;color:var(--soft);font-size:13px}.billing-track{height:8px;background:var(--rule);border-radius:99px;overflow:hidden;margin:1.2rem 0 .5rem}.billing-track div{height:100%;background:var(--green);border-radius:99px}.billing-bar-labels{display:flex;justify-content:space-between;color:var(--soft);font-size:12.5px}.billing-muted{color:var(--faint);font-size:13px;margin:.9rem 0 0}.billing-plan-section{margin-top:2.6rem}.billing-main-action{margin-bottom:1.25rem}.billing-main-action form+form{margin-top:.7rem}.billing-plans{display:grid;grid-template-columns:repeat(3,1fr);gap:1.2rem}.billing-plan{background:var(--card);border:1px solid var(--rule);border-radius:16px;padding:1.6rem 1.45rem;display:flex;flex-direction:column;position:relative}.billing-plan.billing-current{background:var(--mist);border-color:#cfe6cb}.billing-featured{border:2px solid var(--green);box-shadow:0 20px 40px -28px rgb(15 90 12 / .35)}.billing-ribbon{position:absolute;top:-.8rem;left:1.5rem;background:var(--green);color:#fff;padding:.3rem .75rem;border-radius:99px;font-size:11px;font-weight:700}.billing-plan-name{font-size:13px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--soft);margin-bottom:.8rem}.billing-current .billing-plan-name{color:var(--deep)}.billing-price{font-size:36px;font-weight:800;line-height:1.1}.billing-price small{font-size:14px;font-weight:500;color:var(--soft)}.billing-sub{font-size:13px;color:var(--faint);min-height:2.6rem;margin:.35rem 0 1.2rem}.billing-sub b{color:var(--deep)}.billing-current-badge{display:inline-flex;align-items:center;gap:.35rem;color:var(--deep);font-size:12px;font-weight:650;margin:0 0 1.2rem}.billing-current-badge svg{width:13px;height:13px}.billing-includes{font-size:12.5px;color:var(--faint);font-weight:650;margin-bottom:.7rem}.billing-features{list-style:none;padding:0;margin:0 0 1.3rem;display:flex;flex-direction:column;gap:.55rem;flex:1}.billing-features li{display:flex;align-items:flex-start;gap:.45rem;font-size:14px}.billing-features svg{width:16px;height:16px;color:var(--green);flex:none;margin-top:2px}.billing-plan-foot{color:var(--faint);font-size:13px;margin-top:auto}.billing-plan-foot svg{width:14px;height:14px;vertical-align:-2px;color:var(--deep)}.billing-btn{display:block;width:100%;border:1px solid var(--rule);border-radius:9px;padding:.7rem 1rem;background:#fff;color:var(--ink);font:inherit;font-weight:650;cursor:pointer}.billing-btn:hover{border-color:var(--green);background:var(--mist);color:var(--deep)}.billing-btn:focus-visible{outline:3px solid var(--green);outline-offset:2px}.billing-btn-dark{background:var(--ink);border-color:var(--ink);color:#fff}.billing-btn-green{background:var(--green);border-color:var(--green);color:#fff}.billing-btn-solid{background:var(--ink);border-color:var(--ink);color:#fff}.billing-btn-crypto{background:#f3eee3;border-color:#c8b88e}.crypto-option{margin-top:1rem;padding:1rem 1.2rem;border:1px solid #d8cfba;border-radius:12px;background:#fbf8f0;display:flex;align-items:center;justify-content:space-between;gap:1rem}.crypto-option-copy{display:flex;align-items:center;gap:.8rem;flex-wrap:wrap}.crypto-option-copy strong{font-size:14px}.crypto-option-copy>span{font-size:13px;color:var(--soft)}.crypto-assets{display:flex;gap:.35rem}.crypto-assets span{width:1.7rem;height:1.7rem;border-radius:50%;display:grid;place-items:center;background:#efe6d2;color:#6d5524;font-size:.8rem;font-weight:750}.crypto-option-active{color:var(--deep);background:var(--mist);border-color:#cfe6cb;font-size:13px}.crypto-option-active svg{width:15px;height:15px;vertical-align:-3px}.crypto-option-muted{color:var(--faint);font-size:13px}.billing-footnote{color:var(--faint);font-size:13px;margin-top:1.8rem}.billing-footnote a{color:var(--deep);font-weight:650}@media(max-width:1050px){.billing-plans{grid-template-columns:repeat(2,1fr)}}@media(max-width:560px){body{padding:2.5rem 1rem}.billing-h1{font-size:25px}.billing-usage{padding:1.2rem}.billing-plan{padding:1.35rem}.billing-plans{grid-template-columns:1fr}.crypto-option{align-items:flex-start;flex-direction:column}}
  </style></head><body><main class="billing-wrap"><a class="billing-crumb" href="/admin">← blognice admin</a><h1 class="billing-h1">Billing</h1><p class="billing-account">Account: <b>${esc(account.email)}</b></p>${statusNotice}${unknownPaid}${usage}<section class="billing-section billing-plan-section"><div class="billing-section-head"><h2>Plan</h2>${active && renewal ? `<span>${esc(renewal)}</span>` : cryptoActive ? `<span>Valid through ${esc(cryptoExpiry)}</span>` : ""}</div>${billingAction ? `<div class="billing-main-action">${billingAction}</div>` : ""}<div class="billing-plans">${freeCard}${monthlyCard}${yearlyCard}</div>${cryptoOption}</section><p class="billing-footnote">Stripe remains the primary payment provider. Payment details, receipts, invoices, cancellations, and plan changes are managed securely in Stripe. Crypto payments are annual-only, prepaid, and handled by NOWPayments; there is no automatic renewal. ${active ? "" : "Upgrade when you’re ready; access starts only after the payment provider confirms payment."}</p>${formerCustomer}</main></body></html>`;
}

app.get("/admin/billing", async (c) => {
  const account = await currentAccount(c);
  if (!account) return c.redirect("/admin/login");
  const billing = await c.env.DB.prepare("SELECT stripe_customer_id, stripe_subscription_id, billing_status, billing_price_id, billing_period_end, billing_cancel_at_period_end, crypto_paid_through FROM accounts WHERE id = ?").bind(account.id).first() || {};
  const usage = await c.env.DB.prepare("SELECT credits_used AS used, allowance FROM ai_credit_usage WHERE account_id = ? AND period = ?")
    .bind(account.id, aiCreditPeriod()).first<{ used: number; allowance: number }>();
  return c.html(billingPage(account, billing, String(c.req.query("message") || ""), usage || { used: 0, allowance: AI_MONTHLY_CREDITS }, { monthly: c.env.STRIPE_MONTHLY_PRICE_ID || c.env.STRIPE_PRICE_ID, yearly: c.env.STRIPE_YEARLY_PRICE_ID }, nowPaymentsConfigured(c.env)).replaceAll("Blog Nice admin", "blognice admin").replaceAll("Billing · Blog Nice", "Billing · blognice"));
});

app.post("/admin/billing/checkout", async (c) => {
  const account = await currentAccount(c);
  if (!account) return c.redirect("/admin/login");
  if (!stripeConfigured(c.env)) return c.redirect("/admin/billing?message=Stripe is not configured yet.");
  const form = await c.req.formData();
  const plan = String(form.get("plan") || "monthly");
  const priceId = plan === "yearly" ? (c.env.STRIPE_YEARLY_PRICE_ID || "") : (c.env.STRIPE_MONTHLY_PRICE_ID || c.env.STRIPE_PRICE_ID || "");
  if (!priceId) return c.redirect("/admin/billing?message=The selected Stripe plan is not configured yet.");
  const billing = await c.env.DB.prepare("SELECT stripe_customer_id, billing_status FROM accounts WHERE id = ?").bind(account.id).first<{ stripe_customer_id?: string | null; billing_status: string }>();
  if (billing && ["active", "trialing", "past_due"].includes(billing.billing_status)) return c.redirect("/admin/billing?message=This account already has a subscription.");
  try {
    const origin = new URL(c.req.url).origin;
    const session = await createCheckoutSession(c.env, { accountId: account.id, email: account.email, priceId, customerId: billing?.stripe_customer_id, successUrl: `${origin}/admin/billing?message=Checkout completed. Subscription access will update after Stripe confirms payment.`, cancelUrl: `${origin}/admin/billing?message=Checkout cancelled.` });
    return c.redirect(session.url, 303);
  } catch (error) {
    return c.redirect(`/admin/billing?message=${encodeURIComponent(error instanceof Error ? error.message : "Stripe checkout failed.")}`);
  }
});

app.post("/admin/billing/portal", async (c) => {
  const account = await currentAccount(c);
  if (!account) return c.redirect("/admin/login");
  const billing = await c.env.DB.prepare("SELECT stripe_customer_id FROM accounts WHERE id = ?").bind(account.id).first<{ stripe_customer_id?: string | null }>();
  if (!billing?.stripe_customer_id) return c.redirect("/admin/billing?message=No Stripe billing customer exists yet.");
  try {
    const origin = new URL(c.req.url).origin;
    const session = await createPortalSession(c.env, billing.stripe_customer_id, `${origin}/admin/billing`);
    return c.redirect(session.url, 303);
  } catch (error) {
    return c.redirect(`/admin/billing?message=${encodeURIComponent(error instanceof Error ? error.message : "Stripe portal failed.")}`);
  }
});

app.post("/admin/billing/crypto/checkout", async (c) => {
  const account = await currentAccount(c);
  if (!account) return c.redirect("/admin/login");
  if (!nowPaymentsConfigured(c.env)) return c.redirect("/admin/billing?message=Crypto payments are not configured yet.");
  const billing = await c.env.DB.prepare("SELECT billing_status, crypto_paid_through FROM accounts WHERE id = ?").bind(account.id).first<{ billing_status: string; crypto_paid_through?: number | null }>();
  if (accountHasPaidPlan(billing || {})) return c.redirect("/admin/billing?message=This account already has paid access.");
  try {
    const origin = new URL(c.req.url).origin;
    const orderId = `blognice-${account.id}-${crypto.randomUUID()}`;
    const invoice = await createAnnualInvoice(c.env, {
      orderId,
      callbackUrl: `${origin}/nowpayments/webhook`,
      successUrl: `${origin}/admin/billing?message=Crypto payment received. Access will update after NOWPayments confirms it.`,
      cancelUrl: `${origin}/admin/billing?message=Crypto payment cancelled.`,
    });
    const url = invoice.invoice_url || invoice.payment_url || invoice.pay_url;
    if (!url) throw new Error("NOWPayments did not return an invoice URL.");
    return c.redirect(url, 303);
  } catch (error) {
    return c.redirect(`/admin/billing?message=${encodeURIComponent(error instanceof Error ? error.message : "Crypto checkout failed.")}`);
  }
});

app.post("/nowpayments/webhook", async (c) => {
  const raw = await c.req.text();
  if (!await verifyNowPaymentsIpn(raw, c.req.header("x-nowpayments-sig"), c.env.NOWPAYMENTS_IPN_SECRET)) return c.json({ error: "invalid signature" }, 400);
  let payload: any;
  try { payload = JSON.parse(raw); } catch { return c.json({ error: "invalid payload" }, 400); }
  const paymentId = String(payload.payment_id || "");
  const orderId = String(payload.order_id || "");
  if (!paymentId || !orderId) return c.json({ error: "missing payment identity" }, 400);
  try {
    const payment = await getPayment(c.env, paymentId);
    if (String(payment.order_id || orderId) !== orderId) throw new Error("NOWPayments order mismatch.");
    if (Number(payment.price_amount) !== NOWPAYMENTS_ANNUAL_USD || String(payment.price_currency || "").toLowerCase() !== "usd") throw new Error("NOWPayments payment amount mismatch.");
    const order = await c.env.DB.prepare("SELECT account_id, price_usd_cents, credited_at, revoked_at FROM crypto_payments WHERE order_id = ?").bind(orderId).first<{ account_id: number; price_usd_cents: number; credited_at: number | null; revoked_at: number | null }>();
    const accountId = order?.account_id || Number(orderId.match(/^blognice-(\d+)-/)?.[1] || 0);
    if (!accountId) throw new Error("NOWPayments order could not be mapped to an account.");
    const now = Math.floor(Date.now() / 1000);
    const paymentStatus = String(payment.payment_status || payload.payment_status || "");
    const finished = isTerminalPaidStatus(paymentStatus);
    // Unpaid/intermediate states must remain retryable: NOWPayments can send a
    // later finished callback. Only a true post-credit refund revokes access.
    const reversible = paymentStatus === "refunded";
    await c.env.DB.prepare(
      `INSERT INTO crypto_payments (id, account_id, order_id, plan, price_usd_cents, pay_currency, pay_amount, actually_paid, status, created_at, updated_at, paid_at, credited_at)
       VALUES (?, ?, ?, 'yearly', ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(order_id) DO UPDATE SET pay_currency = excluded.pay_currency, pay_amount = excluded.pay_amount, actually_paid = excluded.actually_paid, status = excluded.status, updated_at = excluded.updated_at, paid_at = COALESCE(crypto_payments.paid_at, excluded.paid_at), credited_at = COALESCE(crypto_payments.credited_at, excluded.credited_at)`
    ).bind(paymentId, accountId, orderId, NOWPAYMENTS_ANNUAL_USD * 100, payment.pay_currency || payload.pay_currency || null, payment.pay_amount || payload.pay_amount || null, payment.actually_paid || payload.actually_paid || null, paymentStatus, now, now, finished ? now : null, null).run();
    if (finished) {
      const nonce = crypto.randomUUID();
      const claim = await c.env.DB.batch([
        c.env.DB.prepare("UPDATE crypto_payments SET credited_at = ?, credit_nonce = ? WHERE order_id = ? AND status = 'finished' AND credited_at IS NULL AND revoked_at IS NULL").bind(now, nonce, orderId),
        c.env.DB.prepare("UPDATE accounts SET crypto_paid_through = CASE WHEN COALESCE(crypto_paid_through, 0) > ? THEN crypto_paid_through + ? ELSE ? END WHERE id = ? AND EXISTS (SELECT 1 FROM crypto_payments WHERE order_id = ? AND credit_nonce = ?)").bind(now, NOWPAYMENTS_ANNUAL_SECONDS, now + NOWPAYMENTS_ANNUAL_SECONDS, accountId, orderId, nonce),
        // Keep each payment's own one-year contribution independent from the
        // account's stacked expiry. Refund recomputation can then remove only
        // this payment without preserving a cumulative expiry from another one.
        c.env.DB.prepare("UPDATE crypto_payments SET entitlement_through = ? WHERE order_id = ? AND credit_nonce = ?").bind(now + NOWPAYMENTS_ANNUAL_SECONDS, orderId, nonce),
      ]);
      if (claim[0].meta.changes !== 1) console.info(JSON.stringify({ message: "NOWPayments duplicate finished IPN", paymentId, orderId }));
    } else if (reversible) {
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE crypto_payments SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE order_id = ?").bind(now, now, orderId),
        c.env.DB.prepare(`WITH RECURSIVE ordered AS (
            SELECT credited_at, ROW_NUMBER() OVER (ORDER BY credited_at, id) AS rn
              FROM crypto_payments
             WHERE account_id = ? AND status = 'finished' AND revoked_at IS NULL AND credited_at IS NOT NULL
          ), timeline(rn, expiry) AS (
            SELECT rn, credited_at + ? FROM ordered WHERE rn = 1
            UNION ALL
            SELECT o.rn, CASE WHEN t.expiry > o.credited_at THEN t.expiry ELSE o.credited_at END + ?
              FROM timeline t JOIN ordered o ON o.rn = t.rn + 1
          )
          UPDATE accounts SET crypto_paid_through = (SELECT expiry FROM timeline ORDER BY rn DESC LIMIT 1) WHERE id = ?`).bind(accountId, NOWPAYMENTS_ANNUAL_SECONDS, NOWPAYMENTS_ANNUAL_SECONDS, accountId),
      ]);
    }
    return c.json({ received: true });
  } catch (error) {
    console.error(JSON.stringify({ message: "NOWPayments webhook processing failed", paymentId, orderId, error: error instanceof Error ? error.message : String(error) }));
    return c.json({ error: "webhook processing failed" }, 500);
  }
});

app.post("/stripe/webhook", async (c) => {
  const raw = await c.req.text();
  if (!await verifyStripeSignature(raw, c.req.header("Stripe-Signature"), c.env.STRIPE_WEBHOOK_SECRET)) return c.json({ error: "invalid signature" }, 400);
  const event = JSON.parse(raw) as { id: string; type: string; created: number; data?: { object?: any } };
  const eventCreated = event.created || Math.floor(Date.now() / 1000);
  const inserted = await c.env.DB.prepare("INSERT OR IGNORE INTO stripe_events (id, type, created_at, processed_at, status) VALUES (?, ?, ?, 0, 'processing')").bind(event.id, event.type, eventCreated).run();
  if (!inserted.meta.changes) {
    const existing = await c.env.DB.prepare("SELECT status FROM stripe_events WHERE id = ?").bind(event.id).first<{ status: string }>();
    if (existing?.status === "processed") return c.json({ received: true, duplicate: true });
    await c.env.DB.prepare("UPDATE stripe_events SET status = 'processing', last_error = NULL WHERE id = ?").bind(event.id).run();
  }
  try {
  const object = event.data?.object || {};
  const entitlementEvent = event.type.startsWith("customer.subscription.") || event.type === "invoice.payment_failed";
  const invoiceSubscriptionId = typeof object.parent?.subscription_details?.subscription === "string"
    ? object.parent.subscription_details.subscription
    : typeof object.subscription === "string" ? object.subscription : null;
  let subscriptionObject = object;
  if (entitlementEvent && !event.type.endsWith(".deleted")) {
    const subscriptionId = event.type === "invoice.payment_failed" ? invoiceSubscriptionId : object.id;
    if (typeof subscriptionId === "string" && subscriptionId) subscriptionObject = await retrieveSubscription(c.env, subscriptionId);
  }
  const customerId = typeof (subscriptionObject.customer || object.customer) === "string" ? (subscriptionObject.customer || object.customer) : null;
  let accountId: number | null = Number(object.metadata?.account_id || 0) || null;
  if (!accountId && customerId) {
    const row = await c.env.DB.prepare("SELECT id FROM accounts WHERE stripe_customer_id = ?").bind(customerId).first<{ id: number }>();
    accountId = row?.id || null;
  }
  if (entitlementEvent && !accountId) throw new Error("Stripe billing event could not be mapped to a Blog Nice account yet.");
  if (event.type === "invoice.payment_failed" && accountId) {
    const accountBilling = await c.env.DB.prepare("SELECT stripe_subscription_id FROM accounts WHERE id = ?").bind(accountId).first<{ stripe_subscription_id: string | null }>();
    if (!invoiceSubscriptionId || !accountBilling?.stripe_subscription_id || invoiceSubscriptionId !== accountBilling.stripe_subscription_id) {
      await c.env.DB.prepare("UPDATE stripe_events SET account_id = ? WHERE id = ?").bind(accountId, event.id).run();
      // This invoice is unrelated to Blog Nice's subscription; acknowledge it.
      subscriptionObject = null;
    }
  }
  if (event.type === "checkout.session.completed" && accountId && customerId && typeof object.subscription === "string") {
    const incomingSubscription = await retrieveSubscription(c.env, object.subscription);
    const currentBilling = await c.env.DB.prepare("SELECT stripe_subscription_id, billing_subscription_created_at FROM accounts WHERE id = ?")
      .bind(accountId).first<{ stripe_subscription_id: string | null; billing_subscription_created_at: number | null }>();
    let currentCreated = currentBilling?.billing_subscription_created_at || null;
    if (currentBilling?.stripe_subscription_id && currentBilling.stripe_subscription_id !== incomingSubscription.id && !currentCreated) {
      // Backfill the comparison value for subscriptions created before this
      // column existed. If Stripe cannot provide it, fail and let Stripe retry;
      // guessing could allow an old Checkout session to replace a newer one.
      const currentSubscription = await retrieveSubscription(c.env, currentBilling.stripe_subscription_id);
      currentCreated = currentSubscription.created || null;
      if (!currentCreated) throw new Error("Stripe did not return the current subscription creation time.");
    }
    if (!incomingSubscription.created) throw new Error("Stripe did not return the completed subscription creation time.");
    const checkoutDecision = checkoutSubscriptionDecision({
      currentId: currentBilling?.stripe_subscription_id,
      currentCreated,
      incomingId: incomingSubscription.id,
      incomingCreated: incomingSubscription.created,
    });
    if (checkoutDecision !== "ignore") {
      const checkoutStatus = String(incomingSubscription.status || "inactive");
      const checkoutPeriodEnd = incomingSubscription.current_period_end || incomingSubscription.items?.data?.[0]?.current_period_end || null;
      if (checkoutDecision === "adopt") {
        // A new subscription starts a new event-ordering stream. Reset the
        // webhook cursor even if an old subscription produced a later event.
        await c.env.DB.prepare("UPDATE accounts SET stripe_customer_id = ?, stripe_subscription_id = ?, billing_subscription_created_at = ?, billing_status = ?, billing_price_id = ?, billing_period_end = ?, billing_cancel_at_period_end = ?, billing_updated_at = ?, billing_event_created_at = ?, billing_event_id = ? WHERE id = ?")
          .bind(customerId, incomingSubscription.id, incomingSubscription.created, checkoutStatus, incomingSubscription.items?.data?.[0]?.price?.id || null, checkoutPeriodEnd, incomingSubscription.cancel_at_period_end ? 1 : 0, Math.floor(Date.now() / 1000), eventCreated, event.id, accountId).run();
      } else {
        // Reprocessing Checkout for the same subscription refreshes live state
        // without moving its event-ordering cursor backwards.
        await c.env.DB.prepare("UPDATE accounts SET stripe_customer_id = ?, billing_subscription_created_at = COALESCE(billing_subscription_created_at, ?), billing_status = ?, billing_price_id = ?, billing_period_end = ?, billing_cancel_at_period_end = ?, billing_updated_at = ?, billing_event_created_at = CASE WHEN COALESCE(billing_event_created_at, 0) < ? THEN ? ELSE billing_event_created_at END, billing_event_id = CASE WHEN COALESCE(billing_event_created_at, 0) < ? THEN ? ELSE billing_event_id END WHERE id = ?")
          .bind(customerId, incomingSubscription.created, checkoutStatus, incomingSubscription.items?.data?.[0]?.price?.id || null, checkoutPeriodEnd, incomingSubscription.cancel_at_period_end ? 1 : 0, Math.floor(Date.now() / 1000), eventCreated, eventCreated, eventCreated, event.id, accountId).run();
      }
    }
    await c.env.DB.prepare("UPDATE stripe_events SET account_id = ? WHERE id = ?").bind(accountId, event.id).run();
  }
  if (event.type.startsWith("customer.subscription.") && accountId && subscriptionObject) {
    const currentBilling = await c.env.DB.prepare("SELECT stripe_subscription_id FROM accounts WHERE id = ?")
      .bind(accountId).first<{ stripe_subscription_id: string | null }>();
    const incomingSubscriptionId = String(subscriptionObject.id || object.id || "");
    if (!subscriptionEventMatchesCurrent(currentBilling?.stripe_subscription_id, incomingSubscriptionId)) {
      // A delayed event from an older Stripe subscription must never replace the
      // account's current subscription or revoke its entitlement.
      await c.env.DB.prepare("UPDATE stripe_events SET account_id = ? WHERE id = ?").bind(accountId, event.id).run();
      subscriptionObject = null;
    }
  }
  if (event.type.startsWith("customer.subscription.") && accountId && subscriptionObject) {
    const status = event.type.endsWith(".deleted") ? "canceled" : String(subscriptionObject.status || "inactive");
    const periodEnd = subscriptionObject.current_period_end || subscriptionObject.items?.data?.[0]?.current_period_end || null;
    const subscriptionUpdate = await c.env.DB.prepare("UPDATE accounts SET stripe_customer_id = COALESCE(?, stripe_customer_id), stripe_subscription_id = ?, billing_subscription_created_at = COALESCE(?, billing_subscription_created_at), billing_status = ?, billing_price_id = ?, billing_period_end = ?, billing_cancel_at_period_end = ?, billing_updated_at = ?, billing_event_created_at = ?, billing_event_id = ? WHERE id = ? AND (COALESCE(billing_event_created_at, 0) < ? OR (COALESCE(billing_event_created_at, 0) = ? AND COALESCE(billing_event_id, '') < ?))")
      .bind(customerId, subscriptionObject.id || object.id || null, subscriptionObject.created || null, status, subscriptionObject.items?.data?.[0]?.price?.id || null, periodEnd, subscriptionObject.cancel_at_period_end ? 1 : 0, Math.floor(Date.now() / 1000), eventCreated, event.id, accountId, eventCreated, eventCreated, event.id).run();
    await c.env.DB.prepare("UPDATE stripe_events SET account_id = ? WHERE id = ?").bind(accountId, event.id).run();
    if (subscriptionUpdate.meta.changes && event.type === "customer.subscription.created" && ["active", "trialing"].includes(status) && c.env.EMAIL_QUEUE && emailEnabled(c.env)) {
      const account = await c.env.DB.prepare("SELECT email FROM accounts WHERE id = ?").bind(accountId).first<{ email: string }>();
      if (account?.email && object.id) {
        const idempotencyKey = `subscription-welcome:${accountId}:${String(object.id)}`;
        const welcome = await c.env.DB.prepare(
          `INSERT OR IGNORE INTO email_delivery_log (idempotency_key, status, recipient, kind, created_at)
           VALUES (?, 'pending', ?, 'subscription-welcome', ?)`
        ).bind(idempotencyKey, account.email, Math.floor(Date.now() / 1000)).run();
        if (welcome.meta.changes) {
          const billingUrl = `https://www.${c.env.ROOT_DOMAIN}/admin/billing`;
          await c.env.EMAIL_QUEUE.send({
            kind: "email-delivery",
            emailKind: "subscription-welcome",
            idempotencyKey,
            to: account.email,
            subject: "Welcome to blognice Pro",
            plainText: `Your blognice Pro subscription is active.\n\nYou can now use AI features, collaborators, custom domains, favicons, and up to five blogs.\n\nManage billing: ${billingUrl}\n\nStripe will send your payment receipt separately.`,
            html: `<p>Your <strong>blognice Pro</strong> subscription is active.</p><p>You can now use AI features, collaborators, custom domains, favicons, and up to five blogs.</p><p><a href="${billingUrl}">Manage billing</a></p><p style="color:#687064;font-size:13px">Stripe will send your payment receipt separately.</p>`,
          } satisfies EmailJobMessage);
        }
      }
    }
  }
  if (event.type === "invoice.payment_failed" && accountId && subscriptionObject) {
    // Preserve the authoritative Stripe status. In particular, an initial
    // failed payment can be `incomplete`/`incomplete_expired`/`paused`; mapping
    // those to `past_due` would incorrectly grant Pro access.
    const stripeStatus = String(subscriptionObject.status || "inactive");
    const reconciledStatus = ["active", "trialing", "past_due", "canceled", "unpaid", "incomplete", "incomplete_expired", "paused"].includes(stripeStatus)
      ? stripeStatus
      : "inactive";
    await c.env.DB.prepare("UPDATE accounts SET billing_status = ?, billing_updated_at = ?, billing_event_created_at = ?, billing_event_id = ? WHERE id = ? AND (COALESCE(billing_event_created_at, 0) < ? OR (COALESCE(billing_event_created_at, 0) = ? AND COALESCE(billing_event_id, '') < ?))").bind(reconciledStatus, Math.floor(Date.now() / 1000), eventCreated, event.id, accountId, eventCreated, eventCreated, event.id).run();
    await c.env.DB.prepare("UPDATE stripe_events SET account_id = ? WHERE id = ?").bind(accountId, event.id).run();
  }
    await c.env.DB.prepare("UPDATE stripe_events SET status = 'processed', processed_at = ?, last_error = NULL WHERE id = ?").bind(Math.floor(Date.now() / 1000), event.id).run();
    return c.json({ received: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
    await c.env.DB.prepare("UPDATE stripe_events SET status = 'failed', last_error = ? WHERE id = ?").bind(detail, event.id).run().catch(() => undefined);
    console.error(JSON.stringify({ message: "Stripe webhook processing failed", eventId: event.id, error: detail }));
    return c.json({ error: "webhook processing failed" }, 500);
  }
});

app.post("/manage-subscriptions/:token", async (c) => {
  const token = c.req.param("token");
  const identity = await c.env.DB.prepare("SELECT email FROM subscription_manage_tokens WHERE token = ?")
    .bind(token).first<{ email: string }>();
  if (!identity) return c.text("Invalid subscription management link", 404);
  const form = await c.req.formData();
  const selected = new Set(form.getAll("subscription").map(String));
  const subscriptions = await c.env.DB.prepare("SELECT id FROM subscribers WHERE email = ?")
    .bind(identity.email).all<{ id: number }>();
  const remove = subscriptions.results.filter((row) => !selected.has(String(row.id)));
  if (remove.length) await c.env.DB.batch(remove.map((row) => c.env.DB.prepare("DELETE FROM subscribers WHERE id = ? AND email = ?").bind(row.id, identity.email)));
  const remaining = await c.env.DB.prepare("SELECT s.id, t.title, t.slug, t.custom_domain FROM subscribers s JOIN tenants t ON t.id = s.tenant_id WHERE s.email = ? AND s.confirmed_at IS NOT NULL ORDER BY t.title")
    .bind(identity.email).all<{ id: number; title: string; slug: string; custom_domain?: string | null }>();
  return c.html(subscriptionManagePage(identity.email, remaining.results, token, "Your subscription preferences have been saved."));
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
        "cache-control": "public, max-age=0, s-maxage=0, must-revalidate",
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

    const postsPromise = tenantDb(c.env, tenant).prepare(
      "SELECT * FROM posts WHERE tenant_id = ? AND published = 1 ORDER BY created_at DESC"
    ).bind(tenant.id).all<Post>();
    const popularityPromise = c.env.DB.prepare(
      `SELECT path, score, reader_days_30
         FROM post_popularity
        WHERE tenant_id = ? AND reader_days_30 >= 3
        ORDER BY score DESC, reader_days_30 DESC, path
        LIMIT 3`
    ).bind(tenant.id).all<{ path: string; score: number; reader_days_30: number }>().catch((error) => {
      // A missing migration or transient ranking failure must never make the
      // public blog unavailable. Keep the last normal homepage layout instead.
      console.error(JSON.stringify({
        message: "popular posts lookup failed",
        tenantId: tenant.id,
        error: error instanceof Error ? error.message : String(error),
      }));
      return { results: [] as { path: string; score: number; reader_days_30: number }[] };
    });
    const [{ results }, popularity] = await Promise.all([postsPromise, popularityPromise]);
    const postsByPath = new Map(results.map((post) => [`/${post.slug}`, post]));
    const popularPosts = popularity.results
      .map((row) => postsByPath.get(row.path))
      .filter((post): post is Post => Boolean(post));

    return new Response(renderHome(tenant, results, originOf(c), analyticsConsentRequired(c.req.raw.cf?.country), popularPosts), {
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

    return new Response(renderPost(tenant, post, htmlBody, originOf(c), adminOriginOf(c), analyticsConsentRequired(c.req.raw.cf?.country)), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });
});

export default {
  fetch: app.fetch,
  async queue(batch, env) {
    for (const message of batch.messages) {
      const jobMessage = message.body as AudioJobMessage | ImageJobMessage | IndexNowMessage | EmailJobMessage | EmailFanoutMessage;
      try {
        if ("kind" in jobMessage && jobMessage.kind === "indexnow") await processIndexNow(env, jobMessage);
        else if ("kind" in jobMessage && jobMessage.kind === "email-fanout") await processEmailFanout(env, jobMessage);
        else if ("kind" in jobMessage && jobMessage.kind === "email-delivery") await processEmailJob(env, jobMessage);
        else if ("kind" in jobMessage && jobMessage.kind === "image") await processImageJob(env, jobMessage.jobKey);
        else await processAudioJob(env, jobMessage.jobKey);
        message.ack();
      } catch (error) {
        const attempts = Number((message as unknown as { attempts?: number }).attempts || 1);
        // max_retries is five in both Wrangler configurations, so attempt six
        // is the terminal delivery. Refund only then; transient failures must
        // retain their reservation while the queue retries.
        const isImageJob = "kind" in jobMessage && jobMessage.kind === "image";
        const isAudioJob = "jobKey" in jobMessage && !("kind" in jobMessage);
        if (attempts >= 6 && (isImageJob || isAudioJob) && "jobKey" in jobMessage) {
          await refundTerminalAiJob(env, jobMessage.jobKey, isImageJob ? "image" : "audio").catch((refundError) => console.error(JSON.stringify({ message: "terminal AI credit refund failed", error: refundError instanceof Error ? refundError.message : String(refundError) })));
        }
        console.error(JSON.stringify({
          message: "Queued job failed; retrying",
          jobKey: "jobKey" in jobMessage ? jobMessage.jobKey : undefined,
          idempotencyKey: "idempotencyKey" in jobMessage ? jobMessage.idempotencyKey : undefined,
          error: error instanceof Error ? error.message : String(error),
        }));
        message.retry();
      }
    }
  },
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      Promise.all([archivePreviousDay(env), archivePreviousDayEvents(env), refreshPostPopularity(env)]).catch((error) => {
        console.error(JSON.stringify({
          message: "scheduled metrics maintenance failed",
          error: error instanceof Error ? error.message : String(error),
        }));
      })
    );
  },
} satisfies ExportedHandler<Bindings>;
