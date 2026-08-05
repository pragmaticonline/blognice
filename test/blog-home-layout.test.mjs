import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const renderSource = readFileSync(new URL("../src/render.ts", import.meta.url), "utf8");

test("tenant homepage art matches the designer mockup aspect ratios", () => {
  assert.match(renderSource, /\.blog-art \{ display:block; aspect-ratio:16 \/ 9/);
  assert.match(renderSource, /\.blog-cards, \.blog-popular-cards \{ display:grid; grid-template-columns:repeat\(3/);
  assert.match(renderSource, /\.blog-card \.blog-art, \.blog-popular-card \.blog-art \{ margin-bottom/);
  assert.match(renderSource, /Popular posts/);
  assert.match(renderSource, /\.homepage-wrap \{[\s\S]*max-width: 82\.5rem/);
  const homepageBlock = renderSource.match(/\.homepage-wrap\s*\{([\s\S]*?)\n\s*\}/)?.[1] || "";
  assert.doesNotMatch(homepageBlock, /--ink\s*:/);
  assert.match(renderSource, /html\[data-theme="dark"\]/);
});
