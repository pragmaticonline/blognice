import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  POPULARITY_HALF_LIFE_DAYS,
  calculatePopularity,
} from "../src/popularity.ts";

test("popularity rewards recent real readers and engaged reading", () => {
  const ranked = calculatePopularity([
    { tenantId: 1, path: "/recent", day: "2026-08-07", readerDays: 10, engagedReaders: 4 },
    { tenantId: 1, path: "/older", day: "2026-07-17", readerDays: 20, engagedReaders: 0 },
  ], "2026-08-08");

  assert.equal(POPULARITY_HALF_LIFE_DAYS, 21);
  assert.deepEqual(ranked.map((row) => row.path), ["/recent", "/older"]);
  assert.ok(ranked[0].score > ranked[1].score);
  assert.equal(ranked[0].readerDays30, 10);
  assert.equal(ranked[0].engagedReaders30, 4);
});

test("popularity caps engagement, ignores invalid paths, and requires evidence", () => {
  const ranked = calculatePopularity([
    { tenantId: 2, path: "/bounded", day: "2026-08-07", readerDays: 3, engagedReaders: 999 },
    { tenantId: 2, path: "/too-small", day: "2026-08-07", readerDays: 2, engagedReaders: 2 },
    { tenantId: 2, path: "/nested/path", day: "2026-08-07", readerDays: 100, engagedReaders: 100 },
    { tenantId: 2, path: "/expired", day: "2026-05-09", readerDays: 100, engagedReaders: 100 },
  ], "2026-08-08");

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].path, "/bounded");
  assert.equal(ranked[0].engagedReaders30, 3);
});

test("homepage popularity is materialized and never aliases newest posts", () => {
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const render = readFileSync(new URL("../src/render.ts", import.meta.url), "utf8");
  const metrics = readFileSync(new URL("../src/metrics.ts", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../migrations/042-post-popularity.sql", import.meta.url), "utf8");

  assert.match(index, /refreshPostPopularity\(env\)/);
  assert.match(index, /name !== "engaged_read"/);
  assert.match(index, /FROM post_popularity/);
  assert.doesNotMatch(render, /const popular = posts\.slice/);
  assert.match(render, /rankedPopularPosts\.length >= 3/);
  assert.match(metrics, /event:"engaged_read"/);
  assert.match(metrics, /elapsed\(\)>=30000&&progress>=\.5/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS post_popularity_daily/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS idx_post_popularity_rank/);
});
