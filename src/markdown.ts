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
  "img", "table", "thead", "tbody", "tr", "th", "td",
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
    strong: [], em: [], del: [], s: [], u: [], blockquote: [], pre: [],
    code: [], ul: [], ol: [], li: [],
    a: ["href", "title", "target", "rel"],
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
      }
      if (node.tagName === "img" && !isSafeUrl(node.properties?.src, "src")) delete node.properties.src;
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
  .use(rehypeSanitize, markdownSchema as any)
  .use(rehypeStringify);

/** Render untrusted Markdown without allowing raw HTML to reach the browser. */
export function renderMarkdown(md: string): string {
  return String(processor.processSync(md));
}
