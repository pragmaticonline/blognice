// Native Blogger import: parse a Blogger backup (Atom XML) into posts and pages.
//
// Blogger ships two backup flavours, both Atom feeds with one <entry> per item:
//   - legacy export: kind comes from a category with scheme
//     "http://schemas.google.com/g/2005#kind" (term ...#post, ...#page,
//     ...#comment, ...#settings, ...#template); drafts carry
//     <app:control><app:draft>yes</app:draft></app:control>.
//   - 2018 Takeout (feed.atom): <blogger:type>POST|PAGE|COMMENT</blogger:type>,
//     <blogger:status>DRAFT</blogger:status>, <blogger:trashed>...</blogger:trashed>.
// This module is worker-safe: pure string parsing, no DOM, no Node APIs.

export const BLOGGER_SOURCE = "blogger";
export const BLOGGER_IMPORT_MAX_ENTRIES = 2000;

export class BloggerImportError extends Error {}

export type BloggerImportItem = {
  externalId: string;
  kind: "post" | "page";
  title: string;
  suggestedSlug: string;
  bodyMarkdown: string;
  tags: string[];
  publishedAt: number;
  updatedAt: number;
  draft: boolean;
  author: string;
};

export type BloggerImportParse = {
  items: BloggerImportItem[];
  skipped: { comments: number; settings: number; trashed: number; unknown: number };
};

const KIND_SCHEME = "http://schemas.google.com/g/2005#kind";
const KIND_POST = "http://schemas.google.com/blogger/2008/kind#post";
const KIND_PAGE = "http://schemas.google.com/blogger/2008/kind#page";
const KIND_COMMENT = "http://schemas.google.com/blogger/2008/kind#comment";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  nbsp: " ", hellip: "…", mdash: "—", ndash: "–",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
  laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™",
  times: "×", divide: "÷", plusmn: "±",
};

export function unescapeXmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, digits: string) => {
      const code = Number(digits);
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      const code = parseInt(hex, 16);
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    })
    .replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, (match: string, name: string) => NAMED_ENTITIES[name] ?? match);
}

function stripCdata(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function textOf(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}\\s*>`));
  return match ? stripCdata(match[1]).trim() : null;
}

function attrOf(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*(['"])(.*?)\\1`));
  return match ? unescapeXmlEntities(match[2]) : null;
}

function categoriesOf(block: string): Array<{ scheme: string | null; term: string }> {
  const out: Array<{ scheme: string | null; term: string }> = [];
  for (const match of block.matchAll(/<category\b([^>]*?)\/?>/g)) {
    const term = attrOf(match[0], "term");
    if (!term) continue;
    out.push({ scheme: attrOf(match[0], "scheme"), term });
  }
  return out;
}

