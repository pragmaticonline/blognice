import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("Markdown rendering uses an HTML allowlist and strips executable blocks", () => {
  assert.match(source, /function sanitizeRenderedHtml\(html: string\)/);
  assert.match(source, /script\|style\|iframe\|object\|embed/);
  assert.match(source, /const safeTags = new Set/);
  assert.match(source, /attr === "href" \|\| attr === "src"/);
  assert.match(source, /https\?:/);
  assert.match(source, /protocol-relative URLs/);
  assert.match(source, /mailto:/);
  assert.match(source, /noopener noreferrer/);
});
