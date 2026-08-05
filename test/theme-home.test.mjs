import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/render.ts", import.meta.url), "utf8");

test("blog homepage inherits the global light/dark theme variables", () => {
  const homepage = source.match(/\.homepage-wrap\s*\{([\s\S]*?)\n\s*\}/)?.[1] || "";
  assert.doesNotMatch(homepage, /--bg\s*:/);
  assert.doesNotMatch(homepage, /background:\s*var\(--bg\)/);
  assert.match(source, /html\[data-theme="dark"\]/);
});

test("public pages provide a scroll-to-top control after scrolling", () => {
  assert.match(source, /id="to-top"/);
  assert.match(source, /scrollY\/max>\.35/);
  assert.match(source, /scrollTo\(\{top:0,behavior:"smooth"\}\)/);
});
