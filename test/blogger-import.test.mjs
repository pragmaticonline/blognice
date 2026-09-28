import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";
import {
  BLOGGER_IMPORT_MAX_ENTRIES,
  BloggerImportError,
  bloggerHtmlToMarkdown,
  normalizeBloggerTags,
  parseBloggerExport,
} from "../src/blogger-import.ts";

const require = createRequire(import.meta.url);
for (const extension of [".html", ".svg"]) {
  require.extensions[extension] = (module, filename) => {
    module.exports = readFileSync(filename, "utf8");
  };
}

globalThis.caches = { default: { delete: async () => true, match: async () => undefined, put: async () => {} } };

const LEGACY_XML = `<?xml version='1.0' encoding='UTF-8' ?>
<feed xmlns='http://www.w3.org/2005/Atom' xmlns:app='http://purl.org/atom/app#'>
  <entry>
    <id>tag:blogger.com,1999:blog-123.post-111</id>
    <published>2024-05-01T10:00:00.000Z</published>
    <updated>2024-05-02T11:30:00.000Z</updated>
    <category scheme='http://schemas.google.com/g/2005#kind' term='http://schemas.google.com/blogger/2008/kind#post'/>
    <category scheme='http://www.blogger.com/atom/ns#' term='Travel'/>
    <category scheme='http://www.blogger.com/atom/ns#' term='notes'/>
    <title type='text'>Hello From Lisbon</title>
    <content type='html'>&lt;h2&gt;Day one&lt;/h2&gt;&lt;p&gt;We arrived &amp;amp; unpacked.&lt;/p&gt;</content>
    <author><name>Lena</name></author>
  </entry>
  <entry>
    <id>tag:blogger.com,1999:blog-123.post-112</id>
    <published>2024-06-01T10:00:00.000Z</published>
    <category scheme="http://schemas.google.com/g/2005#kind" term="http://schemas.google.com/blogger/2008/kind#post"/>
    <category scheme="http://www.blogger.com/atom/ns#" term="Drafts"/>
    <title type='text'>Unfinished Thoughts</title>
    <content type='html'>&lt;p&gt;not ready yet&lt;/p&gt;</content>
    <app:control><app:draft>yes</app:draft></app:control>
    <author><name>Lena</name></author>
  </entry>
  <entry>
    <id>tag:blogger.com,1999:blog-123.page-113</id>
    <published>2024-04-01T10:00:00.000Z</published>
    <category scheme='http://schemas.google.com/g/2005#kind' term='http://schemas.google.com/blogger/2008/kind#page'/>
    <title type='text'>About Me</title>
    <content type='html'>&lt;p&gt;I blog about trips.&lt;/p&gt;</content>
    <author><name>Lena</name></author>
  </entry>
  <entry>
    <id>tag:blogger.com,1999:blog-123.post-111.comment-1</id>
    <published>2024-05-03T10:00:00.000Z</published>
    <category scheme='http://schemas.google.com/g/2005#kind' term='http://schemas.google.com/blogger/2008/kind#comment'/>
    <title type='text'>Nice!</title>
    <content type='html'>Great post</content>
  </entry>
  <entry>
    <id>tag:blogger.com,1999:blog-123.settings</id>
    <category scheme='http://schemas.google.com/g/2005#kind' term='http://schemas.google.com/blogger/2008/kind#settings'/>
    <title type='text'>Settings</title>
    <content type='html'>blog settings</content>
  </entry>
</feed>`;

const TAKEOUT_XML = `<?xml version='1.0' encoding='UTF-8' ?>
<feed xmlns='http://www.w3.org/2005/Atom' xmlns:blogger='http://schemas.google.com/blogger/2018'>
  <entry>
    <id>tag:blogger.com,1999:blog-9.post-21</id>
    <blogger:type>POST</blogger:type>
    <blogger:status>LIVE</blogger:status>
    <published>2023-01-02T03:04:05Z</published>
    <updated>2023-01-03T04:05:06Z</updated>
    <category term='Food'/>
    <title>Soup Season</title>
    <content>See &lt;a href="https://example.com/recipe"&gt;this recipe&lt;/a&gt; and &lt;img src="https://example.com/soup.jpg" alt="soup"/&gt;.</content>
    <author><name>Marco</name></author>
  </entry>
  <entry>
    <id>tag:blogger.com,1999:blog-9.page-22</id>
    <blogger:type>PAGE</blogger:type>
    <published>2023-02-01T00:00:00Z</published>
    <title>Contact</title>
    <content>&lt;p&gt;Write to me.&lt;/p&gt;</content>
  </entry>
  <entry>
    <id>tag:blogger.com,1999:blog-9.post-23</id>
    <blogger:type>POST</blogger:type>
    <blogger:status>DRAFT</blogger:status>
    <published>2023-03-01T00:00:00Z</published>
    <title>Secret Stew</title>
    <content>shh</content>
  </entry>
  <entry>
    <id>tag:blogger.com,1999:blog-9.post-21.comment-5</id>
    <blogger:type>COMMENT</blogger:type>
    <published>2023-01-04T00:00:00Z</published>
    <title>Yum</title>
    <content>tasty</content>
  </entry>
  <entry>
    <id>tag:blogger.com,1999:blog-9.post-24</id>
    <blogger:type>POST</blogger:type>
    <blogger:trashed>2023-04-01T00:00:00Z</blogger:trashed>
    <published>2023-04-01T00:00:00Z</published>
    <title>Deleted</title>
    <content>gone</content>
  </entry>
</feed>`;

