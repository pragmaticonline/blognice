import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const privacy = readFileSync(new URL("../privacy.html", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("public privacy policy is complete and linked by the worker", () => {
  assert.match(privacy, /Privacy Policy/);
  assert.match(privacy, /privacy@blognice\.com/);
  assert.match(privacy, /Analytics and technical data/);
  assert.match(privacy, /Your choices and rights/);
  assert.match(indexSource, /app\.get\("\/privacy"/);
assert.match(indexSource, /import privacyPageSource from "\.\.\/privacy\.html"/);
});
