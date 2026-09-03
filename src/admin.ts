// Server-rendered admin UI. Utilitarian but styled to match the public theme.
import { accentTextColor, esc, formatDate, normalizeAccentColor, type Page, type Post, type Tenant } from "./render";
import { accountHasPaidPlan, type Account } from "./auth";
import type { AuditEntry, MetricsReport } from "./metrics";

const ACCENT_PRESETS = [
  ["blognice green", "#1a8917"],
  ["Ocean blue", "#2563eb"],
  ["Deep teal", "#0f766e"],
  ["Indigo", "#4f46e5"],
  ["Berry", "#9f1239"],
  ["Terracotta", "#c2412d"],
  ["Amber", "#b7791f"],
  ["Slate", "#475569"],
] as const;

function tenantTopics(tenant: Tenant): string[] {
  try {
    const value = JSON.parse(tenant.topics_json || "[]");
    return Array.isArray(value) ? value.filter((topic): topic is string => typeof topic === "string") : [];
  } catch {
    return [];
  }
}

const SOCIAL_LINK_FIELDS = [
  ["instagram", "Instagram", "https://instagram.com/yourname"],
  ["youtube", "YouTube channel", "https://youtube.com/@yourchannel"],
  ["x", "X (formerly Twitter)", "https://x.com/yourname"],
  ["facebook", "Facebook", "https://facebook.com/yourpage"],
  ["linkedin", "LinkedIn profile or company page", "https://linkedin.com/in/yourname"],
  ["tiktok", "TikTok", "https://tiktok.com/@yourname"],
  ["bluesky", "Bluesky", "https://bsky.app/profile/yourname"],
  ["mastodon", "Mastodon profile", "https://your-instance.example/@yourname"],
  ["telegram", "Telegram channel or group", "https://t.me/yourchannel"],
  ["bitchute", "BitChute", "https://bitchute.com/channel/yourchannel"],
] as const;

function tenantSocialLinks(tenant: Tenant): Record<string, string> {
  try {
    const value = JSON.parse(tenant.social_links_json || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([key, url]) =>
      SOCIAL_LINK_FIELDS.some(([field]) => field === key) && typeof url === "string"
    )) as Record<string, string>;
  } catch {
    return {};
  }
}

const ADMIN_STYLES = /* css */ `
  :root {
    --bg: #fdfdfc; --panel: #ffffff; --ink: #1a1a18; --muted: #6a6a66;
    --rule: #e4e3de; --accent: #146b54; --accent-ink: #ffffff;
    --danger: #a3352b; --field: #ffffff;
    --admin-measure: 76.25rem; --admin-gutter: 1.25rem;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #161614; --panel: #1e1e1b; --ink: #e9e8e3; --muted: #9a9a93;
      --rule: #302f2b; --accent: #6fc9a9; --accent-ink: #10241d;
      --danger: #e8897f; --field: #14140f;
    }
  }
  * { box-sizing: border-box; }
  /* Keep the content column fixed when one admin page needs a scrollbar and
     another does not. This prevents horizontal movement between sections. */
  html { overflow-y: scroll; scrollbar-gutter: stable; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font-family: var(--sans); font-size: 15px; line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent); }
  .topbar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.8rem 1.2rem; border-bottom: 1px solid var(--rule);
  }
  .globalbar { background: var(--bg); }
  .topbar .brand { font-weight: 600; }
  .topbar .right { display: flex; gap: 1.2rem; align-items: center; font-size: 0.9rem; }
  .topbar { position: relative; }
  .topbar-menu-open { display:none; width:2.1rem; height:2.1rem; padding:0; border:1px solid var(--rule); border-radius:7px; background:var(--field); color:var(--muted); align-items:center; justify-content:center; cursor:pointer; }
  .topbar-menu-open svg { width:1.15rem; height:1.15rem; }
  .topbar-menu { position:absolute; top:calc(100% + .5rem); right:1.2rem; z-index:25; width:min(16rem, calc(100vw - 2rem)); padding:.45rem; background:var(--panel); border:1px solid var(--rule); border-radius:8px; box-shadow:0 12px 30px rgb(0 0 0 / .14); }
  .topbar-menu[hidden] { display:none; }
  .topbar-menu a, .topbar-menu .linkbtn { display:block; width:100%; padding:.55rem; border-radius:5px; color:var(--ink); text-decoration:none; font-size:.9rem; text-align:left; }
  .topbar-menu a:hover, .topbar-menu .linkbtn:hover { background:color-mix(in srgb, var(--accent) 10%, transparent); color:var(--accent); }
  @media (max-width: 700px) { .topbar .right { display:none; } .topbar-menu-open { display:inline-flex; margin-left:auto; } }
  .plan-badge { display:inline-flex; align-items:center; gap:.35rem; padding:.2rem .55rem; border:1px solid var(--rule); border-radius:999px; color:var(--ink); text-decoration:none; font-size:.78rem; font-weight:600; }
  .plan-badge.free { color:var(--muted); }
  .plan-badge.paid { color:#fff; background:var(--accent); border-color:var(--accent); box-shadow:0 2px 7px color-mix(in srgb, var(--accent) 28%, transparent); }
  .topbar form { margin: 0; }
  .linkbtn {
    background: none; border: none; color: var(--muted); cursor: pointer;
    font: inherit; font-size: 0.9rem; padding: 0; text-decoration: underline;
  }
  .linkbtn:hover { color: var(--accent); }
  .contextbar { border-bottom: 1px solid var(--rule); background: var(--panel); }
  .context-inner { width: min(var(--admin-measure), calc(100% - 2 * var(--admin-gutter))); margin: 0 auto; padding: 0.65rem 0; display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .context-title { display: flex; align-items: center; min-width: 0; position: relative; }
  .context-label { color: var(--muted); font-size: .72rem; letter-spacing: .08em; text-transform: uppercase; }
  .context-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .blog-switcher { position: relative; }
  .blog-switcher-toggle { display:inline-flex; align-items:center; gap:.45rem; max-width:20rem; border:1px solid var(--rule); border-radius:7px; padding:.42rem .65rem; background:var(--field); color:var(--ink); font:inherit; font-weight:600; cursor:pointer; }
  .blog-switcher-toggle:hover { border-color:var(--accent); }
  .blog-switcher-toggle svg { width:1rem; height:1rem; flex:0 0 auto; }
  .blog-switcher-menu { position:absolute; z-index:20; top:calc(100% + .5rem); left:0; width:min(21rem, calc(100vw - 2rem)); padding:.45rem; background:var(--panel); border:1px solid var(--rule); border-radius:8px; box-shadow:0 12px 30px rgb(0 0 0 / .14); }
  .blog-switcher-menu[hidden] { display:none; }
  .blog-switcher-heading { color:var(--muted); font-size:.72rem; letter-spacing:.06em; text-transform:uppercase; padding:.45rem .55rem .3rem; }
  .blog-switcher-list { display:grid; gap:.15rem; }
  .blog-switcher-item, .blog-switcher-new { display:flex; align-items:center; gap:.5rem; padding:.55rem; border-radius:5px; color:var(--ink); text-decoration:none; font-size:.9rem; }
  .blog-switcher-item:hover, .blog-switcher-new:hover { background:color-mix(in srgb, var(--accent) 10%, transparent); }
  .blog-switcher-item.current { background:color-mix(in srgb, var(--accent) 13%, transparent); font-weight:600; }
  .blog-switcher-item small { margin-left:auto; color:var(--muted); font-size:.75rem; }
  .blog-switcher-new { border-top:1px solid var(--rule); margin-top:.35rem; color:var(--accent); }
  .context-links { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
  .context-links a { color: var(--muted); font-size: .88rem; text-decoration: none; }
  .context-links a:hover { color: var(--accent); }
  .breadcrumb { color: var(--muted); font-size: .8rem; margin: 0 0 .8rem; }
  .breadcrumb a { color: inherit; text-decoration: none; }
  .breadcrumb a:hover { color: var(--accent); }

  .page { width: min(var(--admin-measure), calc(100% - 2 * var(--admin-gutter))); max-width: none; margin: 0 auto; padding: 2rem 0 4rem; }
  .page.narrow { width: min(24rem, calc(100% - 2 * var(--admin-gutter))); }
  .page-nav-settings { min-width: 0; margin: 1.5rem 0; padding: 1rem 1.1rem; border: 1px solid var(--rule); border-radius: 8px; background: color-mix(in srgb, var(--panel) 94%, var(--accent) 6%); }
  .page-nav-settings h2 { margin: 0 0 .3rem; font-size: 1rem; }
  .page-nav-settings > p { margin: 0 0 .9rem; color: var(--muted); font-size: .88rem; }
  .page-nav-settings .check { margin: .65rem 0 1rem; }
  .page-nav-settings .nav-fields { display: grid; grid-template-columns: minmax(0, 1fr) 8rem; gap: 1rem; align-items: end; }
  .page-nav-settings .nav-fields label { margin: 0; }
  .page-nav-settings .nav-fields input, .page-nav-settings .nav-fields select { width: 100%; margin-top: .35rem; }
  @media (max-width: 560px) { .page-nav-settings .nav-fields { grid-template-columns: 1fr; gap: .75rem; } }
  h1 { font-size: 1.4rem; margin: 0 0 1.4rem; }

  .row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.4rem; }
  .btn {
    display: inline-block; background: var(--accent); color: var(--accent-ink);
    border: none; border-radius: 6px; padding: 0.5rem 0.9rem; font: inherit;
    font-weight: 500; cursor: pointer; text-decoration: none;
  }
  .btn:hover { filter: brightness(1.05); }
  .btn.ghost { background: none; color: var(--muted); border: 1px solid var(--rule); }
  .btn.danger { background: none; color: var(--danger); border: 1px solid var(--rule); }

  ul.posts { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--rule); }
  ul.posts li {
    display: flex; align-items: center; justify-content: space-between;
    gap: 1rem; padding: 0.85rem 0; border-bottom: 1px solid var(--rule);
  }
  ul.posts .t { font-weight: 500; }
  ul.posts .t a { color: inherit; text-decoration: none; }
  ul.posts .t a:hover { color: var(--accent); }
  ul.posts .sub { font-size: 0.82rem; color: var(--muted); margin-top: 0.15rem; }
  ul.posts .acts { display: flex; gap: 0.6rem; align-items: center; white-space: nowrap; }
  .icon-btn { width: 2.25rem; height: 2.25rem; display: inline-flex; align-items: center; justify-content: center; padding: 0; }
  .icon-btn svg { width: 1.05rem; height: 1.05rem; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .post-summary { display:flex; align-items:center; gap:.8rem; min-width:0; }
  .post-thumb { width:4.5rem; height:3.4rem; flex:0 0 auto; object-fit:cover; border-radius:4px; background:var(--rule); }
  .tag {
    font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em;
    padding: 0.1rem 0.4rem; border-radius: 4px; border: 1px solid var(--rule);
    color: var(--muted);
  }
  .tag.live { color: var(--accent); border-color: var(--accent); }

  label { display: block; font-size: 0.82rem; color: var(--muted); margin: 0 0 0.3rem; }
  input[type=text], input[type=email], input[type=password], textarea, select {
    width: 100%; background: var(--field); color: var(--ink);
    border: 1px solid var(--rule); border-radius: 6px; padding: 0.55rem 0.65rem;
    font: inherit; margin-bottom: 1rem;
  }
  textarea { font-family: var(--mono); font-size: 13.5px; line-height: 1.55; resize: vertical; }
  input:focus, textarea:focus, select:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent; }
  .settings-card { border: 1px solid var(--rule); border-radius: 8px; padding: 1rem; margin: 0 0 1.4rem; }
  .settings-card legend { padding: 0; font-weight: 650; }
  .settings-card .help { color: var(--muted); font-size: .85rem; margin: .25rem 0 .9rem; }
  .social-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 1rem; }
  .social-grid input { margin-bottom: .85rem; }
  .social-more { color: var(--muted); font-size: .86rem; font-weight: 650; margin: .35rem 0 .7rem; }
  @media (max-width: 720px) { .social-grid { grid-template-columns: 1fr; } }
  .check { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1.2rem; }
  .check input { width: auto; margin: 0; }
  .check label { margin: 0; color: var(--ink); }

  /* Editor: a full-width writing area with a Write / Preview toggle. */
  .tabs { display: flex; gap: 0.3rem; border-bottom: 1px solid var(--rule); margin-bottom: 0.9rem; }
  .tab {
    background: none; border: none; border-bottom: 2px solid transparent;
    color: var(--muted); font: inherit; font-size: 0.9rem; font-weight: 500;
    padding: 0.45rem 0.3rem; margin-bottom: -1px; cursor: pointer;
  }
  .tab:hover { color: var(--ink); }
  .tab.active { color: var(--ink); border-bottom-color: var(--accent); }
  .img-btn { color: var(--accent); border-bottom-color: transparent !important; font-weight: 500; }
  .img-btn:hover { color: var(--accent); filter: brightness(1.1); }
  .markdown-intro { color:var(--muted); font-size:.88rem; margin:.1rem 0 .65rem; }
  .markdown-tools { display:flex; flex-wrap:wrap; align-items:center; gap:.35rem; margin:0 0 .7rem; }
  .markdown-tool { min-width:2.75rem; min-height:2.75rem; padding:.4rem .65rem; border:1px solid var(--rule); border-radius:6px; background:var(--field); color:var(--ink); font:600 .85rem/1 var(--sans); cursor:pointer; }
  .markdown-tool:hover { border-color:var(--accent); color:var(--accent); }
  .markdown-tool.auto-format { color:var(--accent); border-color:color-mix(in srgb, var(--accent) 45%, var(--rule)); }
  .markdown-tool:focus-visible, .markdown-help summary:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .markdown-help { margin:0 0 .8rem; border:1px solid var(--rule); border-radius:7px; background:var(--panel); }
  .markdown-help summary { padding:.65rem .8rem; color:var(--accent); font-size:.86rem; font-weight:650; cursor:pointer; }
  .markdown-help-content { padding:0 .8rem .9rem; color:var(--muted); font-size:.84rem; }
  .markdown-help-section + .markdown-help-section { border-top:1px solid var(--rule); margin-top:.8rem; padding-top:.65rem; }
  .markdown-help-section h3 { color:var(--ink); font-size:.84rem; margin:0 0 .45rem; }
  .markdown-help-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.45rem 1rem; }
  .markdown-help-grid p { display:flex; align-items:baseline; gap:.45rem; min-width:0; margin:0; }
  .markdown-help-grid code { flex:0 1 auto; overflow-wrap:anywhere; }
  .markdown-help-note { margin:.8rem 0 0; }
  .markdown-help code { color:var(--ink); }
  @media (max-width: 560px) { .markdown-help-grid { grid-template-columns:1fr; } }
  .save-toast { position:fixed; right:1.25rem; bottom:1.25rem; z-index:40; max-width:min(22rem,calc(100vw - 2.5rem)); padding:.7rem 1rem; border:1px solid color-mix(in srgb,var(--accent) 40%,var(--rule)); border-radius:8px; background:var(--panel); color:var(--ink); box-shadow:0 8px 24px rgb(0 0 0 / .16); }
  .media-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 1rem; }
  .media-card { min-width: 0; background: var(--panel); border: 1px solid var(--rule); border-radius: 8px; overflow: hidden; }
  .media-card img { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: cover; background: var(--rule); }
  .media-card-body { padding: 0.65rem; }
  .media-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.82rem; }
  .media-meta { color: var(--muted); font-size: 0.75rem; margin: 0.15rem 0 0.55rem; }
  dialog.media-dialog { width: min(58rem, calc(100% - 2rem)); max-height: 85vh; color: var(--ink); background: var(--bg); border: 1px solid var(--rule); border-radius: 10px; padding: 0; }
  dialog.media-dialog::backdrop { background: rgb(0 0 0 / 0.55); }
  .media-dialog-head { display:flex; align-items:center; gap:0.7rem; padding:1rem; border-bottom:1px solid var(--rule); }
  .media-dialog-body { padding:1rem; overflow:auto; max-height:calc(85vh - 4rem); }
  .media-pick { cursor:pointer; text-align:left; color:var(--ink); padding:0; }
  .featured-picker { display:flex; align-items:center; gap:1rem; margin:0 0 1.2rem; }
  .featured-preview-button { display:block; border:0; padding:0; border-radius:6px; background:var(--rule); cursor:zoom-in; overflow:hidden; }
  .featured-preview-button:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
  .featured-preview { display:block; width:10rem; aspect-ratio:4/3; object-fit:cover; }
  dialog.image-lightbox { width:min(72rem, calc(100% - 2rem)); max-width:none; max-height:90vh; padding:0; border:0; border-radius:10px; background:#111; }
  dialog.image-lightbox::backdrop { background:rgb(0 0 0 / .78); }
  .image-lightbox-body { position:relative; display:flex; align-items:center; justify-content:center; min-height:8rem; }
  .image-lightbox-body img { display:block; max-width:100%; max-height:86vh; width:auto; height:auto; object-fit:contain; }
  .image-lightbox-close { position:absolute; top:.65rem; right:.65rem; z-index:1; color:#fff; background:rgb(0 0 0 / .65); border:1px solid rgb(255 255 255 / .35); border-radius:999px; padding:.35rem .65rem; }
  .audio-picker { margin:0 0 1.2rem; padding:0.85rem 1rem; border:1px solid var(--rule); border-radius:8px; background:var(--panel); }
  .audio-picker audio { display:block; width:100%; height:2.5rem; margin-bottom:0.7rem; }
  .audio-picker .actions { margin-top:0; }
  .ai-result { display:flex; gap:1rem; align-items:center; margin-top:1rem; }
  .ai-result img { width:12rem; max-width:45%; aspect-ratio:4/3; object-fit:cover; border-radius:6px; }
  .generation-status { display:inline-flex; align-items:center; gap:.45rem; }
  .generation-spinner { width:.9rem; height:.9rem; border:2px solid color-mix(in srgb, currentColor 25%, transparent); border-top-color:currentColor; border-radius:50%; animation: generation-spin .75s linear infinite; flex:0 0 auto; }
  @keyframes generation-spin { to { transform:rotate(360deg); } }
  button:disabled, select:disabled, textarea:disabled { cursor:wait; opacity:.55; }
  textarea.dragover { outline: 2px dashed var(--accent); outline-offset: -4px; }
  .avatar-row { display: flex; align-items: center; gap: 1.1rem; margin: 0.3rem 0 0.2rem; }
  .accent-presets { display:flex; flex-wrap:wrap; gap:.55rem; margin:.2rem 0 1rem; }
  .accent-preset { display:inline-flex; align-items:center; gap:.4rem; border:1px solid var(--rule); border-radius:999px; padding:.35rem .6rem .35rem .4rem; background:var(--field); color:var(--ink); font:inherit; font-size:.8rem; cursor:pointer; }
  .accent-preset:hover, .accent-preset.selected { border-color:var(--accent); background:color-mix(in srgb, var(--accent) 9%, var(--field)); }
  .accent-swatch { width:1.15rem; height:1.15rem; border-radius:50%; border:1px solid rgb(0 0 0 / .16); flex:0 0 auto; }
  .avatar-lg {
    width: 5rem; height: 5rem; border-radius: 50%; flex: 0 0 auto;
    background: var(--accent); color: #fff; object-fit: cover; overflow: hidden;
    display: flex; align-items: center; justify-content: center;
    font-family: var(--sans); font-weight: 700; font-size: 2rem;
  }
  img.avatar-lg { display: block; }
  .editor textarea { width: 100%; min-height: 32rem; margin: 0; }
  .preview {
    background: var(--panel); border: 1px solid var(--rule); border-radius: 6px;
    padding: 1.4rem 1.7rem; min-height: 32rem; overflow-wrap: anywhere;
  }
  .preview > *:first-child { margin-top: 0; }
  .preview img { max-width: 100%; height: auto; border-radius: 4px; margin: 1.5rem 0; }
  .preview h2 { font-size: 1.3rem; } .preview h3 { font-size: 1.1rem; }
  .preview pre { background: color-mix(in srgb, var(--ink) 7%, transparent); padding: 0.8rem; border-radius: 6px; overflow-x: auto; }
  .preview code { font-family: var(--mono); font-size: 0.9em; }
  .preview blockquote { border-left: 3px solid var(--rule); margin: 1rem 0; padding-left: 1rem; color: var(--muted); }
  .preview table { border-collapse: collapse; width: 100%; margin: 1.1rem 0; font-size: 0.95em; }
  .preview th, .preview td { border: 1px solid var(--rule); padding: 0.4rem 0.7rem; text-align: left; }
  .preview th { background: color-mix(in srgb, var(--ink) 5%, transparent); font-weight: 600; }
  [hidden] { display: none !important; }
  .actions { display: flex; gap: 0.7rem; margin-top: 1.4rem; align-items: center; }
  .spacer { flex: 1; }
  .error { background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--danger); border-radius: 6px; padding: 0.6rem 0.8rem; margin-bottom: 1.2rem; font-size: 0.9rem; }
  .notice { background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent); border-radius: 6px; padding: 0.6rem 0.8rem; margin-bottom: 1.2rem; font-size: 0.9rem; }
  .panel-block { background: var(--panel); border: 1px solid var(--rule); border-radius: 8px; padding: 1rem 1.2rem; margin: 0 0 1.6rem; }
  .metric-cards { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1rem; margin-bottom:1.5rem; }
  .metric-card { background:var(--panel); border:1px solid var(--rule); border-radius:8px; padding:1rem 1.2rem; }
  .metric-value { font-size:2rem; font-weight:650; line-height:1.15; }
  .metric-label { color:var(--muted); font-size:.82rem; margin-top:.2rem; }
  .metric-chart { display:flex; align-items:end; gap:3px; height:10rem; padding-top:1.6rem; border-bottom:1px solid var(--rule); overflow:visible; }
  .metric-bar { flex:1; min-width:2px; max-width:2rem; background:var(--accent); border-radius:3px 3px 0 0; opacity:.82; position:relative; }
  .metric-bar::after { content: attr(data-tooltip); position:absolute; left:50%; bottom:calc(100% + .45rem); transform:translate(-50%, .2rem); padding:.3rem .45rem; border-radius:4px; background:var(--ink); color:var(--bg); font:500 .7rem/1 var(--sans); white-space:nowrap; opacity:0; pointer-events:none; transition: opacity .15s ease, transform .15s ease; }
  .metric-bar:hover::after, .metric-bar:focus-visible::after { opacity:1; transform:translate(-50%, 0); }
  .metrics-more { margin-top:.65rem; font-size:.82rem; }
  .metrics-more-panel[hidden] { display:none; }
  .metrics-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1.2rem; }
  table.metrics { width:100%; border-collapse:collapse; font-size:.86rem; }
  table.metrics th, table.metrics td { padding:.5rem .25rem; border-bottom:1px solid var(--rule); text-align:left; }
  table.metrics th { color:var(--muted); font-weight:500; }
  table.metrics td.num, table.metrics th.num { text-align:right; font-variant-numeric:tabular-nums; }
  table.dns { width: 100%; border-collapse: collapse; margin: 0.3rem 0; font-size: 0.85rem; }
  table.dns th { text-align: left; color: var(--muted); font-weight: 500; width: 4.5rem; padding: 0.2rem 0.6rem 0.2rem 0; vertical-align: top; }
  table.dns td { padding: 0.2rem 0; overflow-wrap: anywhere; }
  table.dns code { font-family: var(--mono); font-size: 0.85em; background: color-mix(in srgb, var(--ink) 7%, transparent); padding: 0.1rem 0.35rem; border-radius: 4px; }
  @media (max-width: 900px) { .context-inner { align-items: flex-start; flex-direction: column; } .context-links { justify-content: flex-start; gap: .7rem 1rem; } }
  @media (max-width: 720px) { :root { --admin-gutter: 1rem; } .page { padding: 1.4rem 0 3rem; } .metrics-grid { grid-template-columns:1fr; } .topbar { align-items: flex-start; gap: .5rem; flex-direction: column; } .topbar .right { gap: .7rem 1rem; flex-wrap: wrap; } }

  /* Owner-admin refresh: a compact global bar, blog toolbar, and mobile drawer. */
  .owner-topbar { height: 3.5rem; padding: 0; background: var(--panel); flex-direction: row; align-items: center; }
  .owner-topbar-inner, .owner-toolbar-inner { width: min(var(--admin-measure), calc(100% - 2 * var(--admin-gutter))); margin: 0 auto; }
  .owner-topbar-inner { height: 100%; display:flex; align-items:center; justify-content:space-between; gap:1rem; }
  .owner-topbar .brand { color: var(--accent); font-size:1rem; font-weight:700; text-decoration:none; }
  .owner-account { display:flex; align-items:center; gap:1rem; min-width:0; }
  .owner-account-email { color:var(--muted); font-size:.84rem; max-width:18rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .owner-menu-open { display:none; width:2.1rem; height:2.1rem; padding:0; border:1px solid var(--rule); border-radius:7px; color:var(--muted); align-items:center; justify-content:center; }
  .owner-menu-open svg { width:1.15rem; height:1.15rem; }
  .owner-toolbar { background:var(--panel); border-bottom:1px solid var(--rule); }
  .owner-toolbar-inner { display:flex; align-items:center; gap:1.25rem; padding:.8rem 0; min-width:0; }
  .owner-nav { display:flex; align-items:center; gap:.2rem; min-width:0; overflow-x:auto; scrollbar-width:none; }
  .owner-nav::-webkit-scrollbar { display:none; }
  .owner-nav a { flex:0 0 auto; padding:.5rem .75rem; border-radius:7px; color:var(--muted); font-size:.88rem; font-weight:600; text-decoration:none; white-space:nowrap; }
  .owner-nav a:hover { color:var(--ink); background:var(--bg); }
  .owner-nav a.active { color:var(--accent); background:color-mix(in srgb, var(--accent) 12%, transparent); }
  .owner-switcher .blog-switcher-toggle { border-radius:8px; padding:.55rem .8rem; }
  .owner-drawer-backdrop { position:fixed; inset:0; z-index:60; background:rgb(0 0 0 / .4); opacity:0; pointer-events:none; transition:opacity .2s ease; }
  .owner-drawer-backdrop.open { opacity:1; pointer-events:auto; }
  .owner-drawer { position:fixed; top:0; right:0; bottom:0; z-index:61; width:min(18rem,82vw); background:var(--panel); box-shadow:-1rem 0 2.5rem -1.5rem rgb(0 0 0 / .4); transform:translateX(100%); transition:transform .24s ease; overflow:auto; }
  .owner-drawer.open { transform:translateX(0); }
  .owner-drawer-head { display:flex; align-items:center; justify-content:space-between; gap:.6rem; padding:1rem 1.1rem; border-bottom:1px solid var(--rule); }
  .owner-drawer-who { color:var(--muted); font-size:.82rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .owner-drawer-close { width:2rem; height:2rem; display:flex; align-items:center; justify-content:center; border:1px solid var(--rule); border-radius:7px; color:var(--muted); }
  .owner-drawer-close svg { width:1rem; height:1rem; }
  .owner-drawer-section { padding:.9rem .75rem; }
  .owner-drawer-label { padding:.2rem .55rem .5rem; color:var(--muted); font-size:.7rem; font-weight:700; letter-spacing:.07em; text-transform:uppercase; }
  .owner-drawer-link { display:block; padding:.7rem .6rem; border-radius:7px; color:var(--ink); font-size:.95rem; font-weight:600; text-decoration:none; }
  .owner-drawer-link:hover, .owner-drawer-link.active { color:var(--accent); background:color-mix(in srgb, var(--accent) 12%, transparent); }
  .owner-drawer-divider { height:1px; margin:.1rem .75rem; background:var(--rule); }
  .owner-drawer form { margin:0; }
  .owner-drawer .linkbtn { display:block; width:100%; padding:.7rem .6rem; text-align:left; text-decoration:none; border-radius:7px; }
  .owner-drawer .linkbtn:hover { background:var(--bg); }
  .page { width:min(var(--admin-measure), calc(100% - 2 * var(--admin-gutter))); max-width:none; padding-top:2rem; }
  ul.posts li { padding:1rem 0; gap:1rem; }
  ul.posts .t { font-size:1rem; font-weight:650; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  ul.posts .sub { font-size:.82rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .post-summary { flex:1; min-width:0; }
  .post-thumb { width:4rem; height:4rem; border-radius:8px; }
  .acts { display:flex; align-items:center; gap:.4rem; flex:0 0 auto; }
  .icon-btn { width:2.15rem; height:2.15rem; border-radius:7px; }
  @media (max-width: 960px) {
    .owner-topbar { height:3.25rem; }
    :root { --admin-gutter: 1rem; }
    .owner-account-email, .owner-account > a, .owner-account > form { display:none; }
    .owner-menu-open { display:flex; }
    .owner-toolbar-inner { padding:.65rem 0; }
    .owner-nav { display:none; }
    .owner-toolbar-inner .blog-switcher { flex:1; }
    .owner-toolbar-inner .blog-switcher-toggle { max-width:100%; }
    ul.posts li { align-items:center; flex-wrap:nowrap; gap:0.8rem; }
    .post-summary { min-width:0; }
    .acts { margin-left:auto; margin-top:0; flex:0 0 auto; }
  }
  @media (max-width: 420px) {
    :root { --admin-gutter: .75rem; }
    .post-thumb { width:3.25rem; height:3.25rem; }
    .acts { margin-left:auto; }
  }
  .post-summary > div { min-width: 0; flex: 1; overflow: hidden; }
  ul.posts li { min-width: 0; overflow: hidden; }
  @media (max-width: 520px) {
    ul.posts li { gap: .5rem; }
    .post-thumb { width: 2.9rem; height: 2.9rem; }
    .tag { font-size: .62rem; padding: .08rem .28rem; }
    .icon-btn { width: 1.9rem; height: 1.9rem; }
    .icon-btn svg { width: .95rem; height: .95rem; }
    ul.posts .t { font-size: .92rem; }
    ul.posts .sub { font-size: .74rem; }
  }
  @media (max-width: 700px) { .topbar { flex-direction: row !important; align-items: center !important; justify-content: space-between !important; gap: .75rem; } }
`;

