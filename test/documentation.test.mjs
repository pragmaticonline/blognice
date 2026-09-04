import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const read = (file) => fs.readFileSync(file, "utf8");

test("README local links and npm commands resolve", () => {
  const markdown = read("README.md");
  const links = [...markdown.matchAll(/\[[^\]]*\]\(([^)#]+)(?:#[^)]+)?\)/g)]
    .map((match) => match[1])
    .filter((target) => !target.includes("://") && !target.startsWith("/") && !target.startsWith("mailto:"));
  for (const target of links) assert.equal(fs.existsSync(path.resolve(target)), true, `missing README target: ${target}`);
  const scripts = JSON.parse(read("package.json")).scripts;
  const commands = [...markdown.matchAll(/npm run ([a-z0-9:-]+)/gi)].map((match) => match[1]);
  for (const command of commands) assert.ok(scripts[command], `missing npm script: ${command}`);
  assert.doesNotMatch(markdown, /\/admin\/domains\b/);
});

test("production migration ledger accounts for every migration", () => {
  const runbook = read("docs/production-operations.md");
  const files = fs.readdirSync("migrations").filter((file) => file.endsWith(".sql"));
  for (const file of files) assert.match(runbook, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `migration absent from runbook: ${file}`);
});

test("production queue documentation and example bindings stay aligned", () => {
  const example = read("wrangler.production.example.jsonc");
  const runbook = read("docs/production-operations.md");
  for (const queue of ["blognice-audio", "blognice-email", "blognice-email-dlq", "blognice-push", "blognice-push-dlq", "blognice-indexnow"]) {
    assert.match(example + runbook, new RegExp(queue), `queue is undocumented: ${queue}`);
  }
  for (const binding of ["AUDIO_QUEUE", "EMAIL_QUEUE", "PUSH_QUEUE", "INDEXNOW_QUEUE"]) assert.match(example, new RegExp(binding));
});
