import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { askZuck, buildContext } from "../tools/zuck-qa.mjs";

const report = { output_text: JSON.stringify({ status: "PASS", findings: {}, affected_files: [], recommended_fixes: [], missing_tests: [] }) };

test("missing API key fails clearly without making a request", async () => {
  await assert.rejects(() => askZuck({ prompt: "review", apiKey: "", fetchImpl: () => { throw new Error("called"); } }), /MODEL_API_KEY is required/);
});

test("uses Muse model and never exposes the API key in the report", async () => {
  let request;
  const secret = "muse_test_secret_should_not_print";
  const result = await askZuck({ prompt: "review", apiKey: secret, fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, json: async () => report }; } });
  assert.equal(request.url, "https://api.meta.ai/v1/responses");
  assert.equal(JSON.parse(request.options.body).model, "muse-spark-1.2");
  assert.equal(result.status, "PASS");
  assert.ok(!JSON.stringify(result).includes(secret));
});

test("excludes repository secrets and .wrangler context", async () => {
  const context = await buildContext({ repoRoot: process.cwd(), files: [".dev.vars", ".wrangler/state.json", "README.md"], diff: "API_KEY=sk_example_secret" });
  assert.ok(!context.includes("FILE: .dev.vars"));
  assert.ok(!context.includes("FILE: .wrangler/state.json"));
  assert.ok(!context.includes("sk_example_secret"));
  assert.match(context, /README\.md/);
});

test("is read-only and malformed API responses fail safely", async () => {
  const before = await readFile(new URL("../tools/zuck-qa.mjs", import.meta.url), "utf8");
  await assert.rejects(() => askZuck({ prompt: "review", apiKey: "x", fetchImpl: async () => ({ ok: true, json: async () => ({ output_text: "not json" }) }) }), /unusable QA report/);
  const after = await readFile(new URL("../tools/zuck-qa.mjs", import.meta.url), "utf8");
  assert.equal(after, before);
});
