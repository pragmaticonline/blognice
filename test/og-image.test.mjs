import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
for (const extension of [".html", ".svg"]) {
  require.extensions[extension] = (module, filename) => {
    module.exports = readFileSync(filename, "utf8");
  };
}

test("og-image.png serves the brand share image as a real PNG", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const req = new Request("https://www.blognice.test/og-image.png", {
    headers: { host: "www.blognice.test" },
  });
  const env = { ROOT_DOMAIN: "blognice.test" };
  const executionCtx = { waitUntil() {}, passThroughOnException() {} };
  const res = await blogniceApp.request(req, undefined, env, executionCtx);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /image\/png/);
  const buf = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...buf.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(buf.length > 10000, "serves a non-trivial image, not a placeholder");
});
