import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const admin = fs.readFileSync("src/admin.ts", "utf8");

test("Bruv: domain linking Pending -> Waiting, no raw CNAME error, no empty cert boxes", () => {
  assert.match(admin, /\${inst\.active \? "Active" : "Waiting"}/);
  // list also uses Waiting
  assert.match(admin, /d\.status === "active" \? "Active" : "Waiting"/);
  // cert validation filtered to non-empty txt_name/txt_value
  assert.match(admin, /filter\(\(r: any\) => String\(r\.txt_name/);
  assert.match(admin, /String\(r\.txt_value/);
  // waiting message instead of red CNAME error while pending
  assert.match(admin, /Waiting for DNS — your CNAME is being checked/);
  assert.match(admin, /CNAME to this zone/);
  // no longer shows empty placeholders
  assert.doesNotMatch(admin, /inst\.ssl_validation && inst\.ssl_validation\.length\s+\? `<p/);
});