export function shell(
  title: string,
  inner: string,
  account?: Account,
  tenant?: Tenant
) {
  const paid = account ? accountHasPaidPlan(account) : false;
  const planBadge = account
    ? `<a class="plan-badge ${paid ? "paid" : "free"}" href="/admin/billing" title="View your blognice plan">${paid ? "Pro" : "Free"}</a>`
    : "";
  let bar = "";
  if (account && tenant) {
    const titleKey = title.toLowerCase();
    const activeNav = titleKey.startsWith("page") ? "pages"
      : titleKey.startsWith("media") ? "media"
      : titleKey.startsWith("subscriber") ? "subscribers"
      : titleKey.startsWith("collaborator") || titleKey.startsWith("author") ? "authors"
      : titleKey.startsWith("metric") ? "metrics"
      : titleKey.startsWith("audit") ? "audit"
      : titleKey.startsWith("domain") ? "domains"
      : titleKey.startsWith("setting") ? "settings" : "posts";
    const role = (tenant as unknown as { membership_role?: string }).membership_role as string | undefined;
    const can = (capability: string): boolean => {
      if (!role) return true;
      if (role === "owner") return true;
      if (capability === "settings.manage") return role === "owner";
      if (capability === "members.manage") return role === "owner";
      return true;
    };
    const navDefinitions: Array<[string, string, string, string | null]> = [
      ["posts", "Posts", `/admin/b/${tenant.public_id}`, null],
      ["pages", "Pages", `/admin/b/${tenant.public_id}/pages`, null],
      ["media", "Media", `/admin/b/${tenant.public_id}/media`, null],
      ["subscribers", "Subscribers", `/admin/b/${tenant.public_id}/subscribers`, "settings.manage"],
      ["authors", "Collaborators", `/admin/b/${tenant.public_id}/authors`, "members.manage"],
      ["metrics", "Metrics", `/admin/b/${tenant.public_id}/metrics`, null],
      ["audit", "Audit log", `/admin/b/${tenant.public_id}/audit`, null],
      ["domains", "Domains", `/admin/b/${tenant.public_id}/domains`, "settings.manage"],
      ["settings", "Settings", `/admin/b/${tenant.public_id}/settings`, "settings.manage"],
    ];
    const navItems = navDefinitions.filter(([, , , cap]) => !cap || can(cap)).map(([k, l, h]) => [k, l, h] as const);
    const navLinks = navItems.map(([key, label, href]) => `<a class="${activeNav === key ? "active" : ""}" href="${href}">${label}</a>`).join("");
    const drawerLinks = navItems.map(([key, label, href]) => `<a class="owner-drawer-link ${activeNav === key ? "active" : ""}" href="${href}">${label}</a>`).join("");
    bar = `<header class="topbar globalbar owner-topbar">
        <div class="owner-topbar-inner">
          <a class="brand" href="/admin?list=1">blognice</a>
          <div class="owner-account">
            <span class="owner-account-email">${esc(account.email)}</span>${planBadge}
            <a href="/admin?list=1">Blogs</a>
            <a href="/admin/api-key">API</a>
            <form method="post" action="/admin/logout"><button class="linkbtn" type="submit">Log out</button></form>
            <button class="owner-menu-open" id="owner-menu-open" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="owner-drawer"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="6" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="18" r="1.7"/></svg></button>
          </div>
        </div>
      </header>
      <div class="contextbar owner-toolbar"><div class="owner-toolbar-inner">
        <div class="blog-switcher owner-switcher">
          <button class="blog-switcher-toggle" type="button" id="blog-switcher-toggle" aria-label="Current blog: ${esc(tenant.title)}" aria-expanded="false" aria-controls="blog-switcher-menu">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5A2.5 2.5 0 0 0 17.5 16H4z"/><path d="M4 5.5V19a2 2 0 0 0 2 2h11.5A2.5 2.5 0 0 0 20 18.5V3"/></svg>
            <span class="context-name">${esc(tenant.title)}</span><span aria-hidden="true">⌄</span>
          </button>
          <div class="blog-switcher-menu" id="blog-switcher-menu" hidden><div class="blog-switcher-heading">Switch blog</div><div class="blog-switcher-list" id="blog-switcher-list"><span style="padding:.55rem;color:var(--muted);font-size:.85rem">Loading…</span></div><a class="blog-switcher-new" href="/admin/new-blog">＋ Create new blog</a></div>
        </div>
        <nav class="owner-nav context-links" aria-label="Blog navigation">${navLinks}</nav>
      </div></div>
      <div class="owner-drawer-backdrop" id="owner-drawer-backdrop"></div>
      <aside class="owner-drawer" id="owner-drawer" aria-label="Owner menu" aria-hidden="true" inert>
        <div class="owner-drawer-head"><span class="owner-drawer-who">${esc(account.email)} · ${paid ? "Pro" : "Free"}</span><button class="owner-drawer-close" id="owner-menu-close" type="button" aria-label="Close menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>
        <div class="owner-drawer-section"><div class="owner-drawer-label">${esc(tenant.title)}</div>${drawerLinks}</div>
        <div class="owner-drawer-divider"></div>
        <div class="owner-drawer-section"><div class="owner-drawer-label">Account</div><a class="owner-drawer-link" href="/admin?list=1">Blogs</a><a class="owner-drawer-link" href="/admin/api-key">API</a><form method="post" action="/admin/logout"><button class="linkbtn" type="submit">Log out</button></form></div>
      </aside>`;
  } else if (account) {
    // Account-level pages (blog list, new blog).
    const affiliateCurrent = title.toLowerCase().startsWith("affiliate") ? ' aria-current="page"' : "";
    const billingCurrent = title.toLowerCase().startsWith("billing") ? ' aria-current="page"' : "";
    bar = `<div class="topbar">
        <span class="brand">blognice</span>
        <div class="right">
          <span style="color:var(--muted);font-size:0.85rem">${esc(account.email)}</span>${planBadge}
          <a href="/admin?list=1">Blogs</a>
          <a href="/admin/billing"${billingCurrent}>Billing</a>
          <a href="/admin/affiliate"${affiliateCurrent}>Affiliate</a>
          <a href="/admin/api-key">API</a>
          <form method="post" action="/admin/logout">
            <button class="linkbtn" type="submit">Log out</button>
          </form>
        </div>
        <button class="topbar-menu-open" id="topbar-menu-open" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="topbar-menu"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="6" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="18" r="1.7"/></svg></button>
        <div class="topbar-menu" id="topbar-menu" hidden>
          <div style="padding:.4rem .55rem; color:var(--muted); font-size:.82rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(account.email)} ${paid ? "· Pro" : "· Free"}</div>
          <a href="/admin?list=1">Blogs</a>
          <a href="/admin/billing"${billingCurrent}>Billing</a>
          <a href="/admin/affiliate"${affiliateCurrent}>Affiliate</a>
          <a href="/admin/api-key">API</a>
          <form method="post" action="/admin/logout"><button class="linkbtn" type="submit">Log out</button></form>
        </div>
      </div>`;
  }
  const switcherScript = account && tenant ? `<script>
    (function () {
      var toggle = document.getElementById("blog-switcher-toggle");
      var menu = document.getElementById("blog-switcher-menu");
      var list = document.getElementById("blog-switcher-list");
      if (!toggle || !menu || !list) return;
      var loaded = false;
      toggle.addEventListener("click", function () {
        var open = menu.hidden;
        menu.hidden = !open;
        toggle.setAttribute("aria-expanded", String(open));
        if (open && !loaded) {
          fetch("/admin/blogs.json").then(function (response) { if (!response.ok) throw new Error(); return response.json(); }).then(function (data) {
            loaded = true;
            list.innerHTML = "";
            (data.blogs || []).forEach(function (blog) {
              var link = document.createElement("a");
              link.className = "blog-switcher-item" + (String(blog.public_id) === "${tenant.public_id}" ? " current" : "");
              link.href = "/admin/b/" + encodeURIComponent(blog.public_id);
              link.textContent = blog.title || "Untitled blog";
              var address = document.createElement("small");
              address.textContent = blog.slug || "";
              link.appendChild(address); list.appendChild(link);
            });
          }).catch(function () { list.innerHTML = '<span style="padding:.55rem;color:var(--danger);font-size:.85rem">Could not load blogs.</span>'; });
        }
      });
      document.addEventListener("click", function (event) { if (!menu.contains(event.target) && !toggle.contains(event.target)) { menu.hidden = true; toggle.setAttribute("aria-expanded", "false"); } });
      var openButton = document.getElementById("owner-menu-open");
      var closeButton = document.getElementById("owner-menu-close");
      var drawer = document.getElementById("owner-drawer");
      var backdrop = document.getElementById("owner-drawer-backdrop");
      var lastFocus = null;
      function closeOwnerMenu() {
        if (!drawer || !backdrop || !openButton) return;
        drawer.classList.remove("open"); backdrop.classList.remove("open");
        drawer.setAttribute("aria-hidden", "true"); openButton.setAttribute("aria-expanded", "false");
        drawer.setAttribute("inert", "");
        document.body.style.overflow = "";
        if (lastFocus) lastFocus.focus();
      }
      function openOwnerMenu() {
        if (!drawer || !backdrop || !openButton) return;
        lastFocus = document.activeElement;
        drawer.classList.add("open"); backdrop.classList.add("open");
        drawer.setAttribute("aria-hidden", "false"); openButton.setAttribute("aria-expanded", "true");
        drawer.removeAttribute("inert");
        document.body.style.overflow = "hidden";
        if (closeButton) closeButton.focus();
      }
      if (openButton) openButton.addEventListener("click", openOwnerMenu);
      if (closeButton) closeButton.addEventListener("click", closeOwnerMenu);
      if (backdrop) backdrop.addEventListener("click", closeOwnerMenu);
      document.addEventListener("keydown", function (event) {
        if (event.key === "Escape") { closeOwnerMenu(); return; }
        if (event.key !== "Tab" || !drawer || !drawer.classList.contains("open")) return;
        var focusable = drawer.querySelectorAll("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])");
        if (!focusable.length) { event.preventDefault(); return; }
        var first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      });
    })();
  </script>` : "";
  const brandingStyle = account && tenant
    ? `<style>:root { --accent: ${normalizeAccentColor(tenant.accent_color)}; --accent-ink: ${accentTextColor(normalizeAccentColor(tenant.accent_color))}; }</style>`
    : "";
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title><style>${ADMIN_STYLES}</style>${brandingStyle}</head>
<body>${bar}${inner}${switcherScript}<script>(function(){var b=document.getElementById('topbar-menu-open'),m=document.getElementById('topbar-menu');if(!b||!m)return;b.addEventListener('click',function(){var o=m.hidden;m.hidden=!o;b.setAttribute('aria-expanded',String(o));});document.addEventListener('click',function(e){if(!m.contains(e.target)&&!b.contains(e.target)){m.hidden=true;b.setAttribute('aria-expanded','false');}});})();</script><footer class="admin-footer"><span><strong>blognice</strong> · © 2026 Pragmatic Online Co., Ltd.</span><nav aria-label="Legal"><a href="https://www.blognice.com/policies">Policies</a></nav></footer><style>.admin-footer{max-width:1220px;margin:2.5rem auto 0;padding:1.25rem 1.5rem 2rem;border-top:1px solid var(--rule);display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;color:var(--muted);font-size:.82rem}.admin-footer nav{display:flex;gap:1rem;flex-wrap:wrap}.admin-footer a{color:inherit;text-decoration:none}.admin-footer a:hover,.admin-footer a:focus-visible{color:var(--accent);text-decoration:underline}@media(max-width:640px){.admin-footer{align-items:flex-start;flex-direction:column}.admin-footer a{padding:.5rem 0}}</style></body></html>`;
}

export function loginPage(error?: string, invite?: { token: string; email: string; title: string; role: string }): string {
  const inviteBanner = invite
    ? `<div class="notice" style="margin-bottom:1rem"><strong>Invitation for ${esc(invite.email)}</strong><br>Join <strong>${esc(invite.title)}</strong> as <em>${esc(invite.role)}</em>. Sign in with the invited email to accept.</div>`
    : "";
  const inviteInput = invite ? `<input type="hidden" name="invite" value="${esc(invite.token)}">` : "";
  const inviteSignupLink = invite
    ? `<p style="margin-top:1rem;color:var(--muted);font-size:0.9rem">Need an account for ${esc(invite.email)}? <a href="/signup?invite=${esc(invite.token)}">Create account</a></p>`
    : "";
  const action = invite ? `/admin/login?invite=${esc(invite.token)}` : "/admin/login";
  return shell(
    "Sign in",
    `<div class="page narrow">
      <h1>Sign in</h1>
      ${inviteBanner}
      ${error ? `<div class="error">${esc(error)}</div>` : ""}
      <form method="post" action="${action}">
        ${inviteInput}
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="username" required value="${invite ? esc(invite.email) : ""}">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <button class="btn" type="submit">Sign in</button>
      </form>
      <p style="margin-top:1.1rem;color:var(--muted);font-size:0.9rem"><a href="/admin/forgot">Forgot your password?</a></p>
      ${inviteSignupLink}
      <p style="margin-top:1.4rem;color:var(--muted);font-size:0.9rem">
        Don't have a blog yet? <a href="/signup${invite ? `?invite=${esc(invite.token)}` : ""}">Create one</a>.
      </p>
    </div>`
  );
}

export function suspendedAccountPage(account: Account): string {
  const reason = account.status_reason?.trim();
  return shell(
    "Account suspended",
    `<div class="page narrow">
      <h1>Your account is currently suspended</h1>
      <div class="error" style="margin: 1rem 0; padding: 1rem; background: #fae7e4; border: 1px solid #e8897f; border-radius: 6px; color: #8d241b;">
        Your account is currently suspended and you should contact support.
      </div>
      ${reason ? `<p style="color:var(--muted);font-size:0.9rem">Reason: ${esc(reason)}</p>` : ""}
      <p style="color:var(--muted);font-size:0.9rem">If you believe this is a mistake, please contact <a href="mailto:support@blognice.com">support@blognice.com</a>.</p>
      <form method="post" action="/admin/logout" style="margin-top:1.5rem">
        <button class="btn" type="submit">Log out</button>
      </form>
    </div>`,
    account
  );
}

export function signupPage(
  rootDomain: string,
  values?: { slug?: string; title?: string; email?: string },
  error?: string,
  inviteToken?: string,
  inviteInfo?: { title: string; role: string; email: string }
): string {
  const slug = esc(values?.slug ?? "");
  const title = esc(values?.title ?? "");
  const email = esc(values?.email ?? inviteInfo?.email ?? "");
  const inviteBanner = inviteToken && inviteInfo
    ? `<div class="notice" style="margin-bottom:1rem">You're invited to join <strong>${esc(inviteInfo.title)}</strong> as <em>${esc(inviteInfo.role)}</em> — create an account for <strong>${esc(inviteInfo.email)}</strong> to accept.</div>`
    : inviteToken
      ? `<p style="color:var(--muted)">Create your blognice account to accept this invitation.</p>`
      : "";
  return shell(
    inviteToken ? "Join a blog" : "Create your blog",
    `<div class="page narrow">
      <h1>${inviteToken ? "Join a blog" : "Create your blog"}</h1>
      ${inviteBanner}
      ${error ? `<div class="error">${esc(error)}</div>` : ""}
      <form method="post" action="/signup">
        ${inviteToken ? `<input type="hidden" name="invite" value="${esc(inviteToken)}">` : ""}
        ${inviteToken ? "" : `<label for="slug">Blog address</label>
        <input id="slug" name="slug" type="text" value="${slug}" placeholder="yourname"
               autocapitalize="none" autocorrect="off" spellcheck="false" required>
        <div style="margin:-0.6rem 0 1rem;color:var(--muted);font-size:0.82rem">
          <span id="preview">yourname</span>.${esc(rootDomain)}
        </div>
        <label for="title">Blog title</label>
        <input id="title" name="title" type="text" value="${title}" placeholder="My Blog" required>`}
        <label for="email">Email</label>
        <input id="email" name="email" type="email" value="${email}" autocomplete="username" required ${inviteInfo ? `readonly style="background:var(--rule-bg, #f6f6f5)"` : ""}>
        ${inviteInfo ? `<div style="margin:-0.6rem 0 1rem;color:var(--muted);font-size:0.82rem">Invitation is for ${esc(inviteInfo.email)} — use that address.</div>` : ""}
        <label for="password">Password <span style="color:var(--muted)">(8+ characters)</span></label>
        <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required>
        <button class="btn" type="submit">${inviteToken ? "Create account and join" : "Create blog"}</button>
      </form>
      <p style="margin-top:1.4rem;color:var(--muted);font-size:0.9rem">
        Already have an account? <a href="/admin/login${inviteToken ? `?invite=${esc(inviteToken)}` : ""}">Sign in</a>.
      </p>
    </div>
    <script>
      (function () {
        var s = document.getElementById("slug"), p = document.getElementById("preview");
        if (!s || !p) return;
        function clean(v){ return v.toLowerCase().replace(/[^a-z0-9-]/g,"").replace(/^-+|-+$/g,""); }
        s.addEventListener("input", function () { p.textContent = clean(s.value) || "yourname"; });
      })();
    </script>`
  );
}

