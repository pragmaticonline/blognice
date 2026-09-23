// MP3 upload validation: real frame chain required, not just a header sniff.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isValidMp3 } from "../src/media.ts";

const require = createRequire(import.meta.url);
for (const extension of [".html", ".svg"]) {
  require.extensions[extension] = (module, filename) => {
    module.exports = readFileSync(filename, "utf8");
  };
}

// MPEG1 Layer III, 128kbps, 44.1kHz: frame length 417 bytes.
const FRAME = [0xff, 0xfb, 0x90, 0x64];
function frame() {
  const out = new Uint8Array(417);
  out.set(FRAME, 0);
  return out;
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

test("accepts consecutive valid MP3 frames", () => {
  assert.equal(isValidMp3(concat(frame(), frame())), true);
});

test("accepts an ID3v2 tag followed by valid frames", () => {
  const tag = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  assert.equal(isValidMp3(concat(tag, frame(), frame())), true);
});

test("rejects a truncated final frame", () => {
  assert.equal(isValidMp3(concat(frame(), new Uint8Array([0xff, 0xfb]))), false);
});

test("rejects non-audio bytes outright", () => {
  const html = new TextEncoder().encode("<html><body>not audio</body></html>");
  assert.equal(isValidMp3(html), false);
});

test("rejects a corrupt second frame header", () => {
  const bad = frame();
  bad.set([0x00, 0x00, 0x00, 0x00], 0);
  assert.equal(isValidMp3(concat(frame(), bad)), false);
});

test("rejects empty input", () => {
  assert.equal(isValidMp3(new Uint8Array(0)), false);
});

test("audio upload builds a tenant-scoped key, URL, and player snippet", async () => {
  const { prepareAudioUpload } = await import("../src/media.ts");
  const out = prepareAudioUpload(42, concat(frame(), frame()), "narration.mp3");
  assert.match(out.key, /^42\/\d+-[a-z0-9]+-audio\.mp3$/);
  assert.equal(out.url, `/media/${out.key}`);
  assert.equal(out.snippet, out.url);
});

test("the upload snippet pasted into a post renders a player", async () => {
  const { prepareAudioUpload } = await import("../src/media.ts");
  const { renderMarkdown } = await import("../src/markdown.ts");
  const out = prepareAudioUpload(42, concat(frame(), frame()), "clip.mp3");
  const html = renderMarkdown(`Intro:\n\n${out.snippet}\n\nOutro.`);
  assert.match(html, new RegExp(`<audio controls preload="none" src="${out.url}"></audio>`));
});

test("audio upload rejects non-audio bytes", async () => {
  const { prepareAudioUpload } = await import("../src/media.ts");
  assert.throws(() => prepareAudioUpload(42, new TextEncoder().encode("nope"), "evil.mp3"), /not audio/);
});

test("narration uploads mint a hidden -narration key", async () => {
  const { prepareAudioUpload } = await import("../src/media.ts");
  const out = prepareAudioUpload(42, concat(frame(), frame()), "voice.mp3", "narration");
  assert.match(out.key, /^42\/\d+-[a-z0-9]+-narration\.mp3$/);
});

test("the media library shows clips but hides narration", async () => {
  const { listMedia } = await import("../src/index.ts");
  const obj = (key) => ({ key, size: 12, uploaded: new Date("2026-09-22T10:00:00Z"), customMetadata: {} });
  const env = {
    MEDIA: {
      list: async () => ({
        objects: [obj("4/1789200000000-ee55ff66-audio.mp3"), obj("4/1789200000000-ff66aa77-narration.mp3")],
        truncated: false,
      }),
    },
  };
  const items = await listMedia(env, 4);
  assert.deepEqual(items.map((i) => i.key), ["4/1789200000000-ee55ff66-audio.mp3"]);
});

test("editor offers narration MP3 upload next to generation", () => {
  const source = readFileSync(new URL("../src/admin.ts", import.meta.url), "utf8");
  assert.match(source, /id="upload-audio"/);
  assert.match(source, /\/audio\/" \+ \(currentPostId \|\| ""\) \+ "\/upload"/);
  assert.match(source, /accept="audio\/mpeg,\.mp3"/);
});

test("editor body uploads and library picker insert audio as a bare URL", () => {
  const source = readFileSync(new URL("../src/admin.ts", import.meta.url), "utf8");
  assert.match(source, /data\.snippet \|\| data\.url/);
  assert.match(source, /data-audio="1"/);
});

test("editor has a visible Add audio button wired to the media picker", () => {
  const source = readFileSync(new URL("../src/admin.ts", import.meta.url), "utf8");
  assert.match(source, /id="add-audio"/);
  assert.match(source, /addAudio\.addEventListener\("click", function \(\) \{ openLibrary\("body"\); \}\);/);
});

test("API docs cover audio upload and narration upload", () => {
  const source = readFileSync(new URL("../src/admin.ts", import.meta.url), "utf8");
  assert.match(source, /-F file=@clip\.mp3/);
  assert.match(source, /posts\/POST_ID\/audio/);
});

test("range parsing slices media bodies for seeking", async () => {
  const { parseRange } = await import("../src/media.ts");
  assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=500-", 1000), { start: 500, end: 999 });
  assert.deepEqual(parseRange("bytes=-200", 1000), { start: 800, end: 999 });
  assert.equal(parseRange(null, 1000), null);
  assert.equal(parseRange("bytes=999-0", 1000), null);
  assert.equal(parseRange("bytes=2000-3000", 1000), null);
  assert.equal(parseRange("items=0-99", 1000), null);
});
