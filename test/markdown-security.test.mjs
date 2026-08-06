import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderMarkdown } from "../src/markdown.ts";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("Markdown rendering uses a parser-based allowlist and strips executable blocks", () => {
  assert.match(readFileSync(new URL("../src/markdown.ts", import.meta.url), "utf8"), /rehypeSanitize/);
  assert.match(readFileSync(new URL("../src/markdown.ts", import.meta.url), "utf8"), /allowDangerousHtml: false/);
  const html = renderMarkdown('# Hello\n\n<script>alert(1)</script>\n\n<div onclick="alert(2)">safe</div>\n\n[bad](javascript:alert(3))\n\n![bad](data:text/html,x)');
  assert.match(html, /<h1 id="bn-hello">Hello<\/h1>/);
  assert.doesNotMatch(html, /script|onclick|javascript:|data:text/i);
  assert.doesNotMatch(html, /alert|safe/i);
});

test("Markdown headings and fragments remain linked without clobberable IDs", () => {
  const html = renderMarkdown('# One\n\n[Jump](#one)\n\n# One');
  assert.match(html, /id="bn-one"/);
  assert.match(html, /href="#bn-one"/);
  assert.match(html, /id="bn-one-1"/);
});
