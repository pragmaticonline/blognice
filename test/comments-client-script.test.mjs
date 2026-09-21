// Regression: the comment client script is emitted through a server-side
// template literal, so every backslash in its regexes must be escaped.
// A single `\n` once shipped a raw newline and killed the whole script in
// every browser (no handler, no socket, native form submit). This test
// compiles every served inline script and pins the emitted escapes.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

test("served comment scripts parse and keep their regex escapes", async () => {
  const { renderCommentSection } = await import("../src/render.ts");
  const html = renderCommentSection(
    { id: 11, slug: "usa-politics-tlmcgb" },
    [
        { id: 1, parent_id: null, author_name: "Loop QA", body: "First.", created_at: 1789913617, status: "approved" },
        { id: 2, parent_id: 1, author_name: "Loop QA", body: "Line one\nLine two.", created_at: 1789913620, status: "approved" },
    ],
  );
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 1, "comment section ships a client script");
  for (const code of scripts) {
    new vm.Script(code); // throws on the raw-newline class of breakage
  }
  const client = scripts.join("\n");
  assert.ok(client.includes("replace(/\\n/g"), "newline regex survives as backslash-n");
  assert.ok(client.includes("/\\bd([0-4])\\b/"), "word boundaries survive as backslash-b");
  assert.ok(client.includes("/\\(([0-9]+)\\)/"), "count parens survive escaped");
  assert.ok(client.includes("preventScroll"), "modal focus never scrolls the page");
});
