import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { editorPage } from "../src/admin.ts";

const admin = readFileSync(new URL("../src/admin.ts", import.meta.url), "utf8");
const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("editor offers save-and-continue and autosaves featured-image changes", () => {
  assert.match(admin, /id="post-editor-form"/);
  assert.match(admin, /name="save" value="close"/);
  assert.match(admin, /name="save" value="continue"/);
  assert.match(admin, /editorForm\.requestSubmit\(saveContinue\)/);
  assert.match(admin, /x-blognice-save/);
  assert.match(admin, /history\.replaceState/);
  assert.match(admin, /Saved/);
  assert.match(admin, /role="status"/);
});

test("save handler keeps the editor open when requested", () => {
  assert.match(index, /stayInEditor/);
  assert.match(index, /inserted\.meta\.last_row_id/);
  assert.match(index, /\/edit\/\$\{savedId\}/);
  assert.match(index, /x-blognice-save/);
  assert.match(index, /c\.json\(\{ saved: true, id: savedId \}\)/);
});

test("editor teaches Markdown and provides accessible formatting shortcuts", () => {
  assert.match(admin, /You can write normally\. Markdown adds formatting/);
  assert.match(admin, /<summary>Markdown formatting help<\/summary>/);
  assert.match(admin, /aria-label="Bold"[^>]+data-prefix="\*\*"[^>]+data-suffix="\*\*"/);
  assert.match(admin, /aria-label="Add a link"/);
  assert.match(admin, /setSelectionRange/);
  assert.match(admin, /aria-describedby="markdown-intro markdown-help"/);
  assert.match(admin, /id="auto-format"/);
  for (const topic of [
    "Six heading levels", "Bold and italic", "Strikethrough", "Numbered list",
    "Nested list", "Inline code", "Code block", "Divider", "Image", "Table",
    "Link to a heading", "New paragraph", "Line break", "Show Markdown symbols",
  ]) assert.match(admin, new RegExp(topic));
  assert.match(admin, /Raw HTML is removed for safety/);
  assert.match(admin, /Use the Preview tab/);
});

test("generated editor scripts compile in the browser", () => {
  const html = editorPage(
    { id: 1, email: "writer@example.com", billing_status: "active" },
    { id: 2, public_id: "blog-public", slug: "notes", title: "Notes", membership_role: "owner" },
    "blognice.test", { id: 3, title: "Draft", slug: "draft", body_md: "Body", tags_json: "[]", published: 1 },
  );
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(match[1]));
});
