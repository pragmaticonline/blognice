import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("the apex domain permanently redirects to www while preserving URL details", () => {
  assert.match(indexSource, /app\.use\("\*", async \(c, next\)/);
  assert.match(indexSource, /host === c\.env\.ROOT_DOMAIN\.toLowerCase\(\)/);
  assert.match(indexSource, /https:\/\/www\.\$\{c\.env\.ROOT_DOMAIN\}\$\{requestUrl\.pathname\}\$\{requestUrl\.search\}/);
  assert.match(indexSource, /c\.redirect\([\s\S]*?,\s*301\s*\)/);
});
