import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("uploaded images are signature-checked and served with nosniff", () => {
  assert.match(source, /async function detectedImageType\(file: File\)/);
  assert.match(source, /await detectedImageType\(file\)/);
  assert.match(source, /x-content-type-options/);
  assert.doesNotMatch(source.slice(source.indexOf("const ALLOWED_IMAGE"), source.indexOf("const MAX_UPLOAD")), /image\/svg\+xml/);
});