type DomainRow = { hostname: string; status: string };
type DomainInstructions = {
  hostname: string;
  active: boolean;
  status: string;
  ssl_status: string;
  dns: { type: string; name: string; value: string };
  ssl_validation: Array<{ txt_name?: string; txt_value?: string }>;
  errors: string[];
};

export type DomainSearchResult = {
  domain: string;
  available: boolean;
  premium?: string;
  priceList?: Array<{ currency: string; registration_price: string; renewal_price: string; unit?: string }>;
  error?: string;
};

function dynadotMarkupPrice(raw: string): string {
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return raw;
  return (n + 2).toFixed(2);
}

export function domainsPage(
  account: Account,
  tenant: Tenant,
  domains: DomainRow[],
  cfg: { cnameTarget: string; rootDomain: string },
  opts?: {
    notice?: string;
    error?: string;
    instructions?: DomainInstructions;
    searchResult?: DomainSearchResult | null;
    searchError?: string;
    purchaseError?: string;
    purchaseNotice?: string;
    dynadotEnabled?: boolean;
    isSandbox?: boolean;
  }
): string {
  const base = `/admin/b/${tenant.public_id}`;
  const inst = opts?.instructions;
  const instBlock = inst
    ? `<div class="panel-block">
        <div class="row" style="margin-bottom:0.6rem">
          <strong>${esc(inst.hostname)}</strong>
          <span class="tag ${inst.active ? "live" : ""}">${inst.active ? "Active" : "Waiting"}</span>
        </div>
        ${
          inst.active
            ? `<p style="margin:0;color:var(--muted)">This domain is verified and live.</p>`
            : `<p style="margin:0 0 0.7rem;color:var(--muted)">Add this DNS record at your domain provider, then click “Check status”. Certificates can take a few minutes.</p>
               <table class="dns">
                 <tr><th>Type</th><td>${esc(inst.dns.type)}</td></tr>
                 <tr><th>Name</th><td><code>${esc(inst.dns.name)}</code></td></tr>
                 <tr><th>Value</th><td><code>${esc(inst.dns.value)}</code></td></tr>
               </table>
               ${
                 inst.ssl_validation && inst.ssl_validation.filter((r: any) => String(r.txt_name ?? "").trim() && String(r.txt_value ?? "").trim()).length
                   ? `<p style="margin:0.8rem 0 0.3rem;color:var(--muted);font-size:0.85rem">Certificate validation record:</p>
                      ${inst.ssl_validation.filter((r: any) => String(r.txt_name ?? "").trim() && String(r.txt_value ?? "").trim())
                        .map(
                          (r) =>
                            `<table class="dns"><tr><th>Name</th><td><code>${esc(
                              r.txt_name ?? ""
                            )}</code></td></tr><tr><th>Value</th><td><code>${esc(
                              r.txt_value ?? ""
                            )}</code></td></tr></table>`
                        )
                        .join("")}`
                   : ""
               }`
        }
        ${
          inst.errors && inst.errors.length && inst.errors.some((e: string) => /CNAME to this zone/i.test(e)) && !inst.active
            ? `<p style="margin:0.7rem 0 0;color:var(--muted);font-size:0.85rem">Waiting for DNS — your CNAME is being checked. This usually takes a minute.</p>`
            : inst.errors && inst.errors.length
            ? `<p style="margin:0.7rem 0 0;color:var(--danger);font-size:0.85rem">${esc(
                inst.errors.join("; ")
              )}</p>`
            : ""
        }
      </div>`
    : "";

  const _dynadotEnabled = opts?.dynadotEnabled ?? false;
  const _isSandbox = opts?.isSandbox ?? false;
  const _searchResult = opts?.searchResult ?? null;
  const _searchError = opts?.searchError ?? null;
  const _purchaseError = opts?.purchaseError ?? null;
  const _purchaseNotice = opts?.purchaseNotice ?? null;

  const list =
    domains.length === 0
      ? `<p style="color:var(--muted)">No custom domains yet.</p>`
      : `<ul class="posts">${domains
          .map(
            (d) => `<li>
              <div>
                <div class="t">${esc(d.hostname)}</div>
              </div>
              <div class="acts">
                <span class="tag ${d.status === "active" ? "live" : ""}">${
                  d.status === "active" ? "Active" : "Waiting"
                }</span>
                ${
                  d.status === "active"
                    ? `<a class="btn ghost" href="https://${esc(d.hostname)}" target="_blank">Visit</a>`
                    : `<form method="post" action="${base}/domains/check">
                         <input type="hidden" name="hostname" value="${esc(d.hostname)}">
                         <button class="btn ghost" type="submit">Check status</button>
                       </form>`
                }
                <form method="post" action="${base}/domains/remove" onsubmit="return confirm('Disconnect this domain?')">
                  <input type="hidden" name="hostname" value="${esc(d.hostname)}">
                  <button class="btn danger" type="submit">Remove</button>
                </form>
              </div>
            </li>`
          )
          .join("")}</ul>`;

  const searchBlock = ``;

  return shell(
    `Domains — ${tenant.title}`,
    `<div class="page">
      <h1>Custom domains</h1>
      ${opts?.error ? `<div class="error">${esc(opts.error)}</div>` : ""}
      ${opts?.notice ? `<div class="notice">${esc(opts.notice)}</div>` : ""}
      <p style="color:var(--muted);margin-top:-0.6rem">
        Serve this blog on your own domain. Use a subdomain like
        <code>blog.yourcompany.com</code> — bare domains aren't supported.
        Your blog also stays reachable at
        <code>${esc(tenant.slug)}.${esc(cfg.rootDomain)}</code>.
      </p>
      <form method="post" action="${base}/domains" style="display:flex;gap:0.6rem;align-items:flex-start;margin:1.2rem 0">
        <input name="hostname" type="text" placeholder="blog.yourcompany.com"
               autocapitalize="none" autocorrect="off" spellcheck="false"
               style="margin:0" required>
        <button class="btn ghost" type="submit">Connect</button>
      </form>
      ${instBlock}
      ${list}
      ${searchBlock}
    </div>`,
    account,
    tenant
  );
}

