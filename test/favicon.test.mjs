import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const renderSource = readFileSync(new URL("../src/render.ts", import.meta.url), "utf8");
const homepage = readFileSync(new URL("../homepage.html", import.meta.url), "utf8");
const favicon = readFileSync(new URL("../favicon.svg", import.meta.url), "utf8");

test("the supplied favicon is installed as a valid SVG asset", () => {
  assert.match(favicon, /<svg[\s>]/i);
  assert.match(favicon, /viewBox=/i);
});

test("landing and tenant pages link to the cached SVG favicon", () => {
  assert.match(homepage, /<link rel="icon" href="\/favicon\.svg"/);
  assert.match(renderSource, /<link rel="icon" href="\/favicon\.svg"/);
  assert.match(indexSource, /app\.get\("\/favicon\.svg"/);
});
