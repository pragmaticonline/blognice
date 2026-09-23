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

test("ordered lists keep their start number instead of renumbering to 1", () => {
  const html = renderMarkdown("1. Hardware\n\nText.\n\n2. Data\n\nMore.\n\n3. Power");
  assert.match(html, /<ol start="2">/);
  assert.match(html, /<ol start="3">/);
});

test("a bare MP3 link on its own line becomes a constrained audio player", () => {
  const html = renderMarkdown("Listen:\n\nhttps://example.com/media/4/1722510000-deadbeef-audio.mp3\n\nDone.");
  assert.match(html, /<audio controls preload="none" src="https:\/\/example\.com\/media\/4\/1722510000-deadbeef-audio\.mp3"><\/audio>/);
  assert.doesNotMatch(html, /autoplay|loop/i);
});

test("MP3 links with link text stay links instead of embedding", () => {
  const html = renderMarkdown("[episode](https://example.com/media/4/1722510000-deadbeef-audio.mp3)");
  assert.match(html, /<a /);
  assert.doesNotMatch(html, /<audio/);
});

test("unsafe MP3 hrefs never become players", () => {
  const html = renderMarkdown("https://example.com/x.mp3\" onerror=\"alert(1)");
  assert.doesNotMatch(html, /<audio/);
});
