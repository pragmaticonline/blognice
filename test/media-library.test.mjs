// The media library is a live R2 listing: job manifests and site furniture
// must never appear as (broken) images.
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

const obj = (key, uploaded, name) => ({
  key, size: 12, uploaded: new Date(uploaded),
  customMetadata: name ? { originalName: name } : {},
});

test("media library hides job manifests and site furniture", async () => {
  const { listMedia } = await import("../src/index.ts");
  const objects = [
    obj("4/1789000000000-aa11bb22.png", "2026-09-20T10:00:00Z", "upload.png"),
    obj("4/1789100000000-cc33dd44-ai.jpg", "2026-09-21T10:00:00Z", "AI generated image.jpg"),
    obj("4/.autopilot-image/305-aaa.json", "2026-09-22T10:00:00Z"),
    obj("4/.image-jobs/job1.json", "2026-09-22T10:00:00Z"),
    obj("4/.audio-jobs/gen1.json", "2026-09-22T10:00:00Z"),
    obj("4/avatar-abcdef12.png", "2026-09-22T10:00:00Z"),
    obj("4/favicon-abcdef12.ico", "2026-09-22T10:00:00Z"),
    obj("4/1789200000000-ee55ff66-tts.mp3", "2026-09-22T10:00:00Z"),
    obj("9/1789300000000-other.png", "2026-09-22T10:00:00Z", "other-blog.png"),
  ];
  const env = {
    MEDIA: {
      list: async ({ prefix }) => ({
        objects: objects.filter((o) => o.key.startsWith(prefix)),
        truncated: false,
      }),
    },
  };
  const items = await listMedia(env, 4);
  assert.deepEqual(
    items.map((i) => i.key),
    ["4/1789100000000-cc33dd44-ai.jpg", "4/1789000000000-aa11bb22.png"],
  );
  assert.equal(items[0].url, "/media/4/1789100000000-cc33dd44-ai.jpg");
  assert.equal(items[0].name, "AI generated image.jpg");
});