function plainText(value: string): string {
  return unescapeXmlEntities(stripCdata(value)).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function bloggerSlugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function parseUnixSeconds(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const millis = Date.parse(value);
  return Number.isSafeInteger(millis) ? Math.floor(millis / 1000) : fallback;
}

// Mirror the post-tag rules in src/index.ts, but drop offending labels instead
// of failing: a Blogger label that is not a valid blognice tag is skipped.
export function normalizeBloggerTags(terms: string[]): string[] {
  const cleaned = terms
    .map((term) => term.trim().replace(/^#+/, "").toLowerCase())
    .filter(Boolean);
  const unique = [...new Set(cleaned)];
  return unique
    .filter((tag) => tag.length <= 40 && /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(tag))
    .slice(0, 20);
}

function legacyKind(categories: Array<{ scheme: string | null; term: string }>): string | null {
  for (const category of categories) {
    if (category.scheme === KIND_SCHEME) return category.term;
  }
  return null;
}

export function bloggerHtmlToMarkdown(html: string): string {
  let text = html.replace(/\r\n?/g, "\n");
  text = text.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  // Keep tag attributes on one line so the structural rewrites below match.
  text = text.replace(/<[^>]+>/g, (tag) => tag.replace(/\s+/g, " "));

  text = text.replace(/<\s*pre[^>]*>([\s\S]*?)<\s*\/\s*pre\s*>/gi, (_, inner: string) => {
    const code = inner.replace(/^\s*<\s*code[^>]*>([\s\S]*?)<\s*\/\s*code\s*>\s*$/i, "$1").trim();
    return `\n\`\`\`\n${code}\n\`\`\`\n`;
  });
  text = text.replace(/<\s*code[^>]*>([\s\S]*?)<\s*\/\s*code\s*>/gi, (_, inner: string) => `\`${inner.trim()}\``);
  for (let level = 1; level <= 6; level++) {
    text = text.replace(
      new RegExp(`<\\s*h${level}[^>]*>([\\s\\S]*?)<\\s*\\/\\s*h${level}\\s*>`, "gi"),
      (_, inner: string) => `\n${"#".repeat(level)} ${inner.trim()}\n`
    );
  }
  text = text.replace(/<\s*hr\s*\/?>/gi, "\n---\n");
  text = text.replace(/<\s*br\s*\/?>/gi, "\n");
  text = text.replace(/<\s*img\b[^>]*>/gi, (tag) => {
    const src = attrOf(tag, "src") || "";
    if (!src) return "";
    return `![${attrOf(tag, "alt") || ""}](${src})`;
  });
  text = text.replace(/<\s*a\b[^>]*>([\s\S]*?)<\s*\/\s*a\s*>/gi, (whole, inner: string) => {
    const href = attrOf(whole.slice(0, whole.indexOf(">") + 1), "href") || "";
    const label = plainText(inner);
    if (!href) return label;
    return `[${label || href}](${href})`;
  });
  text = text.replace(/<\s*iframe\b([^>]*?)(?:\/>|>[\s\S]*?<\s*\/\s*iframe\s*>)/gi, (whole, attrs: string) => {
    const src = attrOf(`<iframe ${attrs}>`, "src") || "";
    if (!src) return "";
    const title = attrOf(`<iframe ${attrs}>`, "title") || "Video";
    return `[${title}](${src})`;
  });
  text = text.replace(/<\s*blockquote[^>]*>([\s\S]*?)<\s*\/\s*blockquote\s*>/gi, (_, inner: string) =>
    `\n${inner.split("\n").map((line) => (line.trim() ? `> ${line.trim()}` : ">")).join("\n")}\n`
  );
  const listItems = (inner: string): string[] =>
    [...inner.matchAll(/<\s*li[^>]*>([\s\S]*?)<\s*\/\s*li\s*>/gi)].map((item) => plainText(item[1]));
  text = text.replace(/<\s*ul[^>]*>([\s\S]*?)<\s*\/\s*ul\s*>/gi, (_, inner: string) =>
    `\n${listItems(inner).map((item) => `- ${item}`).join("\n")}\n`
  );
  text = text.replace(/<\s*ol[^>]*>([\s\S]*?)<\s*\/\s*ol\s*>/gi, (_, inner: string) =>
    `\n${listItems(inner).map((item, index) => `${index + 1}. ${item}`).join("\n")}\n`
  );
  text = text.replace(/<\s*(strong|b)[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, "**$2**");
  text = text.replace(/<\s*(em|i)[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, "*$2*");
  text = text.replace(/<\s*\/\s*p\s*>/gi, "\n\n");
  text = text.replace(/<\s*p[^>]*>/gi, "");
  text = text.replace(/<\s*\/\s*div\s*>/gi, "\n");
  text = text.replace(/<\s*div[^>]*>/gi, "");
  text = text.replace(/<[^>]+>/g, "");
  text = unescapeXmlEntities(text);
  text = text.split("\n").map((line) => line.replace(/[ \t]+/g, " ").trimEnd()).join("\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export function parseBloggerExport(xml: string, now = Math.floor(Date.now() / 1000)): BloggerImportParse {
  if (!xml.includes("<feed")) throw new BloggerImportError("That file is not a Blogger backup (no Atom feed found).");
  const blocks = [...xml.matchAll(/<(?:atom:)?entry[\s>][\s\S]*?<\/(?:atom:)?entry\s*>/g)].map((match) => match[0]);
  if (blocks.length > BLOGGER_IMPORT_MAX_ENTRIES) {
    throw new BloggerImportError(`That backup holds ${blocks.length} entries; imports are limited to ${BLOGGER_IMPORT_MAX_ENTRIES}. Split the file and try again.`);
  }
  const items: BloggerImportItem[] = [];
  const skipped = { comments: 0, settings: 0, trashed: 0, unknown: 0 };
  for (const block of blocks) {
    const externalId = textOf(block, "id");
    if (!externalId) { skipped.unknown += 1; continue; }
    const takeoutType = textOf(block, "blogger:type");
    let kind: "post" | "page" | null = null;
    let tags: string[] = [];
    let draft = false;
    if (takeoutType) {
      if (takeoutType === "COMMENT") { skipped.comments += 1; continue; }
      if (takeoutType !== "POST" && takeoutType !== "PAGE") { skipped.settings += 1; continue; }
      if (textOf(block, "blogger:trashed")) { skipped.trashed += 1; continue; }
      kind = takeoutType === "PAGE" ? "page" : "post";
      draft = textOf(block, "blogger:status") === "DRAFT";
      tags = normalizeBloggerTags(categoriesOf(block).map((category) => category.term));
    } else {
      const categories = categoriesOf(block);
      const entryKind = legacyKind(categories);
      if (entryKind === KIND_COMMENT) { skipped.comments += 1; continue; }
      if (entryKind !== KIND_POST && entryKind !== KIND_PAGE) {
        if (entryKind) skipped.settings += 1; else skipped.unknown += 1;
        continue;
      }
      kind = entryKind === KIND_PAGE ? "page" : "post";
      draft = /<\s*app:draft[^>]*>\s*yes\s*<\s*\/\s*app:draft\s*>/.test(block);
      tags = normalizeBloggerTags(
        categories
          .filter((category) => category.scheme !== KIND_SCHEME && !category.term.includes("schemas.google.com") && !category.term.includes("blogger/2008/kind"))
          .map((category) => category.term)
      );
    }
    const rawTitle = plainText(textOf(block, "title") ?? "");
    const bodyHtml = unescapeXmlEntities(stripCdata(textOf(block, "content") ?? ""));
    const publishedAt = parseUnixSeconds(textOf(block, "published"), now);
    const author = plainText(textOf(block, "author")?.match(/<name[^>]*>([\s\S]*?)<\/name\s*>/)?.[1] ?? "").slice(0, 120);
    const idTail = externalId.split(/[:.]/).pop() || externalId;
    items.push({
      externalId,
      kind,
      title: (rawTitle || "Untitled").slice(0, 200),
      suggestedSlug: bloggerSlugify(rawTitle) || bloggerSlugify(idTail) || "blogger-import",
      bodyMarkdown: bloggerHtmlToMarkdown(bodyHtml),
      tags,
      publishedAt,
      updatedAt: parseUnixSeconds(textOf(block, "updated"), publishedAt),
      draft,
      author,
    });
  }
  return { items, skipped };
}
