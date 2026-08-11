import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { askZuck, buildContext, MAX_FILE_CHARS, MAX_FILES, MAX_INPUT_CHARS, MAX_PROMPT_CHARS, parseRangeSpec, redact } from "../tools/zuck-qa.mjs";

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
    assert.match(context, /CONTEXT_COMPLETE: false/);
    assert.match(context, /requested file omitted by policy/);
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
  const databaseUrl = ["postgres", "://user", ":pass", "@example.test/db"].join("");
  const credentialUrl = ["https", "://user", ":pass", "@example.test/x"].join("");
  const fence = "-".repeat(5);
  const privateLabel = ["PRIVATE", "KEY"].join(" ");
  const privateKey = [fence, "BEGIN ", privateLabel, fence, "secret", fence, "END ", privateLabel, fence].join("");
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", ".eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"].join("");
  const opaque = ["ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz0123456789+/"].join("");
  const text = [databaseUrl, credentialUrl, privateKey, jwt, opaque].join(" ");
  const safe = redact(text);
  assert.ok(!safe.includes("pass@example.test"));
  assert.ok(!safe.includes("BEGIN PRIVATE KEY"));
  assert.ok(!safe.includes("eyJhbGciOiJIUzI1NiJ9"));
  assert.ok(!safe.includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ"));
});

