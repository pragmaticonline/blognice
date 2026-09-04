import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const index = fs.readFileSync("src/index.ts", "utf8");
const metrics = fs.readFileSync("src/metrics.ts", "utf8");
const schema = fs.readFileSync("schema.sql", "utf8");

test("mailnice webhook is tenant-scoped and records PII-free Analytics Engine events", () => {
  assert.match(index, /app\.post\("\/mailnice\/webhook"/);
  assert.match(index, /MAILNICE_WEBHOOK_SECRET/);
  assert.match(index, /email_bounced/);
  assert.match(index, /email_complained/);
  assert.match(index, /email_opened/);
  assert.match(index, /email_clicked/);
  assert.match(index, /recordCustomEvent\(c\.env/);
  assert.doesNotMatch(index, /recordCustomEvent\([^)]*toEmail\)/);
  assert.match(schema, /email_suppressions/);
  assert.match(metrics, /email_bounced/);
});

test("push click and delivered events are ledger-complete", () => {
  assert.match(index, /app\.post\("\/_blognice\/push\/click"/);
  assert.match(index, /push_clicked/);
  assert.match(index, /push_delivered/);
  assert.match(index, /recordCustomEvent\(env as any, tenant\.id, \{ name: "push_delivered"/);
  assert.match(fs.readFileSync("src/admin.ts","utf8"), /Subscribers/);
  assert.match(fs.readFileSync("src/admin.ts","utf8"), /report\.subscribers\.emailSubscribed/);
  assert.match(index, /\/sw\.js.*notificationclick.*\/_blognice\/push\/click/s);
});

test("email suppression prevents repeat delivery", () => {
  assert.match(index, /email_suppressions/);
  assert.match(index, /SELECT 1 FROM email_suppressions WHERE email/);
  assert.match(schema, /PRIMARY KEY \(email, tenant_id\)/);
});
