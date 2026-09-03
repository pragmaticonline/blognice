export const AI_MARKDOWN_TEXT_MAX = 20_000;

export type AiMarkdownMessage = { role: "system" | "user" | "assistant"; content: string };

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