export function dnsPage(
  account: Account,
  tenant: Tenant,
  hostname: string,
  cfg: { cnameTarget: string },
  opts?: {
    error?: string;
    notice?: string;
    records?: Array<{ host: string; type: string; value: string; ttl?: number }>;
    nameservers?: string[];
    raw?: any;
    isSandbox?: boolean;
  }
): string {
  const base = `/admin/b/${tenant.public_id}`;
  const recs = opts?.records ?? [];
  const nss = opts?.nameservers ?? [];
  const recTable = recs.length
    ? `<table class="dns" style="width:100%;margin:.8rem 0"><tr><th>Host</th><th>Type</th><th>Value</th><th>TTL</th></tr>${recs.map((r) => `<tr><td><code>${esc(r.host || "@")}</code></td><td>${esc(r.type)}</td><td><code>${esc(r.value)}</code></td><td>${esc(String(r.ttl ?? ""))}</td></tr>`).join("")}</table>`
    : `<p style="color:var(--muted)">No records found (domain may be outside Dynadot or use external nameservers).</p>`;
  const nsTable = nss.length
    ? `<p style="margin:.4rem 0;color:var(--muted);font-size:.85rem">${nss.map((ns) => `<code>${esc(ns)}</code>`).join(", ")}</p>`
    : `<p style="color:var(--muted);font-size:.85rem">No nameservers returned — likely using Dynadot default DNS.</p>`;
  return shell(
    `DNS — ${hostname}`,
    `<div class="page">
      <p><a href="${base}/domains">← Back to domains</a></p>
      <h1>DNS for ${esc(hostname)}</h1>
      ${opts?.isSandbox ? `<p style="color:var(--muted)"><span class="tag">Sandbox mode</span> Changes are simulated.</p>` : ``}
      ${opts?.error ? `<div class="error">${esc(opts.error)}</div>` : ``}
      ${opts?.notice ? `<div class="notice">${esc(opts.notice)}</div>` : ``}
      <div class="panel-block">
        <h3 style="margin:0 0 .6rem">Current Dynadot DNS</h3>
        ${recTable}
        <h4 style="margin:1rem 0 .4rem">Nameservers</h4>
        ${nsTable}
        ${opts?.raw ? `<details style="margin-top:.8rem"><summary style="cursor:pointer;color:var(--muted)">Raw response</summary><pre style="white-space:pre-wrap;word-break:break-all;font-size:.75rem">${esc(JSON.stringify(opts.raw, null, 2).slice(0, 4000))}</pre></details>` : ``}
      </div>
      <div class="panel-block">
        <h3 style="margin:0 0 .6rem">Simple DNS update</h3>
        <p style="color:var(--muted);font-size:.85rem;margin:0 0 .8rem">Sets <code>@</code> to <code>${esc(cfg.cnameTarget)}</code> or a custom record. Replaces current Dynadot records (external nameservers will be overridden).</p>
        <form method="post" action="${base}/domains/dns" style="display:grid;gap:.6rem;max-width:520px">
          <input type="hidden" name="hostname" value="${esc(hostname)}">
          <div style="display:grid;gap:.6rem;grid-template-columns:1fr 1fr 2fr">
            <label>Host <input name="host" type="text" placeholder="@" value="@" maxlength="64"></label>
            <label>Type <select name="type"><option value="CNAME" selected>CNAME</option><option value="A">A</option><option value="TXT">TXT</option></select></label>
            <label>Value <input name="value" type="text" required placeholder="${esc(cfg.cnameTarget)}" value="${esc(cfg.cnameTarget)}"></label>
          </div>
          <div style="display:flex;gap:.6rem">
            <button class="btn" type="submit">Save DNS</button>
            <button class="btn ghost" type="submit" name="preset" value="blognice">Reset to ${esc(cfg.cnameTarget)}</button>
          </div>
        </form>
      </div>
      <div class="panel-block">
        <h3 style="margin:0 0 .6rem">Nameservers</h3>
        <p style="color:var(--muted);font-size:.85rem;margin:0 0 .8rem">Use Dynadot DNS (default) or switch to external nameservers (e.g. Cloudflare). Switching will override DNS above.</p>
        <form method="post" action="${base}/domains/nameservers" style="display:grid;gap:.6rem;max-width:520px">
          <input type="hidden" name="hostname" value="${esc(hostname)}">
          <label>Nameservers (comma or newline separated) <textarea name="nameservers" rows="2" placeholder="ns1.dynadot.com, ns2.dynadot.com">${esc(nss.join(", "))}</textarea></label>
          <div style="display:flex;gap:.6rem">
            <button class="btn" type="submit">Save nameservers</button>
            <button class="btn ghost" type="submit" name="preset" value="dynadot">Reset to Dynadot default</button>
          </div>
        </form>
      </div>
      <div class="panel-block">
        <h3 style="margin:0 0 .6rem">Renew domain</h3>
        <form method="post" action="${base}/domains/renew" style="display:flex;gap:.6rem;align-items:flex-end;max-width:320px">
          <input type="hidden" name="hostname" value="${esc(hostname)}">
          <label>Duration <select name="duration"><option value="1" selected>1 year</option><option value="2">2 years</option><option value="3">3 years</option><option value="5">5 years</option></select></label>
          <button class="btn" type="submit">Renew</button>
        </form>
        <p style="color:var(--muted);font-size:.8rem;margin:.6rem 0 0">Dynadot will charge renewal + $2 service fee. Sandbox renewals are simulated.</p>
      </div>
    </div>`,
    account,
    tenant
  );
}

export function postListPage(
  account: Account,
  tenant: Tenant,
  posts: Post[],
  rootDomain: string
): string {
  const base = `/admin/b/${tenant.public_id}`;
  const publicHost = tenant.custom_domain || `${tenant.slug}.${rootDomain}`;
  const rows =
    posts.length === 0
      ? `<p style="color:var(--muted)">No posts yet. Write your first one.</p>`
      : `<ul class="posts">${posts
          .map(
            (p) => `<li>
              <div class="post-summary">
                ${p.featured_image_key ? `<img class="post-thumb" src="/media/${esc(p.featured_image_key)}" alt="">` : ""}
                <div>
                <div class="t"><a href="${base}/edit/${p.id}">${esc(p.title)}</a></div>
                <div class="sub">${formatDate(p.created_at)} &middot; /${esc(p.slug)}</div>
                </div>
              </div>
              <div class="acts">
                <span class="tag ${p.published ? "live" : ""}">${p.published ? "Published" : "Draft"}</span>
                <a class="btn ghost icon-btn" href="${base}/edit/${p.id}" aria-label="Edit ${esc(p.title)}" title="Edit">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>
                </a>
                <a class="btn ghost icon-btn" href="https://${esc(publicHost)}/${esc(p.slug)}" target="_blank" rel="noopener noreferrer" aria-label="View ${esc(p.title)}" title="View">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></svg>
                </a>
                <form method="post" action="${base}/delete/${p.id}" onsubmit="return confirm('Delete this post?')">
                  <button class="btn danger icon-btn" type="submit" aria-label="Delete ${esc(p.title)}" title="Delete">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 14h10l1-14"/><path d="M9 7V4h6v3"/></svg>
                  </button>
                </form>
              </div>
            </li>`
          )
          .join("")}</ul>`;

  return shell(
    `Posts — ${tenant.title}`,
    `<div class="page">
      <div class="row">
        <h1 style="margin:0">Posts</h1>
        <a class="btn" href="${base}/new">New post</a>
      </div>
      ${rows}
    </div>`,
    account,
    tenant
  );
}

