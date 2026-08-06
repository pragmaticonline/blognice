import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/020-ai-credits.sql", import.meta.url), "utf8");

test("AI credits use a monthly 1000-credit allowance and shared costs", () => {
  assert.match(index, /AI_MONTHLY_CREDITS = 1000/);
  assert.match(index, /AI_IMAGE_CREDITS = 3/);
  assert.match(index, /AI_AUDIO_WORDS_PER_CREDIT = 500/);
  assert.match(index, /reserveAiCredits/);
  assert.match(index, /refundAiCredits/);
});

test("AI credit usage is account-period scoped and supports atomic reservations", () => {
  assert.match(migration, /PRIMARY KEY \(account_id, period\)/);
  assert.match(index, /INSERT OR IGNORE INTO ai_credit_usage/);
  assert.match(index, /credits_used \+ \? <= allowance/);
});

test("queued AI jobs refund only on terminal delivery", () => {
  assert.match(index, /attempts >= 6/);
  assert.match(index, /refundTerminalAiJob/);
  assert.match(index, /ai_credit_refunds/);
  assert.match(index, /changes\(\) > 0/);
  assert.doesNotMatch(index, /job\.creditsRefunded = true;\s*\n\s*}\s*\n\s*await writeAudioJob/);
});

test("billing exposes remaining AI credits", () => {
  assert.match(index, /remaining/);
  assert.match(index, /ai_credit_usage WHERE account_id/);
});
