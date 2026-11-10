import assert from "node:assert/strict";
import test from "node:test";
import { excerpt } from "../src/render.ts";

test("linked cover images leave no markdown or URL residue", () => {
  const out = excerpt(
    "Dave Cullen’s thriller **Deus v Machina** — a Las Vegas noir.\n\n[![](/media/154/1794301179569-2adaeab4.jpg)](https://thedavecullenshow.com/product/deus-v-machina/)\n\nMore words here.",
    155,
  );
  assert.doesNotMatch(out, /!?\[|]\(|https?:|media\//);
  assert.match(out, /Dave Cullen’s thriller/);
});

test("plain images keep alt text, links keep text, bare URLs drop out", () => {
  assert.equal(excerpt("Look ![a sunset](https://cdn.example/s.jpg) today", 180), "Look a sunset today");
  assert.equal(excerpt("See [the shop](https://shop.example/electronics) now", 180), "See the shop now");
  const bare = excerpt("Watch this.\n\nhttps://www.youtube.com/watch?v=WuFEX-Sb0Ck\n\nIf you enjoy it.", 125);
  assert.doesNotMatch(bare, /youtu|https?:|v=/);
  assert.match(bare, /Watch this/);
});

test("ordinary prose truncates at a word boundary with an ellipsis", () => {
  const out = excerpt("word ".repeat(100), 30);
  assert.ok(out.endsWith("…") && out.length <= 31);
  assert.equal(excerpt("Short.", 180), "Short.");
});
