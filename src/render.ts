import { metricsBeacon } from "./metrics";

// All HTML rendering lives here. No framework, no client-side JS —
// just server-rendered pages so they are fast and index cleanly.
//
// The look is inspired by Medium: a wide, comfortable measure, a large serif
// body (Charter — the same face Medium licenses), bold sans headings, and a
// byline with read time.

export type Tenant = {
  id: number;
  public_id: string;
  slug: string;
  custom_domain: string | null;
  title: string;
  description: string;
  footer_name?: string | null;
  avatar_key: string | null; // R2 key of the blog's profile image
  favicon_key: string | null; // R2 key of the blog's favicon
  accent_color: string | null; // hex accent used for this blog's branding
  topics_json: string | null;
  social_links_json?: string | null;
  shard: string; // which database holds this tenant's posts (see src/db.ts)
  created_at: number;
};

export const DEFAULT_ACCENT_COLOR = "#1a8917";

export function normalizeAccentColor(value: unknown): string {
  const color = String(value ?? "").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : DEFAULT_ACCENT_COLOR;
}

export function accentTextColor(value: string): "#ffffff" | "#15170f" {
  const color = normalizeAccentColor(value);
  const channels = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2] < 0.52 ? "#ffffff" : "#15170f";
}

export type Post = {
  id: number;
  tenant_id: number;
  author_account_id?: number | null;
  author_name?: string | null;
  author_visible?: number;
  slug: string;
  title: string;
  featured_image_key: string | null;
  audio_key: string | null;
  body_md: string;
  tags_json: string | null;
  published: number;
  created_at: number;
  updated_at: number;
};

export type Page = {
  id: number;
  tenant_id: number;
  slug: string;
  title: string;
  body_md: string;
  published: number;
  show_in_navigation?: number;
  navigation_label?: string | null;
  navigation_order?: number;
  meta_description?: string | null;
  created_at: number;
  updated_at: number;
  published_at?: number | null;
};

// Escape text that gets dropped into HTML (titles, descriptions, etc.).
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// Estimated read time, Medium-style (~200 words/min, minimum 1).
export function readingTime(md: string): number {
  const words = md.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

// A plain-text excerpt from Markdown, for the feed and meta description.
function excerpt(md: string, n = 180): string {
  const t = md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~|]/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > n ? t.slice(0, n).replace(/\s+\S*$/, "") + "…" : t;
}

function monogram(title: string): string {
  const ch = (title.trim()[0] || "?").toUpperCase();
  return esc(ch);
}

function tenantTopics(tenant: Tenant): string[] {
  try {
    const value = JSON.parse(tenant.topics_json || "[]");
    return Array.isArray(value) ? value.filter((topic): topic is string => typeof topic === "string").slice(0, 6) : [];
  } catch {
    return [];
  }
}

function postTags(post: Post): string[] {
  try {
    const value = JSON.parse(post.tags_json || "[]");
    return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === "string").slice(0, 20) : [];
  } catch {
    return [];
  }
}

function openingParagraphHasDropCap(html: string): boolean {
  const match = /<p\b[^>]*>([\s\S]*?)<\/p\s*>/i.exec(html);
  if (!match) return false;
  const text = match[1]
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.split(/\s+/).filter(Boolean).length >= 20;
}

// The reader-facing subscribe box, with progressive-enhancement JS: it submits
// via fetch and shows an inline message, but the plain <form> still works
// without JS (the endpoint returns a confirmation page).
function subscribeBox(tenant: Tenant): string {
  return `<section class="subscribe">
    <h3>Subscribe to ${esc(tenant.title)}</h3>
    <p class="sub-sub">Get new posts delivered to your inbox.</p>
    <form action="/subscribe" method="post" data-sub>
      <input type="email" name="email" placeholder="you@example.com" required aria-label="Email address">
      <button type="submit">Subscribe</button>
    </form>
    <div class="sub-msg" data-sub-msg></div>
  </section>
  <script>
    (function () {
      var form = document.querySelector("form[data-sub]");
      if (!form) return;
      var msg = document.querySelector("[data-sub-msg]");
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var email = (form.email.value || "").trim();
        if (!email) return;
        msg.textContent = "Subscribing…";
        var fd = new FormData(); fd.append("email", email);
        fetch("/subscribe", { method: "POST", body: fd })
          .then(function (r) { return r.json().catch(function () { return { ok: r.ok }; }); })
          .then(function (d) {
            if (d && d.ok) {
              form.reset();
        msg.textContent = "Check your inbox to confirm your subscription.";
            } else { msg.textContent = (d && d.error) || "Something went wrong."; }
          })
          .catch(function () { msg.textContent = "Something went wrong."; });
      });
    })();
  </script>`;
}

// A minimal standalone page (subscribe/unsubscribe confirmations), styled like
// the blog. Exported for use by the Worker routes.
export function renderSimplePage(
  tenant: Tenant,
  pageTitle: string,
  innerHtml: string
): string {
  return shell({
    tenant,
    pageTitle,
    description: pageTitle,
    canonical: "",
    body: `<article><h1>${esc(pageTitle)}</h1><div class="prose">${innerHtml}</div>
      <a class="backlink" href="/">&larr; Back to ${esc(tenant.title)}</a></article>`,
  });
}