test("legacy Blogger export parses posts, drafts, and pages; skips comments and settings", () => {
  const parsed = parseBloggerExport(LEGACY_XML);
  assert.equal(parsed.items.length, 3);
  assert.deepEqual(parsed.skipped, { comments: 1, settings: 1, trashed: 0, unknown: 0 });

  const post = parsed.items[0];
  assert.equal(post.kind, "post");
  assert.equal(post.title, "Hello From Lisbon");
  assert.equal(post.suggestedSlug, "hello-from-lisbon");
  assert.deepEqual(post.tags, ["travel", "notes"]);
  assert.equal(post.publishedAt, Date.parse("2024-05-01T10:00:00.000Z") / 1000);
  assert.equal(post.updatedAt, Date.parse("2024-05-02T11:30:00.000Z") / 1000);
  assert.equal(post.draft, false);
  assert.equal(post.author, "Lena");
  assert.match(post.bodyMarkdown, /## Day one/);
  assert.match(post.bodyMarkdown, /We arrived & unpacked\./);

  const draft = parsed.items[1];
  assert.equal(draft.draft, true);
  assert.equal(draft.suggestedSlug, "unfinished-thoughts");

  const page = parsed.items[2];
  assert.equal(page.kind, "page");
  assert.equal(page.suggestedSlug, "about-me");
  assert.deepEqual(page.tags, []);
});

test("Takeout feed parses POST/PAGE entries; skips comments, drafts stay drafts, trashed skipped", () => {
  const parsed = parseBloggerExport(TAKEOUT_XML);
  assert.equal(parsed.items.length, 3);
  assert.deepEqual(parsed.skipped, { comments: 1, settings: 0, trashed: 1, unknown: 0 });

  const post = parsed.items[0];
  assert.equal(post.kind, "post");
  assert.equal(post.draft, false);
  assert.deepEqual(post.tags, ["food"]);
  assert.equal(post.author, "Marco");
  assert.match(post.bodyMarkdown, /\[this recipe\]\(https:\/\/example\.com\/recipe\)/);
  assert.match(post.bodyMarkdown, /!\[soup\]\(https:\/\/example\.com\/soup\.jpg\)/);

  assert.equal(parsed.items[1].kind, "page");
  assert.equal(parsed.items[2].draft, true);
});

test("Blogger HTML converts to Markdown and drops scripts", () => {
  const md = bloggerHtmlToMarkdown(
    `<script>alert(1)</script><h1>Title</h1><p>Hello <strong>bold</strong> and <em>italic</em>.</p>` +
    `<ul><li>one</li><li>two</li></ul><ol><li>first</li></ol>` +
    `<blockquote>quoted<br>line</blockquote><pre><code>const a = 1;</code></pre><hr>` +
    `<a href="https://example.com">link</a> <img src="https://example.com/i.png">` +
    `<iframe src="https://www.youtube.com/embed/x"></iframe>&nbsp;&mdash;`
  );
  assert.match(md, /^# Title/m);
  assert.match(md, /\*\*bold\*\* and \*italic\*/);
  assert.match(md, /- one\n- two/);
  assert.match(md, /1\. first/);
  assert.match(md, /> quoted/);
  assert.match(md, /```\nconst a = 1;\n```/);
  assert.match(md, /^---$/m);
  assert.match(md, /\[link\]\(https:\/\/example\.com\)/);
  assert.match(md, /!\[\]\(https:\/\/example\.com\/i\.png\)/);
  assert.match(md, /\[Video\]\(https:\/\/www\.youtube\.com\/embed\/x\)/);
  assert.match(md, / —$/);
  assert.doesNotMatch(md, /alert/);
  assert.doesNotMatch(md, /<[^>]+>/);
});

test("Blogger tags mirror post-tag rules and drop invalid labels", () => {
  assert.deepEqual(normalizeBloggerTags(["#Hello", "HELLO", "bad tag!", "x".repeat(50), "ok_tag-2"]), ["hello", "ok_tag-2"]);
  assert.deepEqual(normalizeBloggerTags(Array.from({ length: 25 }, (_, i) => `tag${i}`)).length, 20);
});

test("Blogger parser rejects non-feeds, caps entries, and falls back on missing fields", () => {
  assert.throws(() => parseBloggerExport("<html>nope</html>"), BloggerImportError);
  const many = `<feed>${"<entry><id>x</id><title>t</title></entry>".repeat(BLOGGER_IMPORT_MAX_ENTRIES + 1)}</feed>`;
  assert.throws(() => parseBloggerExport(many), /limited to/);
  const fallback = parseBloggerExport(
    `<feed><entry><id>tag:blogger.com,1999:blog-1.post-7</id><category scheme='${"http://schemas.google.com/g/2005#kind"}' term='${"http://schemas.google.com/blogger/2008/kind#post"}'/><title></title><content></content></entry></feed>`,
    1700000000
  );
  assert.equal(fallback.items.length, 1);
  assert.equal(fallback.items[0].title, "Untitled");
  assert.equal(fallback.items[0].suggestedSlug, "post-7");
  assert.equal(fallback.items[0].publishedAt, 1700000000);
  assert.equal(fallback.items[0].bodyMarkdown, "");
});

async function loadSchema(db, path) {
  const schema = readFileSync(new URL(path, import.meta.url), "utf8");
  const statements = schema
    .replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "")
    .split(/;\s*(?=\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const st of statements) await db.prepare(st).run();
}

async function setupBlog() {
  const { blogniceApp } = await import("../src/index.ts");
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: ["DB", "POSTS"],
    r2Buckets: ["MEDIA"],
  });
  const indexDb = await mf.getD1Database("DB");
  const postsDb = await mf.getD1Database("POSTS");
  const media = await mf.getR2Bucket("MEDIA");
  await loadSchema(indexDb, "../schema.sql");
  await loadSchema(postsDb, "../schema-posts.sql");
  const now = Math.floor(Date.now() / 1000);
  await indexDb.prepare(
    "INSERT INTO accounts (id, email, pw_hash, email_verified, created_at) VALUES (1, 'owner@example.com', 'x', 1, ?)",
  ).bind(now).run();
  await indexDb.prepare(
    "INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES ('import-session', 1, ?, ?)",
  ).bind(now, now + 3600).run();
  await indexDb.prepare(
    "INSERT INTO tenants (id, public_id, slug, title, created_at) VALUES (1, 'importblog00000001', 'importblog', 'Import Blog', ?)",
  ).bind(now).run();
  await indexDb.prepare(
    "INSERT INTO memberships (account_id, tenant_id, role, created_at) VALUES (1, 1, 'owner', ?)",
  ).bind(now).run();
  const env = { DB: indexDb, POSTS: postsDb, MEDIA: media, ROOT_DOMAIN: "blognice.test" };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const upload = (xml, { session = "import-session", origin = "https://www.blognice.test" } = {}) => {
    const form = new FormData();
    if (xml !== null) form.append("file", new File([xml], "blogger-backup.xml", { type: "text/xml" }));
    const headers = { cookie: `bn_session=${session}` };
    if (origin) headers.Origin = origin;
    return blogniceApp.request(new Request("https://www.blognice.test/admin/b/importblog00000001/import/blogger", {
      method: "POST", headers, body: form,
    }), undefined, env, ctx);
  };
  return { blogniceApp, mf, indexDb, postsDb, env, ctx, upload };
}

