import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const render = fs.readFileSync("src/render.ts", "utf8");
const index = fs.readFileSync("src/index.ts", "utf8");

test("Bruv P1: push denied shows blocked message not spinner forever", () => {
  assert.match(render, /Notification\.permission === "denied"/);
  assert.match(render, /Notifications are blocked in your browser/);
  assert.match(render, /pushMsg\.textContent/);
});

test("Bruv P1: push requestPermission denied branch is present", () => {
  assert.match(render, /Notification\.requestPermission\(\)\.then/);
  assert.match(render, /if \(permission !== "granted"\)/);
  assert.match(render, /Notifications were not enabled/);
  assert.match(render, /Unable to enable notifications/);
});

test("Bruv P1: push opt-in is owner-gated and serviceWorker guarded", () => {
  assert.match(render, /data-push-owner-enabled/);
  assert.match(render, /serviceWorker.*in.*navigator/);
  assert.match(render, /PushManager.*in.*window/);
  assert.match(index, /app\.get\("\/sw\.js"/);
});