const STYLES = /* css */ `
  :root {
    --bg: #ffffff;
    --ink: #242424;
    --soft: #4a4a48;
    --muted: #6b6b6b;
    --rule: #e8e8e6;
    --accent: #1a8917;               /* Medium-ish green, used sparingly */
    --measure: 53rem;                /* ~800px of text after padding, matching spiked */
    --serif: Charter, "Iowan Old Style", "Palatino Linotype", Georgia, Cambria, "Times New Roman", serif;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #121212;
      --ink: #e8e8e6;
      --soft: #c9c9c6;
      --muted: #a0a0a0;
      --rule: #2a2a2a;
      --accent: #6fd06b;
    }
  }
  html[data-theme="light"] {
    --bg: #ffffff; --ink: #242424; --soft: #4a4a48; --muted: #6b6b6b; --rule: #e8e8e6;
  }
  html[data-theme="dark"] {
    --bg: #121212; --ink: #e8e8e6; --soft: #c9c9c6; --muted: #a0a0a0; --rule: #2a2a2a;
  }

  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; scrollbar-gutter: stable; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font-family: var(--serif);
    font-size: 1.3rem;
    line-height: 1.58;
    text-rendering: optimizeLegibility;
    -webkit-font-smoothing: antialiased;
  }

  .wrap { max-width: var(--measure); margin: 0 auto; padding: 0 1.4rem 6rem; }
  .homepage-wrap {
    max-width: 82.5rem;
    padding-left: 1.5rem;
    padding-right: 1.5rem;
    font-family: var(--sans);
    font-size: 1rem;
    line-height: 1.6;
  }
  .site-controls { display:flex; align-items:center; justify-content:flex-end; gap:.55rem; padding-top:.8rem; }
  .theme-toggle { width: 2.35rem; height: 2.35rem; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--rule); border-radius: 999px; background: color-mix(in srgb, var(--bg) 90%, transparent); color: var(--muted); cursor: pointer; font: inherit; line-height: 1; box-shadow: 0 2px 8px rgb(0 0 0 / .08); }
  .theme-toggle:hover, .theme-toggle:focus-visible { color: var(--accent); border-color: var(--accent); }
  .rss-global { display:inline-flex; }
  .rss-global a { display:inline-flex; align-items:center; justify-content:center; width:2.35rem; height:2.35rem; border:1px solid var(--rule); border-radius:999px; color:var(--muted); background:color-mix(in srgb,var(--bg) 90%,transparent); text-decoration:none; }
  .rss-global svg { width:1.15rem; height:1.15rem; fill:currentColor; }
  .rss-global a:hover, .rss-global a:focus-visible { color:var(--accent); border-color:var(--accent); }
  .theme-toggle .moon { display: none; }
  html[data-theme="dark"] .theme-toggle .sun { display: none; }
  html[data-theme="dark"] .theme-toggle .moon { display: inline; }
  .site-controls .subscribe-link { display:inline-flex; align-items:center; justify-content:center; width:2.35rem; height:2.35rem; border:1px solid var(--rule); border-radius:999px; color:var(--muted); background:color-mix(in srgb,var(--bg) 90%,transparent); text-decoration:none; }
  .site-controls .subscribe-link svg { width:1.15rem; height:1.15rem; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  .site-controls .subscribe-link:hover, .site-controls .subscribe-link:focus-visible { color:var(--accent); border-color:var(--accent); }
  .homepage-wrap .blog-nav .subscribe-link { display:none; }
  .homepage-wrap .site-controls { margin-bottom:-3.15rem; position:relative; z-index:2; }
  .homepage-wrap .blog-nav { padding-right:9.5rem; }
  .homepage-wrap .blog-topics + .blog-section { padding-top: 1rem; }
  @media (max-width:640px) { .homepage-wrap .blog-nav { padding-right:8.5rem; } }
  .to-top { position: fixed; right: max(1rem, calc((100vw - var(--measure) - 2.8rem) / 2)); bottom: 1.2rem; z-index: 30; width: 2.5rem; height: 2.5rem; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--accent); border-radius: 999px; background: var(--accent); color: var(--accent-ink); cursor: pointer; font: inherit; font-size: 1.3rem; font-weight: 700; line-height: 1; box-shadow: 0 4px 14px rgb(0 0 0 / .24); opacity: 0; pointer-events: none; transform: translateY(.5rem); transition: opacity .2s ease, transform .2s ease, filter .2s ease; }
  .to-top.visible { opacity: 1; pointer-events: auto; transform: translateY(0); }
  .to-top:hover, .to-top:focus-visible { filter: brightness(1.1); }
  @media (max-width: 640px) { .to-top { right: .65rem; bottom: .8rem; } }

  /* Slim publication header, like a Medium publication bar. */
  .masthead {
    text-align: center;
    padding: 2.4rem 0 2rem;
    margin-bottom: 3rem;
    border-bottom: 1px solid var(--rule);
  }
  .masthead a { color: inherit; text-decoration: none; }
  .site-title {
    font-family: var(--sans);
    font-size: 1.5rem;
    font-weight: 700;
    letter-spacing: -0.01em;
    margin: 0;
  }
  .site-desc {
    font-family: var(--sans);
    font-size: 0.98rem;
    color: var(--muted);
    margin: 0.5rem 0 0;
  }

  /* Home feed — title, excerpt, meta per item. */
  .feed { list-style: none; margin: 0; padding: 0; }
  .feed li { padding: 0 0 2.4rem; margin-bottom: 2.4rem; border-bottom: 1px solid var(--rule); }
  .feed li:last-child { border-bottom: none; }
  .feed a { color: inherit; text-decoration: none; display: block; }
  .feed-title {
    font-family: var(--sans);
    font-size: 1.7rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1.2;
    margin: 0 0 0.5rem;
  }
  .feed a:hover .feed-title { color: var(--accent); }
  .feed a.has-thumb { display: grid; grid-template-columns: minmax(0, 1fr) 12rem; gap: 1.5rem; align-items: center; }
  .feed-thumb { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border-radius: 4px; }
  .feed-excerpt { color: var(--soft); margin: 0 0 0.7rem; font-size: 1.12rem; line-height: 1.5; }
  .feed-meta { font-family: var(--sans); font-size: 0.86rem; color: var(--muted); }

  /* Blog homepage — compact identity header, featured post, and card grids. */
  .blog-nav { display:flex; align-items:center; justify-content:space-between; gap:1.25rem; padding:1.1rem 0; border-bottom:1px solid var(--rule); }
  .blog-header-id { display:flex; align-items:center; gap:.8rem; min-width:0; }
  .blog-header-id > a { display:flex; align-items:center; gap:.8rem; min-width:0; color:inherit; text-decoration:none; }
  .blog-avatar { width:3.1rem; height:3.1rem; border-radius:50%; background:var(--accent); color:#fff; display:flex; align-items:center; justify-content:center; font-family:var(--sans); font-weight:700; font-size:1.2rem; flex:0 0 auto; object-fit:cover; overflow:hidden; }
  img.blog-avatar { display:block; }
  .blog-header-text { min-width:0; }
  .blog-nav .site-title { margin:0; font-family:var(--sans); font-size:1.08rem; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .blog-tagline { color:var(--muted); font-size:.86rem; font-style:italic; margin:.05rem 0 0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .blog-nav .subscribe-link { flex:0 0 auto; font-family:var(--sans); font-size:.84rem; border:1px solid var(--rule); border-radius:999px; padding:.45rem 1rem; color:var(--muted); text-decoration:none; }
  .blog-nav .subscribe-link:hover { color:var(--accent); border-color:var(--accent); }
  .blog-nav-links { display:flex; align-items:center; gap:.9rem; flex-wrap:wrap; padding:.7rem 0 .85rem; border-top:1px solid var(--rule); }
  .blog-nav-links a { display:inline-flex; align-items:center; min-height:2rem; padding:.25rem .15rem; color:var(--muted); font-family:var(--sans); font-size:.84rem; text-decoration:none; }
  .blog-nav-links a:hover, .blog-nav-links a:focus-visible, .blog-nav-links a[aria-current="page"] { color:var(--accent); text-decoration:underline; text-underline-offset:3px; }
  .blog-nav-actions { display:flex; align-items:center; gap:.55rem; flex:0 0 auto; }
  .blog-nav .rss-link { font-family:var(--sans); font-size:.84rem; border:1px solid var(--accent); border-radius:999px; padding:.45rem 1rem; color:var(--accent); text-decoration:none; font-weight:600; }
  .blog-nav .rss-link:hover { color:var(--accent-ink); background:var(--accent); }
  .blog-topics { display:flex; flex-wrap:wrap; gap:.45rem; padding-top:.5rem; }
  .blog-topics span { color:var(--accent); font-family:var(--sans); font-size:.8rem; font-weight:600; }
  .homepage-wrap a { color:inherit; }
  .blog-section { padding:3.5rem 0; }
  .tag-page { padding-top: 3rem; }
  .tag-page-title { margin: 0 0 2rem; font-family: var(--sans); font-size: clamp(2rem, 4vw, 3rem); line-height: 1.1; letter-spacing: -.03em; }
  .blog-kicker { display:block; font-family:var(--sans); font-size:.76rem; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:var(--accent); margin-bottom:1.2rem; }
  .blog-featured { display:grid; grid-template-columns:minmax(0,1.15fr) minmax(0,1fr); gap:2.75rem; align-items:center; }
  .blog-art { display:block; aspect-ratio:16 / 9; border-radius:9px; background:linear-gradient(135deg,var(--accent),color-mix(in srgb,var(--accent) 35%,var(--ink))); overflow:hidden; }
  .blog-art img { width:100%; height:100%; object-fit:cover; }
  .blog-featured h2 { font-family:var(--sans); font-size:clamp(1.65rem,3vw,2.4rem); line-height:1.15; margin:0 0 .8rem; }
  .blog-featured h2 a, .blog-card h3 a, .blog-popular-card h3 a { text-decoration:none; }
  .blog-featured h2 a:hover, .blog-card h3 a:hover, .blog-popular-card h3 a:hover { color:var(--accent); }
  .blog-excerpt { color:var(--soft); line-height:1.55; margin:0 0 .8rem; }
  .blog-meta { font-family:var(--sans); font-size:.82rem; color:var(--muted); }
  .blog-grid-head { display:flex; align-items:baseline; justify-content:space-between; gap:1rem; margin-bottom:1.5rem; }
  .blog-grid-head h2 { font-family:var(--sans); font-size:1.35rem; margin:0; }
  .blog-see-all { font-family:var(--sans); font-size:.85rem; color:var(--accent); }
  .blog-cards, .blog-popular-cards { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:2.4rem 2.2rem; }
  .blog-card, .blog-popular-card { min-width:0; }
  .blog-card .blog-art, .blog-popular-card .blog-art { margin-bottom:.9rem; }
  .blog-card h3, .blog-popular-card h3 { font-family:var(--sans); font-size:1.08rem; line-height:1.25; margin:0 0 .45rem; }
  .blog-popular-section { background:color-mix(in srgb,var(--ink) 3%,transparent); }
  .blog-subscribe-wrap { padding:3.5rem 0; }
  @media (max-width: 860px) { .blog-featured { grid-template-columns:1fr; gap:1.5rem; } }
  @media (max-width: 640px) {
    .blog-cards, .blog-popular-cards { grid-template-columns:1fr; }
    .blog-nav { gap:.65rem; }
    .blog-tagline { display:none; }
    .blog-nav .subscribe-link, .blog-nav .rss-link { padding:.4rem .8rem; }
  }

  /* A single post. */
  article h1 {
    font-family: var(--sans);
    font-size: 2.7rem;
    font-weight: 800;
    line-height: 1.13;
    letter-spacing: -0.03em;
    margin: 0 0 1.4rem;
  }
  .owner-edit {
    width: 2.35rem; height: 2.35rem; display: inline-flex; align-items: center; justify-content: center;
    border: 1px solid var(--rule); border-radius: 999px;
    background: color-mix(in srgb, var(--bg) 90%, transparent); color: var(--muted);
    font-family: var(--sans); font-size: 0.82rem; font-weight: 600;
    color: var(--muted); text-decoration: none;
    box-shadow: 0 2px 8px rgb(0 0 0 / .08);
  }
  .owner-edit svg { width: 1.05rem; height: 1.05rem; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .site-controls .owner-edit[data-blog-edit] svg { display: none; }
  .site-controls .owner-edit[data-blog-edit]::before { content: "🔧"; font-size: 1rem; line-height: 1; filter: grayscale(1); }
  .owner-edit:hover, .owner-edit:focus-visible { color: var(--accent); border-color: var(--accent); }
  .owner-edit[hidden] { display: none; }
  .blog-owner-actions, .post-owner-actions { display: none; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  .byline { display: flex; align-items: center; gap: 0.75rem; margin: 0 0 2.6rem; }
  .post-page { padding-top: 1.5rem; }
  .byline-identity { display: flex; align-items: center; gap: 0.75rem; min-width: 0; color: inherit; text-decoration: none; }
  .avatar {
    width: 2.6rem; height: 2.6rem; border-radius: 50%;
    background: var(--accent); color: #fff;
    display: flex; align-items: center; justify-content: center;
    font-family: var(--sans); font-weight: 700; font-size: 1.1rem;
    flex: 0 0 auto; object-fit: cover; overflow: hidden;
  }
  img.avatar { display: block; }
  .featured-image { display: block; width: 100%; height: auto; max-height: 34rem; object-fit: cover; border-radius: 5px; margin: 0 0 2.4rem; }
  .post-tags { display:flex; flex-wrap:wrap; gap:.45rem; margin:0 0 1rem; }
  .post-tags a { color:var(--accent); font-family:var(--sans); font-size:.82rem; text-decoration:none; }
  .post-tags a:hover { text-decoration:underline; }
  .post-featured-row { display: grid; grid-template-columns: minmax(0, 1fr) 2.5rem; gap: 1rem; align-items: center; margin: 0 0 1.1rem; }
  .post-featured-row > aside { order: 2; }
  .post-featured-row .featured-image { margin: 0; }
  .share-rail { display: flex; flex-direction: column; align-items: center; gap: .55rem; }
  .share-button { position: relative; width: 2.65rem; height: 2.65rem; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--rule); border-radius: 50%; background: var(--bg); color: var(--muted); font-family: var(--sans); font-size: .86rem; font-weight: 700; line-height: 1; text-decoration: none; cursor: pointer; transition: color .15s ease, border-color .15s ease, background .15s ease, transform .15s ease; }
  .share-button svg { width: 1.3rem; height: 1.3rem; fill: currentColor; stroke: currentColor; }
  .share-button:hover, .share-button:focus-visible { color: var(--share-color, var(--accent)); border-color: var(--share-color, var(--accent)); background: color-mix(in srgb, var(--share-color, var(--accent)) 9%, var(--bg)); transform: translateY(-1px); }
  .share-button::after { content: attr(data-tooltip); position: absolute; left: 50%; bottom: calc(100% + .45rem); transform: translate(-50%, .2rem); padding: .3rem .45rem; border-radius: 4px; background: var(--ink); color: var(--bg); font: 500 .7rem/1 var(--sans); white-space: nowrap; opacity: 0; pointer-events: none; transition: opacity .15s ease, transform .15s ease; }
  .share-button:hover::after, .share-button:focus-visible::after { opacity: 1; transform: translate(-50%, 0); }
  .share-whatsapp { --share-color: #25d366; }
  .share-telegram { --share-color: #229ed9; }
  .share-email { --share-color: #6b7280; }
  .share-x { --share-color: #111111; }
  .share-facebook { --share-color: #1877f2; }
  .share-linkedin { --share-color: #0a66c2; }
  .share-reddit { --share-color: #ff4500; }
  .share-button.share-copy.is-copied { color: var(--accent); border-color: var(--accent); }
  .share-inline { display: none; }
  .byline-name { font-family: var(--sans); font-size: 1rem; color: var(--ink); font-weight: 500; }
  .byline-meta { font-family: var(--sans); font-size: 0.9rem; color: var(--muted); margin-top: 0.1rem; }
  .post-audio { display: block; width: 19rem; height: 2rem; margin-left: auto; flex: 0 1 19rem; }

  .prose > *:first-child { margin-top: 0; }
  .page-content { max-width: 760px; margin: 0 auto; padding: .5rem 1.25rem 5rem; }
  .page-content-inner > h1 { font-size: clamp(2rem, 5vw, 3.2rem); line-height: 1.12; margin: 0 0 2.2rem; letter-spacing: -0.025em; }
  .page-prose { font-family: var(--serif); font-size: 1.12rem; line-height: 1.78; }
  .page-prose > *:first-child { margin-top: 0; }
  .prose p, .prose ul, .prose ol { margin: 1.5rem 0; }
  .prose ul, .prose ol { padding-left: 1.5rem; }
  .prose li { margin: 0.3rem 0; }
  .prose li > ul, .prose li > ol { margin: 0.4rem 0; }
  .prose h1, .prose h2, .prose h3, .prose h4, .prose h5, .prose h6 {
    font-family: var(--sans); font-weight: 700; scroll-margin-top: 1.5rem;
  }
  .prose h1 { font-size: 1.9rem; letter-spacing: -0.02em; line-height: 1.2; margin: 2.6rem 0 0.9rem; }
  .prose h2 { font-size: 1.5rem; letter-spacing: -0.015em; margin: 2.6rem 0 0.7rem; }
  .prose h3 { font-size: 1.25rem; margin: 2.2rem 0 0.5rem; }
  .prose h4 { font-size: 1.08rem; margin: 2rem 0 0.4rem; }
  .prose h5 { font-size: 0.95rem; margin: 1.8rem 0 0.4rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--soft); }
  .prose h6 { font-size: 0.85rem; margin: 1.7rem 0 0.4rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
  .prose a { color: inherit; text-decoration: underline; text-decoration-color: var(--muted); text-underline-offset: 3px; }
  .prose a:hover { text-decoration-color: var(--accent); color: var(--accent); }
  .prose img { max-width: 100%; height: auto; border-radius: 4px; margin: 1.5rem 0; }
  .prose blockquote {
    margin: 2rem 0;
    padding: 0.2rem 0 0.2rem 1.4rem;
    border-left: 3px solid var(--ink);
    font-style: italic;
    color: var(--soft);
    font-size: 1.28rem;
  }
  /* Nested quotes step down in size and lighten, so depth reads clearly. */
  .prose blockquote blockquote {
    margin: 1rem 0; font-size: 0.92em;
    border-left-color: var(--rule);
  }
  .prose code {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.88em;
    background: color-mix(in srgb, var(--ink) 7%, transparent);
    padding: 0.12em 0.35em; border-radius: 4px;
  }
  .prose pre {
    background: color-mix(in srgb, var(--ink) 5%, transparent);
    padding: 1rem 1.2rem; border-radius: 8px; overflow-x: auto; font-size: 0.9rem;
    line-height: 1.6; border: 1px solid var(--rule);
  }
  .prose pre code { background: none; padding: 0; font-size: inherit; }

  /* Keyboard keys, e.g. <kbd>Ctrl</kbd> + <kbd>S</kbd>. */
  .prose kbd {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.82em; line-height: 1;
    padding: 0.2em 0.5em; border-radius: 5px;
    background: color-mix(in srgb, var(--ink) 5%, transparent);
    border: 1px solid var(--rule);
    box-shadow: 0 1.5px 0 var(--rule);
    white-space: nowrap;
  }
  .prose del { color: var(--muted); }
  .prose mark { background: color-mix(in srgb, gold 55%, transparent); color: inherit; padding: 0 0.15em; border-radius: 2px; }

  /* GFM task lists: drop the bullet, line the checkbox up with the text. */
  .prose li:has(> input[type="checkbox"]) { list-style: none; margin-left: -1.4em; }
  .prose li > input[type="checkbox"] {
    appearance: none; -webkit-appearance: none;
    width: 1.05em; height: 1.05em; margin: 0 0.55em -0.16em 0;
    border: 1.5px solid var(--muted); border-radius: 4px;
    vertical-align: baseline; position: relative; flex: 0 0 auto;
  }
  .prose li > input[type="checkbox"]:checked {
    background: var(--accent); border-color: var(--accent);
  }
  .prose li > input[type="checkbox"]:checked::after {
    content: ""; position: absolute; left: 0.32em; top: 0.12em;
    width: 0.28em; height: 0.55em; border: solid #fff;
    border-width: 0 2px 2px 0; transform: rotate(45deg);
  }

  /* Section breaks — the Markdown marker picks the style (see renderMarkdown):
     ---  diamond rule   ***  asterism   ___  plain hairline. */
  .prose hr { border: none; margin: 3.2rem 0; height: 1px; overflow: visible; position: relative; background: none; }
  .prose hr.rule-dash {
    background: linear-gradient(to right, transparent, var(--rule) 25%, var(--rule) 75%, transparent);
  }
  .prose hr.rule-dash::after {
    content: ""; position: absolute; left: 50%; top: 50%;
    width: 6px; height: 6px; background: var(--bg);
    border: 1px solid var(--muted); border-radius: 1px;
    transform: translate(-50%, -50%) rotate(45deg);
  }
  .prose hr.rule-star { height: 0; margin: 2.8rem 0; }
  .prose hr.rule-star::after {
    content: ""; position: absolute; left: 50%; top: 0;
    width: 4px; height: 4px; border-radius: 50%; background: var(--muted);
    transform: translate(-50%, -50%);
    box-shadow: -8px 6px 0 var(--muted), 8px 6px 0 var(--muted);
  }
  .prose hr.rule-line { background: var(--rule); }

  .prose table { border-collapse: collapse; width: 100%; margin: 1.8rem 0; font-size: 0.98rem; display: block; overflow-x: auto; }
  .prose th, .prose td { border: 1px solid var(--rule); padding: 0.5rem 0.8rem; text-align: left; }
  .prose th[align="center"], .prose td[align="center"] { text-align: center; }
  .prose th[align="right"], .prose td[align="right"] { text-align: right; }
  .prose th { background: color-mix(in srgb, var(--ink) 4%, transparent); font-family: var(--sans); font-weight: 600; white-space: nowrap; }
  .prose tbody tr:nth-child(even) td { background: color-mix(in srgb, var(--ink) 2%, transparent); }

  /* Drop cap on the opening paragraph — a Medium signature. */
  .prose.lead-dropcap > p:first-of-type::first-letter {
    float: left;
    font-weight: 700;
    font-size: 2.8em;
    line-height: 0.8;
    padding: 0.08em 0.1em 0 0;
    color: var(--accent);
  }

  .backlink {
    display: inline-block; margin-top: 3.5rem;
    font-family: var(--sans); font-size: 0.95rem; color: var(--muted); text-decoration: none;
  }
  .backlink:hover { color: var(--accent); }

  footer.site-footer {
    max-width: var(--measure); margin: 5rem auto 0; padding: 1.75rem 1.4rem 2rem;
    border-top: 1px solid var(--rule); font-family: var(--sans); font-size: .85rem; color: var(--muted);
    display: grid; gap: .9rem;
  }
  footer.site-footer.homepage-footer { max-width: 82.5rem; }
  .site-footer-row { display:flex; align-items:center; justify-content:space-between; gap:1rem; flex-wrap:wrap; }
  .site-footer-brand { color:var(--ink); font-weight:600; }
  .site-footer-links { display:flex; gap:.9rem; flex-wrap:wrap; }
  .site-footer a { color:inherit; text-decoration:none; }
  .site-footer a:hover, .site-footer a:focus-visible { color:var(--accent); text-decoration:underline; }
  @media (max-width: 640px) { .site-footer-row { align-items:flex-start; flex-direction:column; } .site-footer-links a, .site-footer button { padding:.55rem .2rem; } }

  a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 2px; }

  /* Subscribe box (home + end of posts). */
  .subscribe {
    border: 1px solid var(--rule); border-radius: 10px;
    padding: 1.6rem 1.8rem; margin: 3.5rem 0 1rem;
    background: color-mix(in srgb, var(--ink) 2.5%, transparent);
  }
  .subscribe h3 { font-family: var(--sans); font-size: 1.3rem; font-weight: 700; letter-spacing: -0.01em; margin: 0 0 0.3rem; }
  .subscribe .sub-sub { font-family: var(--sans); font-size: 0.98rem; color: var(--muted); margin: 0 0 1rem; }
  .subscribe form { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 0; }
  .subscribe input {
    flex: 1 1 15rem; font-family: var(--sans); font-size: 1rem;
    padding: 0.62rem 0.75rem; border: 1px solid var(--rule); border-radius: 6px;
    background: var(--bg); color: var(--ink);
  }
  .subscribe button {
    font-family: var(--sans); font-size: 1rem; font-weight: 600;
    padding: 0.62rem 1.2rem; border: none; border-radius: 6px;
    background: var(--accent); color: #fff; cursor: pointer;
  }
  .subscribe button:hover { filter: brightness(1.05); }
  .subscribe .sub-msg { font-family: var(--sans); font-size: 0.92rem; color: var(--accent); margin-top: 0.7rem; min-height: 1.1rem; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  @media (max-width: 640px) {
    body { font-size: 1.2rem; }
    article h1 { font-size: 2.1rem; }
    .feed-title { font-size: 1.45rem; }
    .feed a.has-thumb { grid-template-columns: minmax(0, 1fr) 7rem; gap: 1rem; }
    .byline { gap: 0.5rem; }
    .byline-identity { gap: 0.55rem; }
    .post-audio { width: 10rem; flex-basis: 10rem; }
    .post-featured-row { grid-template-columns: 1fr; gap: .8rem; }
    .post-featured-row > aside { order: 2; }
    .post-featured-row .share-rail { flex-direction: row; justify-content: flex-start; order: 2; }
    .share-inline { display: block; margin: 0 0 1.4rem; }
    .share-inline .share-rail { flex-direction: row; justify-content: flex-start; }
  }
`;

