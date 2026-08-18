import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("desktop reading measure provides an approximately 800px text column", () => {
  const source = readFileSync(new URL("../src/render.ts", import.meta.url), "utf8");
  assert.match(source, /--measure: 53rem;/);
  assert.match(source, /\.wrap \{ max-width: var\(--measure\);[^}]*padding: 0 1\.4rem 1\.5rem;/);
});
