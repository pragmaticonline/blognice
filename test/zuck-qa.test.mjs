import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { askZuck, buildContext, redact } from "../tools/zuck-qa.mjs";

const report = { output_text: JSON.stringify({ status: "PASS", findings: {}, affected_files: [], recommended_fixes: [], missing_tests: [] }) };
const runFile = promisify(execFile);

test("missing API key fails clearly without making a request", async () => {
  await assert.rejects(() => askZuck({ prompt: "review", apiKey: "", fetchImpl: () => { throw new Error("called"); } }), /MODEL_API_KEY is required/);
});

test("uses Muse model and never exposes the API key in the report", async () => {
  let request;
  const secret = "muse_test_secret_should_not_print";
  const result = await askZuck({ prompt: "review", apiKey: secret, fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, json: async () => report }; } });
  assert.equal(request.url, "https://api.meta.ai/v1/responses");
  assert.equal(JSON.parse(request.options.body).model, "muse-spark-1.2-contributor");
  assert.equal(result.status, "PASS");
  assert.ok(!JSON.stringify(result).includes(secret));
});

test("excludes repository secrets and .wrangler context", async () => {
  const context = await buildContext({ repoRoot: process.cwd(), files: [".dev.vars", ".wrangler/state.json", "secrets.json", "README.md"], diff: "API_KEY=sk_example_secret" });
  assert.ok(!context.includes("FILE: .dev.vars"));
  assert.ok(!context.includes("FILE: .wrangler/state.json"));
  assert.ok(!context.includes("FILE: secrets.json"));
  assert.ok(!context.includes("sk_example_secret"));
  assert.match(context, /README\.md/);
});

test("rejects a symlink that points outside the repository", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zuck-root-"));
  const outside = await mkdtemp(join(tmpdir(), "zuck-outside-"));
  try {
    await writeFile(join(outside, "secret.txt"), "do not submit");
    try { await symlink(join(outside, "secret.txt"), join(root, "link.txt")); } catch { t.skip("symlink creation is unavailable"); return; }
    const context = await buildContext({ repoRoot: root, files: ["link.txt"] });
    assert.equal(context, "");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("sanitizes sensitive values repeated by the model", async () => {
  const secret = "muse_test_secret_should_not_print";
  const result = await askZuck({ prompt: "review", apiKey: secret, fetchImpl: async () => ({ ok: true, json: async () => ({ output_text: JSON.stringify({ status: "NEEDS CHANGES", findings: { high: [{ message: secret }] }, affected_files: [], recommended_fixes: [], missing_tests: [] }) }) }) });
  assert.equal(result.status, "NEEDS CHANGES");
  assert.ok(!JSON.stringify(result).includes(secret));
});

test("redacts credential-bearing URLs, private keys, JWTs, and long opaque values", () => {
  const text = "postgres://user:pass@example.test/db https://user:pass@example.test/x -----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY----- eyJheader.payload.signature ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const safe = redact(text);
  assert.ok(!safe.includes("pass@example.test"));
  assert.ok(!safe.includes("BEGIN PRIVATE KEY"));
  assert.ok(!safe.includes("eyJheader"));
  assert.ok(!safe.includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ"));
});

test("is read-only and malformed API responses fail safely", async () => {
  const before = await readFile(new URL("../tools/zuck-qa.mjs", import.meta.url), "utf8");
  const gitBefore = (await runFile("git", ["status", "--porcelain"], { cwd: process.cwd(), encoding: "utf8" })).stdout;
  await assert.rejects(() => askZuck({ prompt: "review", apiKey: "x", fetchImpl: async () => ({ ok: true, json: async () => ({ output_text: "not json" }) }) }), /unusable QA report/);
  const after = await readFile(new URL("../tools/zuck-qa.mjs", import.meta.url), "utf8");
  const gitAfter = (await runFile("git", ["status", "--porcelain"], { cwd: process.cwd(), encoding: "utf8" })).stdout;
  assert.equal(after, before);
  assert.equal(gitAfter, gitBefore);
});
