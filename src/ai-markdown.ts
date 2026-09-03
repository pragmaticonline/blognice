export const AI_MARKDOWN_TEXT_MAX = 20_000;

export function markdownOutputTokenBudget(text: string): number {
  return Math.min(4096, Math.max(512, Math.ceil(text.length / 2)));
}

export type AiMarkdownMessage = { role: "system" | "user" | "assistant"; content: string };

export function markdownFormattingMessages(text: string): AiMarkdownMessage[] {
  return [
    {
      role: "system",
      content: [
        "Format the supplied blog-post draft as clear, restrained Markdown.",
        "Use headings, short paragraphs, lists, bold, italic, blockquotes, and Markdown tables where the existing text supports them; convert plainly labelled table and list sections instead of leaving them as loose lines; leave URLs and existing links exactly as written.",
        "Do not add, remove, paraphrase, correct, or reorder any of the author's words, punctuation, URLs, or facts.",
        "Do not add a title if the draft does not contain one. Never add commentary or a summary.",
        "Return only the formatted Markdown, with no enclosing code fence.",
      ].join(" "),
    },
    { role: "user", content: text },
  ];
}

export function normalizedMarkdownResponse(value: unknown): string {
  const response = String(value ?? "").trim();
  const fenced = response.match(/^```(?:markdown|md)\s*\n([\s\S]*?)\n```$/i);
  return (fenced ? fenced[1] : response).trim();
}

export function markdownFormattingRetryMessages(text: string, rejected: string): AiMarkdownMessage[] {
  return [
    ...markdownFormattingMessages(text),
    { role: "assistant", content: rejected },
    {
      role: "user",
      content: "That response changed the draft. Try again: copy every original word in the original order; only add Markdown punctuation and whitespace. Return only Markdown.",
    },
  ];
}

function authorTokens(value: string): string[] {
  return value.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

export function preservesAuthorTokens(original: string, formatted: string): boolean {
  const before = authorTokens(original);
  const after = authorTokens(formatted);
  return before.length === after.length && before.every((token, index) => token === after[index]);
}

export function conservativeMarkdownFallback(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").trim().split("\n");
  const contentLines = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.trim());
  if (!contentLines.length) return "";
  const first = contentLines[0];
  if (!/^\s{0,3}(?:#{1,6}\s|>|[-+*]\s|\d+[.)]\s|```)/.test(first.line)) lines[first.index] = `# ${first.line}`;
  const second = contentLines[1];
  if (second && second.index === first.index + 1 && second.line.length <= 240 && !/^\s{0,3}(?:#{1,6}\s|>|[-+*]\s|\d+[.)]\s|```)/.test(second.line)) {
    lines[second.index] = `*${second.line}*`;
  }
  return formatObviousStructures(lines.join("\n"));
}

export function confidentLocalMarkdownFormat(text: string): string | null {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  const lines = normalized.split("\n");
  const content = lines.map((line, index) => ({ line: line.trim(), index })).filter(({ line }) => line);
  const [first, second, third] = content;
  const headlineAndStandfirst = Boolean(
    first && second && third &&
    first.index === 0 && second.index === 1 && third.index >= 3 &&
    first.line.length <= 180 && second.line.length <= 280 &&
    !MARKDOWN_BLOCK.test(first.line)
  );
  if (headlineAndStandfirst) return conservativeMarkdownFallback(normalized);
  const structured = formatObviousStructures(normalized);
  if (structured !== normalized) return structured;
  const alreadyStructured = /^\s{0,3}#{1,6}\s+\S/m.test(normalized) && (
    /^\s{0,3}(?:[-+*]\s+|\d+[.)]\s+|>\s+|\|.+\|)/m.test(normalized) ||
    /\*\*[^*\n]+\*\*/.test(normalized)
  );
  const readableParagraphs = normalized.split(/\n\s*\n/).filter((paragraph) => paragraph.trim()).length >= 3;
  return alreadyStructured || readableParagraphs ? normalized : null;
}

const MARKDOWN_BLOCK = /^\s{0,3}(?:#{1,6}\s|>|[-+*]\s|\d+[.)]\s|```|\|)/;

export function formatObviousStructures(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const label = lines[index].trim();
    if (/^table(?:\s+of\b|\s*:|$)/i.test(label) && !MARKDOWN_BLOCK.test(lines[index])) {
      const rows: string[][] = [];
      let cursor = index + 1;
      while (cursor < lines.length && lines[cursor].trim()) {
        const cells = lines[cursor].trim().split(/\s+/);
        if (!/^\d+$/.test(cells[0]) || cells.length < 2 || cells.length > 6) break;
        rows.push(cells);
        cursor += 1;
      }
      const columnCount = rows[0]?.length || 0;
      if (rows.length >= 2 && rows.every((row) => row.length === columnCount)) {
        const blanks = Array.from({ length: columnCount }, () => "").join(" | ");
        const dividers = Array.from({ length: columnCount }, () => "---").join(" | ");
        const table = ["", `| ${blanks} |`, `| ${dividers} |`, ...rows.map((row) => `| ${row.join(" | ")} |`)];
        lines.splice(index, cursor - index, `## ${label}`, ...table);
        index += table.length;
      }
      continue;
    }
    if (/^(?:(?:numbered|ordered|bulleted|bullet)\s+)?list(?:\s+of\b|\s*:|$)/i.test(label) && !MARKDOWN_BLOCK.test(lines[index])) {
      const items: string[] = [];
      let cursor = index + 1;
      while (cursor < lines.length && lines[cursor].trim() && !MARKDOWN_BLOCK.test(lines[cursor])) {
        items.push(lines[cursor].trim());
        cursor += 1;
      }
      if (items.length >= 2) {
        const numbered = items.every((item) => /^\d+\s+\S/.test(item));
        const formattedItems = numbered
          ? items.map((item) => item.replace(/^(\d+)\s+/, "$1. "))
          : items.map((item) => `- ${item}`);
        lines.splice(index, cursor - index, `## ${label}`, "", ...formattedItems);
        index += items.length + 1;
      }
    }
  }
  return lines.join("\n");
}
