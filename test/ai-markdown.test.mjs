import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";
import { conservativeMarkdownFallback, markdownFormattingMessages, markdownFormattingRetryMessages, markdownOutputTokenBudget, normalizedMarkdownResponse, preservesAuthorTokens } from "../src/ai-markdown.ts";

const require = createRequire(import.meta.url);
for (const extension of [".html", ".svg"]) require.extensions[extension] = (module, filename) => { module.exports = readFileSync(filename, "utf8"); };

const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const admin = readFileSync(new URL("../src/admin.ts", import.meta.url), "utf8");

test("Markdown formatting prompt preserves the author's words and returns only Markdown", () => {
  const messages = markdownFormattingMessages("First line\n\nSecond line");
  assert.match(messages[0].content, /Do not add, remove, paraphrase, correct, or reorder/);
  assert.match(messages[0].content, /Return only the formatted Markdown/);
  assert.equal(messages[1].content, "First line\n\nSecond line");
});

test("Markdown formatting response removes only an enclosing Markdown fence", () => {
  assert.equal(normalizedMarkdownResponse("```markdown\n# Heading\n\nText\n```"), "# Heading\n\nText");
  assert.equal(normalizedMarkdownResponse("# Heading\n\nText"), "# Heading\n\nText");
  assert.equal(normalizedMarkdownResponse("```js\nalert(1)\n```"), "```js\nalert(1)\n```");
});

test("Markdown formatting rejects rewritten or reordered words", () => {
  assert.equal(preservesAuthorTokens("First line. Second line.", "## First line.\n\n**Second line.**"), true);
  assert.equal(preservesAuthorTokens("Don’t SHOUT", "**Don't shout**"), true);
  assert.equal(preservesAuthorTokens("First line. Second line.", "## Better first line.\n\nSecond line."), false);
  assert.equal(preservesAuthorTokens("First line. Second line.", "Second line. First line."), false);
  assert.match(markdownFormattingRetryMessages("Original", "Changed").at(-1).content, /copy every original word/i);
});

test("Markdown formatting bounds model output and has a word-preserving fallback", () => {
  assert.equal(markdownOutputTokenBudget("short"), 512);
  assert.equal(markdownOutputTokenBudget("x".repeat(20_000)), 4096);
  const original = "Iran targets US bases\nAir bases used by US hit\n\nIran has continued to demonstrate an ability to target bases.";
  const fallback = conservativeMarkdownFallback(original);
  assert.equal(fallback, "# Iran targets US bases\n*Air bases used by US hit*\n\nIran has continued to demonstrate an ability to target bases.");
  assert.equal(preservesAuthorTokens(original, fallback), true);
});

test("auto-format endpoint is tenant scoped, same-origin, paid, metered, and refundable", () => {
  assert.match(index, /app\.post\("\/admin\/b\/:blogId\/format-markdown"/);
  assert.match(index, /AI_FORMAT_CREDITS/);
  assert.match(index, /tenantHasPaidPlan/);
  assert.match(index, /same-origin request required/);
  assert.match(index, /reserveAiCredits\(c\.env, ctx\.tenant\.id, AI_FORMAT_CREDITS\)/);
  assert.match(index, /refundAiCredits\(c\.env, creditReservation\.accountId, creditReservation\.period, AI_FORMAT_CREDITS\)/);
});

test("editor exposes busy, error, replacement, and undo states", () => {
  assert.match(admin, /id="auto-format"/);
  assert.match(admin, /id="auto-format-status"[^>]+aria-live="polite"/);
  assert.match(admin, /Undo auto-format/);
  assert.match(admin, /body\.value = data\.markdown/);
});

test("authenticated editor auto-format consumes one credit and returns AI Markdown without saving", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: { DB: "ai-markdown-http" } });
  try {
    const db = await mf.getD1Database("DB");
    for (const statement of readFileSync(new URL("../schema.sql", import.meta.url), "utf8").replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "").split(/;\s*(?=\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) await db.prepare(statement).run();
    const now = Math.floor(Date.now() / 1000);
    await db.prepare("INSERT INTO accounts (id,email,pw_hash,billing_status,email_verified,created_at) VALUES (1,'writer@example.com','x','active',1,?)").bind(now).run();
    await db.prepare("INSERT INTO tenants (id,public_id,slug,title,created_at) VALUES (2,'blog-public','notes','Notes',?)").bind(now).run();
    await db.prepare("INSERT INTO memberships (account_id,tenant_id,role,created_at) VALUES (1,2,'owner',?)").bind(now).run();
    await db.prepare("INSERT INTO sessions (token,account_id,created_at,expires_at) VALUES ('format-session',1,?,?)").bind(now, now + 3600).run();
    const calls = [];
    const aiResponses = [
      "## First line\n\nSecond line",
      "## A rewritten article", "## First line\n\n- Second line",
      "## Completely different", "## Still different",
    ];
    const env = { DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test", EVENTS: { writeDataPoint() {} }, AI: { run: async (_model, input) => { calls.push(input); return { response: aiResponses.shift() }; } } };
    const request = () => blogniceApp.request(new Request("https://www.blognice.test/admin/b/blog-public/format-markdown", {
      method: "POST", headers: { cookie: "bn_session=format-session", origin: "https://www.blognice.test", "content-type": "application/json" }, body: JSON.stringify({ text: "First line\n\nSecond line" }),
    }), undefined, env, { waitUntil() {}, passThroughOnException() {} });
    const response = await request();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { markdown: "## First line\n\nSecond line" });
    assert.equal(calls.length, 1);
    assert.equal(await db.prepare("SELECT credits_used FROM ai_credit_usage WHERE account_id=1").first().then((row) => row.credits_used), 1);
    const retried = await request();
    assert.equal(retried.status, 200);
    assert.deepEqual(await retried.json(), { markdown: "## First line\n\n- Second line" });
    assert.equal(calls.length, 3);
    assert.equal(await db.prepare("SELECT credits_used FROM ai_credit_usage WHERE account_id=1").first().then((row) => row.credits_used), 2);
    const rejected = await request();
    assert.equal(rejected.status, 200);
    const fallback = await rejected.json();
    assert.equal(fallback.markdown, "# First line\n\nSecond line");
    assert.match(fallback.warning, /safe basic formatting/);
    assert.equal(calls.length, 5);
    assert.equal(await db.prepare("SELECT credits_used FROM ai_credit_usage WHERE account_id=1").first().then((row) => row.credits_used), 2);
  } finally { await mf.dispose(); }
});