test("selects validated ranges with original line numbers and omission markers", async () => {
  const root = await mkdtemp(join(tmpdir(), "zuck-range-"));
  try {
    await writeFile(join(root, "sample.ts"), "one\ntwo\nthree\nfour\nfive");
    const context = await buildContext({ repoRoot: root, ranges: ["sample.ts:2-3"] });
    assert.match(context, /INCLUDED LINES: 2-3 of 5/);
    assert.match(context, /2 \| two/);
    assert.match(context, /3 \| three/);
    assert.match(context, /OMITTED LINES: 1, 4-5/);
    assert.ok(!context.includes("1 | one"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("does not duplicate equivalent whole-file and ranged paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "zuck-dedup-"));
  try {
    await writeFile(join(root, "sample.ts"), "one\ntwo\nthree");
    const context = await buildContext({ repoRoot: root, files: ["./sample.ts"], ranges: ["sample.ts:2-2"] });
    assert.equal((context.match(/FILE: sample\.ts/g) ?? []).length, 1);
    assert.match(context, /INCLUDED LINES: 2-2 of 3/);
    assert.ok(!context.includes("CONTEXT_COMPLETE: true\n one"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("canonicalizes equivalent range paths and counts trailing newlines correctly", async () => {
  const root = await mkdtemp(join(tmpdir(), "zuck-lines-"));
  try {
    await writeFile(join(root, "sample.ts"), "one\ntwo\n");
    const context = await buildContext({ repoRoot: root, ranges: ["./sample.ts:1-1", "sample.ts:2-2"] });
    assert.equal((context.match(/FILE: sample\.ts/g) ?? []).length, 1);
    assert.match(context, /INCLUDED LINES: 1-2 of 2/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("marks excluded or missing requested context as incomplete", async () => {
  const context = await buildContext({ repoRoot: process.cwd(), files: [".dev.vars", "missing-zuck-file.ts"] });
  assert.match(context, /CONTEXT_COMPLETE: false/);
  assert.match(context, /requested file omitted by policy/);
});

test("merges overlapping ranges and rejects invalid ranges", () => {
  assert.deepEqual(parseRangeSpec("src/index.ts:4-9"), { path: "src/index.ts", start: 4, end: 9 });
  assert.throws(() => parseRangeSpec("src/index.ts:0-2"), /Invalid line range/);
  assert.throws(() => parseRangeSpec("src/index.ts:9-4"), /Invalid line range/);
  assert.throws(() => parseRangeSpec("src/index.ts:not-a-range"), /Invalid line range/);
  assert.throws(() => parseRangeSpec("src/\nindex.ts:1-2"), /Invalid line range/);
});

test("enforces range count and line limits after validation", async () => {
  await assert.rejects(() => buildContext({ ranges: Array.from({ length: 41 }, (_, index) => `file-${index}.ts:1-1`) }), /maximum is 40/);
  await assert.rejects(() => buildContext({ ranges: ["file.ts:1-4001"] }), /no larger than 4000/);
  await assert.rejects(() => buildContext({ ranges: ["a.ts:1-4000", "b.ts:1-4000", "c.ts:1-4000", "d.ts:1-1"] }), /12000-line limit/);
});

test("an excluded range prevents an unqualified PASS", async () => {
  const result = await askZuck({ prompt: "review", ranges: [".dev.vars:1-1"], apiKey: "x", fetchImpl: async () => ({ ok: true, json: async () => report }) });
  assert.equal(result.status, "NEEDS CHANGES");
  assert.match(result.findings.medium[0].message, /requested range omitted by policy/);
});

test("incomplete context cannot produce an unqualified PASS", async () => {
  const root = await mkdtemp(join(tmpdir(), "zuck-incomplete-"));
  try {
    await writeFile(join(root, "sample.ts"), "one\ntwo\nthree");
    const result = await askZuck({ prompt: "review", repoRoot: root, ranges: ["sample.ts:2-2"], apiKey: "x", fetchImpl: async () => ({ ok: true, json: async () => report }) });
    assert.equal(result.status, "NEEDS CHANGES");
    assert.match(result.findings.medium[0].message, /Review incomplete/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("enforces exact context budgets and reports truncation", async () => {
  const root = await mkdtemp(join(tmpdir(), "zuck-budget-"));
  try {
    await writeFile(join(root, "large-a.txt"), "a!".repeat(Math.ceil((MAX_FILE_CHARS + 1) / 2)).slice(0, MAX_FILE_CHARS + 1));
    const perFile = await buildContext({ repoRoot: root, files: ["large-a.txt"] });
    assert.ok(perFile.length <= MAX_INPUT_CHARS);
    assert.match(perFile, /FILE TRUNCATED/);
    assert.match(perFile, /CONTEXT_COMPLETE: false/);

    await writeFile(join(root, "large-b.txt"), "b!".repeat(MAX_FILE_CHARS / 2));
    const global = await buildContext({ repoRoot: root, files: ["large-a.txt", "large-b.txt"], diff: "d!".repeat(8_000) });
    assert.ok(global.length <= MAX_INPUT_CHARS);
    assert.match(global, /GLOBAL CONTEXT TRUNCATED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("preserves security logic while redacting literal secret assignments", async () => {
  const root = await mkdtemp(join(tmpdir(), "zuck-redaction-"));
  try {
    await writeFile(join(root, "bridge.js"), "const safeApiKey = String(apiKey ?? '').trim();\nconst options = { authorization: `Bearer ${safeApiKey}` };\nconst secret = 'literal-secret-value';\nAPI_KEY=sk_example_secret\n");
    const context = await buildContext({ repoRoot: root, files: ["bridge.js"] });
    assert.match(context, /safeApiKey = String/);
    assert.match(context, /authorization: `Bearer \$\{safeApiKey\}`/);
    assert.ok(!context.includes("literal-secret-value"));
    assert.ok(!context.includes("sk_example_secret"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("does not redact ordinary credential words and preserves literal delimiters", async () => {
  const root = await mkdtemp(join(tmpdir(), "zuck-prose-"));
  try {
    await writeFile(join(root, "prose.md"), "A token is useful here; authorization and private key are ordinary terms.\nconst apiKey = `literal-secret`;// keep this comment\nconst secret = 'literal-secret' // trailing comment\nconst ordinary = sketched\nconst real = sk_example_secret\n");
    const context = await buildContext({ repoRoot: root, files: ["prose.md"] });
    assert.match(context, /A token is useful here; authorization and private key are ordinary terms\./);
    assert.match(context, /const apiKey = `\[REDACTED SECRET\]`;\/\/ keep this comment/);
    assert.match(context, /const secret = '\[REDACTED SECRET\]' \/\/ trailing comment/);
    assert.match(context, /const ordinary = sketched/);
    assert.ok(!context.includes("sk_example_secret"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("splits globally oversized reviews into complete bounded packets", async () => {
  const root = await mkdtemp(join(tmpdir(), "zuck-packets-"));
  try {
    const fixture = "x\n".repeat(MAX_FILE_CHARS / 2);
    for (const name of ["one.ts", "two.ts", "three.ts"]) await writeFile(join(root, name), fixture);
    const oversized = await buildContext({ repoRoot: root, files: ["one.ts", "two.ts", "three.ts"] });
    assert.match(oversized, /GLOBAL CONTEXT TRUNCATED/);
    const requests = [];
    const result = await askZuck({
      prompt: "review all files",
      repoRoot: root,
      files: ["one.ts", "two.ts", "three.ts"],
      apiKey: "test-api-key-value",
      fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, json: async () => report }; },
    });
    assert.equal(requests.length, 4);
    for (const request of requests) {
      assert.ok(request.input.length < 20_000);
      assert.ok(!request.input.includes("[GLOBAL CONTEXT TRUNCATED]"));
      assert.ok(!request.input.includes("[FILE TRUNCATED"));
    }
    assert.equal(result.status, "PASS");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a failed packet keeps the combined review at NEEDS CHANGES and merges findings", async () => {
  const root = await mkdtemp(join(tmpdir(), "zuck-merge-"));
  try {
    const fixture = "x\n".repeat(MAX_FILE_CHARS / 2);
    for (const name of ["one.ts", "two.ts", "three.ts"]) await writeFile(join(root, name), fixture);
    let packet = 0;
    const result = await askZuck({
      prompt: "review all files",
      repoRoot: root,
      files: ["one.ts", "two.ts", "three.ts"],
      apiKey: "test-api-key-value",
      fetchImpl: async () => {
        packet++;
        if (packet === 4) return { ok: true, json: async () => report };
        const status = packet === 2 ? "NEEDS CHANGES" : "PASS";
        return { ok: true, json: async () => ({ output_text: JSON.stringify({
          status,
          findings: { high: status === "NEEDS CHANGES" ? [{ message: "packet finding" }] : [], medium: [] },
          affected_files: [`file-${packet}.ts`],
          recommended_fixes: [`fix-${packet}`],
          missing_tests: [`test-${packet}`],
        }) }) };
      },
    });
    assert.equal(result.status, "NEEDS CHANGES");
    assert.equal(result.findings.high.length, 1);
    assert.deepEqual(result.affected_files, ["file-1.ts", "file-2.ts", "file-3.ts"]);
    assert.deepEqual(result.recommended_fixes, ["fix-1", "fix-2", "fix-3"]);
    assert.deepEqual(result.missing_tests, ["test-1", "test-2", "test-3"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a medium-only packet transport failure cannot be cleared by a passing synthesis", async () => {
  const root = await mkdtemp(join(tmpdir(), "zuck-packet-failure-"));
  try {
    const fixture = "x\n".repeat(MAX_FILE_CHARS / 2);
    for (const name of ["one.ts", "two.ts", "three.ts"]) await writeFile(join(root, name), fixture);
    let request = 0;
    const result = await askZuck({
      prompt: "review all files",
      repoRoot: root,
      files: ["one.ts", "two.ts", "three.ts"],
      apiKey: "test-api-key-value",
      fetchImpl: async () => {
        request++;
        if (request === 1) throw new Error("temporary packet transport failure");
        return { ok: true, json: async () => report };
      },
    });
    assert.equal(request, 4);
    assert.equal(result.status, "NEEDS CHANGES");
    assert.match(result.findings.medium.map(({ message }) => message).join("\n"), /failed safely|Multipart review/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bounds prompt and packet count before making requests", async () => {
  let requests = 0;
  await assert.rejects(() => askZuck({ prompt: "p".repeat(MAX_PROMPT_CHARS + 1), apiKey: "test-api-key-value", fetchImpl: async () => { requests++; } }), /prompt exceeds/);
  await assert.rejects(() => askZuck({ prompt: "review", files: Array.from({ length: MAX_FILES + 1 }, (_, index) => `file-${index}.ts`), apiKey: "test-api-key-value", fetchImpl: async () => { requests++; } }), /Too many context files/);
  assert.equal(requests, 0);
});

test("truncated diff and test output prevent an unqualified PASS", async () => {
  const result = await askZuck({
    prompt: "review",
    diff: "d!".repeat(8_001),
    tests: "t!".repeat(4_001),
    apiKey: "test-api-key-value",
    fetchImpl: async () => ({ ok: true, json: async () => report }),
  });
  assert.equal(result.status, "NEEDS CHANGES");
  assert.match(result.findings.medium[0].message, /truncated git diff|truncated test output/);
});

test("packet transport errors redact the API key and remain bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "zuck-error-"));
  try {
    const fixture = "x\n".repeat(MAX_FILE_CHARS / 2);
    for (const name of ["one.ts", "two.ts", "three.ts"]) await writeFile(join(root, name), fixture);
    const secret = "transport-secret-value";
    const result = await askZuck({
      prompt: "review all files",
      repoRoot: root,
      files: ["one.ts", "two.ts", "three.ts"],
      apiKey: secret,
      fetchImpl: async () => { throw new Error(`${secret} ${"e".repeat(20_000)}`); },
    });
    const rendered = JSON.stringify(result);
    assert.equal(result.status, "NEEDS CHANGES");
    assert.ok(!rendered.includes(secret));
    assert.ok(rendered.length < 50_000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("single-packet transport errors redact the API key", async () => {
  const secret = "single-transport-secret";
  await assert.rejects(
    () => askZuck({ prompt: "review", apiKey: secret, fetchImpl: async () => { throw new Error(`${secret} provider failure`); } }),
    (error) => !error.message.includes(secret) && /provider failure/.test(error.message)
  );
});

test("streamed provider responses stop at the response limit", async () => {
  const chunk = new Uint8Array(120_000);
  let reads = 0;
  const response = { ok: true, body: { getReader: () => ({ read: async () => { reads++; return reads === 1 ? { done: false, value: chunk } : { done: true }; }, cancel: async () => undefined }) } };
  await assert.rejects(() => askZuck({ prompt: "review", apiKey: "test-api-key-value", fetchImpl: async () => response }), /response exceeded/);
  assert.equal(reads, 1);
});

test("rejects control characters in whole-file paths and preserves ranged line numbers while redacting", async () => {
  const root = await mkdtemp(join(tmpdir(), "zuck-integrity-"));
  try {
    await assert.rejects(() => buildContext({ repoRoot: root, files: ["bad\nname.ts"] }), /Invalid context file path/);
    await writeFile(join(root, "keys.txt"), "one\n-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\nfive");
    const context = await buildContext({ repoRoot: root, ranges: ["keys.txt:3-3"] });
    assert.match(context, /INCLUDED LINES: 3-3 of 5/);
    assert.match(context, /3 \| \[REDACTED PRIVATE KEY\]/);
    assert.ok(!context.includes("secret"));
  } finally { await rm(root, { recursive: true, force: true }); }
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
