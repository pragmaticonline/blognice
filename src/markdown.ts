import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { visit } from "unist-util-visit";

const safeTags = [
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em",
  "del", "s", "u", "blockquote", "pre", "code", "ul", "ol", "li", "a",
  "img", "table", "thead", "tbody", "tr", "th", "td", "div",
];

const markdownSchema = {
  ...defaultSchema,
  // IDs are prefixed by our heading transform; do not prefix them a second
  // time inside rehype-sanitize.
  clobberPrefix: "",
  tagNames: safeTags,
  attributes: {
    p: [], br: [], hr: [["className", "rule-dash", "rule-star", "rule-line"]],
    h1: ["id"], h2: ["id"], h3: ["id"], h4: ["id"], h5: ["id"], h6: ["id"],
    strong: [], em: [], del: [], s: [], u: [], pre: [],
    code: [], ul: [], ol: [], li: [],
    a: ["href", "title", "target", "rel"],
    div: [["className", "tweet-card", "youtube-embed", "youtube-embed__inner", "bitchute-embed", "bitchute-embed__inner"], ["dataYoutubeId"], ["data-youtube-id"], ["dataBitchuteId"], ["data-bitchute-id"]],
    blockquote: [["className", "twitter-tweet"]],
    iframe: ["src", "title", "allow", "allowFullscreen", "frameBorder", "loading", "referrerPolicy"],
    img: ["src", "alt", "title"],
    table: [], thead: [], tbody: [], tr: [], th: ["colSpan", "rowSpan"], td: ["colSpan", "rowSpan"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https", "mailto"],
    src: ["http", "https"],
  },
};

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function textContent(node: any): string {
  if (!node) return "";
  if (node.type === "text") return String(node.value || "");
  return Array.isArray(node.children) ? node.children.map(textContent).join("") : "";
}

function isSafeUrl(value: unknown, attribute: "href" | "src"): boolean {
  if (typeof value !== "string") return false;
  const clean = value.trim().replace(/[\u0000-\u0020\u007f]/g, "");
  if (attribute === "href" && clean.startsWith("#")) return true;
  if (attribute === "href" && /^mailto:/i.test(clean)) return true;
  if (!/^(?:https?:\/\/|\/(?!\/))/i.test(clean)) return false;
  try {
    const parsed = new URL(clean, "https://blognice.invalid/");
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function transformMarkdownTree() {
  return (tree: any) => {
    const headings = new Map<string, string>();
    visit(tree, "element", (node: any) => {
      if (/^h[1-6]$/.test(node.tagName)) {
        const plain = textContent(node);
        const slug = slugify(plain) || "section";
        const count = [...headings.keys()].filter((key) => key === slug || key.startsWith(`${slug}-`)).length;
        const unique = count ? `${slug}-${count}` : slug;
        headings.set(unique, `bn-${unique}`);
        node.properties = { ...(node.properties || {}), id: `bn-${unique}` };
      }
    });
    visit(tree, "element", (node: any) => {
      if (node.tagName === "a" && typeof node.properties?.href === "string") {
        const href = node.properties.href;
        if (href.startsWith("#")) {
          const target = headings.get(href.slice(1));
          if (target) node.properties.href = `#${target}`;
        }
        if (!isSafeUrl(node.properties.href, "href")) delete node.properties.href;
        if (typeof node.properties.href === "string" && /^https?:\/\//i.test(node.properties.href)) {
          node.properties.target = "_blank";
          node.properties.rel = "noopener noreferrer";
        }
      }
      if (node.tagName === "img" && !isSafeUrl(node.properties?.src, "src")) delete node.properties.src;
    });
  };
}

function youtubeIdFromUrl(href: string): string | null {
  try {
    const u = new URL(String(href).trim());
    const host = u.hostname.toLowerCase();
    const path = u.pathname;
    let id: string | null = null;
    if (host === "youtu.be" || host === "www.youtu.be") id = path.split("/")[1] || null;
    else if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com") || host.endsWith("m.youtube.com")) {
      if (path.startsWith("/watch")) id = u.searchParams.get("v");
      else if (path.startsWith("/embed/")) id = path.split("/")[2] || null;
      else if (path.startsWith("/shorts/")) id = path.split("/")[2] || null;
      else if (path.startsWith("/v/")) id = path.split("/")[2] || null;
      else if (path.startsWith("/live/")) id = path.split("/")[2] || null;
    }
    if (!id) return null;
    id = id.split("?")[0].split("&")[0].split("#")[0];
    if (/^[A-Za-z0-9_-]{11}$/.test(id)) return id;
    // Some shorts etc may have extra, truncate
    if (id.length > 11) { const m = id.match(/^([A-Za-z0-9_-]{11})/); if (m) return m[1]; }
    return null;
  } catch { return null; }
}

function bitchuteIdFromUrl(href: string): string | null {
  try {
    const u = new URL(String(href).trim());
    const host = u.hostname.toLowerCase();
    if (!(host === "bitchute.com" || host.endsWith(".bitchute.com"))) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const kind = parts[0].toLowerCase();
    if (kind !== "video" && kind !== "embed") return null;
    let id = parts[1] || null;
    if (!id) return null;
    id = id.split("?")[0].split("&")[0].split("#")[0];
    if (!/^[A-Za-z0-9_-]{6,}$/.test(id)) return null;
    return id;
  } catch { return null; }
}

function youtubeEmbeds() {
  return (tree: any) => {
    visit(tree, "element", (node: any, index: any, parent: any) => {
      if (!parent || node.tagName !== "p" || !Array.isArray(node.children) || node.children.length !== 1) return;
      const child = node.children[0] as any;
      if (!child || child.tagName !== "a" || typeof child.properties?.href !== "string") return;
      const href = String(child.properties.href);
      const vid = youtubeIdFromUrl(href);
      if (!vid) return;
      if (typeof index !== "number") return;
      node.tagName = "div";
      node.properties = { className: ["youtube-embed"], "data-youtube-id": vid };
      node.children = [];
    });
  };
}

function bitchuteEmbeds() {
  return (tree: any) => {
    visit(tree, "element", (node: any, index: any, parent: any) => {
      if (!parent || node.tagName !== "p" || !Array.isArray(node.children) || node.children.length !== 1) return;
      const child = node.children[0] as any;
      if (!child || child.tagName !== "a" || typeof child.properties?.href !== "string") return;
      const href = String(child.properties.href);
      const vid = bitchuteIdFromUrl(href);
      if (!vid) return;
      if (typeof index !== "number") return;
      node.tagName = "div";
      node.properties = { className: ["bitchute-embed"], "data-bitchute-id": vid };
      node.children = [];
    });
  };
}

function tweetCards() {
  return (tree: any) => {
    visit(tree, "element", (node: any, index: any, parent: any) => {
      if (!parent || node.tagName !== "p" || !Array.isArray(node.children) || node.children.length !== 1) return;
      const child = node.children[0] as any;
      if (!child || child.tagName !== "a" || typeof child.properties?.href !== "string") return;
      const href = String(child.properties.href);
      if (!/^https?:\/\/(www\.)?(twitter\.com|x\.com)\//i.test(href)) return;
      if (youtubeIdFromUrl(href)) return;
      if (bitchuteIdFromUrl(href)) return;
      if (typeof index !== "number") return;
      node.tagName = "blockquote";
      node.properties = { className: ["twitter-tweet"] };
      child.properties = { ...(child.properties || {}), href };
    });
  };
}

function dividerStyles() {
  return (tree: any, file: any) => {
    visit(tree, "thematicBreak", (node: any) => {
      const raw = typeof node.position?.start?.offset === "number" && typeof node.position?.end?.offset === "number"
        ? String(file).slice(node.position.start.offset, node.position.end.offset).trim()
        : "---";
      const marker = raw[0] === "*" ? "rule-star" : raw[0] === "_" ? "rule-line" : "rule-dash";
      node.data = { ...(node.data || {}), hProperties: { className: [marker] } };
    });
  };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(dividerStyles)
  .use(remarkRehype, { allowDangerousHtml: false })
  .use(transformMarkdownTree)
  .use(youtubeEmbeds as any)
  .use(bitchuteEmbeds as any)
  .use(tweetCards as any)
  .use(rehypeSanitize, markdownSchema as any)
  .use(rehypeStringify);

/** Render untrusted Markdown without allowing raw HTML to reach the browser. */
export function renderMarkdown(md: string): string {
  return String(processor.processSync(md));
}