export function pageListPage(account: Account, tenant: Tenant, pages: Page[], rootDomain: string, opts?: { error?: string }): string {
  const base = `/admin/b/${tenant.public_id}`;
  const publicHost = tenant.custom_domain || `${tenant.slug}.${rootDomain}`;
  const rows = pages.length ? `<ul class="posts">${pages.map((page) => `<li>
    <div class="post-summary"><div><div class="t"><a href="${base}/pages/edit/${page.id}">${esc(page.title)}</a></div><div class="sub">${formatDate(page.updated_at)} · /pages/${esc(page.slug)}</div></div></div>
    <div class="acts"><span class="tag ${page.published ? "live" : ""}">${page.published ? "Published" : "Draft"}</span>${page.show_in_navigation ? `<span class="tag">Navigation</span>` : ""}
      <a class="btn ghost icon-btn" href="${base}/pages/edit/${page.id}" aria-label="Edit ${esc(page.title)}" title="Edit"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg></a>
      <a class="btn ghost icon-btn" href="https://${esc(publicHost)}/pages/${esc(page.slug)}" target="_blank" rel="noopener noreferrer" aria-label="View ${esc(page.title)}" title="View"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></svg></a>
      <form method="post" action="${base}/pages/delete/${page.id}" onsubmit="return confirm('Delete this page?')"><button class="btn danger icon-btn" type="submit" aria-label="Delete ${esc(page.title)}" title="Delete"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 14h10l1-14"/><path d="M9 7V4h6v3"/></svg></button></form>
    </div></li>`).join("")}</ul>` : `<p style="color:var(--muted)">No pages yet. Create an About page or another evergreen reference.</p>`;
  let links: Array<{ label: string; href: string; order: number }> = [];
  try { const raw = JSON.parse((tenant as any).navigation_links_json || "[]"); if (Array.isArray(raw)) links = raw.filter((item: any) => item && typeof item.label === "string" && typeof item.href === "string").slice(0, 20) as any; } catch {}
  const linksRows = links.length ? `<ul class="posts">${links.map((link, idx) => `<li><div class="post-summary"><div><div class="t">${esc(link.label)}</div><div class="sub">${esc(link.href)} · position ${link.order + 1}${/^https:\/\//i.test(link.href) ? " · external" : ""}</div></div></div><div class="acts"><span class="tag">Link</span><a class="btn ghost icon-btn" href="${esc(link.href)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${esc(link.label)}" title="Open"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></svg></a><form method="post" action="${base}/navigation-links/delete/${idx}" onsubmit="return confirm('Remove this link?')"><button class="btn danger icon-btn" type="submit" aria-label="Remove ${esc(link.label)}" title="Remove"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 14h10l1-14"/><path d="M9 7V4h6v3"/></svg></button></form></div></li>`).join("")}</ul>` : `<p style="color:var(--muted)">No custom links yet. Add a link to your main site (for example your shop or www.domain.com).</p>`;
  const navigationPreview = (() => {
    const pageItems: Array<{ label: string; order: number }> = pages.filter((pg) => pg.show_in_navigation).map((pg) => ({ label: pg.navigation_label?.trim() || pg.title, order: pg.navigation_order ?? 0 }));
    const linkItems: Array<{ label: string; order: number }> = links.map((link) => ({ label: link.label, order: link.order }));
    const merged = [...pageItems, ...linkItems].sort((a, b) => a.order === b.order ? a.label.localeCompare(b.label) : a.order - b.order).slice(0, 6);
    return merged.length ? `<p style="color:var(--muted);font-size:.85rem">Current blog navigation (first ${merged.length}): ${merged.map((item) => esc(item.label)).join(" · ")}</p>` : "";
  })();
  return shell(`Pages — ${tenant.title}`, `<div class="page"><div class="row"><h1 style="margin:0">Pages</h1><a class="btn" href="${base}/pages/new">New page</a></div><p style="color:var(--muted);margin-top:-.8rem">Pages are for evergreen information such as About, Contact, or FAQ. They are separate from posts and do not trigger subscriber emails. Custom links let the blog header point back to your main site (for example www.domain.com) when the blog lives at blog.domain.com.</p>${rows}${navigationPreview}<hr style="margin:1.6rem 0"><h2 style="margin:0 0 .4rem">Custom navigation links</h2><p style="color:var(--muted);margin-top:0">Add external or root-relative links that appear alongside pages in the blog header. Use an absolute https URL for an external site, or a path like /shop for the same domain.</p>${opts?.error ? `<div class="error">${esc(opts.error)}</div>` : ""}${linksRows}<form method="post" action="${base}/navigation-links" style="margin-top:1rem;display:grid;gap:.8rem;max-width:560px"><label>Label <input name="label" type="text" maxlength="40" required placeholder="Our shop"></label><label>Link target <input name="href" type="text" maxlength="200" required placeholder="https://www.domain.com or /about"></label><label>Position <select name="order">${[0,1,2,3,4,5].map((value) => `<option value="${value}">${value + 1}</option>`).join("")}</select></label><div><button class="btn" type="submit">Add link</button></div></form></div>`, account, tenant);
}

export function pageEditorPage(account: Account, tenant: Tenant, page: Partial<Page> | null, error?: string): string {
  const base = `/admin/b/${tenant.public_id}`;
  const isEdit = !!page?.id;
  const action = isEdit ? `${base}/pages/save?id=${page!.id}` : `${base}/pages/save`;
  const title = esc(page?.title ?? "");
  const slug = esc(page?.slug ?? "");
  const body = esc(page?.body_md ?? "");
  const published = page ? page.published !== 0 : false;
  const navigation = page?.show_in_navigation === 1;
  return shell(isEdit ? `Edit page — ${tenant.title}` : `New page — ${tenant.title}`, `<div class="page"><p class="breadcrumb"><a href="${base}/pages">Pages</a> › ${isEdit ? "Edit page" : "New page"}</p><h1>${isEdit ? "Edit page" : "New page"}</h1>${error ? `<div class="error">${esc(error)}</div>` : ""}<form method="post" action="${action}">
    <label for="page-title">Title</label><input id="page-title" name="title" type="text" value="${title}" required>
    <label for="page-slug">URL slug <span style="color:var(--muted)">(the public URL will be /pages/…)</span></label><input id="page-slug" name="slug" type="text" value="${slug}" placeholder="about">
    <label for="page-meta">Meta description <span style="color:var(--muted)">(optional)</span></label><textarea id="page-meta" name="meta_description" rows="2" maxlength="300">${esc(page?.meta_description ?? "")}</textarea>
    <label for="page-body">Page content</label><textarea id="page-body" name="body_md" rows="20" placeholder="Write this page in Markdown…">${body}</textarea>
    <div class="check"><input id="page-published" name="published" type="checkbox" ${published ? "checked" : ""}><label for="page-published">Published</label></div>
    <fieldset class="page-nav-settings"><h2>Blog navigation</h2><p>Optionally add this page to the links at the top of your blog. Pages stay available at their public URL either way.</p><div class="check"><input id="page-navigation" name="show_in_navigation" type="checkbox" ${navigation ? "checked" : ""}><label for="page-navigation">Show this page in navigation</label></div><div class="nav-fields"><label for="page-nav-label">Link label <span style="color:var(--muted)">(optional)</span><input id="page-nav-label" name="navigation_label" type="text" value="${esc(page?.navigation_label ?? "")}" maxlength="40" placeholder="About"></label><label for="page-nav-order">Position <select id="page-nav-order" name="navigation_order">${[0,1,2,3,4,5].map((value) => `<option value="${value}"${(page?.navigation_order ?? 0) === value ? " selected" : ""}>${value + 1}</option>`).join("")}</select></label></div></fieldset>
    <div class="actions"><button class="btn" type="submit">Save page</button><a class="btn ghost" href="${base}/pages">Cancel</a></div>
  </form></div>`, account, tenant);
}

export function metricsPage(
  account: Account,
  tenant: Tenant,
  report: MetricsReport | null,
  options?: { days?: number; error?: string; configured?: boolean; rootDomain?: string }
): string {
  const base = `/admin/b/${tenant.public_id}`;
  const days = options?.days ?? report?.days ?? 30;
  const rootDomain = options?.rootDomain || "blognice.com";
  const publicHost = tenant.custom_domain || `${tenant.slug}.${rootDomain}`;
  const rangeLinks = [7, 30, 90]
    .map((value) => `<a class="btn ${value === days ? "" : "ghost"}" href="${base}/metrics?days=${value}">${value} days</a>`)
    .join(" ");
  const breakdownRows = (items: MetricsReport["countries"], country = false) =>
    items.length
      ? items.map((item) => {
          let label = item.name;
          if (country && /^[A-Z]{2}$/.test(item.name)) {
            try { label = new Intl.DisplayNames(["en"], { type: "region" }).of(item.name) || item.name; } catch { /* keep code */ }
          }
          return `<tr><td>${esc(label)}</td><td class="num">${item.views.toLocaleString()}</td></tr>`;
        }).join("")
      : `<tr><td colspan="2" style="color:var(--muted)">No data yet.</td></tr>`;

  let content: string;
  if (options?.configured === false) {
    content = `<div class="panel-block">
      <h2 style="margin-top:0">Finish metrics setup</h2>
      <p>Set <code>CF_ACCOUNT_ID</code> as a Worker variable and add a secret named
      <code>CF_ANALYTICS_TOKEN</code> with Account Analytics Read permission. Page-view
      collection begins as soon as the Analytics Engine binding is deployed.</p>
    </div>`;
  } else if (!report) {
    content = `<div class="error">${esc(options?.error || "Metrics could not be loaded. Please try again shortly.")}</div>`;
  } else {
    const maxViews = Math.max(1, ...report.daily.map((day) => day.views));
    const chart = report.daily.length
      ? report.daily.map((day) => `<span class="metric-bar" style="height:${Math.max(2, Math.round(day.views / maxViews * 100))}%" data-tooltip="${esc(day.date)}: ${day.views.toLocaleString()} views \u00b7 ${day.visitors.toLocaleString()} visitors" aria-label="${esc(day.date)}: ${day.views.toLocaleString()} views, ${day.visitors.toLocaleString()} visitors" role="img" tabindex="0"></span>`).join("")
      : `<span style="color:var(--muted);font-size:.85rem">No views recorded in this period.</span>`;
    const toRows = (limit: number, items: string[]) => {
      if (items.length <= limit) return { visible: items.join(""), hidden: "", count: 0 };
      return { visible: items.slice(0, limit).join(""), hidden: items.slice(limit).join(""), count: items.length - limit };
    };
    const moreBtn = (count: number) => count ? `<button class="btn ghost metrics-more" type="button" data-metrics-more aria-expanded="false">Show ${count} more</button>` : "";
    const morePanel = (hidden: string) => hidden ? `<tbody class="metrics-more-panel" hidden data-metrics-panel>${hidden}</tbody>` : "";

    const pageRows = report.pages.map((page) => `<tr><td><a href="https://${esc(publicHost)}${esc(page.path)}" target="_blank" rel="noopener noreferrer">${esc(page.path)}</a></td><td class="num">${page.views.toLocaleString()}</td><td class="num">${page.visitors.toLocaleString()}</td></tr>`);
    const referrerRows = report.referrers.map((item) => `<tr><td>${esc(item.referrer)}</td><td class="num">${item.views.toLocaleString()}</td></tr>`);
    const audioRows = report.audio.pages.map((item) => `<tr><td><a href="https://${esc(publicHost)}${esc(item.path)}" target="_blank" rel="noopener noreferrer">${esc(item.path)}</a></td><td class="num">${item.starts.toLocaleString()}</td><td class="num">${item.completions.toLocaleString()}</td></tr>`);
    const countryRows = report.countries.map((item) => {
      let label = item.name;
      if (/^[A-Z]{2}$/.test(item.name)) { try { label = new Intl.DisplayNames(["en"], { type: "region" }).of(item.name) || item.name; } catch {} }
      return `<tr><td>${esc(label)}</td><td class="num">${item.views.toLocaleString()}</td></tr>`;
    });

    const pagesPart = (() => {
      if (!pageRows.length) return `<tr><td colspan="3" style="color:var(--muted)">No page views yet.</td></tr>`;
      const { visible, hidden, count } = toRows(10, pageRows);
      return `${visible}${hidden ? `<tbody class="metrics-more-panel" hidden data-metrics-panel>${hidden}</tbody>` : ""}`;
    })();
    const pagesMore = pageRows.length > 10 ? `<button class="btn ghost metrics-more" type="button" data-metrics-more aria-expanded="false">Show ${pageRows.length - 10} more</button>` : "";
    const referrersPart = (() => {
      if (!referrerRows.length) return `<tr><td colspan="2" style="color:var(--muted)">No external referrers yet.</td></tr>`;
      const { visible, hidden } = toRows(10, referrerRows);
      return `${visible}${hidden ? `<tbody class="metrics-more-panel" hidden data-metrics-panel>${hidden}</tbody>` : ""}`;
    })();
    const referrersMore = referrerRows.length > 10 ? `<button class="btn ghost metrics-more" type="button" data-metrics-more aria-expanded="false">Show ${referrerRows.length - 10} more</button>` : "";
    const countriesPart = (() => {
      if (!countryRows.length) return `<tr><td colspan="2" style="color:var(--muted)">No data yet.</td></tr>`;
      const { visible, hidden } = toRows(10, countryRows);
      return `${visible}${hidden ? `<tbody class="metrics-more-panel" hidden data-metrics-panel>${hidden}</tbody>` : ""}`;
    })();
    const countriesMore = countryRows.length > 10 ? `<button class="btn ghost metrics-more" type="button" data-metrics-more aria-expanded="false">Show ${countryRows.length - 10} more</button>` : "";
    const audioPart = (() => {
      if (!audioRows.length) return `<tr><td colspan="3" style="color:var(--muted)">No audio plays yet.</td></tr>`;
      const { visible, hidden } = toRows(10, audioRows);
      return `${visible}${hidden ? `<tbody class="metrics-more-panel" hidden data-metrics-panel>${hidden}</tbody>` : ""}`;
    })();
    const audioMore = audioRows.length > 10 ? `<button class="btn ghost metrics-more" type="button" data-metrics-more aria-expanded="false">Show ${audioRows.length - 10} more</button>` : "";

    const completionRate = report.audio.starts
      ? Math.min(100, Math.round(report.audio.completions / report.audio.starts * 100))
      : 0;
    content = `<div class="metric-cards">
      <div class="metric-card"><div class="metric-value">${report.summary.views.toLocaleString()}</div><div class="metric-label">Views</div></div>
      <div class="metric-card"><div class="metric-value">${report.summary.visitors.toLocaleString()}</div><div class="metric-label">Unique visitors</div></div>
    </div>
    <div class="panel-block"><strong>Daily views</strong><div class="metric-chart" aria-label="Daily page views">${chart}</div></div>
    <div class="metrics-grid">
      <div class="panel-block"><h2 style="margin-top:0;font-size:1rem">Top pages</h2><table class="metrics"><thead><tr><th>Page</th><th class="num">Views</th><th class="num">Visitors</th></tr></thead><tbody>${pagesPart}</tbody></table>${pagesMore}</div>
      <div class="panel-block"><h2 style="margin-top:0;font-size:1rem">Top referrers</h2><table class="metrics"><thead><tr><th>Source</th><th class="num">Views</th></tr></thead><tbody>${referrersPart}</tbody></table>${referrersMore}</div>
      <div class="panel-block"><h2 style="margin-top:0;font-size:1rem">Countries</h2><table class="metrics"><thead><tr><th>Country</th><th class="num">Views</th></tr></thead><tbody>${countriesPart}</tbody></table>${countriesMore}</div>
      <div class="panel-block"><h2 style="margin-top:0;font-size:1rem">Devices</h2><table class="metrics"><thead><tr><th>Device</th><th class="num">Views</th></tr></thead><tbody>${breakdownRows(report.devices)}</tbody></table></div>
      <div class="panel-block"><h2 style="margin-top:0;font-size:1rem">Browsers</h2><table class="metrics"><thead><tr><th>Browser</th><th class="num">Views</th></tr></thead><tbody>${breakdownRows(report.browsers)}</tbody></table></div>
      <div class="panel-block"><h2 style="margin-top:0;font-size:1rem">Audio engagement</h2><div style="display:flex;gap:1.4rem;margin-bottom:.7rem"><span><strong>${report.audio.starts.toLocaleString()}</strong> starts</span><span><strong>${report.audio.completions.toLocaleString()}</strong> completed</span><span><strong>${completionRate}%</strong> completion</span></div><table class="metrics"><thead><tr><th>Post</th><th class="num">Starts</th><th class="num">Completed</th></tr></thead><tbody>${audioPart}</tbody></table>${audioMore}</div>
    </div><script>(function(){var btns=document.querySelectorAll("[data-metrics-more]");btns.forEach(function(btn){var label=btn.textContent;var count=(btn.closest(".panel-block")?.querySelector("[data-metrics-panel]")?.querySelectorAll("tr").length||0);btn.addEventListener("click",function(){var panel=btn.closest(".panel-block")?.querySelector("[data-metrics-panel]");if(!panel)return;var expanded=btn.getAttribute("aria-expanded")==="true";btn.setAttribute("aria-expanded",expanded?"false":"true");panel.hidden=expanded;btn.textContent=expanded?"Show "+count+" more":"Hide";try{btn.blur();}catch(e){}});});})();</script>`;
  }

  return shell(
    `Metrics — ${tenant.title}`,
    `<div class="page"><div class="row"><h1 style="margin:0">Metrics</h1><div class="actions" style="margin:0">${rangeLinks}</div></div>${content}<p style="color:var(--muted);font-size:.8rem">Visitors are anonymous first-party browser identifiers. Metrics may take a short time to appear.</p></div>`,
    account,
    tenant
  );
}

export function forgotPasswordPage(message = "", error = ""): string {
  return shell(
    "Reset password",
    `<div class="page narrow"><h1>Reset your password</h1>${message ? `<div class="notice">${esc(message)}</div>` : ""}${error ? `<div class="error">${esc(error)}</div>` : ""}<p style="color:var(--muted)">Enter your account email and, if it matches an account, we'll send a reset link.</p><form method="post" action="/admin/forgot"><label for="reset-email">Email</label><input id="reset-email" name="email" type="email" autocomplete="email" required><button class="btn" type="submit">Send reset link</button></form><p style="margin-top:1.4rem;color:var(--muted);font-size:.9rem"><a href="/admin/login">Back to sign in</a></p></div>`
  );
}

export function resetPasswordPage(token: string, error = ""): string {
  return shell(
    "Choose a new password",
    `<div class="page narrow"><h1>Choose a new password</h1>${error ? `<div class="error">${esc(error)}</div>` : ""}<form method="post" action="/admin/reset"><input type="hidden" name="token" value="${esc(token)}"><label for="new-password">New password <span style="color:var(--muted)">(8+ characters)</span></label><input id="new-password" name="password" type="password" autocomplete="new-password" minlength="8" required><label for="confirm-password">Confirm password</label><input id="confirm-password" name="confirm" type="password" autocomplete="new-password" minlength="8" required><button class="btn" type="submit">Set new password</button></form><p style="margin-top:1.4rem;color:var(--muted);font-size:.9rem"><a href="/admin/forgot">Request another reset link</a></p></div>`
  );
}

export function auditPage(
  account: Account,
  tenant: Tenant,
  entries: AuditEntry[] | null,
  options?: { error?: string; paid?: boolean; page?: number; hasMore?: boolean }
): string {
  const page = Number.isSafeInteger(options?.page as number) && (options?.page as number) >= 1 ? (options!.page as number) : 1;
  const hasMore = !!options?.hasMore;
  const content = options?.paid === false
    ? `<div class="notice"><strong>Audit log is a Pro feature.</strong><br>Upgrade to review blog actions for the last 90 days.</div>`
    : entries === null
      ? `<div class="error">${esc(options?.error || "Audit log could not be loaded. Please try again shortly.")}</div>`
      : entries.length
        ? `<table class="metrics"><thead><tr><th>Time</th><th>Action</th><th>Target</th><th>Actor</th></tr></thead><tbody>${entries.map((entry) => `<tr><td>${esc(entry.occurredAt)}</td><td>${esc(entry.action.replaceAll("_", " "))}</td><td>${esc(entry.target || "—")}</td><td>${esc(entry.actor || "—")}</td></tr>`).join("")}</tbody></table>`
        : `<p style="color:var(--muted)">No blog actions recorded in the last 90 days.</p>`;
  const pagination = options?.paid === false || entries === null
    ? ""
    : `<nav class="pagination" style="display:flex;align-items:center;gap:10px;justify-content:flex-end;margin-top:12px"><span>Page ${page}</span>${page > 1 ? `<a class="btn" href="/admin/b/${esc(tenant.public_id)}/audit?page=${page - 1}">← Previous</a>` : ""}${hasMore ? `<a class="btn" href="/admin/b/${esc(tenant.public_id)}/audit?page=${page + 1}">Next →</a>` : ""}</nav>`;
  return shell(
    `Audit log — ${tenant.title}`,
    `<div class="page"><div class="row"><h1 style="margin:0">Audit log</h1><span style="color:var(--muted);font-size:.85rem">Last 90 days</span></div><p style="color:var(--muted);margin-top:-.8rem">Private administrative actions for this blog. Content and secrets are never recorded.</p><div class="notice" style="margin-bottom:1rem"><strong>Logs may take a short time to appear.</strong> Audit events are stored in Cloudflare Analytics, which is eventually consistent. This is especially noticeable for a new blog; an empty log does not mean logging is disabled. Refresh this page shortly after an action.</div><div class="panel-block">${content}</div>${pagination}</div>`,
    account,
    tenant
  );
}

export type MediaItem = {
  key: string;
  name: string;
  url: string;
  size: number;
  uploaded: string;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function mediaCards(items: MediaItem[], selectable = false): string {
  if (!items.length) return `<p style="color:var(--muted)">No images uploaded yet.</p>`;
  return `<div class="media-grid">${items.map((item) => {
    const inner = `<img src="${esc(item.url)}" alt="" loading="lazy"><div class="media-card-body"><div class="media-name" title="${esc(item.name)}">${esc(item.name)}</div><div class="media-meta">${formatBytes(item.size)} · ${esc(new Date(item.uploaded).toLocaleDateString())}</div></div>`;
    return selectable
      ? `<button class="media-card media-pick" type="button" data-url="${esc(item.url)}" data-name="${esc(item.name)}">${inner}</button>`
      : `<article class="media-card">${inner}<div class="media-card-body" style="padding-top:0"><button class="btn danger media-delete" type="button" data-key="${esc(item.key)}">Delete</button></div></article>`;
  }).join("")}</div>`;
}

export function mediaPage(account: Account, tenant: Tenant, items: MediaItem[]): string {
  const base = `/admin/b/${tenant.public_id}`;
  return shell(
    `Media — ${tenant.title}`,
    `<div class="page">
      <div class="row"><div><h1 style="margin:0">Media</h1><div style="color:var(--muted);font-size:.85rem">Upload once and reuse images in any post.</div></div><button class="btn" type="button" id="media-upload">Upload images</button></div>
      <input id="media-input" type="file" accept="image/*" multiple hidden>
      <div id="media-status" class="notice" hidden></div>
      <div id="media-list">${mediaCards(items)}</div>
    </div>
    <script>
      (function () {
        var input=document.getElementById("media-input"), status=document.getElementById("media-status");
        document.getElementById("media-upload").addEventListener("click",function(){input.click();});
        input.addEventListener("change",function(){
          var files=Array.from(input.files || []); if(!files.length)return;
          status.hidden=false; status.textContent="Uploading " + files.length + " image(s)…";
          Promise.all(files.map(function(file){var fd=new FormData();fd.append("file",file,file.name);return fetch("${base}/upload",{method:"POST",body:fd}).then(function(r){if(!r.ok)throw new Error();return r.json();});}))
            .then(function(){location.reload();}).catch(function(){status.className="error";status.textContent="One or more uploads failed. Images must be JPEG, PNG, GIF, WebP, or AVIF and no larger than 15 MB.";});
          input.value="";
        });
        document.addEventListener("click",function(e){
          var btn=e.target.closest(".media-delete"); if(!btn)return;
          if(!confirm("Delete this image permanently?"))return;
          btn.disabled=true;
          fetch("${base}/media/"+encodeURIComponent(btn.dataset.key.split("/").pop()),{method:"DELETE"}).then(function(r){return r.json().then(function(data){return {ok:r.ok,data:data};});}).then(function(result){
            if(!result.ok){alert(result.data.error || "This image could not be deleted.");btn.disabled=false;return;}
            btn.closest(".media-card").remove();
          }).catch(function(){alert("This image could not be deleted.");btn.disabled=false;});
        });
      })();
    </script>`, account, tenant);
}

export function editorPage(
  account: Account,
  tenant: Tenant,
  rootDomain: string,
  post: Partial<Post> | null,
  error?: string,
  authors: Array<{ id: number; label: string }> = []
): string {
  const base = `/admin/b/${tenant.public_id}`;
  const isEdit = !!post?.id;
  const action = isEdit ? `${base}/save?id=${post!.id}` : `${base}/save`;
  const title = esc(post?.title ?? "");
  const slug = esc(post?.slug ?? "");
  const body = esc(post?.body_md ?? "");
  const tags = (() => { try { const value = JSON.parse(post?.tags_json || "[]"); return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === "string").join(", ") : ""; } catch { return ""; } })();
  const featuredKey = post?.featured_image_key ?? "";
  const audioKey = post?.audio_key ?? "";
  const authorId = post?.author_account_id ?? account.id;
  const authorName = post?.author_name ?? "";
  const authorVisible = post?.author_visible !== 0;
  const published = post ? post.published !== 0 : true;
  const viewUrl = `https://${esc(tenant.slug)}.${esc(rootDomain)}/${slug}`;

  return shell(
    isEdit ? `Edit — ${tenant.title}` : `New post — ${tenant.title}`,
    `<div class="page">
      <div class="breadcrumb"><a href="/admin?list=1">blognice</a> / <a href="${base}">${esc(tenant.title)}</a> / ${isEdit ? "Edit post" : "New post"}</div>
      <h1>${isEdit ? "Edit post" : "New post"}</h1>
      ${error ? `<div class="error">${esc(error)}</div>` : ""}
      <form id="post-editor-form" method="post" action="${action}" autocomplete="off">
        <label for="title">Title</label>
        <input id="title" name="title" type="text" value="${title}" required>
        <label for="slug">URL slug <span style="color:var(--muted)">(leave blank to generate from the title)</span></label>
        <input id="slug" name="slug" type="text" value="${slug}" placeholder="my-post">
        <label for="tags">Post tags</label>
        <input id="tags" name="tags" type="text" value="${esc(tags)}" placeholder="technology, writing, cloudflare">
        <p style="color:var(--muted);font-size:.85rem;margin:-.5rem 0 1.2rem">Add comma-separated tags to group related posts.</p>

        ${authors.length ? `<label for="author-visibility">Attribution</label>
        <select id="author-visibility" name="author_visibility"><option value="author"${authorVisible ? " selected" : ""}>Show an author</option><option value="none"${authorVisible ? "" : " selected"}>Show only the blog identity</option></select>
        <label for="author-account">Author</label>
        <select id="author-account" name="author_account_id">${authors.map((author) => `<option value="${author.id}"${author.id === authorId ? " selected" : ""}>${esc(author.label)}</option>`).join("")}</select>
        <label for="author-name">Public author name <span style="color:var(--muted)">(optional; defaults to the selected account)</span></label>
        <input id="author-name" name="author_name" type="text" value="${esc(authorName)}" maxlength="120" placeholder="e.g. Joe Bloggs" autocomplete="off">
        <p style="color:var(--muted);font-size:.85rem;margin:-.5rem 0 1.2rem">The blog identity remains separate from the person credited on this post.</p>` : ""}

        <label>Featured image <span style="color:var(--muted)">(used on the post and in lists)</span></label>
        <input id="featured-image-key" name="featured_image_key" type="hidden" value="${esc(featuredKey)}">
        <div class="featured-picker">
          <button type="button" id="featured-preview-trigger" class="featured-preview-button"${featuredKey ? "" : " hidden"} aria-label="View featured image larger"><img id="featured-preview" class="featured-preview" src="${featuredKey ? `/media/${esc(featuredKey)}` : ""}" alt="Featured image"></button>
          <div class="actions" style="margin:0">
            <button class="btn ghost" type="button" id="choose-featured">${featuredKey ? "Change" : "Choose image"}</button>
            <button class="btn ghost" type="button" id="generate-image">Generate with AI</button>
            <button class="btn danger" type="button" id="remove-featured"${featuredKey ? "" : " hidden"}>Remove</button>
          </div>
        </div>
        <dialog class="image-lightbox" id="featured-lightbox" aria-label="Featured image preview">
          <div class="image-lightbox-body"><button type="button" class="image-lightbox-close" id="featured-lightbox-close">Close</button><img id="featured-lightbox-image" src="${featuredKey ? `/media/${esc(featuredKey)}` : ""}" alt="Featured image enlarged"></div>
        </dialog>

        <label>Audio narration <span style="color:var(--muted)">(generated from the last saved version)</span></label>
        <div class="audio-picker">
          <audio id="audio-preview" controls preload="none" src="${audioKey ? `/media/${esc(audioKey)}` : ""}"${audioKey ? "" : " hidden"}></audio>
          <div class="actions">
            ${isEdit ? `<button class="btn ghost" type="button" id="generate-audio"${audioKey ? " hidden" : ""}>Generate audio</button>
            <button class="btn danger" type="button" id="remove-audio"${audioKey ? "" : " hidden"}>Remove audio</button>` : `<span style="color:var(--muted);font-size:.9rem">Save this post before generating audio.</span>`}
          </div>
          <div id="audio-status" class="notice" style="margin:.8rem 0 0" hidden></div>
        </div>

        <div class="tabs" role="tablist">
          <button class="tab active" type="button" id="tab-write" aria-selected="true">Write</button>
          <button class="tab" type="button" id="tab-preview" aria-selected="false">Preview</button>
          <span class="spacer"></span>
          <button class="tab img-btn" type="button" id="add-image">🖼 Add image</button>
          <input type="file" id="file-input" accept="image/*" multiple hidden>
        </div>
        <p class="markdown-intro" id="markdown-intro">You can write normally. Markdown adds formatting when you want it—select some text and use these buttons.</p>
        <div class="markdown-tools" id="markdown-tools" role="toolbar" aria-label="Text formatting">
          <button class="markdown-tool" type="button" aria-label="Heading" title="Heading" data-prefix="## ">Heading</button>
          <button class="markdown-tool" type="button" aria-label="Bold" title="Bold" data-prefix="**" data-suffix="**">B</button>
          <button class="markdown-tool" type="button" aria-label="Italic" title="Italic" data-prefix="_" data-suffix="_"><em>I</em></button>
          <button class="markdown-tool" type="button" aria-label="Add a link" title="Add a link" data-prefix="[" data-suffix="](https://)">Link</button>
          <button class="markdown-tool" type="button" aria-label="Bulleted list" title="Bulleted list" data-prefix="- ">List</button>
          <button class="markdown-tool" type="button" aria-label="Quote" title="Quote" data-prefix="&gt; ">Quote</button>
          <button class="markdown-tool auto-format" type="button" id="auto-format" title="Use one AI credit to add Markdown formatting">✨ Auto-format</button>
        </div>
        <div class="notice" id="auto-format-status" aria-live="polite" hidden></div>
        <details class="markdown-help" id="markdown-help">
          <summary>Markdown formatting help</summary>
          <div class="markdown-help-content">
            <section class="markdown-help-section" aria-labelledby="markdown-help-text"><h3 id="markdown-help-text">Text and headings</h3><div class="markdown-help-grid">
              <p><code># to ######</code><span>Six heading levels</span></p>
              <p><code>**bold**</code><span>Bold</span></p>
              <p><code>_italic_</code><span>Italic</span></p>
              <p><code>***both***</code><span>Bold and italic</span></p>
              <p><code>~~removed~~</code><span>Strikethrough</span></p>
              <p><code>&gt; quote</code><span>Block quotation</span></p>
            </div></section>
            <section class="markdown-help-section" aria-labelledby="markdown-help-structure"><h3 id="markdown-help-structure">Structure</h3><div class="markdown-help-grid">
              <p><code>- item</code><span>Bulleted list</span></p>
              <p><code>1. item</code><span>Numbered list</span></p>
              <p><code>&nbsp;&nbsp;- item</code><span>Nested list</span></p>
              <p><code>---</code><span>Divider</span></p>
              <p><code>Blank line</code><span>New paragraph</span></p>
              <p><code>Two spaces + Return</code><span>Line break</span></p>
            </div></section>
            <section class="markdown-help-section" aria-labelledby="markdown-help-links"><h3 id="markdown-help-links">Links, media, and code</h3><div class="markdown-help-grid">
              <p><code>[text](https://example.com)</code><span>Link</span></p>
              <p><code>[Jump](#heading-name)</code><span>Link to a heading</span></p>
              <p><code>![Alt text](https://example.com/image.jpg)</code><span>Image—Add image is easier</span></p>
              <p><code>&#96;code&#96;</code><span>Inline code</span></p>
              <p><code>&#96;&#96;&#96; … &#96;&#96;&#96;</code><span>Code block</span></p>
              <p><code>&#92;*not italic&#92;*</code><span>Show Markdown symbols</span></p>
            </div></section>
            <section class="markdown-help-section" aria-labelledby="markdown-help-table"><h3 id="markdown-help-table">Table</h3><div class="markdown-help-grid">
              <p><code>| Name | Note |<br>| --- | --- |<br>| Ada | Writer |</code><span>Header, divider row, then values</span></p>
            </div></section>
            <p class="markdown-help-note">Use the Preview tab to check the result. Raw HTML is removed for safety.</p>
          </div>
        </details>
        <dialog class="media-dialog" id="media-dialog">
          <div class="media-dialog-head"><strong id="media-dialog-title">Choose from media</strong><span class="spacer"></span><button class="btn ghost" type="button" id="media-close">Close</button></div>
          <div class="media-dialog-body" id="media-dialog-body"><p style="color:var(--muted)">Loading…</p></div>
        </dialog>
        <dialog class="media-dialog" id="ai-dialog">
          <div class="media-dialog-head"><strong>Generate an image</strong><span class="spacer"></span><button class="btn ghost" type="button" id="ai-close">Close</button></div>
          <div class="media-dialog-body">
            <label for="ai-style">Style</label>
            <select id="ai-style">
              <option value="auto">Let AI decide</option>
              <option value="editorial-photo">Editorial photograph</option>
              <option value="editorial-illustration">Editorial illustration</option>
              <option value="cinematic">Cinematic</option>
              <option value="child-crayon">Child's crayon drawing</option>
              <option value="arcade-action">Arcade action pixel art</option>
              <option value="risograph">Risograph print</option>
              <option value="paper-collage">Paper collage</option>
              <option value="watercolor">Watercolour illustration</option>
              <option value="minimal">Minimal</option>
            </select>
            <label for="ai-prompt">Creative direction <span style="color:var(--muted)">(optional override)</span></label>
            <textarea id="ai-prompt" maxlength="1200" rows="5" placeholder="Leave blank to use this post. Enter a direction to use it instead, for example: a lone night-shift train driver in a fluorescent cab…"></textarea>
            <div style="color:var(--muted);font-size:.85rem">The post supplies the subject by default. A creative direction replaces the post context rather than being combined with it.</div>
            <div id="ai-status" class="notice" hidden></div>
            <div id="ai-result" class="ai-result" hidden>
              <img id="ai-preview" alt="Generated image preview">
              <div>
                <div style="color:var(--muted);font-size:.85rem">Saved to your media library.</div>
                <div class="actions" style="margin-top:.7rem">
                  <button class="btn" type="button" id="ai-featured">Use as featured</button>
                  <button class="btn ghost" type="button" id="ai-insert">Insert in post</button>
                </div>
              </div>
            </div>
            <div class="actions"><button class="btn" type="button" id="ai-generate">Generate image</button></div>
          </div>
        </dialog>
        <div class="editor">
          <textarea id="body" name="body_md" spellcheck="true" aria-describedby="markdown-intro markdown-help" placeholder="Start writing… (drag, paste, or add an image)">${body}</textarea>
          <div id="preview" class="preview" hidden></div>
        </div>

        <div class="check">
          <input id="published" name="published" type="checkbox" ${published ? "checked" : ""}>
          <label for="published">Published</label>
        </div>
        <div class="actions">
          <button class="btn" type="submit" name="save" value="close">Save &amp; close</button>
          <button class="btn ghost" type="button" id="save-continue">Save &amp; continue</button>
          <a class="btn ghost" href="${base}">Cancel</a>
          <span class="spacer"></span>
          ${isEdit ? `<a class="btn ghost" href="${viewUrl}" target="_blank">View</a>` : ""}
        </div>
      </form>
      <div class="save-toast" id="save-status" role="status" aria-live="polite" hidden></div>
    </div>
    <script>
      (function () {
        var body = document.getElementById("body");
        var preview = document.getElementById("preview");
        var tw = document.getElementById("tab-write");
        var tp = document.getElementById("tab-preview");
        var markdownTools = document.getElementById("markdown-tools");
        var autoFormat = document.getElementById("auto-format");
        var autoFormatStatus = document.getElementById("auto-format-status");
        var autoFormatUndo = null;
        var lastRendered = null;

        function show(which) {
          var writing = which === "write";
          body.hidden = !writing;
          preview.hidden = writing;
          tw.classList.toggle("active", writing);
          tp.classList.toggle("active", !writing);
          tw.setAttribute("aria-selected", writing);
          tp.setAttribute("aria-selected", !writing);
          markdownTools.hidden = !writing;
          if (writing) body.focus();
        }

        markdownTools.addEventListener("click", function (event) {
          var button = event.target.closest("button[data-prefix]");
          if (!button) return;
          var start = body.selectionStart;
          var end = body.selectionEnd;
          var selected = body.value.slice(start, end);
          var prefix = button.dataset.prefix || "";
          var suffix = button.dataset.suffix || "";
          if (!selected && button.getAttribute("aria-label") === "Add a link") selected = "link text";
          var replacement = prefix + selected + suffix;
          body.setRangeText(replacement, start, end, "end");
          body.focus();
          if (selected === "link text") body.setSelectionRange(start + prefix.length, start + prefix.length + selected.length);
          body.dispatchEvent(new Event("input", { bubbles:true }));
        });

        autoFormat.addEventListener("click", function () {
          var original = body.value;
          if (!original.trim()) {
            autoFormatStatus.className = "error";
            autoFormatStatus.textContent = "Write something before using auto-format.";
            autoFormatStatus.hidden = false;
            return;
          }
          autoFormat.disabled = true;
          var stopTimer = startGeneration(autoFormatStatus, "Adding Markdown formatting…");
          fetch("${base}/format-markdown", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: original })
          }).then(function (response) {
            return response.json().then(function (data) {
              if (!response.ok) throw new Error(data.error || "Auto-format failed.");
              return data;
            });
          }).then(function (data) {
            if (body.value !== original) throw new Error("Your draft changed while formatting, so it was left untouched. Run auto-format again when you are ready.");
            autoFormatUndo = original;
            body.value = data.markdown;
            body.dispatchEvent(new Event("input", { bubbles:true }));
            autoFormatStatus.className = "notice";
            autoFormatStatus.innerHTML = (data.warning ? data.warning : 'Markdown formatting added. Review it before saving.') + ' <button class="btn ghost" type="button" id="undo-auto-format">Undo auto-format</button>';
            document.getElementById("undo-auto-format").addEventListener("click", function () {
              if (autoFormatUndo === null) return;
              body.value = autoFormatUndo;
              autoFormatUndo = null;
              body.dispatchEvent(new Event("input", { bubbles:true }));
              autoFormatStatus.textContent = "Auto-format undone.";
              body.focus();
            });
            body.focus();
          }).catch(function (error) {
            autoFormatStatus.className = "error";
            autoFormatStatus.textContent = error.message || "Auto-format failed. Your draft has not been changed.";
          }).finally(function () {
            stopTimer();
            autoFormat.disabled = false;
          });
        });

        function renderPreview() {
          if (body.value === lastRendered) return;      // skip if unchanged
          lastRendered = body.value;
          preview.innerHTML = '<p style="color:var(--muted)">Rendering…</p>';
          fetch("/admin/preview", {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: body.value,
          })
            .then(function (r) { return r.text(); })
            .then(function (html) {
              preview.innerHTML = html || '<p style="color:var(--muted)">Nothing to preview yet.</p>';
            })
            .catch(function () {
              preview.innerHTML = '<p style="color:var(--danger)">Preview failed. Try again.</p>';
            });
        }

        tw.addEventListener("click", function () { show("write"); });
        tp.addEventListener("click", function () { renderPreview(); show("preview"); });

        // --- Image upload ---------------------------------------------------
        var uploadUrl = "${base}/upload";
        var fileInput = document.getElementById("file-input");
        var addImage = document.getElementById("add-image");
        var mediaDialog = document.getElementById("media-dialog");
        var mediaDialogBody = document.getElementById("media-dialog-body");
        var mediaDialogTitle = document.getElementById("media-dialog-title");
        var featuredInput = document.getElementById("featured-image-key");
        var featuredPreview = document.getElementById("featured-preview");
        var featuredPreviewTrigger = document.getElementById("featured-preview-trigger");
        var featuredLightbox = document.getElementById("featured-lightbox");
        var featuredLightboxImage = document.getElementById("featured-lightbox-image");
        var chooseFeatured = document.getElementById("choose-featured");
        var removeFeatured = document.getElementById("remove-featured");
        var aiDialog = document.getElementById("ai-dialog");
        var aiStatus = document.getElementById("ai-status");
        var aiResult = document.getElementById("ai-result");
        var aiGenerate = document.getElementById("ai-generate");
        var audioPreview = document.getElementById("audio-preview");
        var generateAudio = document.getElementById("generate-audio");
        var removeAudio = document.getElementById("remove-audio");
        var audioStatus = document.getElementById("audio-status");
        audioPreview.preservesPitch = true;
        audioPreview.defaultPlaybackRate = 0.88;
        audioPreview.playbackRate = 0.88;
        var generatedImage = null;
        var pickerMode = "body", nextUploadTarget = "body";
        var isExistingPost = ${isEdit ? "true" : "false"};
        var editorForm = document.getElementById("post-editor-form");
        var saveContinue = document.getElementById("save-continue");
        var saveStatus = document.getElementById("save-status");
        var featuredSavePending = false;
        var saveStatusTimer = null;

        function showSaved() {
          clearTimeout(saveStatusTimer);
          saveStatus.className = "save-toast";
          saveStatus.textContent = "Saved";
          saveStatus.hidden = false;
          saveStatusTimer = setTimeout(function () { saveStatus.hidden = true; }, 3000);
        }

        function saveAndContinue() {
          if (saveContinue.disabled) return;
          var originalLabel = saveContinue.textContent;
          var formData = new FormData(editorForm);
          formData.set("save", "continue");
          saveContinue.disabled = true;
          saveContinue.textContent = "Saving…";
          fetch(editorForm.action, {
            method: "POST",
            headers: { "accept": "application/json", "x-blognice-save": "continue" },
            body: formData
          }).then(function (response) {
            if (!response.ok) throw new Error("This post could not be saved. Please try again.");
            return response.json();
          }).then(function (result) {
            if (!result.saved || !result.id) throw new Error("This post could not be saved. Please try again.");
            var editUrl = "${base}/edit/" + encodeURIComponent(result.id);
            editorForm.action = "${base}/save?id=" + encodeURIComponent(result.id);
            history.replaceState(null, "", editUrl);
            isExistingPost = true;
            showSaved();
          }).catch(function (error) {
            saveStatus.className = "save-toast error";
            saveStatus.textContent = error.message;
            saveStatus.hidden = false;
          }).finally(function () {
            featuredSavePending = false;
            saveContinue.disabled = false;
            saveContinue.textContent = originalLabel;
          });
        }
        saveContinue.addEventListener("click", saveAndContinue);

        function startGeneration(status, message) {
          var started = Date.now();
          status.className = "notice";
          status.hidden = false;
          status.innerHTML = '<span class="generation-status"><span class="generation-spinner" aria-hidden="true"></span><span>' + message + ' <strong data-generation-seconds>0s</strong></span></span>';
          var seconds = status.querySelector("[data-generation-seconds]");
          var timer = setInterval(function () {
            if (seconds) seconds.textContent = Math.floor((Date.now() - started) / 1000) + "s";
          }, 250);
          return function () { clearInterval(timer); };
        }

        function setAiBusy(busy) {
          aiDialog.querySelectorAll("button,select,textarea").forEach(function (control) { control.disabled = busy; });
        }

        function setFeatured(key, url) {
          featuredInput.value = key || "";
          featuredPreview.src = url || "";
          featuredPreviewTrigger.hidden = !key;
          featuredPreview.alt = key ? "Featured image" : "";
          featuredLightboxImage.src = url || "";
          removeFeatured.hidden = !key;
          chooseFeatured.textContent = key ? "Change" : "Choose image";
          if (isExistingPost && !featuredSavePending) {
            featuredSavePending = true;
            setTimeout(function () { saveAndContinue(); }, 0);
          }
        }

        featuredPreviewTrigger.addEventListener("click", function () {
          if (featuredInput.value) featuredLightbox.showModal();
        });
        document.getElementById("featured-lightbox-close").addEventListener("click", function () { featuredLightbox.close(); });

        // Insert text at the textarea cursor, replacing a token if given.
        function insertAtCursor(text) {
          var s = body.selectionStart, e = body.selectionEnd;
          body.value = body.value.slice(0, s) + text + body.value.slice(e);
          var pos = s + text.length;
          body.selectionStart = body.selectionEnd = pos;
          body.focus();
        }
        function replaceToken(token, text) {
          var i = body.value.indexOf(token);
          if (i === -1) { insertAtCursor(text); return; }
          body.value = body.value.slice(0, i) + text + body.value.slice(i + token.length);
        }

        // Downscale + recompress to WebP in the browser (skips GIFs to keep
        // animation). Returns a Blob.
        function shrink(file) {
          if (file.type === "image/gif") return Promise.resolve(file);
          return new Promise(function (resolve) {
            var img = new Image();
            img.onload = function () {
              var maxW = 1600;
              var scale = Math.min(1, maxW / img.width);
              var w = Math.round(img.width * scale), h = Math.round(img.height * scale);
              var canvas = document.createElement("canvas");
              canvas.width = w; canvas.height = h;
              canvas.getContext("2d").drawImage(img, 0, 0, w, h);
              canvas.toBlob(
                function (b) { resolve(b || file); },
                "image/webp",
                0.85
              );
            };
            img.onerror = function () { resolve(file); };
            img.src = URL.createObjectURL(file);
          });
        }

        var uploadCount = 0;
        function uploadImage(file, target) {
          if (!file || file.type.indexOf("image/") !== 0) return;
          var token = target === "featured" ? "" : "![uploading image " + (++uploadCount) + "…]()";
          if (token) insertAtCursor("\\n" + token + "\\n");
          shrink(file).then(function (blob) {
            var name = (file.name || "image").replace(/\\.[^.]+$/, "") +
              (blob.type === "image/webp" ? ".webp" : "");
            var fd = new FormData();
            fd.append("file", blob, name);
            return fetch(uploadUrl, { method: "POST", body: fd });
          }).then(function (r) { return r.json(); })
            .then(function (data) {
              if (data && data.url && target === "featured") setFeatured(data.key, data.url);
              else if (data && data.url) replaceToken(token, "![](" + data.url + ")");
              else if (token) replaceToken(token, "");
            })
            .catch(function () { if (token) replaceToken(token, ""); });
        }

        function handleFiles(files, target) {
          for (var i = 0; i < files.length; i++) {
            uploadImage(files[i], target || "body");
            if (target === "featured") break;
          }
        }

        function openLibrary(mode) {
          pickerMode = mode;
          mediaDialogTitle.textContent = mode === "featured" ? "Choose featured image" : "Choose from media";
          mediaDialog.showModal();
          fetch("${base}/media.json").then(function(r){if(!r.ok)throw new Error();return r.json();}).then(function(data){
            if(!data.items.length){mediaDialogBody.innerHTML='<p style="color:var(--muted)">No images yet. <button class="btn" type="button" id="dialog-upload">Upload one</button></p>';}
            else mediaDialogBody.innerHTML='<div class="media-grid">'+data.items.map(function(item){return '<button class="media-card media-pick" type="button" data-key="'+item.key+'" data-url="'+item.url.replace(/&/g,"&amp;").replace(/\"/g,"&quot;")+'"><img src="'+item.url+'" alt="" loading="lazy"><div class="media-card-body"><div class="media-name">'+item.name.replace(/&/g,"&amp;").replace(/</g,"&lt;")+'</div><div class="media-meta">Click to '+(mode === "featured" ? "select" : "insert")+'</div></div></button>';}).join('')+'</div><div class="actions"><button class="btn" type="button" id="dialog-upload">Upload new</button><a class="btn ghost" href="${base}/media">Manage media</a></div>';
            document.getElementById("dialog-upload").onclick=function(){nextUploadTarget=pickerMode;mediaDialog.close();fileInput.click();};
          }).catch(function(){mediaDialogBody.innerHTML='<p class="error">Could not load media.</p>';});
        }
        addImage.addEventListener("click", function () { openLibrary("body"); });
        chooseFeatured.addEventListener("click", function () { openLibrary("featured"); });
        removeFeatured.addEventListener("click", function () { setFeatured("", ""); });
        document.getElementById("media-close").addEventListener("click",function(){mediaDialog.close();});
        mediaDialogBody.addEventListener("click",function(e){var pick=e.target.closest(".media-pick");if(!pick)return;if(pickerMode === "featured")setFeatured(pick.dataset.key,pick.dataset.url);else insertAtCursor("\\n![]("+pick.dataset.url+")\\n");mediaDialog.close();});
        document.getElementById("generate-image").addEventListener("click", function () {
          generatedImage = null; aiStatus.hidden = true; aiResult.hidden = true; aiDialog.showModal();
        });
        document.getElementById("ai-close").addEventListener("click", function () { aiDialog.close(); });
        aiGenerate.addEventListener("click", function () {
          var button = this;
          button.disabled = true; aiResult.hidden = true; setAiBusy(true);
          var stopTimer = startGeneration(aiStatus, "Creating your image…");
          var creativeDirection = document.getElementById("ai-prompt").value.trim();
          var imageRequest = {
            style: document.getElementById("ai-style").value,
            prompt: creativeDirection
          };
          // A direction override is intentionally independent of the article;
          // do not send the full draft over the wire in that mode.
          if (!creativeDirection) {
            imageRequest.postTitle = document.getElementById("title").value;
            imageRequest.postBody = body.value;
          }
          fetch("${base}/media/generate", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify(imageRequest)
          }).then(function(r){return r.json().then(function(data){return {ok:r.ok,data:data};});})
            .then(function(result){
              if(!result.ok) throw new Error(result.data.error || "Image generation failed.");
              generatedImage = result.data;
              document.getElementById("ai-preview").src = generatedImage.url;
              stopTimer(); aiStatus.textContent = "Image generated successfully."; aiResult.hidden = false;
            }).catch(function(error){stopTimer(); aiStatus.className="error";aiStatus.textContent=error.message || "Image generation failed.";})
            .finally(function(){button.disabled=false; setAiBusy(false);});
        });
        document.getElementById("ai-featured").addEventListener("click", function () {
          if (!generatedImage) return; setFeatured(generatedImage.key, generatedImage.url); aiDialog.close();
        });
        document.getElementById("ai-insert").addEventListener("click", function () {
          if (!generatedImage) return; insertAtCursor("\\n![Generated image](" + generatedImage.url + ")\\n"); aiDialog.close();
        });
        if (generateAudio) generateAudio.addEventListener("click", function () {
          var button = this;
          button.disabled = true; if (removeAudio) removeAudio.disabled = true;
          var stopTimer = startGeneration(audioStatus, "Queueing narration…");
          function poll(jobId) {
            return fetch("${base}/audio/${post?.id ?? ""}/status?job=" + encodeURIComponent(jobId))
              .then(function(r){return r.json().then(function(data){return {ok:r.ok,data:data};});})
              .then(function(result){
                if (!result.ok || result.data.error) throw new Error(result.data.error || "Audio job status unavailable.");
                if (result.data.status === "complete") return result.data;
                if (result.data.status === "failed") throw new Error(result.data.error || "Audio generation failed.");
                audioStatus.textContent = (result.data.status === "queued" ? "Narration queued" : "Generating narration") + " — " + result.data.completed + "/" + result.data.segments + " segments";
                return new Promise(function(resolve){setTimeout(function(){resolve(poll(jobId));}, 2500);});
              });
          }
          fetch("${base}/audio/${post?.id ?? ""}", { method: "POST" })
            .then(function(r){return r.json().then(function(data){return {ok:r.ok,data:data};});})
            .then(function(result){
              if(!result.ok || result.data.error) throw new Error(result.data.error || "Audio generation failed.");
              return poll(result.data.jobId);
            })
            .then(function(result){
              audioPreview.src = result.url; audioPreview.hidden = false; audioPreview.load(); audioPreview.playbackRate = 0.88;
              removeAudio.hidden = false; button.hidden = true;
              stopTimer(); audioStatus.textContent = "Narration generated and published.";
            }).catch(function(error){stopTimer(); audioStatus.className="error";audioStatus.textContent=error.message || "Audio generation failed.";})
            .finally(function(){button.disabled=false; if (removeAudio) removeAudio.disabled = false;});
        });
        if (removeAudio) removeAudio.addEventListener("click", function () {
          if (!confirm("Remove the narration from this post?")) return;
          var button = this; button.disabled = true;
          fetch("${base}/audio/${post?.id ?? ""}", { method: "DELETE" })
            .then(function(r){return r.json().then(function(data){return {ok:r.ok,data:data};});})
            .then(function(result){
              if(!result.ok) throw new Error(result.data.error || "Could not remove audio.");
              audioPreview.pause(); audioPreview.removeAttribute("src"); audioPreview.load(); audioPreview.hidden = true;
              button.hidden = true; generateAudio.hidden = false;
              audioStatus.className = "notice"; audioStatus.hidden = false; audioStatus.textContent = "Narration removed.";
            }).catch(function(error){audioStatus.className="error";audioStatus.hidden=false;audioStatus.textContent=error.message || "Could not remove audio.";})
            .finally(function(){button.disabled=false;});
        });
        fileInput.addEventListener("change", function () {
          handleFiles(fileInput.files, nextUploadTarget); nextUploadTarget = "body"; fileInput.value = "";
        });

        // Drag and drop onto the textarea.
        ["dragover", "dragenter"].forEach(function (ev) {
          body.addEventListener(ev, function (e) { e.preventDefault(); body.classList.add("dragover"); });
        });
        ["dragleave", "dragend", "drop"].forEach(function (ev) {
          body.addEventListener(ev, function () { body.classList.remove("dragover"); });
        });
        body.addEventListener("drop", function (e) {
          if (e.dataTransfer && e.dataTransfer.files.length) {
            e.preventDefault(); handleFiles(e.dataTransfer.files, "body");
          }
        });

        // Paste an image from the clipboard.
        body.addEventListener("paste", function (e) {
          var items = e.clipboardData && e.clipboardData.items;
          if (!items) return;
          for (var i = 0; i < items.length; i++) {
            if (items[i].type.indexOf("image/") === 0) {
              var f = items[i].getAsFile();
              if (f) { e.preventDefault(); uploadImage(f, "body"); }
            }
          }
        });
      })();
    </script>`,
    account,
    tenant
  );
}

type BlogRow = { public_id: string; slug: string; title: string; role?: string; description?: string | null; avatar_key?: string | null; topics_json?: string | null };

// Account home: the list of blogs this account can manage.
export function blogListPage(
  account: Account,
  ownedBlogs: BlogRow[],
  collaborations: BlogRow[],
  rootDomain: string
): string {
  const setup = (b: BlogRow) => {
    let topics: unknown[] = [];
    try { topics = JSON.parse(b.topics_json || "[]"); } catch { /* malformed metadata is simply incomplete */ }
    const items = [
      [Boolean(b.title), "Blog title", "settings"],
      [Boolean(b.description?.trim()), "Tagline", "settings"],
      [Boolean(b.avatar_key), "Profile photo", "settings"],
      [topics.length > 0, "Topics", "settings"],
    ] as const;
    const complete = items.filter(([ok]) => ok).length;
    if (complete === items.length) return `<div class="sub" style="color:var(--success,#287a3d);margin-top:.35rem">Setup complete · <a href="https://${esc(b.slug)}.${esc(rootDomain)}" target="_blank">Preview blog</a></div>`;
    return `<div class="sub" style="margin-top:.35rem">Setup ${complete}/${items.length} · ${items.filter(([ok]) => !ok).map(([, label]) => `<a href="/admin/b/${esc(b.public_id)}/settings">${label}</a>`).join(" · ")}</div>`;
  };
  const list = (blogs: BlogRow[], showRole = false) =>
    blogs.length === 0
      ? `<p style="color:var(--muted)">You don't have any blogs yet.</p>`
      : `<ul class="posts">${blogs
          .map(
            (b) => `<li>
              <div>
                <div class="t"><a href="/admin/b/${esc(b.public_id)}">${esc(b.title)}</a></div>
                <div class="sub">${esc(b.slug)}.${esc(rootDomain)}${showRole && b.role ? ` · ${esc(b.role)}` : ""}</div>
                ${!showRole ? setup(b) : ""}
              </div>
              <div class="acts">
                <a class="btn ghost" href="https://${esc(b.slug)}.${esc(rootDomain)}" target="_blank">Visit</a>
                <a class="btn" href="/admin/b/${esc(b.public_id)}">Manage</a>
              </div>
            </li>`
          )
          .join("")}</ul>`;

  return shell(
    "Your blogs",
    `<div class="page">
      <div class="row">
        <h1 style="margin:0">Your blogs</h1>
        <a class="btn" href="/admin/new-blog">New blog</a>
      </div>
      ${list(ownedBlogs)}
      <h2 style="margin-top:2.5rem">Collaborations</h2>
      <p style="color:var(--muted);margin-top:-.8rem">Blogs you help manage. These do not count toward your blog quota.</p>
      ${list(collaborations, true)}
    </div>`,
    account
  );
}

// Create an additional blog for an existing account.
export function newBlogPage(
  account: Account,
  rootDomain: string,
  values?: { slug?: string; title?: string },
  error?: string
): string {
  const slug = esc(values?.slug ?? "");
  const title = esc(values?.title ?? "");
  const paid = accountHasPaidPlan(account);
  return shell(
    "New blog",
    `<div class="page narrow">
      <h1>New blog</h1>
      ${paid ? "" : `<div class="notice"><strong>Free plan:</strong> You can create one blog. Upgrade to create up to five blogs, use custom domains, invite collaborators, and unlock AI features.</div>`}
      ${error ? `<div class="error">${esc(error)}</div>` : ""}
      <form method="post" action="/admin/new-blog">
        <label for="slug">Blog address</label>
        <input id="slug" name="slug" type="text" value="${slug}" placeholder="yourname"
               autocapitalize="none" autocorrect="off" spellcheck="false" required>
        <div style="margin:-0.6rem 0 1rem;color:var(--muted);font-size:0.82rem">
          <span id="preview">yourname</span>.${esc(rootDomain)}
        </div>
        <label for="title">Blog title</label>
        <input id="title" name="title" type="text" value="${title}" placeholder="My Blog" required>
        <div class="actions">
          <button class="btn" type="submit">Create blog</button>
          <a class="btn ghost" href="/admin">Cancel</a>
        </div>
      </form>
    </div>
    <script>
      (function () {
        var s = document.getElementById("slug"), p = document.getElementById("preview");
        function clean(v){ return v.toLowerCase().replace(/[^a-z0-9-]/g,"").replace(/^-+|-+$/g,""); }
        s.addEventListener("input", function () { p.textContent = clean(s.value) || "yourname"; });
      })();
    </script>`,
    account
  );
}

// Blog settings: profile photo (avatar), title, and tagline.
export function settingsPage(
  account: Account,
  tenant: Tenant,
  opts?: { notice?: string; error?: string }
): string {
  const base = `/admin/b/${tenant.public_id}`;
  const initial = (tenant.title.trim()[0] || "?").toUpperCase();
  const avatar = tenant.avatar_key
    ? `<img id="avatar-preview" class="avatar-lg" src="/media/${esc(tenant.avatar_key)}" alt="">`
    : `<span id="avatar-preview" class="avatar-lg">${esc(initial)}</span>`;

  return shell(
    `Settings — ${tenant.title}`,
    `<div class="page">
      <h1>Settings</h1>
      ${opts?.error ? `<div class="error">${esc(opts.error)}</div>` : ""}
      ${opts?.notice ? `<div class="notice">${esc(opts.notice)}</div>` : ""}

      <label>Profile photo</label>
      <div class="avatar-row">
        ${avatar}
        <div>
          <button class="btn ghost" type="button" id="avatar-upload">Upload photo</button>
          <button class="btn danger" type="button" id="avatar-remove"${tenant.avatar_key ? "" : " hidden"}>Remove</button>
          <input type="file" id="avatar-input" accept="image/*" hidden>
          <div id="avatar-status" class="meta" style="margin-top:0.4rem"></div>
        </div>
      </div>
      <p style="color:var(--muted);font-size:0.85rem;margin:0.4rem 0 1.8rem">
        Shown next to your name on every post. Square images look best.
      </p>

      <label>Browser icon</label>
      <div style="display:flex;align-items:center;gap:.7rem;margin:0 0 1.8rem">
        <button class="btn ghost" type="button" id="favicon-upload">${tenant.favicon_key ? "Replace favicon" : "Upload favicon"}</button>
        <button class="btn danger" type="button" id="favicon-remove"${tenant.favicon_key ? "" : " hidden"}>Remove</button>
        <input type="file" id="favicon-input" accept="image/png,image/x-icon,.ico" hidden>
        <span id="favicon-status" class="meta">PNG or ICO, up to 1 MB.</span>
      </div>

      <form method="post" action="${base}/settings">
        <label for="slug">Blog address</label>
        <input id="slug" name="slug" type="text" value="${esc(tenant.slug)}" autocapitalize="none" autocorrect="off" spellcheck="false" required>
        <p style="color:#b42318;font-size:1rem;font-weight:700;line-height:1.45;margin:-.35rem 0 1.2rem">I understand this changes the blog address. Existing links may be broken by this change.</p>
        <label for="title">Blog title</label>
        <input id="title" name="title" type="text" value="${esc(tenant.title)}" required>
        <label for="description">Tagline</label>
        <input id="description" name="description" type="text" value="${esc(tenant.description)}" placeholder="A short description of your blog">
        <label for="header-link">Header link</label>
        <input id="header-link" name="header_link_url" type="text" value="${esc((tenant as any).header_link_url || "/")}" placeholder="/" maxlength="500">
        <p style="color:var(--muted);font-size:.85rem;margin:-.5rem 0 1.2rem">Where the logo and title link. Use <code>/</code> for the blog home or a full <code>https://</code> URL for a parent site. External links open in a new tab.</p>
        <fieldset class="settings-card"><legend>Reader notifications</legend>
          <p class="help">Allow readers to opt in to browser notifications when this blog publishes a new post. Readers must still grant permission in their browser.</p>
          <label><input type="checkbox" name="browser_push_enabled" value="1"${tenant.browser_push_enabled ? " checked" : ""}> Enable browser notifications for this blog</label>
        </fieldset>
        <label for="footer-name">Footer publisher name</label>
        <input id="footer-name" name="footer_name" type="text" value="${esc(tenant.footer_name || "")}" maxlength="160" placeholder="Defaults to your blog title">
        <p style="color:var(--muted);font-size:.85rem;margin:-.5rem 0 1.2rem">Shown in the public footer. This is useful when the blog represents a company or publication; leave blank to use the blog title.</p>
        <label for="topics">Blog topics</label>
        <textarea id="topics" name="topics" rows="3" placeholder="technology, photography, travel">${esc(tenantTopics(tenant).join(", "))}</textarea>
        <p style="color:var(--muted);font-size:.85rem;margin:-.5rem 0 1.2rem">Add up to 50 topics, separated by commas. They help group blogs with similar themes; the first six appear publicly.</p>
        <fieldset class="settings-card social-links-card"><legend>Social profiles</legend>
          <p class="help">These links are public and will appear on your blog when social links are enabled. Leave a field blank to hide it. Use your profile or channel URL, not an individual post.</p>
          <div class="social-grid">
            ${SOCIAL_LINK_FIELDS.slice(0, 6).map(([key, label, placeholder]) => `<div><label for="social-${key}">${esc(label)}</label><input id="social-${key}" name="social_${key}" type="url" value="${esc(tenantSocialLinks(tenant)[key] || "")}" placeholder="${esc(placeholder)}" maxlength="500" inputmode="url" autocomplete="url"></div>`).join("")}
          </div>
          <div class="social-more">More platforms</div>
          <div class="social-grid">
            ${SOCIAL_LINK_FIELDS.slice(6).map(([key, label, placeholder]) => `<div><label for="social-${key}">${esc(label)}</label><input id="social-${key}" name="social_${key}" type="url" value="${esc(tenantSocialLinks(tenant)[key] || "")}" placeholder="${esc(placeholder)}" maxlength="500" inputmode="url" autocomplete="url"></div>`).join("")}
          </div>
        </fieldset>
        <label for="accent-color">Brand colour</label>
        <div class="accent-presets" role="group" aria-label="Brand colour presets">
          ${ACCENT_PRESETS.map(([label, value]) => `<button class="accent-preset${normalizeAccentColor(tenant.accent_color) === value ? " selected" : ""}" type="button" data-accent-preset="${value}" aria-label="${esc(label)}" aria-pressed="${normalizeAccentColor(tenant.accent_color) === value ? "true" : "false"}"><span class="accent-swatch" style="background:${value}"></span>${esc(label)}</button>`).join("")}
        </div>
        <div style="display:flex;align-items:center;gap:.7rem;margin-bottom:1rem">
          <input id="accent-color" name="accent_color" type="color" value="${esc(normalizeAccentColor(tenant.accent_color))}" style="width:3.2rem;height:2.4rem;padding:.15rem;margin:0;cursor:pointer">
          <input id="accent-color-hex" type="text" value="${esc(normalizeAccentColor(tenant.accent_color))}" pattern="#[0-9a-fA-F]{6}" maxlength="7" style="max-width:10rem;margin:0;font-family:var(--mono)" aria-label="Brand colour hex value">
        </div>
        <p style="color:var(--muted);font-size:.85rem;margin:-.5rem 0 1.4rem">Used for links, buttons, highlights, and other accents on this blog and its dashboard.</p>
        <div class="actions">
          <button class="btn" type="submit">Save</button>
          <a class="btn ghost" href="${base}">Done</a>
        </div>
      </form>
    </div>
    <script>
      (function () {
        var input = document.getElementById("avatar-input");
        var uploadBtn = document.getElementById("avatar-upload");
        var removeBtn = document.getElementById("avatar-remove");
        var status = document.getElementById("avatar-status");
        var preview = document.getElementById("avatar-preview");
        var color = document.getElementById("accent-color");
        var colorHex = document.getElementById("accent-color-hex");
        var presets = Array.prototype.slice.call(document.querySelectorAll("[data-accent-preset]"));
        var faviconInput = document.getElementById("favicon-input");
        var faviconUpload = document.getElementById("favicon-upload");
        var faviconRemove = document.getElementById("favicon-remove");
        var faviconStatus = document.getElementById("favicon-status");
        function markPreset(value) {
          presets.forEach(function (button) {
            var selected = button.getAttribute("data-accent-preset") === value.toLowerCase();
            button.classList.toggle("selected", selected);
            button.setAttribute("aria-pressed", selected ? "true" : "false");
          });
        }
        color.addEventListener("input", function () { colorHex.value = color.value; });
        color.addEventListener("input", function () { markPreset(color.value); });
        colorHex.addEventListener("input", function () { if (/^#[0-9a-f]{6}$/i.test(colorHex.value)) { color.value = colorHex.value; markPreset(colorHex.value); } });
        presets.forEach(function (button) { button.addEventListener("click", function () { var value = button.getAttribute("data-accent-preset"); color.value = value; colorHex.value = value; markPreset(value); }); });

        function shrink(file) {
          return new Promise(function (resolve) {
            var img = new Image();
            img.onload = function () {
              var size = 400;
              var scale = Math.min(1, size / Math.max(img.width, img.height));
              var w = Math.round(img.width * scale), h = Math.round(img.height * scale);
              var canvas = document.createElement("canvas");
              canvas.width = w; canvas.height = h;
              canvas.getContext("2d").drawImage(img, 0, 0, w, h);
              canvas.toBlob(function (b) { resolve(b || file); }, "image/webp", 0.85);
            };
            img.onerror = function () { resolve(file); };
            img.src = URL.createObjectURL(file);
          });
        }

        function swapPreview(url) {
          // Replace the monogram span with an <img> (or update existing src).
          if (preview.tagName === "IMG") { preview.src = url; return; }
          var img = document.createElement("img");
          img.id = "avatar-preview"; img.className = "avatar-lg"; img.alt = ""; img.src = url;
          preview.replaceWith(img); preview = img;
        }

        uploadBtn.addEventListener("click", function () { input.click(); });
        input.addEventListener("change", function () {
          var file = input.files[0];
          if (!file) return;
          status.textContent = "Uploading…";
          shrink(file).then(function (blob) {
            var fd = new FormData();
            fd.append("file", blob, "avatar.webp");
            return fetch("${base}/avatar", { method: "POST", body: fd });
          }).then(function (r) { return r.json(); })
            .then(function (data) {
              if (data && data.url) { swapPreview(data.url); removeBtn.hidden = false; status.textContent = "Saved."; }
              else status.textContent = "Upload failed.";
            })
            .catch(function () { status.textContent = "Upload failed."; });
          input.value = "";
        });

        removeBtn.addEventListener("click", function () {
          status.textContent = "Removing…";
          fetch("${base}/avatar/remove", { method: "POST" })
            .then(function () {
              var span = document.createElement("span");
              span.id = "avatar-preview"; span.className = "avatar-lg";
              span.textContent = ${JSON.stringify(initial)};
              preview.replaceWith(span); preview = span;
              removeBtn.hidden = true; status.textContent = "Removed.";
            })
            .catch(function () { status.textContent = "Couldn't remove."; });
        });

        function normalizeFavicon(file) {
          var sizes = [16, 32, 48, 256];
          return new Promise(function (resolve, reject) {
            var url = URL.createObjectURL(file), img = new Image();
            img.onload = async function () {
              try {
                var result = [];
                for (var index = 0; index < sizes.length; index++) {
                  var size = sizes[index];
                  faviconStatus.textContent = "Preparing " + size + "×" + size + "…";
                  var scale = Math.min(size / img.width, size / img.height);
                  var w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
                  var canvas = document.createElement("canvas"); canvas.width = size; canvas.height = size;
                  var context = canvas.getContext("2d");
                  if (!context) throw new Error("Your browser could not prepare the favicon image.");
                  context.clearRect(0, 0, size, size);
                  context.drawImage(img, Math.round((size - w) / 2), Math.round((size - h) / 2), w, h);
                  var blob = await new Promise(function (ok, fail) {
                    canvas.toBlob(function (encoded) {
                      if (encoded) ok(encoded); else fail(new Error("Your browser could not encode the favicon."));
                    }, "image/png");
                  });
                  result.push({ size: size, blob: blob });
                }
                resolve(result);
              } catch (error) { reject(error); }
              URL.revokeObjectURL(url);
            };
            img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("Could not read that image. Please choose a PNG or ICO file.")); };
            img.src = url;
          });
        }
        var faviconBusy = false;
        faviconUpload.addEventListener("click", function () {
          if (faviconBusy) return;
          // Clear the previous selection before opening the picker. Without this,
          // choosing the same file twice does not reliably emit a change event.
          faviconInput.value = "";
          faviconStatus.textContent = "Choose a PNG or ICO file.";
          if (typeof faviconInput.showPicker === "function") faviconInput.showPicker();
          else faviconInput.click();
        });
        faviconInput.addEventListener("change", async function () {
          var file = faviconInput.files && faviconInput.files[0];
          if (!file || faviconBusy) return;
          if (file.size > 1024 * 1024) { faviconStatus.textContent = "Favicon is too large (maximum 1 MB)."; faviconInput.value = ""; return; }
          faviconBusy = true;
          faviconUpload.disabled = true;
          faviconUpload.setAttribute("aria-busy", "true");
          faviconStatus.textContent = "Preparing favicon…";
          var controller = new AbortController();
          var timeout = setTimeout(function () { controller.abort(); }, 30000);
          try {
            var normalized = await normalizeFavicon(file);
            var fd = new FormData();
            normalized.forEach(function (item) { fd.append("icon" + item.size, item.blob, "favicon-" + item.size + ".png"); });
            fd.append("original_name", file.name || "favicon");
            faviconStatus.textContent = "Uploading favicon…";
            var response = await fetch("${base}/favicon", { method: "POST", body: fd, signal: controller.signal });
            var text = await response.text();
            var data = {};
            try { data = text ? JSON.parse(text) : {}; }
            catch (_) { data = { error: text ? text.slice(0, 500) : "The server returned an empty response." }; }
            if (!response.ok) throw new Error(data.error || "Upload failed (HTTP " + response.status + ").");
            if (!data || !data.ok) throw new Error(data && data.error ? data.error : "The server did not confirm the favicon was saved.");
            faviconRemove.hidden = false;
            faviconUpload.textContent = "Replace favicon";
            faviconStatus.textContent = "Saved. Refresh browser tabs to see it.";
          } catch (error) {
            faviconStatus.textContent = error && error.name === "AbortError"
              ? "Upload timed out after 30 seconds. Please try again."
              : (error && error.message ? error.message : "Upload failed.");
          } finally {
            clearTimeout(timeout);
            faviconBusy = false;
            faviconUpload.disabled = false;
            faviconUpload.removeAttribute("aria-busy");
            faviconInput.value = "";
          }
        });
        faviconRemove.addEventListener("click", function () {
          faviconStatus.textContent = "Removing…";
          fetch("${base}/favicon/remove", { method: "POST" }).then(function () { faviconRemove.hidden = true; faviconUpload.textContent = "Upload favicon"; faviconStatus.textContent = "Removed."; }).catch(function () { faviconStatus.textContent = "Couldn't remove."; });
        });
      })();
    </script>`,
    account,
    tenant
  );
}

// Subscriber list for a blog, with CSV export and per-row removal.
export function subscribersPage(
  account: Account,
  tenant: Tenant,
  subs: Array<{ email: string; created_at: number }>,
  emailOn: boolean,
  options?: { page?: number; hasMore?: boolean; total?: number }
): string {
  const base = `/admin/b/${tenant.public_id}`;
  const page = Number.isSafeInteger(options?.page as number) && (options?.page as number) >= 1 ? (options!.page as number) : 1;
  const hasMore = !!options?.hasMore;
  const total = typeof options?.total === "number" ? options!.total as number : undefined;
  const countLabel = typeof total === "number" ? total : subs.length;
  const list =
    subs.length === 0 && page === 1
      ? `<p style="color:var(--muted)">No subscribers yet. The subscribe box appears on your blog's home page and under each post.</p>`
      : subs.length === 0
        ? `<p style="color:var(--muted)">No subscribers on this page.</p>`
        : `<ul class="posts">${subs
          .map(
            (s) => `<li>
              <div>
                <div class="t">${esc(s.email)}</div>
                <div class="sub">${formatDate(s.created_at)}</div>
              </div>
              <div class="acts">
                <form method="post" action="${base}/subscribers/remove" onsubmit="return confirm('Remove this subscriber?')">
                  <input type="hidden" name="email" value="${esc(s.email)}">
                  <button class="btn danger" type="submit">Remove</button>
                </form>
              </div>
            </li>`
          )
          .join("")}</ul>`;
  const pagination = `<nav class="pagination" style="display:flex;align-items:center;gap:10px;justify-content:flex-end;margin-top:12px"><span>Page ${page}</span>${page > 1 ? `<a class="btn" href="${base}/subscribers?page=${page - 1}">← Previous</a>` : ""}${hasMore ? `<a class="btn" href="${base}/subscribers?page=${page + 1}">Next →</a>` : ""}</nav>`;
  const showPagination = subs.length > 0 || page > 1 || hasMore;
  return shell(
    `Subscribers — ${tenant.title}`,
    `<div class="page">
      <div class="row">
        <h1 style="margin:0">Subscribers <span style="color:var(--muted);font-weight:400">(${countLabel})</span></h1>
        ${(typeof total === "number" ? total : subs.length) ? `<a class="btn ghost" href="${base}/subscribers.csv">Export CSV</a>` : ""}
      </div>
      ${
        emailOn
          ? ""
          : `<div class="notice" style="background:color-mix(in srgb, var(--ink) 6%, transparent);color:var(--muted)">
               Email Integration TODO
             </div>`
      }
      ${list}
      ${showPagination ? pagination : ""}
    </div>`,
    account,
    tenant
  );
}

// Account-level API key management + quick-start docs. The full key is only
// ever passed in via `opts.newKey` right after generation (shown once).
export function apiKeyPage(
  account: Account,
  rootDomain: string,
  opts: { createdAt: number | null; newKey?: string; blogs?: Array<{ public_id: string; title: string; slug: string }> }
): string {
  const base = `https://www.${esc(rootDomain)}/api/v1`;
  const has = opts.createdAt != null;
  const paid = accountHasPaidPlan(account);
  const exampleBlogId = opts.blogs?.[0]?.public_id || "BLOG_ID";
  const blogIds = opts.blogs?.length
    ? `<div class="panel-block"><strong>Your blog IDs</strong><ul>${opts.blogs.map((blog) => `<li><code>${esc(blog.public_id)}</code> — ${esc(blog.title)} <span style="color:var(--muted)">(${esc(blog.slug)})</span></li>`).join("")}</ul><p style="color:var(--muted);font-size:.85rem;margin-bottom:0">Use the opaque ID in API paths; post IDs remain numeric.</p></div>`
    : `<p style="color:var(--muted)">Create a blog first; its public ID will appear here.</p>`;

  const reveal = opts.newKey
    ? `<div class="notice" style="background:color-mix(in srgb, var(--accent) 10%, transparent)">
         <strong>Here's your new API key — copy it now.</strong> For your security it
         won't be shown again. If you lose it, generate a new one (which replaces this one).
         <div style="display:flex;gap:0.5rem;margin-top:0.7rem">
           <input id="apikey" type="text" readonly value="${esc(opts.newKey)}"
                  style="flex:1;font-family:ui-monospace,Menlo,monospace;font-size:0.9rem" onclick="this.select()">
           <button class="btn" type="button" onclick="navigator.clipboard.writeText(document.getElementById('apikey').value);this.textContent='Copied'">Copy</button>
         </div>
       </div>`
    : "";

  const status = has
    ? `<p>An API key is active${
        opts.createdAt ? ` (created ${formatDate(opts.createdAt)})` : ""
      }. Only its hash is stored, so it can't be shown again — regenerate to get a new one.</p>
       <div class="actions">
         <form method="post" action="/admin/api-key/regenerate" onsubmit="return confirm('Regenerate? The current key stops working immediately.')">
           <button class="btn" type="submit">Regenerate key</button>
         </form>
         <form method="post" action="/admin/api-key/revoke" onsubmit="return confirm('Revoke your API key? Any scripts using it stop working.')">
           <button class="btn danger" type="submit">Revoke</button>
         </form>
       </div>`
    : paid
      ? `<p style="color:var(--muted)">You don't have an API key yet. Generate one to manage your blogs and posts programmatically.</p>
         <form method="post" action="/admin/api-key/regenerate">
           <button class="btn" type="submit">Generate API key</button>
         </form>`
      : `<p style="color:var(--muted)">API keys are available after upgrading to a paid plan.</p>`;

  return shell(
    "API",
    `<div class="page">
      <h1>API access</h1>
      ${paid ? "" : `<div class="notice"><strong>API access is a paid-plan feature.</strong> Upgrade to generate an API key.</div>`}
      ${reveal}
      ${status}

      <h2 style="font-size:1.15rem;margin-top:2.2rem">Using your key</h2>
      <p>Send it as a bearer token. Base URL: <code>${base}</code></p>
      ${blogIds}
      <pre style="background:color-mix(in srgb, var(--ink) 5%, transparent);padding:1rem;border-radius:8px;overflow-x:auto;font-size:0.85rem;line-height:1.5"># List blogs and IDs
curl ${base}/me \\
  -H "Authorization: Bearer YOUR_KEY"

# Create a published post with tags and a public author name
curl -X POST ${base}/blogs/${exampleBlogId}/posts \\
  -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" \\
  -d '{"title":"Hello from the API","body_md":"# Hello\\n\\nWritten via Markdown.","tags":["api","automation"],"author_name":"AI & BIG AI","author_visible":true,"published":true}'

# Create a draft
curl -X POST ${base}/blogs/${exampleBlogId}/posts \\
  -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" \\
  -d '{"title":"A draft","body_md":"Work in progress.","published":false}'

# List and fetch posts
curl ${base}/blogs/${exampleBlogId}/posts -H "Authorization: Bearer YOUR_KEY"
curl ${base}/blogs/${exampleBlogId}/posts/POST_ID -H "Authorization: Bearer YOUR_KEY"

# Re-queue IndexNow discovery for the homepage, feeds, and published posts
curl -X POST ${base}/blogs/${exampleBlogId}/indexnow \\
  -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" \\
  -d '{"post_ids":[POST_ID]}'

# Update metadata and assign an existing featured image
curl -X PATCH ${base}/blogs/${exampleBlogId}/posts/POST_ID \\
  -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" \\
  -d '{"title":"Updated title","tags":["updates"],"author_name":null,"author_visible":false,"featured_image_key":"${exampleBlogId}/image.jpg","published":true}'

# Generate an image from a prompt or a post, then poll its job
curl -X POST ${base}/blogs/${exampleBlogId}/images/generations \\
  -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" \\
  -d '{"prompt":"A portrait of a watchmaker at work","style":"editorial-photo"}'
# or from an existing post: -d '{"post_id":POST_ID,"style":"auto"}'  # styles: editorial-photo, editorial-illustration, cinematic, child-crayon, arcade-action, risograph, paper-collage, watercolor, minimal, auto
curl ${base}/blogs/${exampleBlogId}/images/generations/IMAGE_JOB_ID \\
  -H "Authorization: Bearer YOUR_KEY"

# Generate narration, then poll its job
curl -X POST ${base}/blogs/${exampleBlogId}/posts/POST_ID/audio/generations \\
  -H "Authorization: Bearer YOUR_KEY"
curl ${base}/blogs/${exampleBlogId}/audio/generations/AUDIO_JOB_ID \\
  -H "Authorization: Bearer YOUR_KEY"

# Remove narration from a post (idempotent)
curl -X DELETE ${base}/blogs/${exampleBlogId}/posts/POST_ID/audio \\
  -H "Authorization: Bearer YOUR_KEY"

# Delete a post
curl -X DELETE ${base}/blogs/${exampleBlogId}/posts/POST_ID \\
  -H "Authorization: Bearer YOUR_KEY"

# Blog details and settings
curl ${base}/blogs/${exampleBlogId} -H "Authorization: Bearer YOUR_KEY"
curl -X PATCH ${base}/blogs/${exampleBlogId} -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" -d '{"title":"New title","description":"A calmer blog.","accent_color":"#2563eb","topics":["travel","photography"],"navigation_links":[{"label":"Shop","href":"https://www.domain.com/shop","order":0}],"browser_push_enabled":true}'
curl -X POST ${base}/blogs -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" -d '{"slug":"my-new-blog","title":"My New Blog"}'

# Pages (create, list, fetch, update, delete)
curl ${base}/blogs/${exampleBlogId}/pages -H "Authorization: Bearer YOUR_KEY"
curl -X POST ${base}/blogs/${exampleBlogId}/pages -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" -d '{"title":"About","slug":"about","body_md":"# About\\nWe love writing.","published":true,"show_in_navigation":true}'
curl ${base}/blogs/${exampleBlogId}/pages/PAGE_ID -H "Authorization: Bearer YOUR_KEY"
curl -X PATCH ${base}/blogs/${exampleBlogId}/pages/PAGE_ID -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" -d '{"title":"About us","published":true}'
curl -X DELETE ${base}/blogs/${exampleBlogId}/pages/PAGE_ID -H "Authorization: Bearer YOUR_KEY"

# Media library
curl ${base}/blogs/${exampleBlogId}/media -H "Authorization: Bearer YOUR_KEY"
curl -X POST ${base}/blogs/${exampleBlogId}/media -H "Authorization: Bearer YOUR_KEY" -F file=@photo.jpg
curl -X DELETE "${base}/blogs/${exampleBlogId}/media?key=KEY" -H "Authorization: Bearer YOUR_KEY"

# Metrics and tags
curl "${base}/blogs/${exampleBlogId}/metrics?days=30" -H "Authorization: Bearer YOUR_KEY"
curl ${base}/blogs/${exampleBlogId}/tags -H "Authorization: Bearer YOUR_KEY"</pre>
      <p style="color:var(--muted);font-size:0.85rem">
        In these examples, <code>BLOG_ID</code> means the opaque <code>public_id</code>
        returned by <code>GET /me</code> (for example <code>ggh6gvgsgj4h</code>), not
        the internal numeric tenant ID. Post IDs remain numeric.<br><br>
        Endpoints: <code>GET /me</code>, <code>GET /blogs/:id</code> / <code>PATCH /blogs/:id</code> / <code>POST /blogs</code>,
        <code>GET/POST /blogs/:id/posts</code>, <code>GET/PATCH/DELETE /blogs/:id/posts/:postId</code>,
        <code>GET/POST /blogs/:id/pages</code>, <code>GET/PATCH/DELETE /blogs/:id/pages/:pageId</code>,
        <code>GET/POST/DELETE /blogs/:id/media</code>, <code>GET /blogs/:id/metrics</code> (<code>?days=7|30|90</code>), <code>GET /blogs/:id/tags</code>,
        plus asynchronous <code>images/generations</code> and <code>posts/:postId/audio/generations</code>
        jobs with status endpoints, <code>DELETE /blogs/:id/posts/:postId/audio</code> to
        remove narration, and <code>POST /blogs/:id/indexnow</code> to
        re-queue discovery for published pages. Its optional body accepts
        <code>post_ids</code> and/or <code>paths</code>; an empty body queues the
        homepage, sitemap, and RSS feed. Post creation and updates accept <code>tags</code>,
        <code>author_name</code>, <code>author_visible</code>, and a validated
        <code>featured_image_key</code>; image generation accepts <code>prompt</code> or
        <code>post_id</code> with <code>style</code> (see above); pages accept <code>title</code>, <code>slug</code>, <code>body_md</code>, <code>published</code>, <code>show_in_navigation</code>, <code>navigation_label</code>, <code>navigation_order</code>, <code>meta_description</code>; blogs accept <code>slug</code>, <code>title</code>, <code>description</code>, <code>accent_color</code>, <code>topics</code>, <code>social_links</code>, <code>navigation_links</code> (<code>{label, href, order}</code> with https or / paths), <code>browser_push_enabled</code>; use the returned job URLs to poll AI work.
        Everything is scoped to blogs you own.
      </p>
    </div>`,
    account
  );
}
