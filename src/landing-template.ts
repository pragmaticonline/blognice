// Landing page template engine.
//
// Landing designs are plain HTML files (src/landing-designs/<id>/design.html)
// with a deliberately tiny, logic-less placeholder syntax, so a new design can
// be contributed with HTML and CSS alone — no TypeScript renderer per design.
//
//   {{a.b}}            value, HTML-escaped (always)
//   {{{x_html}}}       raw HTML — ONLY for keys ending in "_html", which the
//                      engine/view builder produces from sanitized sources
//   {{#a}}…{{/a}}      array: repeat per item (item becomes the context)
//                      other truthy value: render once
//   {{^a}}…{{/a}}      render when a is missing, false, "" or []
//   {{! comment }}     removed
//
// Lookups walk the context stack outward, so inside {{#features}} you can still
// read {{site.title}}. As in Mustache, the FIRST context that has the first path
// segment wins; if a deeper segment is missing there, the result is empty (no
// further fall-through). There are no helpers, partials, or expressions on
// purpose: anything computed belongs in buildLandingView(), where it is tested once.

export type TemplateView = Record<string, unknown>;

type Token =
  | { kind: "text"; value: string }
  | { kind: "var"; path: string; raw: boolean }
  | { kind: "section"; path: string; inverted: boolean; children: Token[] };

