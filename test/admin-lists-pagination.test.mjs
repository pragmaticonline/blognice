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

function makePosts(count) {
  const posts = [];
  for (let i = 1; i <= count; i++) {
    posts.push({
      id: i,
      tenant_id: 1,
      slug: `post-${i}`,
      title: `Post number ${String(i).padStart(2, "0")}`,
      published: 1,
      scheduled_at: null,
      created_at: NOW - 1000 + i,
      updated_at: NOW - 1000 + i,
    });
  }
  return posts;
}

function makeMediaObjects(count) {
  const objects = [];
  for (let i = 1; i <= count; i++) {
    const padded = String(i).padStart(2, "0");
    objects.push({
      key: `1/17890000${padded}-aa11bb22.png`,
      size: 12,
      uploaded: new Date(`2026-09-${String((i % 28) + 1).padStart(2, "0")}T10:00:00Z`),
      customMetadata: { originalName: `Media file ${padded}.png` },
    });
  }
  // Newest first by uploaded; force a deterministic order matching listMedia's sort.
  objects.sort((a, b) => b.uploaded - a.uploaded);
  return objects;
}

function fakeDb(state) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => {
              if (sql.includes("FROM platform_settings")) return null;
              if (sql.includes("FROM sessions")) {
                return state.sessions[args[0]] ?? null;
              }
              if (sql.includes("t.public_id")) {
                if (args[0] !== "b_pagetest") return null;
                return { ...state.tenant, membership_role: "owner" };
              }
              if (sql.includes("m.role = 'owner'")) return null;
              if (sql.includes("COUNT(*)") && sql.includes("FROM posts")) {
                return { count: state.posts.filter((p) => p.tenant_id === args[0]).length };
              }
              return null;
            },
            all: async () => {
              if (sql.includes("FROM posts")) {
                let rows = state.posts
                  .filter((p) => p.tenant_id === args[0])
                  .sort((a, b) => b.created_at - a.created_at);
                const limit = args[args.length - 2];
                const offset = args[args.length - 1];
                if (typeof limit === "number" && typeof offset === "number") {
                  rows = rows.slice(offset, offset + limit);
                }
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

function adminReq(path, session) {
  return new Request(`https://www.blognice.test${path}`, {
    headers: {
      host: "www.blognice.test",
      cookie: `bn_session=${session}`,
      Origin: "https://www.blognice.test",
    },
  });
}

test("posts dashboard paginates", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const state = {
    tenant: {
      id: 1, public_id: "b_pagetest", slug: "pagetest", title: "Page Test",
      description: "", accent_color: "#1a8917", shard: "primary",
      created_at: NOW, deleted_at: null,
    },
    sessions: {
      "owner-session": { id: 1, email: "owner@example.com", email_verified: 1, billing_status: "inactive" },
    },
    posts: makePosts(55),
  };
  const db = fakeDb(state);
  const env = { DB: db, POSTS: db, ROOT_DOMAIN: "blognice.test" };
  const executionCtx = { waitUntil() {}, passThroughOnException() {} };
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => {} } };
  try {
    const page1 = await blogniceApp.request(adminReq("/admin/b/b_pagetest", "owner-session"), undefined, env, executionCtx);
    assert.equal(page1.status, 200);
    const page1Html = await page1.text();
    assert.match(page1Html, /Post number 55/);
    assert.doesNotMatch(page1Html, /Post number 01/);
    assert.match(page1Html, /Page 1/);
    assert.match(page1Html, /page=2/);

    const page2 = await blogniceApp.request(adminReq("/admin/b/b_pagetest?page=2", "owner-session"), undefined, env, executionCtx);
    assert.equal(page2.status, 200);
    const page2Html = await page2.text();
    assert.match(page2Html, /Post number 01/);
    assert.doesNotMatch(page2Html, /Post number 55/);
    assert.match(page2Html, /Page 2/);

    const bad = await blogniceApp.request(adminReq("/admin/b/b_pagetest?page=nope", "owner-session"), undefined, env, executionCtx);
    assert.match(await bad.text(), /Post number 55/);
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test("media library paginates", async () => {
  const { blogniceApp } = await import("../src/index.ts");
  const state = {
    tenant: {
      id: 1, public_id: "b_pagetest", slug: "pagetest", title: "Page Test",
      description: "", accent_color: "#1a8917", shard: "primary",
      created_at: NOW, deleted_at: null,
    },
    sessions: {
      "owner-session": { id: 1, email: "owner@example.com", email_verified: 1, billing_status: "inactive" },
    },
    posts: [],
  };
  const db = fakeDb(state);
  const objects = makeMediaObjects(55);
  const newestName = objects[0].customMetadata.originalName;
  const oldestName = objects[objects.length - 1].customMetadata.originalName;
  const env = {
    DB: db,
    POSTS: db,
    ROOT_DOMAIN: "blognice.test",
    MEDIA: {
      list: async ({ prefix }) => ({
        objects: objects.filter((o) => o.key.startsWith(prefix)),
        truncated: false,
      }),
    },
  };
  const executionCtx = { waitUntil() {}, passThroughOnException() {} };
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => {} } };
  try {
    const page1 = await blogniceApp.request(adminReq("/admin/b/b_pagetest/media", "owner-session"), undefined, env, executionCtx);
    assert.equal(page1.status, 200);
    const page1Html = await page1.text();
    assert.ok(page1Html.includes(newestName));
    assert.ok(!page1Html.includes(oldestName));
    assert.match(page1Html, /Page 1/);
    assert.match(page1Html, /page=2/);

    const page2 = await blogniceApp.request(adminReq("/admin/b/b_pagetest/media?page=2", "owner-session"), undefined, env, executionCtx);
    assert.equal(page2.status, 200);
    const page2Html = await page2.text();
    assert.ok(page2Html.includes(oldestName));
    assert.ok(!page2Html.includes(newestName));
    assert.match(page2Html, /Page 2/);
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});
