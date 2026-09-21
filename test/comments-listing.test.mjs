import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
for (const extension of [".html", ".svg"]) {
  require.extensions[extension] = (module, filename) => {
    module.exports = readFileSync(filename, "utf8");
  };
}

const NOW = Math.floor(Date.now() / 1000);

function makeState() {
  // A tree: 1 -> 2 -> 3 -> 4 -> 5 -> 6 (depth chain), a tombstone parent 10
  // with approved child 11, a childless removed 12, and 25 flat top-level
  // comments for paging. Author 1 smuggles markup to prove escaping.
  const comments = [
    { id: 1, tenant_id: 1, post_id: 7, parent_id: null, author_name: "<script>alert(1)</script>", email_hash: "e1", body: "TopLevelBody.", status: "approved", created_at: NOW - 100 },
    { id: 2, tenant_id: 1, post_id: 7, parent_id: 1, author_name: "B", email_hash: "e2", body: "ReplyLevelTwo.", status: "approved", created_at: NOW - 90 },
    { id: 3, tenant_id: 1, post_id: 7, parent_id: 2, author_name: "C", email_hash: "e3", body: "L3.", status: "approved", created_at: NOW - 80 },
    { id: 4, tenant_id: 1, post_id: 7, parent_id: 3, author_name: "D", email_hash: "e4", body: "L4.", status: "approved", created_at: NOW - 70 },
    { id: 5, tenant_id: 1, post_id: 7, parent_id: 4, author_name: "E", email_hash: "e5", body: "L5.", status: "approved", created_at: NOW - 60 },
    { id: 6, tenant_id: 1, post_id: 7, parent_id: 5, author_name: "F", email_hash: "e6", body: "L6 deep.", status: "approved", created_at: NOW - 50 },
    { id: 10, tenant_id: 1, post_id: 7, parent_id: null, author_name: "Gone", email_hash: "e7", body: "Removed parent.", status: "removed", created_at: NOW - 40 },
    { id: 11, tenant_id: 1, post_id: 7, parent_id: 10, author_name: "H", email_hash: "e8", body: "Orphan kept.", status: "approved", created_at: NOW - 30 },
    { id: 12, tenant_id: 1, post_id: 7, parent_id: null, author_name: "Vanished", email_hash: "e9", body: "Childless removed.", status: "removed", created_at: NOW - 20 },
  ];
  for (let i = 0; i < 25; i++) {
    comments.push({ id: 100 + i, tenant_id: 1, post_id: 7, parent_id: null, author_name: `P${i}`, email_hash: `p${i}`, body: `Flat ${i}.`, status: "approved", created_at: NOW - 10 + i });
  }
  return {
    tenant: {
      id: 1, public_id: "b_comments", slug: "commentblog", title: "Comment Blog",
      description: "", accent_color: "#1a8917", comments_enabled: 1, shard: "primary",
      created_at: NOW, deleted_at: null,
    },
    posts: {
      "live-post": { id: 7, tenant_id: 1, slug: "live-post", title: "Live", body_md: "Post body.", tags_json: "[]", published: 1, created_at: NOW, updated_at: NOW, author_visible: 1 },
    },
    comments,
  };
}

function fakeDb(state) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => {
              if (sql.includes("tenant_slug_aliases")) return null;
              if (sql.includes("FROM tenants")) return state.tenant;
              if (sql.includes("FROM posts")) return state.posts[args[args.length - 1]] ?? null;
              return null;
            },
            all: async () => {
              if (sql.includes("FROM comments")) {
                let rows = state.comments.filter((c) => c.tenant_id === args[0] && (args[1] === undefined || c.post_id === args[1]));
                if (sql.includes("status = 'approved'")) rows = rows.filter((c) => c.status === "approved");
                if (sql.includes("id > ?")) rows = rows.filter((c) => c.id > args[args.length - 1]);
                return { results: rows };
              }
              return { results: [] };
            },
            run: async () => ({ success: true }),
          };
        },
      };
    },
  };
}

const req = (path, opts = {}) => new Request(`https://commentblog.blognice.test${path}`, {
  ...opts,
  headers: { host: "commentblog.blognice.test", ...(opts.headers || {}) },
});

