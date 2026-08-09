import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const admin = readFileSync(new URL("../src/admin.ts", import.meta.url), "utf8");
const render = readFileSync(new URL("../src/render.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/004-tenant-accent-color.sql", import.meta.url), "utf8");
const socialMigration = readFileSync(new URL("../migrations/044-tenant-social-links.sql", import.meta.url), "utf8");
const publicIdMigration = readFileSync(new URL("../migrations/005-tenant-public-id.sql", import.meta.url), "utf8");

test("accent colours are validated and choose readable button text", () => {
  assert.match(render, /export function normalizeAccentColor/);
  assert.match(render, /DEFAULT_ACCENT_COLOR = "#1a8917"/);
  assert.match(render, /export function accentTextColor/);
  assert.match(indexSource, /!\/\^#\[0-9a-f\]\{6\}\$\/i\.test\(accentColor\)/);
});

test("blog branding is persisted and injected into public and admin pages", () => {
  assert.match(migration, /ADD COLUMN accent_color TEXT NOT NULL DEFAULT '#1a8917'/);
  assert.match(socialMigration, /ADD COLUMN social_links_json TEXT NOT NULL DEFAULT '\{\}'/);
  assert.match(admin, /name="accent_color"/);
  assert.match(admin, /name="social_\$\{key\}"/);
  assert.match(admin, /\["bluesky", "Bluesky"\]/);
  assert.match(admin, /ACCENT_PRESETS/);
  assert.match(admin, /blognice green/);
  assert.match(admin, /data-accent-preset/);
  assert.match(indexSource, /UPDATE tenants SET slug = \?, title = \?, description = \?, footer_name = \?, accent_color = \?, topics_json = \?, social_links_json = \?/);
  assert.match(indexSource, /socialLinks\[key\] = url\.toString\(\)/);
  assert.match(indexSource, /url\.protocol !== "https:"/);
  assert.match(indexSource, /INSERT INTO tenant_slug_aliases/);
  assert.doesNotMatch(indexSource, /confirm_slug_change/);
  assert.match(render, /--accent: \$\{normalizeAccentColor\(tenant\.accent_color\)\}/);
});

test("public pages provide a persistent sun and moon theme toggle", () => {
  assert.match(render, /blognice-theme/);
  assert.match(render, /id="theme-toggle"/);
  assert.match(render, /Use dark theme/);
  assert.match(render, /data-theme="dark"/);
});

test("public blog URLs use opaque IDs while internal joins keep tenant_id", () => {
  assert.match(publicIdMigration, /ADD COLUMN public_id TEXT/);
  assert.match(publicIdMigration, /randomblob\(8\)/);
  assert.match(admin, /type BlogRow = \{ public_id: string/);
  assert.match(indexSource, /WHERE t\.public_id = \? AND m\.account_id/);
  assert.match(indexSource, /SELECT t\.public_id, t\.slug, t\.title/);
});
