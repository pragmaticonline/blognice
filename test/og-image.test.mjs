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

test("og-image.jpg serves the brand share image as a real JPEG", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const req = new Request("https://www.blognice.test/og-image.jpg", {
    headers: { host: "www.blognice.test" },
  });
  const env = { ROOT_DOMAIN: "blognice.test" };
  const executionCtx = { waitUntil() {}, passThroughOnException() {} };
  const res = await blogniceApp.request(req, undefined, env, executionCtx);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /image\/jpeg/);
  const buf = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...buf.slice(0, 3)], [255, 216, 255]);
  assert.ok(buf.length > 100000, "serves the full share photo, not a placeholder");
});
