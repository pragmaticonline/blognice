import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const adminSource = readFileSync(new URL("../src/admin.ts", import.meta.url), "utf8");
const renderSource = readFileSync(new URL("../src/render.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/011-post-author-name.sql", import.meta.url), "utf8");
const displayMigration = readFileSync(new URL("../migrations/012-membership-display-name.sql", import.meta.url), "utf8");
const visibilityMigration = readFileSync(new URL("../migrations/013-post-author-visibility.sql", import.meta.url), "utf8");

test("editor exposes tenant-scoped author selection and public author name", () => {
  assert.match(adminSource, /name="author_account_id"/);
  assert.match(adminSource, /name="author_name"/);
  assert.match(indexSource, /JOIN accounts a ON a\.id = m\.account_id/);
  assert.match(indexSource, /selectedAuthor/);
});

test("post saves validate selected authors through blog memberships", () => {
  assert.match(indexSource, /const authors = can\(ctx\.role, "posts\.edit\.any"\)/);
  assert.match(indexSource, /authorAccountId/);
  assert.match(indexSource, /author_name/);
  assert.match(migration, /ALTER TABLE posts ADD COLUMN author_name TEXT/);
});

test("public posts use the selected author while retaining blog attribution", () => {
  assert.match(renderSource, /post\.author_name && !post\.author_name\.includes\("@"\)/);
  assert.match(renderSource, /For \$\{esc\(tenant\.title\)\}/);
});

test("collaborators can set a blog-specific public display name", () => {
  assert.match(indexSource, /UPDATE memberships SET display_name/);
  assert.match(indexSource, /m\.display_name/);
  assert.match(displayMigration, /ALTER TABLE memberships ADD COLUMN display_name TEXT/);
});

test("owners can hide the author while retaining internal attribution", () => {
  assert.match(adminSource, /name="author_visibility"/);
  assert.match(indexSource, /author_visible/);
  assert.match(renderSource, /post\.author_visible === 0/);
  assert.match(visibilityMigration, /ALTER TABLE posts ADD COLUMN author_visible/);
});