test("Blogger import creates posts and pages with tags, dates, and drafts; reruns skip", async () => {
  const { blogniceApp, mf, postsDb, env, ctx, upload } = await setupBlog();
  try {
    const page = await blogniceApp.request(new Request("https://www.blognice.test/admin/b/importblog00000001/import", {
      headers: { cookie: "bn_session=import-session" },
    }), undefined, env, ctx);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Import from Blogger/);

    const res = await upload(LEGACY_XML);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Imported 2 posts and 1 page, including 1 draft/);

    const posts = await postsDb.prepare("SELECT slug, title, tags_json, published, created_at, updated_at, author_name, body_md FROM posts WHERE tenant_id = 1 ORDER BY slug").all();
    assert.equal(posts.results.length, 2);
    const live = posts.results.find((p) => p.slug === "hello-from-lisbon");
    assert.ok(live);
    assert.equal(live.title, "Hello From Lisbon");
    assert.deepEqual(JSON.parse(live.tags_json), ["travel", "notes"]);
    assert.equal(live.published, 1);
    assert.equal(live.created_at, Date.parse("2024-05-01T10:00:00.000Z") / 1000);
    assert.equal(live.updated_at, Date.parse("2024-05-02T11:30:00.000Z") / 1000);
    assert.equal(live.author_name, "Lena");
    assert.match(live.body_md, /## Day one/);
    const draft = posts.results.find((p) => p.slug === "unfinished-thoughts");
    assert.ok(draft);
    assert.equal(draft.published, 0);

    const pages = await postsDb.prepare("SELECT slug, published, published_at FROM pages WHERE tenant_id = 1").all();
    assert.equal(pages.results.length, 1);
    assert.equal(pages.results[0].slug, "about-me");
    assert.equal(pages.results[0].published, 1);
    assert.ok(pages.results[0].published_at);

    const records = await postsDb.prepare("SELECT external_id, item_type, slug FROM import_records WHERE tenant_id = 1 AND source = 'blogger'").all();
    assert.equal(records.results.length, 3);

    const rerun = await upload(LEGACY_XML);
    assert.equal(rerun.status, 200);
    const rerunHtml = await rerun.text();
    assert.match(rerunHtml, /Imported 0 posts and 0 pages/);
    assert.match(rerunHtml, /3 already-imported items were skipped/);
    const still = await postsDb.prepare("SELECT COUNT(*) AS count FROM posts WHERE tenant_id = 1").first();
    assert.equal(still.count, 2);
  } finally {
    await mf.dispose();
  }
});

