import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { findMediaUse, mediaKey, mediaUrl, validLibraryFile } from "../src/media.ts";

test("library deletion accepts generated upload names but not avatars or paths", () => {
  assert.equal(validLibraryFile("1722510000-deadbeef.webp"), true);
  assert.equal(validLibraryFile("avatar-deadbeef.webp"), false);
  assert.equal(validLibraryFile("../other-blog.webp"), false);
  assert.equal(validLibraryFile("folder/image.webp"), false);
});

test("media keys and URLs remain scoped to the tenant", () => {
  const key = mediaKey(42, "1722510000-deadbeef.webp");
  assert.equal(key, "42/1722510000-deadbeef.webp");
  assert.equal(mediaUrl(key), "/media/42/1722510000-deadbeef.webp");
});

test("reference lookup is tenant scoped and searches for the exact media URL", async () => {
  const calls = [];
  const expected = { id: 7, title: "Referenced post" };
  const db = {
    prepare(sql) {
      calls.push(["prepare", sql]);
      return {
        bind(...values) {
          calls.push(["bind", ...values]);
          return { first: async () => expected };
        },
      };
    },
  };
  const found = await findMediaUse(db, 42, "/media/42/image.webp");
  assert.deepEqual(found, expected);
  assert.match(calls[0][1], /tenant_id = \?/);
  assert.match(calls[0][1], /instr\(body_md, \?\)/);
  assert.deepEqual(calls[1], ["bind", 42, "/media/42/image.webp", "42/image.webp"]);
});

test("editor media insertion keeps newline escapes valid in generated JavaScript", () => {
  const source = readFileSync(new URL("../src/admin.ts", import.meta.url), "utf8");
  const escapedInsertion = String.raw`insertAtCursor("\\n![]("+pick.dataset.url+")\\n")`;
  assert.ok(source.includes(escapedInsertion));
});

test("editor preview constrains wide images to its container", () => {
  const source = readFileSync(new URL("../src/admin.ts", import.meta.url), "utf8");
  assert.match(source, /\.preview img \{[^}]*max-width: 100%;[^}]*height: auto;/);
});
