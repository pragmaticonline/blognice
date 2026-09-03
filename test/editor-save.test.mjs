import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const admin = readFileSync(new URL("../src/admin.ts", import.meta.url), "utf8");
const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("editor offers save-and-continue and autosaves featured-image changes", () => {
  assert.match(admin, /id="post-editor-form"/);
  assert.match(admin, /name="save" value="close"/);
  assert.match(admin, /name="save" value="continue"/);
  assert.match(admin, /editorForm\.requestSubmit\(saveContinue\)/);
});

test("save handler keeps the editor open when requested", () => {
  assert.match(index, /stayInEditor/);
  assert.match(index, /inserted\.meta\.last_row_id/);
  assert.match(index, /\/edit\/\$\{savedId\}/);
});

test("editor teaches Markdown and provides accessible formatting shortcuts", () => {
  assert.match(admin, /You can write normally\. Markdown adds formatting/);
  assert.match(admin, /<summary>Markdown formatting help<\/summary>/);
  assert.match(admin, /aria-label="Bold"[^>]+data-prefix="\*\*"[^>]+data-suffix="\*\*"/);
  assert.match(admin, /aria-label="Add a link"/);
  assert.match(admin, /setSelectionRange/);
  assert.match(admin, /aria-describedby="markdown-intro markdown-help"/);
});
