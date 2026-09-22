// Regression: the comment client script is emitted through a server-side
// template literal, so every backslash in its regexes must be escaped.
// A single `\n` once shipped a raw newline and killed the whole script in
// every browser (no handler, no socket, native form submit). This test
// compiles every served inline script and pins the emitted escapes.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

test("served comment scripts parse and keep their regex escapes", async () => {
  const { renderCommentSection } = await import("../src/render.ts");
  const html = renderCommentSection(
    { id: 11, slug: "usa-politics-tlmcgb" },
    [
        { id: 1, parent_id: null, author_name: "Loop QA", body: "First.", created_at: 1789913617, status: "approved" },
        { id: 2, parent_id: 1, author_name: "Loop QA", body: "Line one\nLine two.", created_at: 1789913620, status: "approved" },
    ],
  );
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 1, "comment section ships a client script");
  for (const code of scripts) {
    new vm.Script(code); // throws on the raw-newline class of breakage
  }
  const client = scripts.join("\n");
  assert.ok(client.includes("replace(/\\n/g"), "newline regex survives as backslash-n");
  assert.ok(client.includes("/\\bd([0-1])\\b/"), "word boundaries survive as backslash-b");
  assert.ok(client.includes("/\\(([0-9]+)\\)/"), "count parens survive escaped");
  assert.ok(client.includes("preventScroll"), "modal focus never scrolls the page");
  assert.ok(client.includes("settleDialog"), "dialog open restores scroll after top-layer race");
  assert.ok(client.includes("data-sort-tab"), "sort tabs re-order threads without a reload");
  assert.ok(client.includes('closest(".comment-children")'), "live replies flatten into the level-1 container");
  assert.ok(client.includes("↩"), "live reply-to labels match the server style");
  assert.ok(client.includes('addEventListener("close"'), "dialog Escape returns the form to the thread");
  assert.ok(client.includes("openThread"), "replying opens a collapsed thread so the form stays visible");
  assert.ok(client.includes("toggle-replies"), "threads beyond two replies get a show-more toggle");
  assert.ok(client.includes("more replies"), "toggle labels the hidden reply count");
  assert.ok(client.includes("data-ts"), "live comments carry machine time for relative stamps");
  assert.ok(client.includes("mins ago"), "client refreshes human timestamps");
  assert.ok(client.includes("<summary>"), "live replies use the flush inline-avatar row");
  assert.ok(client.includes('<span class="comment-avatar"'), "live replies keep the initial-circle avatar");
  assert.ok(client.includes('<img class="comment-avatar"'), "live replies show photo avatars when set");
  assert.ok(client.includes("data-excerpt-body"), "live long comments excerpt");
  assert.ok(client.includes("data-full-body"), "live long comments keep the full text");
  assert.ok(client.includes("data-comment-more"), "live long comments toggle");
  assert.ok(client.includes("Show less"), "toggle collapses back");
  assert.ok(client.includes("data-pending"), "submits render instantly, confirmed in the background");
  assert.ok(client.includes("Sending"), "form shows progress while the post completes");
  assert.ok(client.includes("toggleReply"), "Reply toggles the inline box instead of a caption line");
  assert.ok(!client.includes("refresh to read"), "arriving comments insert, no refresh gate");
  assert.ok(client.includes("' fresh'"), "new arrivals highlight briefly");
  assert.ok(!client.includes("data-replying-to"), "no Replying-to caption in the script");
  assert.ok(!client.includes("data-reply-cancel"), "no Cancel button in the script");
  assert.ok(client.includes("data-settings-cog"), "cog opens reader settings");
  assert.ok(client.includes("data-settings-dialog"), "settings dialog is wired");
  assert.ok(client.includes("data-settings-save"), "settings save persists identity");
  assert.ok(!client.includes("data-settings-hue"), "hue swatches are gone from settings");
  assert.ok(client.includes("data-settings-site"), "settings asks for the website address");
  assert.ok(client.includes("data-field-site"), "first-time modal asks for the website address");
  assert.ok(client.includes("data-profile-link"), "profiles with a site render as links");
  assert.ok(client.includes("window.open"), "profile clicks open a new tab");
  assert.ok(client.includes(".comment-avatar,.comment-author"), "every profile click skips the collapse toggle");
  assert.ok(client.includes('/^\\d+$/.test(parentId)'), "restored reply targets must be numeric ids");
  assert.ok(client.includes("data-field-subscribe"), "subscribe box state rides the submit");
  assert.ok(client.includes("paintSubRow"), "subscribe box hides once the reader is set");
  assert.ok(client.includes("Show 1 more reply"), "single hidden reply uses the singular");
  assert.ok(client.includes('showInline("","");\n    insertApproved({id:tempId'), "the box resets the instant Send is tapped");
  assert.ok(client.includes("confirm your subscription"), "pending subscriptions surface the inbox step");
  assert.ok(client.includes("data-entry-avatar"), "entry avatar slot is addressable");
  assert.ok(client.includes("paintEntry"), "entry box shows the profile photo when set");
  assert.ok(client.includes("data-vote-btn"), "like and dislike buttons are wired");
  assert.ok(client.includes("bn_comment_votes"), "my votes persist locally");
  assert.ok(client.includes("comment-votes"), "vote broadcasts converge without reload");
  assert.ok(client.includes("aria-pressed"), "active vote highlights");
  assert.ok(client.includes("data-settings-upload"), "photo upload is wired");
  assert.ok(client.includes("data-settings-remove"), "photo removal is wired");
  assert.ok(client.includes("bn_comment_avatar_key"), "photo key persists locally");
  assert.ok(client.includes("60000"), "fallback poll runs every 60s");
  assert.ok(client.includes("document.hidden"), "fallback poll skips hidden tabs");
  assert.ok(client.includes("visibilitychange"), "returning to the tab catches up immediately");
});
