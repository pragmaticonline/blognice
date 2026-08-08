import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
for (const [file, title] of [["terms.html", "Terms of Service"], ["cookies.html", "Cookie and Local Storage Policy"], ["security.html", "Security Policy"]]) {
  test(`${file} is published with the shared legal navigation`, () => {
    const page = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(page, new RegExp(title));
    assert.match(page, /href="\/privacy"/);
    assert.match(page, /href="\/terms"/);
    assert.match(page, /href="\/cookies"/);
    assert.match(page, /id="theme-toggle"/);
  });
}
test("terms and cookies have public worker routes", () => {
  assert.match(indexSource, /import termsPage from "\.\.\/terms\.html"/);
  assert.match(indexSource, /import cookiesPage from "\.\.\/cookies\.html"/);
  assert.match(indexSource, /app\.get\("\/terms"/);
  assert.match(indexSource, /app\.get\("\/cookies"/);
  assert.match(indexSource, /import securityPage from "\.\.\/security\.html"/);
  assert.match(indexSource, /app\.get\("\/security"/);
  assert.match(indexSource, /\.well-known\/security\.txt/);
  assert.match(indexSource, /consistentTheme/);
  assert.match(indexSource, /class="theme-toggle"/);
  assert.match(indexSource, /Analytics preferences/);
  assert.match(indexSource, /analytics-dialog/);
});

test("algorithms page explains the materialized popularity ranking", () => {
  const algorithms = readFileSync(new URL("../algorithms.html", import.meta.url), "utf8");
  const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(algorithms, /How blognice ranks popular posts/);
  assert.match(algorithms, /21-day half-life/);
  assert.match(algorithms, /engaged-read/);
  assert.match(indexSource, /app\.get\("\/algorithms"/);
});

test("policies overview links the platform policies", () => {
  const policies = readFileSync(new URL("../policies.html", import.meta.url), "utf8");
  assert.match(indexSource, /app\.get\("\/policies"/);
  for (const path of ["privacy", "terms", "cookies", "security"]) {
    assert.match(policies, new RegExp(`href=\"/${path}\"`));
  }
  assert.match(indexSource, /replaceAll\('href=\"mailto:privacy@blognice\.com\">Contact privacy'/);
  assert.match(indexSource, /replaceAll\('href=\"mailto:privacy@blognice\.com\">Contact'/);
  assert.match(indexSource, /policy-nav/);
  assert.match(indexSource, /aria-current="page"/);
  assert.match(indexSource, /replace\('<\/nav><a href=\"https:\/\/www\.blognice\.com\//);
  assert.ok(indexSource.includes('[ ["/policies", "All policies"]') || indexSource.includes('[["/policies", "All policies"]'));
  assert.ok(indexSource.includes('["/privacy", "Privacy"]'));
  assert.ok(indexSource.includes('["/terms", "Terms"]'));
  assert.ok(indexSource.includes('["/cookies", "Cookies"]'));
  assert.ok(indexSource.includes('["/security", "Security"]'));
});