function shell(opts: {
  tenant: Tenant;
  pageTitle: string;
  description: string;
  canonical: string;
  body: string;
  showMasthead?: boolean;
  wide?: boolean;
  showRss?: boolean;
  ownerEdit?: { href: string; dataAttr: string; label: string };
  image?: string;
  imageAlt?: string;
  ogType?: "website" | "article";
  publishedAt?: number;
  modifiedAt?: number;
  analyticsConsentRequired?: boolean;
}): string {
  const { tenant, pageTitle, description, canonical, body, showMasthead = true, wide = false, showRss = false, ownerEdit, image, imageAlt, ogType = "website", publishedAt, modifiedAt, analyticsConsentRequired = true } = opts;
  const ownerEditControl = ownerEdit ? `<a class="owner-edit" data-${ownerEdit.dataAttr} hidden href="${esc(ownerEdit.href)}" aria-label="${esc(ownerEdit.label)}" title="${esc(ownerEdit.label)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ownerEdit.dataAttr === "blog-edit" ? "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" : "m14.7 6.3 3 3M4 20l4.2-1 9.9-9.9a2.1 2.1 0 0 0-3-3L5.2 16 4 20Z"}"/><path d="${ownerEdit.dataAttr === "blog-edit" ? "m19.4 15 .1.1a1.8 1.8 0 0 1-2.5 2.5l-.1-.1a1.8 1.8 0 0 0-3.1 1.3v.2a1.8 1.8 0 0 1-3.6 0v-.2a1.8 1.8 0 0 0-3.1-1.3l-.1.1a1.8 1.8 0 1 1-2.5-2.5l.1-.1A1.8 1.8 0 0 0 5.3 12a1.8 1.8 0 0 0-1.3-3.1h-.2a1.8 1.8 0 0 1 0-3.6H4a1.8 1.8 0 0 0 1.3-3.1l-.1-.1a1.8 1.8 0 1 1 2.5-2.5l.1.1A1.8 1.8 0 0 0 10.9 1.3v-.2a1.8 1.8 0 0 1 3.6 0v.2a1.8 1.8 0 0 0 3.1 1.3l-.1-.1a1.8 1.8 0 1 1 2.5 2.5l-.1.1A1.8 1.8 0 0 0 19.4 8h.2a1.8 1.8 0 0 1 0 3.6h-.2a1.8 1.8 0 0 0 0 3.4Z" : "m13.5 7.5 3 3"}"/></svg><span class="sr-only">${esc(ownerEdit.label)}</span></a>` : "";
  const canonicalTag = canonical ? `<link rel="canonical" href="${esc(canonical)}">` : "";
  const imageTags = image ? `
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:alt" content="${esc(imageAlt || pageTitle)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${esc(image)}">` : `<meta name="twitter:card" content="summary">`;
  const articleTags = ogType === "article" ? `
<meta property="article:published_time" content="${new Date((publishedAt || 0) * 1000).toISOString()}">
${modifiedAt ? `<meta property="article:modified_time" content="${new Date(modifiedAt * 1000).toISOString()}">` : ""}` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(description)}">
${canonicalTag}
<meta name="theme-color" content="${normalizeAccentColor(tenant.accent_color)}">
<meta property="og:site_name" content="${esc(tenant.title)}">
<meta property="og:title" content="${esc(pageTitle)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="${ogType}">
${canonical ? `<meta property="og:url" content="${esc(canonical)}">` : ""}${imageTags}${articleTags}
<meta name="twitter:title" content="${esc(pageTitle)}">
<meta name="twitter:description" content="${esc(description)}">
<link rel="alternate" type="application/xml" title="Sitemap" href="/sitemap.xml">
<link rel="alternate" type="application/rss+xml" title="${esc(tenant.title)} RSS feed" href="/rss.xml">
<link rel="icon" href="/favicon.svg">
<script>(function(){try{var saved=localStorage.getItem("blognice-theme");var theme=saved==="light"||saved==="dark"?saved:(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.dataset.theme=theme}catch(e){}})();</script>
<style>${STYLES}</style>
<style>:root { --accent: ${normalizeAccentColor(tenant.accent_color)}; --accent-ink: ${accentTextColor(normalizeAccentColor(tenant.accent_color))}; } @media (prefers-color-scheme: dark) { :root { --accent: ${normalizeAccentColor(tenant.accent_color)}; } }</style>
</head>
<body>
  <div class="wrap${wide ? " homepage-wrap" : ""}">
  <div class="site-controls">${ownerEditControl}${showRss ? `<div class="rss-global"><a href="/rss.xml" aria-label="RSS feed" title="RSS feed"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 18.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM4 10v3a7 7 0 0 1 7 7h3A10 10 0 0 0 4 10Zm0-6v3c8.3 0 15 6.7 15 15h3C22 12.2 13.8 4 4 4Z"/></svg><span class="sr-only">RSS feed</span></a></div><a class="subscribe-link" href="#subscribe" aria-label="Subscribe" title="Subscribe"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></svg><span class="sr-only">Subscribe</span></a>` : ""}<button class="theme-toggle" id="theme-toggle" type="button" aria-label="Use dark theme" aria-pressed="false" title="Use dark theme"><span class="sun" aria-hidden="true">☀</span><span class="moon" aria-hidden="true">☾</span></button></div>
  <button class="to-top" id="to-top" type="button" aria-label="Back to top" title="Back to top">↑</button>
  ${showMasthead ? `<header class="masthead">
    <a href="/">
      <p class="site-title">${esc(tenant.title)}</p>
      ${tenant.description ? `<p class="site-desc">${esc(tenant.description)}</p>` : ""}
    </a>
  </header>` : ""}
  ${body}
</div>
<footer class="site-footer${wide ? " homepage-footer" : ""}">
  <div class="site-footer-row"><span class="site-footer-brand">${esc(tenant.footer_name?.trim() || tenant.title)} <span style="font-weight:400;color:var(--muted)">· powered by <a href="https://www.blognice.com" target="_blank" rel="noopener noreferrer">blognice</a></span></span><nav class="site-footer-links" aria-label="Legal"><a href="https://www.blognice.com/policies">Policies</a></nav></div>
  <div class="site-footer-row"><span>© 2026 Pragmatic Online Co., Ltd.</span></div>
</footer>
<style>#blognice-consent{position:fixed;z-index:100;left:1rem;right:1rem;bottom:1rem;max-width:760px;margin:auto;padding:.85rem 1rem;border:1px solid var(--rule);border-radius:10px;background:var(--bg);box-shadow:0 8px 28px #0002;display:flex;align-items:center;gap:.65rem;flex-wrap:wrap;font:14px/1.45 system-ui,sans-serif}#blognice-consent[hidden]{display:none}#blognice-consent span{flex:1 1 100%;color:var(--soft)}#blognice-consent button,#blognice-consent a{font:inherit;padding:.45rem .7rem;border:1px solid var(--rule);border-radius:6px;background:var(--bg);color:var(--ink);cursor:pointer}#blognice-consent button:focus-visible,#blognice-consent a:focus-visible{color:var(--accent);text-decoration:underline;outline:2px solid var(--accent);outline-offset:2px}</style>
${metricsBeacon(analyticsConsentRequired)}
<script>(function(){var button=document.getElementById("theme-toggle");if(button){function update(){var dark=document.documentElement.dataset.theme==="dark";button.setAttribute("aria-label",dark?"Use light theme":"Use dark theme");button.setAttribute("title",dark?"Use light theme":"Use dark theme");button.setAttribute("aria-pressed",dark?"true":"false")}update();button.addEventListener("click",function(){var dark=document.documentElement.dataset.theme!=="dark";document.documentElement.dataset.theme=dark?"dark":"light";try{localStorage.setItem("blognice-theme",dark?"dark":"light")}catch(e){}update()})}var top=document.getElementById("to-top");if(!top)return;function reveal(){var max=document.documentElement.scrollHeight-window.innerHeight;top.classList.toggle("visible",max>0&&window.scrollY/max>.35)}window.addEventListener("scroll",reveal,{passive:true});reveal();top.addEventListener("click",function(){window.scrollTo({top:0,behavior:"smooth"})})})();</script>
</body>
</html>`;
}

export function renderHome(
  tenant: Tenant,
  posts: Post[],
  origin: string,
  analyticsConsentRequired = true,
  rankedPopularPosts: Post[] = [],
  navigationPages: Array<{ slug: string; label: string }> = []
): string {
  const topics = tenantTopics(tenant);
  const art = (post: Post, index: number, rank?: number) =>
    post.featured_image_key
      ? `<img src="/media/${esc(post.featured_image_key)}" alt="" loading="lazy">`
      : rank
        ? `<span class="rank">${rank}</span>`
        : "";
  const header = (avatar: string) => `<div class="blog-owner-actions"><a class="owner-edit" data-blog-edit hidden href="${esc(origin)}/admin/b/${esc(tenant.public_id)}/settings" aria-label="Open blog settings" title="Open blog settings"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"/><path d="m19.4 15 .1.1a1.8 1.8 0 0 1-2.5 2.5l-.1-.1a1.8 1.8 0 0 0-3.1 1.3v.2a1.8 1.8 0 0 1-3.6 0v-.2a1.8 1.8 0 0 0-3.1-1.3l-.1.1a1.8 1.8 0 1 1-2.5-2.5l.1-.1A1.8 1.8 0 0 0 5.3 12a1.8 1.8 0 0 0-1.3-3.1h-.2a1.8 1.8 0 0 1 0-3.6H4a1.8 1.8 0 0 0 1.3-3.1l-.1-.1a1.8 1.8 0 1 1 2.5-2.5l.1.1A1.8 1.8 0 0 0 10.9 1.3v-.2a1.8 1.8 0 0 1 3.6 0v.2a1.8 1.8 0 0 0 3.1 1.3l.1-.1a1.8 1.8 0 1 1 2.5 2.5l-.1.1A1.8 1.8 0 0 0 19.4 8h.2a1.8 1.8 0 0 1 0 3.6h-.2a1.8 1.8 0 0 0 0 3.4Z"/></svg><span class="sr-only">Open blog settings</span></a></div><nav class="blog-nav"><div class="blog-header-id"><a href="/"><div>${avatar}</div><div class="blog-header-text"><div class="site-title">${esc(tenant.title)}</div>${tenant.description ? `<div class="blog-tagline">${esc(tenant.description)}</div>` : ""}</div></a></div><a class="subscribe-link" href="#subscribe">Subscribe</a></nav>`;
  const ownerScript = `<script>(function(){var link=document.querySelector("[data-blog-edit]");if(!link)return;fetch("/_blognice/blog-edit-link?tenant=${encodeURIComponent(tenant.public_id)}",{credentials:"include",headers:{accept:"application/json"}}).then(function(r){if(!r.ok)throw new Error();return r.json()}).then(function(d){if(d.url){link.href=d.url;link.hidden=false}}).catch(function(){if(location.origin!==${JSON.stringify(origin)})fetch(${JSON.stringify(origin)}+"/_blognice/blog-edit-link?tenant=${encodeURIComponent(tenant.public_id)}",{credentials:"include"}).then(function(r){return r.ok?r.json():null}).then(function(d){if(d&&d.url){link.href=d.url;link.hidden=false}}).catch(function(){})});})();</script>`;
  const withNavigation = (markup: string) => navigationPages.length
    ? markup.replace('</nav>', `</nav><div class="blog-nav-links" aria-label="Page navigation"><a href="/" aria-current="page">Home</a>${navigationPages.map((page) => `<a href="/pages/${esc(page.slug)}">${esc(page.label)}</a>`).join("")}</div>`)
    : markup;
  if (!posts.length) {
    return shell({
      tenant, pageTitle: tenant.title, description: tenant.description || tenant.title, analyticsConsentRequired,
      canonical: origin + "/", ownerEdit: { href: `${origin}/admin/b/${tenant.public_id}/settings`, dataAttr: "blog-edit", label: "Open blog settings" }, body: `${withNavigation(header(`<div class="blog-avatar">${monogram(tenant.title)}</div>`))}${topics.length ? `<div class="blog-topics" aria-label="Blog topics">${topics.map((topic) => `<span>#${esc(topic)}</span>`).join("")}</div>` : ""}<section class="blog-section"><p class="feed-meta">No posts yet.</p></section><div id="subscribe" class="blog-subscribe-wrap">${subscribeBox(tenant)}</div>${ownerScript}`,
    });
  }
  const featured = posts[0];
  const more = posts.slice(1, 7);
  // Do not label recent posts as popular. Until the materialized metrics have
  // enough evidence for three posts, omit this section entirely.
  const popular = rankedPopularPosts.length >= 3 ? rankedPopularPosts.slice(0, 3) : [];
  const avatar = tenant.avatar_key
    ? `<img class="blog-avatar" src="/media/${esc(tenant.avatar_key)}" alt="">`
    : `<div class="blog-avatar">${monogram(tenant.title)}</div>`;
  const card = (p: Post, index: number) => `<article class="blog-card"><a class="blog-art" href="/${esc(p.slug)}">${art(p, index)}</a><h3><a href="/${esc(p.slug)}">${esc(p.title)}</a></h3><p class="blog-excerpt">${esc(excerpt(p.body_md, 125))}</p><div class="blog-meta">${formatDate(p.created_at)} · ${readingTime(p.body_md)} min read</div></article>`;
  const popularCard = (p: Post, index: number) => `<article class="blog-popular-card"><a class="blog-art" href="/${esc(p.slug)}">${art(p, index)}</a><h3><a href="/${esc(p.slug)}">${esc(p.title)}</a></h3><div class="blog-meta">${readingTime(p.body_md)} min read</div></article>`;
  const body = `${withNavigation(header(avatar))}
    ${topics.length ? `<div class="blog-topics" aria-label="Blog topics">${topics.map((topic) => `<span>#${esc(topic)}</span>`).join("")}</div>` : ""}
    <section class="blog-section"><div class="blog-kicker">Featured post</div><article class="blog-featured"><a class="blog-art" href="/${esc(featured.slug)}">${art(featured, 0)}</a><div><h2><a href="/${esc(featured.slug)}">${esc(featured.title)}</a></h2><p class="blog-excerpt">${esc(excerpt(featured.body_md))}</p><div class="blog-meta">${formatDate(featured.created_at)} · ${readingTime(featured.body_md)} min read</div></div></article></section>
    ${more.length ? `<section class="blog-section" style="padding-top:0"><div class="blog-grid-head"><h2>More posts</h2></div><div class="blog-cards">${more.map(card).join("")}</div></section>` : ""}
    ${popular.length ? `<section class="blog-popular-section blog-section"><div class="blog-grid-head"><h2>Popular posts</h2></div><div class="blog-popular-cards">${popular.map(popularCard).join("")}</div></section>` : ""}
    <div id="subscribe" class="blog-subscribe-wrap">${subscribeBox(tenant)}</div>`;

  return shell({
    tenant,
    pageTitle: tenant.title,
    description: tenant.description || tenant.title,
    canonical: origin + "/",
    ownerEdit: { href: `${origin}/admin/b/${tenant.public_id}/settings`, dataAttr: "blog-edit", label: "Open blog settings" },
    body: body + ownerScript,
    showMasthead: false,
    wide: true,
    showRss: true,
    image: featured.featured_image_key ? `${origin}/media/${featured.featured_image_key}` : (tenant.avatar_key ? `${origin}/media/${tenant.avatar_key}` : undefined),
    imageAlt: featured.featured_image_key ? featured.title : tenant.title,
  });
}