const TAG = /\{\{\{\s*([\w.]+)\s*\}\}\}|\{\{\s*([#^/!]?)\s*([^}]*?)\s*\}\}/g;

export class TemplateError extends Error {}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function parseTemplate(source: string): Token[] {
  const root: Token[] = [];
  const stack: { path: string; children: Token[] }[] = [{ path: "", children: root }];
  let last = 0;
  for (const m of source.matchAll(TAG)) {
    const top = stack[stack.length - 1];
    if (m.index! > last) top.children.push({ kind: "text", value: source.slice(last, m.index) });
    last = m.index! + m[0].length;
    if (m[1] !== undefined) {
      if (!m[1].endsWith("_html"))
        throw new TemplateError(`Raw output {{{${m[1]}}}} is only allowed for keys ending in "_html".`);
      top.children.push({ kind: "var", path: m[1], raw: true });
      continue;
    }
    const sigil = m[2];
    const path = m[3];
    if (sigil === "!") continue;
    if (!/^[\w.]+$/.test(path)) throw new TemplateError(`Invalid placeholder {{${sigil}${path}}}.`);
    if (sigil === "#" || sigil === "^") {
      const node: Token = { kind: "section", path, inverted: sigil === "^", children: [] };
      top.children.push(node);
      stack.push({ path, children: node.children });
    } else if (sigil === "/") {
      if (stack.length === 1 || top.path !== path)
        throw new TemplateError(`Unexpected {{/${path}}}; expected {{/${top.path || "(none)"}}}.`);
      stack.pop();
    } else {
      top.children.push({ kind: "var", path, raw: false });
    }
  }
  if (stack.length > 1) throw new TemplateError(`Unclosed section {{#${stack[stack.length - 1].path}}}.`);
  if (last < source.length) root.push({ kind: "text", value: source.slice(last) });
  return root;
}

function lookup(contexts: unknown[], path: string): unknown {
  const parts = path.split(".");
  for (let i = contexts.length - 1; i >= 0; i--) {
    let value: unknown = contexts[i];
    if (value === null || typeof value !== "object") continue;
    if (!(parts[0] in (value as object))) continue;
    for (const part of parts) {
      if (value === null || typeof value !== "object") return undefined;
      value = (value as Record<string, unknown>)[part];
    }
    return value;
  }
  return undefined;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === false || value === "" ||
    (Array.isArray(value) && value.length === 0);
}

function renderTokens(tokens: Token[], contexts: unknown[]): string {
  let out = "";
  for (const t of tokens) {
    if (t.kind === "text") out += t.value;
    else if (t.kind === "var") {
      const value = lookup(contexts, t.path);
      if (value === undefined || value === null || value === false) continue;
      out += t.raw ? String(value) : escapeHtml(String(value));
    } else {
      const value = lookup(contexts, t.path);
      if (t.inverted) {
        if (isEmpty(value)) out += renderTokens(t.children, contexts);
      } else if (Array.isArray(value)) {
        for (const item of value) out += renderTokens(t.children, [...contexts, item]);
      } else if (!isEmpty(value)) {
        out += renderTokens(t.children, typeof value === "object" ? [...contexts, value] : contexts);
      }
    }
  }
  return out;
}

// Bounded: only registry templates should ever be rendered, but never let an
// unexpected caller grow this without limit.
const parsedCache = new Map<string, Token[]>();
const PARSED_CACHE_MAX = 32;

export function renderTemplate(source: string, view: TemplateView): string {
  let tokens = parsedCache.get(source);
  if (!tokens) {
    tokens = parseTemplate(source);
    if (parsedCache.size >= PARSED_CACHE_MAX) parsedCache.clear();
    parsedCache.set(source, tokens);
  }
  return renderTokens(tokens, [view]);
}

// --- Design validation ------------------------------------------------------
// Run by the conformance test suite for every registered design, so a design
// that breaks a platform rule fails CI instead of reaching visitors.

export type DesignManifest = {
  id: string;
  label: string;
  description: string;
  author: string;
  sections: string[];
};

export const SECTION_CLASSES: Record<string, string> = {
  hero: "lp-hero",
  ctas: "lp-ctas",
  intro: "lp-intro",
  features: "lp-features",
  contact: "lp-contact",
  posts: "lp-posts",
};

export function validateDesign(id: string, source: string, manifest: DesignManifest): string[] {
  const errors: string[] = [];
  try {
    parseTemplate(source);
  } catch (e) {
    errors.push((e as Error).message);
    return errors;
  }
  if (manifest.id !== id) errors.push(`design.json id "${manifest.id}" must match folder name "${id}".`);
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(id)) errors.push(`Design id "${id}" must be lowercase letters, digits and dashes.`);
  for (const key of ["label", "description", "author"] as const)
    if (!String(manifest[key] ?? "").trim()) errors.push(`design.json needs a "${key}".`);
  for (const s of manifest.sections ?? [])
    if (!SECTION_CLASSES[s]) errors.push(`Unknown section "${s}" in design.json.`);

  const headSlot = source.indexOf("{{{head_html}}}");
  if (headSlot < 0) errors.push("Missing {{{head_html}}} in <head> (meta tags, theme script, owner custom CSS).");
  const lastStyle = source.lastIndexOf("</style>");
  if (headSlot >= 0 && lastStyle > headSlot)
    errors.push("Design <style> must come before {{{head_html}}} so the owner's custom CSS wins.");
  if (!/<body[^>]*\{\{\{body_attrs_html\}\}\}/.test(source)) errors.push("<body> must include {{{body_attrs_html}}}.");
  if (!/\{\{\{body_end_html\}\}\}\s*<\/body>/.test(source)) errors.push("{{{body_end_html}}} must come immediately before </body> (consent banner, metrics).");
  if (!source.includes("{{blog_url}}")) errors.push("Design must link to the blog with {{blog_url}}.");
  if (/\{\{#nav(_all)?\}\}/.test(source) && !source.includes("{{#nav_more}}"))
    errors.push("Designs that render {{#nav}}/{{#nav_all}} must also render {{#nav_more}} in a .lp-menu (mobile overflow menu).");
  if (/<script/i.test(source)) errors.push("Designs must not contain <script>.");
  if (/<(iframe|object|embed|form)\b/i.test(source)) errors.push("Designs must not contain iframes, embeds or forms.");
  if (/(src|href)\s*=\s*["']?\s*(https?:)?\/\//i.test(source) || /url\(\s*["']?\s*(https?:)?\/\//i.test(source) || /@import/i.test(source))
    errors.push("Designs must not load external resources (images, fonts, stylesheets). Use {{placeholders}} and system fonts.");
  if (/@media\s*\(\s*prefers-color-scheme/i.test(source))
    errors.push('Use html[data-theme=dark] for dark mode, not @media (prefers-color-scheme).');
  if (!/html\[data-theme=dark\]/.test(source)) errors.push("Design must define dark-mode tokens under html[data-theme=dark].");
  if (!/@media\s*\(\s*max-width/i.test(source)) errors.push("Design must include phone styles (@media (max-width: …)).");
  for (const s of manifest.sections ?? []) {
    const cls = SECTION_CLASSES[s];
    if (cls && !new RegExp(`class="[^"]*\\b${cls}\\b`).test(source))
      errors.push(`Section "${s}" is declared but no element has class "${cls}".`);
  }
  for (const token of ["--accent", "--accent-ink", "--bg", "--ink", "--muted", "--rule"])
    if (!source.includes(`var(${token})`)) errors.push(`Design should use the shared token var(${token}).`);
  return errors;
}
