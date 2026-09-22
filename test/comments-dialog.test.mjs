// Regression: the first-time comment modal showed its name/email inputs
// flush against the dialog edges with no padding, and the inputs overflowed
// because they lacked box-sizing while set to width:100%.
import assert from "node:assert/strict";
import test from "node:test";

test("linked profiles keep the avatar pinned like plain ones", async () => {
  const { STYLES } = await import("../src/render.ts");
  const pinned = STYLES.match(/\.comment > \.comment-avatar, \.comment > \.comment-profile \{([^}]*)\}/);
  assert.ok(pinned, "direct-child avatars and profile links share the pin rule");
  assert.ok(pinned[1].includes("position: absolute"), "linked avatar stays out of flow");
});

test("comment text leads, the action line recedes", async () => {
  const { STYLES } = await import("../src/render.ts");
  const body = STYLES.match(/\.comment-body \{([^}]*)\}/);
  assert.ok(body, "body rule exists");
  assert.ok(body[1].includes("font-size: 1.06rem"), "comment text steps up");
  const reply = STYLES.match(/\.comment \.reply-btn \{([^}]*)\}/);
  assert.ok(reply && reply[1].includes("font-size: .78em"), "reply line steps down");
});

test("show-more sits inline after the last excerpt word", async () => {
  const { STYLES } = await import("../src/render.ts");
  const inline = STYLES.match(/\.comment-body \.more-btn \{([^}]*)\}/);
  assert.ok(inline, "inline show-more rule exists");
  assert.ok(inline[1].includes("margin-left"), "a space separates the last word from show-more");
});

test("comment dialog form has breathing room and contained inputs", async () => {
  const { STYLES } = await import("../src/render.ts");
  const dialogForm = STYLES.match(/\.comment-dialog \.comment-form \{([^}]*)\}/);
  assert.ok(dialogForm, "dialog form rule exists");
  assert.ok(/padding:\s*[^0\s]/.test(dialogForm[1]), "dialog form has nonzero padding");
  const inputs = STYLES.match(/\.comment-form input\[type="text"\][^{]*\{([^}]*)\}/);
  assert.ok(inputs, "comment form input rule exists");
  assert.ok(inputs[1].includes("box-sizing: border-box"), "inputs stay inside their container");
});