export function renderTagPage(
  tenant: Tenant,
  tag: string,
  posts: Post[],
  origin: string,
  analyticsConsentRequired = true
): string {
  const avatar = tenant.avatar_key
    ? `<img class="blog-avatar" src="/media/${esc(tenant.avatar_key)}" alt="">`
    : `<div class="blog-avatar">${monogram(tenant.title)}</div>`;
  const header = `<nav class="blog-nav"><div class="blog-header-id"><a href="/"><div>${avatar}</div><div class="blog-header-text"><div class="site-title">${esc(tenant.title)}</div>${tenant.description ? `<div class="blog-tagline">${esc(tenant.description)}</div>` : ""}</div></a></div><a class="subscribe-link" href="#subscribe">Subscribe</a></nav>`;
  const cards = posts.map((post) => `<article class="blog-card"><a class="blog-art" href="/${esc(post.slug)}">${post.featured_image_key ? `<img src="/media/${esc(post.featured_image_key)}" alt="" loading="lazy">` : ""}</a><h3><a href="/${esc(post.slug)}">${esc(post.title)}</a></h3><p class="blog-excerpt">${esc(excerpt(post.body_md, 125))}</p><div class="blog-meta">${formatDate(post.created_at)} · ${readingTime(post.body_md)} min read</div></article>`).join("");
  const body = `${header}<section class="blog-section tag-page"><div class="blog-kicker">Posts tagged</div><h1 class="tag-page-title">#${esc(tag)}</h1>${posts.length ? `<div class="blog-cards">${cards}</div>` : `<p class="feed-meta">No published posts use this tag yet.</p>`}</section><div id="subscribe" class="blog-subscribe-wrap">${subscribeBox(tenant)}</div>`;
  return shell({
    tenant,
    pageTitle: `#${tag} — ${tenant.title}`,
    description: `Posts tagged ${tag} on ${tenant.title}`,
    canonical: `${origin}/tag/${encodeURIComponent(tag)}`,
    showMasthead: false,
    wide: true,
    showRss: true,
    ownerEdit: { href: `${origin}/admin/b/${tenant.public_id}/settings`, dataAttr: "blog-edit", label: "Open blog settings" },
    analyticsConsentRequired,
    body,
  });
}

