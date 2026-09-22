// Regression: the first-time comment modal showed its name/email inputs
// flush against the dialog edges with no padding, and the inputs overflowed
// because they lacked box-sizing while set to width:100%.
import assert from "node:assert/strict";
import test from "node:test";

test("comment dialog form has breathing room and contained inputs", async () => {
  const { STYLES } = await import("../src/render.ts");
  const dialogForm = STYLES.match(/\.comment-dialog \.comment-form \{([^}]*)\}/);
  assert.ok(dialogForm, "dialog form rule exists");
  assert.ok(/padding:\s*[^0\s]/.test(dialogForm[1]), "dialog form has nonzero padding");
  const inputs = STYLES.match(/\.comment-form input\[type="text"\][^{]*\{([^}]*)\}/);
  assert.ok(inputs, "comment form input rule exists");
  assert.ok(inputs[1].includes("box-sizing: border-box"), "inputs stay inside their container");
});
