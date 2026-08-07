import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/index.ts", "utf8");
const admin = readFileSync("src/admin.ts", "utf8");

assert.match(source, /normalizeApiPostTags/);
assert.match(source, /tags_json, published, created_at, updated_at, author_account_id, author_name, author_visible/);
assert.match(source, /author_name must be 120 characters or fewer/);
assert.match(source, /author_visible: !!authorVisible/);
assert.match(source, /SELECT id, slug, title, featured_image_key, tags_json, author_name, author_visible/);
assert.match(source, /tags: storedPostTags\(post\.tags_json\)/);
assert.match(admin, /"tags":\["api","automation"\]/);
assert.match(admin, /author_visible/);

console.log("api post metadata tests passed");