export function renderPage(
  tenant: Tenant,
  page: Page,
  htmlBody: string,
  origin: string,
  analyticsConsentRequired = true,
  isOwner = false,
  navigationPages: Array<{ slug: string; label: string }> = []
): string {
  const description = page.meta_description?.trim() || excerpt(page.body_md, 180) || page.title;
  const canonical = `${origin}/pages/${encodeURIComponent(page.slug)}`;
  const edit = isOwner
    ? { href: `${origin}/admin/b/${tenant.public_id}/pages/edit/${page.id}`, dataAttr: "page-edit", label: "Edit page" }
    : undefined;
  const avatar = tenant.avatar_key
    ? `<img class="blog-avatar" src="/media/${esc(tenant.avatar_key)}" alt="">`
    : `<div class="blog-avatar">${monogram(tenant.title)}</div>`;
  const owner = isOwner ? `<div class="blog-owner-actions"><a class="owner-edit" data-page-edit hidden href="${esc(origin)}/admin/b/${esc(tenant.public_id)}/pages/edit/${page.id}" aria-label="Edit page" title="Edit page"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.7 6.3 3 3M4 20l4.2-1 9.9-9.9a2.1 2.1 0 0 0-3-3L5.2 16 4 20Z"/></svg><span class="sr-only">Edit page</span></a></div>` : "";
  const pageLinks = `<div class="blog-nav-links" aria-label="Page navigation"><a href="/">Home</a>${navigationPages.map((item) => `<a href="/pages/${esc(item.slug)}"${item.slug === page.slug ? ` aria-current="page"` : ""}>${esc(item.label)}</a>`).join("")}</div>`;
  const header = `${owner}<nav class="blog-nav"><div class="blog-header-id"><a href="/"><div>${avatar}</div><div class="blog-header-text"><div class="site-title">${esc(tenant.title)}</div>${tenant.description ? `<div class="blog-tagline">${esc(tenant.description)}</div>` : ""}</div></a></div><a class="subscribe-link" href="/#subscribe">Subscribe</a></nav>${pageLinks}`;
  return shell({
    tenant,
    pageTitle: `${page.title} — ${tenant.title}`,
    description,
    canonical,
    analyticsConsentRequired,
    ownerEdit: edit,
    wide: true,
    showMasthead: false,
    showRss: true,
    body: `${header}<main class="page-content"><div class="page-content-inner"><h1>${esc(page.title)}</h1><div class="page-prose">${htmlBody}</div></div></main>`,
  });
}