test("Blogger import takes a fresh slug when the title slug is taken", async () => {
  const { mf, postsDb, upload } = await setupBlog();
  try {
    const now = Math.floor(Date.now() / 1000);
    await postsDb.prepare(
      "INSERT INTO posts (tenant_id, slug, title, body_md, published, created_at, updated_at) VALUES (1, 'hello-from-lisbon', 'Existing', 'x', 1, ?, ?)",
    ).bind(now, now).run();
    const res = await upload(LEGACY_XML);
    assert.equal(res.status, 200);
    const rows = await postsDb.prepare("SELECT slug FROM posts WHERE tenant_id = 1 AND title = 'Hello From Lisbon'").all();
    assert.equal(rows.results.length, 1);
    assert.notEqual(rows.results[0].slug, "hello-from-lisbon");
    assert.match(rows.results[0].slug, /^hello-from-lisbon-/);
  } finally {
    await mf.dispose();
  }
});

test("Blogger import rejects bad uploads and non-owners", async () => {
  const { blogniceApp, mf, indexDb, env, ctx, upload } = await setupBlog();
  try {
    const now = Math.floor(Date.now() / 1000);
    await indexDb.prepare(
      "INSERT INTO accounts (id, email, pw_hash, email_verified, created_at) VALUES (2, 'editor@example.com', 'x', 1, ?)",
    ).bind(now).run();
    await indexDb.prepare(
      "INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES ('editor-session', 2, ?, ?)",
    ).bind(now, now + 3600).run();
    await indexDb.prepare(
      "INSERT INTO memberships (account_id, tenant_id, role, created_at) VALUES (2, 1, 'editor', ?)",
    ).bind(now).run();

    const forbidden = await upload(LEGACY_XML, { session: "editor-session" });
    assert.equal(forbidden.status, 403);

    const pageForbidden = await blogniceApp.request(new Request("https://www.blognice.test/admin/b/importblog00000001/import", {
      headers: { cookie: "bn_session=editor-session" },
    }), undefined, env, ctx);
    assert.equal(pageForbidden.status, 403);

    const garbage = await upload("<html>not a backup</html>");
    assert.equal(garbage.status, 400);
    assert.match(await garbage.text(), /not a Blogger backup/);

    const empty = await upload(null);
    assert.equal(empty.status, 400);

    const noOrigin = await upload(LEGACY_XML, { origin: null });
    assert.equal(noOrigin.status, 403);

    const huge = await upload("x".repeat(10 * 1024 * 1024 + 1));
    assert.equal(huge.status, 413);
  } finally {
    await mf.dispose();
  }
});