test("post pages server-render comment threads with tombstones and depth caps", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const state = makeState();
  const env = { DB: fakeDb(state), POSTS: fakeDb(state), ROOT_DOMAIN: "blognice.test" };
  const executionCtx = { waitUntil() {}, passThroughOnException() {} };
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  try {
    const res = await blogniceApp.request(req("/live-post"), undefined, env, executionCtx);
    assert.equal(res.status, 200);
    const html = await res.text();
    // Section, count (approved only: 6 chain + 1 orphan + 25 flat = 32).
    assert.match(html, /id="comments"/);
    assert.match(html, /Comments \(32\)/);
    // Nesting renders parent before child.
    assert.ok(html.indexOf("TopLevelBody.") < html.indexOf("ReplyLevelTwo."), "replies nest under parents");
    // Markup in author names is escaped, never executed.
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.match(html, /&lt;script&gt;/);
    // Removed parent with children becomes a tombstone keeping context.
    assert.match(html, /Removed by moderator/);
    assert.match(html, /Orphan kept\./);
    // Childless removed comments vanish entirely.
    assert.doesNotMatch(html, /Childless removed\./);
    assert.doesNotMatch(html, /Removed parent\./);
    // Only two nesting levels: replies past depth 1 flatten to d1 with a
    // jquery-comments-style reply-to label instead of indenting forever.
    assert.match(html, /↩/);
    assert.match(html, /L6 deep\./);
    assert.doesNotMatch(html, /comment d[2-9]/);
    assert.match(html, /↩ B/);
    assert.match(html, /↩ C/);
    // jquery-comments-style entry: avatar beside a tailed bubble box.
    assert.match(html, /comment-entry-avatar/);
    assert.match(html, /comment-bubble/);
    // Collapsed replies use the hidden attribute, which must beat the row CSS.
    assert.match(html, /\.comment\[hidden\]/);
    // Replies keep text flush: avatar rides inline in the name row.
    assert.match(html, /<summary><span class="comment-avatar"/);
    // Human timestamps: machine time in data-ts, relative text for readers.
    assert.match(html, /data-ts="/);
    assert.match(html, /1 min ago/);
    // Flattened, not nested: the 1->2->3 chain renders a single
    // comment-children container holding every descendant as a sibling.
    const chain = html.slice(html.indexOf('data-comment="1"'), html.indexOf('data-comment="10"'));
    assert.equal(chain.match(/<div class="comment-children">/g).length, 1);
    // The container opens before the root closes: sorting a thread moves its
    // replies with it instead of stranding them above their parent.
    assert.ok(chain.indexOf('<div class="comment-children">') < chain.indexOf("</details>"),
      "children container grouped inside the root");
    // Reply affordance and comment form exist for readers.
    assert.match(html, /data-reply-to="1"/);
    assert.match(html, /data-comment-form/);
    // Entry is an always-visible slim box above the thread; the dialog
    // holds the same form only for first-time verification.
    assert.match(html, /data-comment-dialog/);
    assert.ok(!html.includes("data-comment-teaser"), "no teaser gate");
    assert.match(html, /data-form-home/);
    assert.match(html, /id-fields/);
    assert.equal(html.match(/<form class="comment-form/g).length, 1);
    assert.match(html, />Send</);
    // No visible caption text on the entry box: the textarea is bare with
    // an accessible name, and the submit button gets compact slim styling.
    assert.ok(!html.includes("<label>Comment<"), "no visible Comment label");
    assert.match(html, /aria-label="Comment"/);
    assert.match(html, /\.comment-form\.slim button\[type="submit"\]/);
    // Entry box sits above the thread, YouTube-style.
    assert.ok(html.indexOf("data-comment-teaser") < html.indexOf('<div class="comment-list"'), "teaser precedes the list");
    // jquery-comments-style identity row: avatar with initial, actions row.
    assert.match(html, /comment-avatar/);
    assert.match(html, /comment-avatar[^>]*>B</); // reply author's initial
    assert.match(html, /comment-avatar[^>]*>&lt;</); // markup author's initial is escaped
    assert.match(html, /comment-actions/);
    // jquery-comments-style sort tabs above the thread; oldest matches the
    // server order, newest re-orders client-side without a reload.
    assert.match(html, /data-sort-tabs/);
    assert.match(html, /data-sort-tab="newest"/);
    assert.match(html, /data-sort-tab="oldest"/);

    // Comments disabled: no section at all.
    state.tenant.comments_enabled = 0;
    const off = await blogniceApp.request(req("/live-post"), undefined, env, executionCtx);
    assert.doesNotMatch(await off.text(), /id="comments"/);
    state.tenant.comments_enabled = 1;
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test("comment cursor endpoint pages top-level threads and catches up", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const state = makeState();
  const env = { DB: fakeDb(state), POSTS: fakeDb(state), ROOT_DOMAIN: "blognice.test" };
  const executionCtx = { waitUntil() {}, passThroughOnException() {} };
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  try {
    const page1 = await blogniceApp.request(req("/live-post/comments?cursor=0"), undefined, env, executionCtx);
    assert.equal(page1.status, 200);
    const json1 = await page1.json();
    assert.equal(json1.comments.length, 20);
    assert.ok(json1.next_cursor, "more pages remain");
    // First top-level node carries its subtree.
    const chain = json1.comments.find((c) => c.id === 1);
    assert.ok(chain, "chain root on first page");
    assert.equal(chain.replies[0].replies[0].id, 3);

    const page2 = await blogniceApp.request(req(`/live-post/comments?cursor=${json1.next_cursor}`), undefined, env, executionCtx);
    const json2 = await page2.json();
    assert.ok(json2.comments.length > 0 && json2.comments.length <= 20);
    assert.equal(json2.next_cursor, null);

    // Catch-up: everything approved after a known id, flat with parent links.
    const since = await blogniceApp.request(req("/live-post/comments?since_id=11"), undefined, env, executionCtx);
    const sinceJson = await since.json();
    assert.ok(sinceJson.comments.length > 0);
    assert.ok(sinceJson.comments.every((c) => c.id > 11));
    assert.ok(!sinceJson.comments.some((c) => c.body === "Childless removed."), "removed bodies never leak");

    // Drafts, unknown posts, and disabled blogs 404.
    state.posts["live-post"].published = 0;
    assert.equal((await blogniceApp.request(req("/live-post/comments?cursor=0"), undefined, env, executionCtx)).status, 404);
    state.posts["live-post"].published = 1;
    assert.equal((await blogniceApp.request(req("/nope/comments?cursor=0"), undefined, env, executionCtx)).status, 404);
    state.tenant.comments_enabled = 0;
    assert.equal((await blogniceApp.request(req("/live-post/comments?cursor=0"), undefined, env, executionCtx)).status, 404);
    state.tenant.comments_enabled = 1;
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});
