import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdown } from "../src/markdown.ts";
import { readFileSync } from "node:fs";

test("external links in prose open in new tab", () => {
  // Inline youtube link with surrounding text stays as link and gets target blank
  const inlineHtml = renderMarkdown("Check [Watch it here](https://www.youtube.com/watch?v=eihdjtg_rWs) for more");
  assert.match(inlineHtml, /<a href="https:\/\/www\.youtube\.com\/watch\?v=eihdjtg_rWs" target="_blank" rel="noopener noreferrer">Watch it here<\/a>/);
  // Standalone youtube link becomes embed, not a link
  const embedHtml = renderMarkdown("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.match(embedHtml, /youtube-embed/);
  assert.doesNotMatch(embedHtml, /<a href/);
  // Regular external link
  const ext = renderMarkdown("[Example](https://example.com)");
  assert.match(ext, /target="_blank" rel="noopener noreferrer"/);
});

test("tweet placeholder is still expandable after external-link target is added", () => {
  const html = renderMarkdown("https://x.com/rayvahey/status/2097678999447330935");
  // Should be a blockquote twitter-tweet, not a plain link
  assert.match(html, /<blockquote class="twitter-tweet">/);
  // After our external-link patch, the inner anchor gets target="_blank" — expandTweetEmbeds must tolerate it
  assert.match(html, /<blockquote class="twitter-tweet"><a href="https:\/\/x\.com\/rayvahey\/status\/2097678999447330935"[^>]*>.*<\/a><\/blockquote>/);
  // Verify the file's expand logic is tolerant (must contain [^>]* after href)
  const indexSrc = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.ok(indexSrc.includes('<a href="([^"]+)"[^>]*>'), "expandTweetEmbeds must use tolerant regex with [^>]*");
});

test("tweet placeholder with target still matches tolerant expand regex", () => {
  const html = renderMarkdown("https://x.com/rayvahey/status/2097678999447330935");
  // Simulate the tolerant regex that should be in src/index.ts
  const tolerantRe = /<blockquote class="twitter-tweet"><a href="([^"]+)"[^>]*>[^<]*<\/a><\/blockquote>/g;
  const matches = [...html.matchAll(tolerantRe)];
  assert.equal(matches.length, 1);
  assert.equal(matches[0][1], "https://x.com/rayvahey/status/2097678999447330935");
  // Old strict regex would not match when target is present
  const strictRe = /<blockquote class="twitter-tweet"><a href="([^"]+)">[^<]*<\/a><\/blockquote>/g;
  const strictMatches = [...html.matchAll(strictRe)];
  assert.equal(strictMatches.length, 0, "strict regex should fail on HTML with target=_blank, proving regression");
});
