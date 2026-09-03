export const AI_MARKDOWN_TEXT_MAX = 20_000;

export type AiMarkdownMessage = { role: "system" | "user"; content: string };

export function markdownFormattingMessages(text: string): AiMarkdownMessage[] {
  return [
    {
      role: "system",
      content: [
        "Format the supplied blog-post draft as clear, restrained Markdown.",
        "Use headings, short paragraphs, lists, bold, italic, and blockquotes only where the existing text supports them; leave URLs and existing links exactly as written.",
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

function authorTokens(value: string): string[] {
  return value.normalize("NFKC").match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || [];
}

export function preservesAuthorTokens(original: string, formatted: string): boolean {
  const before = authorTokens(original);
  const after = authorTokens(formatted);
  return before.length === after.length && before.every((token, index) => token === after[index]);
}