export function renderPost(
  tenant: Tenant,
  post: Post,
  htmlBody: string,
  origin: string,
  adminOrigin: string,
  analyticsConsentRequired = true
): string {
  const shareUrl = `${origin}/${post.slug}`;
  const shareTitle = post.title;
  const tags = postTags(post);
  const shareRail = `<div class="share-rail" aria-label="Share this post">
    <button class="share-button share-copy" type="button" data-share-copy="${esc(shareUrl)}" data-tooltip="Copy link" aria-label="Copy link"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 9h9v9H9z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" fill="none" stroke="currentColor" stroke-width="2"/></svg></button>
    <a class="share-button share-whatsapp" href="https://wa.me/?text=${encodeURIComponent(`${shareTitle} ${shareUrl}`)}" target="_blank" rel="noopener noreferrer" data-tooltip="WhatsApp" aria-label="Share on WhatsApp"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a9.5 9.5 0 0 0-8.2 14.3L2.5 21.5l5.3-1.3A9.5 9.5 0 1 0 12 2Zm0 17a7.4 7.4 0 0 1-3.8-1l-.3-.2-3.1.8.8-3-.2-.3A7.4 7.4 0 1 1 12 19Zm4.1-5.4c-.2-.1-1.2-.6-1.4-.7-.2-.1-.3-.1-.5.1l-.6.8c-.2.2-.3.2-.5.1a6 6 0 0 1-1.8-1.1 6.7 6.7 0 0 1-1.2-1.5c-.1-.2 0-.3.1-.4l.4-.5c.1-.1.1-.2.2-.4v-.3c0-.1-.5-1.2-.7-1.6-.2-.4-.4-.3-.5-.3h-.4c-.1 0-.4.1-.6.3-.2.2-.8.8-.8 2s.8 2.3 1 2.6c.1.2 1.6 2.5 3.9 3.5 2.3 1 2.3.7 2.7.7.4 0 1.2-.5 1.4-1 .2-.5.2-.9.1-1-.1-.1-.2-.1-.4-.2Z"/></svg></a>
    <a class="share-button share-telegram" href="https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(shareTitle)}" target="_blank" rel="noopener noreferrer" data-tooltip="Telegram" aria-label="Share on Telegram"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.5 3.5-3.2 16.1c-.2 1.1-.8 1.4-1.6.9l-4.5-3.3-2.2 2.1c-.2.2-.4.4-.8.4l.3-4.6 8.4-7.6c.4-.4-.1-.6-.6-.2L7 13.9l-4.4-1.4c-1-.3-1-1 .2-1.5L20.1 3c.9-.3 1.7.2 1.4.5Z"/></svg></a>
    <a class="share-button share-email" href="mailto:?subject=${encodeURIComponent(shareTitle)}&body=${encodeURIComponent(shareUrl)}" data-tooltip="Email" aria-label="Share by email"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18v14H3z" fill="none" stroke="currentColor" stroke-width="2"/><path d="m4 7 8 6 8-6" fill="none" stroke="currentColor" stroke-width="2"/></svg></a>
    <a class="share-button share-x" href="https://twitter.com/intent/tweet?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(shareTitle)}" target="_blank" rel="noopener noreferrer" data-tooltip="X" aria-label="Share on X">𝕏</a>
    <a class="share-button share-facebook" href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}" target="_blank" rel="noopener noreferrer" data-tooltip="Facebook" aria-label="Share on Facebook">f</a>
    <a class="share-button share-linkedin" href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}" target="_blank" rel="noopener noreferrer" data-tooltip="LinkedIn" aria-label="Share on LinkedIn">in</a>
    <a class="share-button share-reddit" href="https://www.reddit.com/submit?url=${encodeURIComponent(shareUrl)}&title=${encodeURIComponent(shareTitle)}" target="_blank" rel="noopener noreferrer" data-tooltip="Reddit" aria-label="Share on Reddit"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5.2c-3.8 0-6.9 2.3-6.9 5.2s3.1 5.2 6.9 5.2 6.9-2.3 6.9-5.2-3.1-5.2-6.9-5.2Zm-3.1 5.1a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm6.2 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2ZM9.2 14c.8.7 1.7 1 2.8 1s2-.3 2.8-1l.7.7c-.9.9-2.1 1.4-3.5 1.4s-2.6-.5-3.5-1.4l.7-.7Z"/><path d="m14.1 5.5.8-2.6 2.3.5a1.5 1.5 0 1 0 .2-1l-3-.7a.5.5 0 0 0-.6.4l-1 3.3 1.3.1Z"/></svg></a>
  </div>`;
  const shareScript = `<script>(function(){var buttons=document.querySelectorAll("[data-share-copy]");buttons.forEach(function(button){button.addEventListener("click",function(){var value=button.getAttribute("data-share-copy")||location.href;var done=function(){button.classList.add("is-copied");button.textContent="✓";setTimeout(function(){button.classList.remove("is-copied");button.textContent="↗"},1400)};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(value).then(done).catch(function(){})}else{var input=document.createElement("input");input.value=value;document.body.appendChild(input);input.select();try{document.execCommand("copy");done()}catch(e){}input.remove()}})})})();</script>`;
  const featuredBlock = post.featured_image_key
    ? `<div class="post-featured-row"><aside>${shareRail}</aside><div><img class="featured-image" src="/media/${esc(post.featured_image_key)}" alt=""></div></div>`
    : `<div class="share-inline">${shareRail}</div>`;
  const proseClass = openingParagraphHasDropCap(htmlBody) ? "prose lead-dropcap" : "prose";
  const article = `<article class="post-page">
    <div class="post-owner-actions"><a class="owner-edit" data-owner-edit hidden href="${esc(adminOrigin)}/admin/b/${esc(tenant.public_id)}/edit/${post.id}" aria-label="Edit post" title="Edit post"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.7 6.3 3 3M4 20l4.2-1 9.9-9.9a2.1 2.1 0 0 0-3-3L5.2 16 4 20Z"/><path d="m13.5 7.5 3 3"/></svg><span class="sr-only">Edit post</span></a></div>
    <h1>${esc(post.title)}</h1>
    <div class="byline">
      <a class="byline-identity" href="/">
        ${
          tenant.avatar_key
            ? `<img class="avatar" src="/media/${esc(tenant.avatar_key)}" alt="">`
            : `<span class="avatar">${monogram(tenant.title)}</span>`
        }
        <div>
          <div class="byline-name">${post.author_visible === 0 ? esc(tenant.title) : `Author: ${esc(post.author_name && !post.author_name.includes("@") ? post.author_name : tenant.title)}`}</div>
          <div class="byline-meta">${post.author_visible !== 0 && post.author_name && !post.author_name.includes("@") && post.author_name !== tenant.title ? `For ${esc(tenant.title)} · ` : ""}${formatDate(post.created_at)} · ${readingTime(post.body_md)} min read</div>
        </div>
      </a>
      ${post.audio_key ? `<audio class="post-audio" data-narration controls preload="none" aria-label="Listen to this article" src="/media/${esc(post.audio_key)}">Your browser does not support audio playback.</audio>` : ""}
    </div>
    ${featuredBlock}
    ${tags.length ? `<div class="post-tags" aria-label="Post tags">${tags.map((tag) => `<a href="/tag/${encodeURIComponent(tag)}">#${esc(tag)}</a>`).join("")}</div>` : ""}
    <div class="${proseClass}">${htmlBody}</div>
    ${subscribeBox(tenant)}
    <a class="backlink" href="/">&larr; All posts</a>
  </article>`;

  return shell({
    tenant,
    pageTitle: `${post.title} — ${tenant.title}`,
    description: excerpt(post.body_md, 155) || tenant.description,
    canonical: `${origin}/${post.slug}`,
    ownerEdit: { href: `${adminOrigin}/admin/b/${tenant.public_id}/edit/${post.id}`, dataAttr: "owner-edit", label: "Edit post" },
    ogType: "article",
    analyticsConsentRequired,
    image: post.featured_image_key ? `${origin}/media/${post.featured_image_key}` : (tenant.avatar_key ? `${origin}/media/${tenant.avatar_key}` : undefined),
    imageAlt: post.featured_image_key ? post.title : tenant.title,
    publishedAt: post.created_at,
    modifiedAt: post.updated_at,
    body: article + shareScript + `<script>(function(){var link=document.querySelector("[data-owner-edit]");if(!link)return;var path="/_blognice/edit-link?tenant=${encodeURIComponent(tenant.public_id)}&post=${post.id}";function check(url){return fetch(url,{credentials:"include",headers:{accept:"application/json"}}).then(function(response){if(!response.ok)throw new Error();return response.json()}).then(function(data){if(data.url){link.href=data.url;link.hidden=false;return true}})}check(path).catch(function(){if(location.origin!==${JSON.stringify(adminOrigin)})check(${JSON.stringify(adminOrigin)}+path).catch(function(){})})})();</script>` + (post.audio_key ? `<script>(function(){var audio=document.querySelector("audio[data-narration]");if(!audio)return;audio.preservesPitch=true;audio.defaultPlaybackRate=.88;audio.playbackRate=.88;var started=false,completed=false;audio.addEventListener("play",function(){if(started)return;started=true;if(window.__blogniceEvent)window.__blogniceEvent("audio_start",location.pathname)});audio.addEventListener("ended",function(){if(completed)return;completed=true;if(window.__blogniceEvent)window.__blogniceEvent("audio_complete",location.pathname)});})();</script>` : ""),
    showMasthead: false,
  });
}

export function renderNotFound(tenant: Tenant | null): string {
  const title = tenant ? tenant.title : "blognice";
  const body = `<article>
    <h1>Not found</h1>
    <div class="prose"><p>That page doesn't exist.</p></div>
    ${tenant ? `<a class="backlink" href="/">&larr; All posts</a>` : ""}
  </article>`;
  if (!tenant) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>blognice</title><style>${STYLES}</style></head>
<body><div class="wrap"><article><h1>No blog here yet</h1>
<div class="prose"><p>This domain isn't connected to a blognice site.</p></div>
</article></div></body></html>`;
  }
  return shell({
    tenant,
    pageTitle: `Not found — ${title}`,
    description: "Page not found",
    canonical: "",
    body,
  });
}
