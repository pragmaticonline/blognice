import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { Miniflare } from "miniflare";
import { build } from "esbuild";

globalThis.caches = { default: { delete: async () => true } };
if (typeof globalThis.FixedLengthStream === "undefined") {
  globalThis.FixedLengthStream = class {
    constructor() {
      const pipe = new TransformStream();
      this.readable = pipe.readable;
      this.writable = pipe.writable;
    }
  };
}

function wavBytes(pcmLength, declaredSize = null) {
  const bytes = new Uint8Array(44 + pcmLength);
  const view = new DataView(bytes.buffer);
  for (const [offset, text] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]])
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true); view.setUint32(28, 48_000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  view.setUint32(40, declaredSize ?? pcmLength, true);
  for (let i = 0; i < pcmLength; i++) bytes[44 + i] = i % 256;
  return bytes;
}

const cut = wavBytes(10, 100);

async function setup() {
  const bundle = await build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    format: "esm",
    write: false,
    platform: "neutral",
    mainFields: ["module", "main"],
    external: ["node:*", "assert", "buffer", "crypto", "http", "https", "net", "stream", "tls", "tty", "url", "util"],
    loader: { ".html": "text", ".svg": "text" },
    plugins: [{
      name: "web-push-stub",
      setup(plugin) {
        plugin.onResolve({ filter: /^web-push$/ }, () => ({ path: "web-push-stub", namespace: "audio-conv-stub" }));
        plugin.onLoad({ filter: /.*/, namespace: "audio-conv-stub" }, () => ({ contents: "export default {};", loader: "js" }));
      },
    }],
  });
  const url = new URL(`../audio-conv-bundle-${Date.now()}.mjs`, import.meta.url);
  fs.writeFileSync(url, bundle.outputFiles[0].text);
  const worker = await import(url.href);
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "audio-conv-db", POSTS: "audio-conv-posts" },
  });
  const db = await mf.getD1Database("DB");
  const postsDb = await mf.getD1Database("POSTS");
  // In-memory R2: Miniflare's R2 rejects the length-unknown upload stream the
  // worker uses, so fake the bucket with plain key/value semantics.
  const store = new Map();
  const readValue = async (value) => {
    if (value instanceof Uint8Array) return value;
    if (typeof value === "string") return new TextEncoder().encode(value);
    const chunks = [];
    const reader = value.getReader();
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      if (chunk) chunks.push(chunk);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
  };
  const media = {
    get: async (key) => {
      const bytes = store.get(key);
      if (!bytes) return null;
      return {
        arrayBuffer: async () => bytes.slice().buffer,
        text: async () => new TextDecoder().decode(bytes),
      };
    },
    put: async (key, value) => { store.set(key, await readValue(value)); },
    delete: async (key) => {
      for (const k of Array.isArray(key) ? key : [key]) store.delete(k);
    },
  };
  const apply = async (dbh, file) => {
    const sql = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/^[ \t]*--.*(?:\r?\n|$)/gm, "");
    for (const s of sql.split(/;\s*(?=\r?\n|$)/).map((v) => v.trim()).filter(Boolean)) await dbh.prepare(s).run();
  };
  await apply(db, "schema.sql");
  await apply(postsDb, "schema-posts.sql");
  await db.prepare("INSERT INTO tenants (id, public_id, slug, title, created_at) VALUES (1, 't1', 'test', 'Test', 1)").run();
  return { worker, mf, db, postsDb, media };
}

async function seedJob(postsDb, media, { jobId, postId, prompts, model }) {
  const jobKey = `1/.audio-jobs/${jobId}.json`;
  await postsDb.prepare(
    "INSERT INTO posts (id, tenant_id, slug, title, body_md, audio_key, audio_generation_id, created_at, updated_at) VALUES (?, 1, ?, 'T', 'B.', NULL, ?, 1, 1)"
  ).bind(postId, `p${postId}`, jobId).run();
  await media.put(jobKey, JSON.stringify({
    jobId, tenantId: 1, postId, postSlug: `p${postId}`, prompts,
    checkpointKeys: prompts.map((_, i) => `1/.audio-checkpoints/${postId}-${i}.wav`),
    status: "queued", completed: 0, creditCost: 1, creditAccountId: 1, creditPeriod: "2026-09", model,
  }));
  return jobKey;
}

function streamOf(bytes) {
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}

test("a cut segment is retried and the narration still attaches", async () => {
  const { worker, mf, postsDb, media } = await setup();
  try {
    const prompts = [{ text: "First.", pauseAfter: 0 }, { text: "Second.", pauseAfter: 0 }, { text: "Third.", pauseAfter: 0 }];
    const jobKey = await seedJob(postsDb, media, { jobId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", postId: 11, prompts, model: "@cf/deepgram/aura-1" });
    const calls = new Map();
    const env = {
      DB: await mf.getD1Database("DB"), POSTS: postsDb, MEDIA: media, ROOT_DOMAIN: "blognice.com",
      AI: {
        run: async (model, input) => {
          const n = (calls.get(input.text) || 0) + 1;
          calls.set(input.text, n);
          return streamOf(n === 1 ? cut : wavBytes(64));
        },
      },
    };
    let acked = false;
    await worker.default.queue({ messages: [{ body: { jobKey, tenantId: 1, postId: 11 }, attempts: 1, ack() { acked = true; }, retry() {} }] }, env);
    assert.equal(acked, true, "converged job is acked, not retried");
    const job = JSON.parse(await (await media.get(jobKey)).text());
    assert.equal(job.status, "complete", "job completes after segment retries");
    assert.ok(job.audioKey, "audio attaches");
    const post = await postsDb.prepare("SELECT audio_key FROM posts WHERE id = 11").first();
    assert.equal(post.audio_key, job.audioKey);
    for (const [, count] of calls) assert.ok(count >= 2, "each cut segment was resynthesized");
  } finally {
    await mf.dispose();
  }
});

test("a poisoned checkpoint is dropped and resynthesized instead of replayed", async () => {
  const { worker, mf, postsDb, media } = await setup();
  try {
    const prompts = [{ text: "Heal one.", pauseAfter: 0 }, { text: "Heal two.", pauseAfter: 0 }];
    const jobKey = await seedJob(postsDb, media, { jobId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", postId: 22, prompts, model: "@cf/deepgram/aura-1" });
    await media.put("1/.audio-checkpoints/22-1.wav", cut);
    const calls = [];
    const env = {
      DB: await mf.getD1Database("DB"), POSTS: postsDb, MEDIA: media, ROOT_DOMAIN: "blognice.com",
      AI: { run: async (model, input) => { calls.push(input.text); return streamOf(wavBytes(64)); } },
    };
    let acked = false;
    await worker.default.queue({ messages: [{ body: { jobKey, tenantId: 1, postId: 22 }, attempts: 1, ack() { acked = true; }, retry() {} }] }, env);
    assert.equal(acked, true, "healed job is acked, not retried");
    const job = JSON.parse(await (await media.get(jobKey)).text());
    assert.equal(job.status, "complete", "job completes despite the poisoned checkpoint");
    assert.ok(job.audioKey, "audio attaches");
    assert.ok(calls.includes("Heal two."), "poisoned segment was resynthesized, not replayed");
  } finally {
    await mf.dispose();
  }
});
