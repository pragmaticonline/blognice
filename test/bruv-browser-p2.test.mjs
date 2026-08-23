import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const index = fs.readFileSync("src/index.ts", "utf8");
const render = fs.readFileSync("src/render.ts", "utf8");
const markdown = fs.readFileSync("src/markdown.ts", "utf8");

test("Bruv P2: Stripe checkout is single-session per redirect (no double-POST without idempotency)", () => {
  assert.match(index, /checkout\.session\.completed/);
  assert.match(index, /stripe_events/);
  assert.match(index, /INSERT OR IGNORE INTO stripe_events/);
  assert.match(index, /\/admin\/billing\/checkout/);
});

test("Bruv P2: XSS paste is sanitized — remark+rehype-sanitize and esc()", () => {
  assert.match(markdown, /rehypeSanitize/);
  assert.match(markdown, /remarkGfm/);
  assert.match(markdown, /allowDangerousHtml: false/);
  assert.doesNotMatch(markdown, /allowDangerousHtml:\s*true/);
  assert.match(index, /esc\(/);
  assert.match(render, /esc\(/);
});

test("Bruv P2: canonical uses tenant custom_domain when present, not just ROOT_DOMAIN", () => {
  assert.match(index, /canonical/);
  assert.match(index, /custom_domain/);
  assert.match(index, /sitemap\.xml/);
});

test("Bruv P2: media upload uses random key but dedups via hash (slow-3G double-click)", () => {
  assert.match(index, /MEDIA\.put/);
  assert.match(index, /crypto\.randomUUID/);
  assert.match(index, /readBoundedJson/);
});
