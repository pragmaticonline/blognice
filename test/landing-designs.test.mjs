// Conformance suite for landing page designs.
// Every design in src/landing-designs/index.ts is checked automatically, so a
// contributed design needs no tests of its own: if it renders here, it ships.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
require.extensions[".html"] = (module, filename) => { module.exports = readFileSync(filename, "utf8"); };

const { LANDING_DESIGNS, getLandingDesign, DEFAULT_LANDING_DESIGN } = await import("../src/landing-designs/index.ts");
const { renderTemplate, parseTemplate, validateDesign, TemplateError } = await import("../src/landing-template.ts");
const { parseLandingContent, buildLandingView, safeLandingHref } = await import("../src/landing-view.ts");

const HEAD_MARKER = "<!--HEAD_SLOT-->";
const BODY_END_MARKER = "<!--BODY_END_SLOT-->";

function site(overrides = {}) {
  return {
    design_id: "hero",
    title: "Test Site",
    footer_name: "Test Site Ltd",
    blog_url: "/blog",
    avatar_url: null,
    nav: [{ label: "Blog", href: "/blog" }, { label: "About", href: "/pages/about" }, { label: "Prices", href: "/pages/prices" }],
    social: [{ label: "Instagram", url: "https://instagram.com/test" }],
    posts: [{ title: "First post", url: "/first-post", date: "Oct 1, 2026" }],
    head_html: HEAD_MARKER,
    body_end_html: BODY_END_MARKER,
    media_url: (key) => `/media/${key}`,
    year: 2026,
    ...overrides,
  };
}

function render(design, content, siteOverrides) {
  const view = buildLandingView(parseLandingContent(content), site({ design_id: design.id, ...siteOverrides }));
  return renderTemplate(design.template, view);
}

const FULL = JSON.parse(readFileSync(new URL("../src/landing-designs/hero/sample.json", import.meta.url), "utf8")).content;

// --- Registry -----------------------------------------------------------------

test("every design folder is registered, and every registered design has a folder", () => {
  const dir = new URL("../src/landing-designs/", import.meta.url);
  const folders = readdirSync(dir).filter((n) => statSync(new URL(n, dir)).isDirectory()).sort();
  assert.deepEqual(LANDING_DESIGNS.map((d) => d.id).sort(), folders);
});

test("design ids are unique and unknown ids fall back to the default", () => {
  const ids = LANDING_DESIGNS.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(getLandingDesign("does-not-exist").id, DEFAULT_LANDING_DESIGN);
  assert.equal(getLandingDesign(undefined).id, DEFAULT_LANDING_DESIGN);
});

// --- Per-design conformance -------------------------------------------------------

for (const design of LANDING_DESIGNS) {
  test(`[${design.id}] passes platform validation`, () => {
    assert.deepEqual(validateDesign(design.id, design.template, design), []);
  });

  test(`[${design.id}] has a sample.json that renders`, () => {
    const sample = JSON.parse(readFileSync(new URL(`../src/landing-designs/${design.id}/sample.json`, import.meta.url), "utf8"));
    const html = render(design, sample.content, sample.site);
    assert.match(html, /data-landing-page/);
  });

  test(`[${design.id}] renders full content: hooks, head slot after styles, blog link`, () => {
    const html = render(design, FULL);
    assert.match(html, new RegExp(`<body data-landing-page data-landing-design="${design.id}">`));
    assert.ok(html.indexOf(HEAD_MARKER) > html.lastIndexOf("</style>"), "owner custom CSS must load after design CSS");
    assert.match(html, new RegExp(`${BODY_END_MARKER}\\s*</body>`), "consent/metrics slot right before </body>");
    assert.ok(html.includes('href="/blog"'), "must link to the blog index");
    assert.ok(!/\{\{[#^/!{]?\s*[\w.]+/.test(html), "no unrendered placeholders");
    for (const s of design.sections) assert.match(html, new RegExp(`class="[^"]*lp-${s}`), `section ${s}`);
  });

  test(`[${design.id}] renders empty content without empty sections or placeholders`, () => {
    const html = render(design, {}, { nav: [], social: [], posts: [] });
    assert.ok(!/\{\{[#^/!{]?\s*[\w.]+/.test(html));
    assert.ok(html.includes("<h1>Test Site</h1>"), "falls back to the site title as headline");
    assert.ok(!/<h2[^>]*>[^<]*<\/h2>\s*<\/section>/.test(html), "no heading-only sections");
    assert.ok(!/class="lp-features"/.test(html), "features hidden when empty");
    assert.ok(!/class="lp-menu"/.test(html), "no menu when there is no overflow nav");
  });

  test(`[${design.id}] escapes every owner-supplied value`, () => {
    const evil = '<script>alert(1)</script>"\'><img src=x onerror=alert(1)>';
    const html = render(design, {
      hero: { headline: evil, subheadline: evil },
      ctas: [{ label: evil, href: "https://ok.example/" }],
      intro_md: evil,
      features: [{ title: evil, body_md: evil }],
      contact: { address: evil, hours: evil },
      show_latest_posts: true,
    }, { title: evil, footer_name: evil, posts: [{ title: evil, url: "/p", date: evil }], nav: [{ label: evil, href: "/a" }, { label: "b", href: "/b" }, { label: "c", href: "/c" }] });
    assert.ok(!/<script/i.test(html), "no live script");
    assert.ok(!/<img src=x/i.test(html), "no injected tags");
    assert.ok(!/onerror=alert/i.test(html.replace(/&lt;[^&]*&gt;/g, "")), "no injected attributes");
  });

  test(`[${design.id}] never emits unsafe links`, () => {
    const html = render(design, {
      ctas: [{ label: "x", href: "javascript:alert(1)" }, { label: "y", href: "//evil.example" }],
      contact: { map_url: "javascript:alert(1)", address: "Somewhere" },
    });
    assert.ok(!/href="javascript:/i.test(html));
    assert.ok(!/href="\/\/evil/i.test(html));
  });

  test(`[${design.id}] keeps every nav item reachable on phones (inline or in the menu)`, () => {
    if (!/\{\{#nav(_all)?\}\}/.test(design.template)) return; // design has no nav (e.g. minimal)
    const nav = ["One", "Two", "Three", "Four"].map((l, i) => ({ label: l, href: `/p${i}` }));
    const html = render(design, FULL, { nav });
    const menu = html.match(/<details class="lp-menu">[\s\S]*?<\/details>/)?.[0] ?? "";
    for (const item of nav.slice(1)) assert.ok(menu.includes(`href="${item.href}"`), `${item.label} in phone menu`);
  });
}

// --- Engine -----------------------------------------------------------------

test("engine: escapes, sections, inverted sections, loops, outer-scope lookup", () => {
  const out = renderTemplate(
    "{{a}}|{{#list}}[{{name}}-{{outer}}]{{/list}}|{{^none}}empty{{/none}}|{{#flag}}yes{{/flag}}{{! gone }}",
    { a: "<b>", list: [{ name: "x" }, { name: "y" }], outer: "o", none: [], flag: true },
  );
  assert.equal(out, "&lt;b&gt;|[x-o][y-o]|empty|yes");
});

test("engine: raw output only for *_html keys", () => {
  assert.equal(renderTemplate("{{{body_html}}}", { body_html: "<p>ok</p>" }), "<p>ok</p>");
  assert.throws(() => parseTemplate("{{{title}}}"), TemplateError);
});

test("engine: mismatched or unclosed sections are errors", () => {
  assert.throws(() => parseTemplate("{{#a}}x{{/b}}"), TemplateError);
  assert.throws(() => parseTemplate("{{#a}}x"), TemplateError);
});

test("validator rejects scripts, external resources and missing slots", () => {
  const manifest = { id: "bad", label: "Bad", description: "d", author: "a", sections: [] };
  const errors = validateDesign("bad", '<html><head><link href="https://cdn.example/x.css"></head><body><SCRIPT></SCRIPT></body></html>', manifest).join("\n");
  assert.match(errors, /head_html/);
  assert.match(errors, /body_attrs_html/);
  assert.match(errors, /body_end_html/);
  assert.match(errors, /<script>/i);
  assert.match(errors, /external resources/);
});

// --- Content parsing --------------------------------------------------------

test("parseLandingContent clamps, drops unknown keys and bad values", () => {
  const c = parseLandingContent({
    hero: { headline: "x".repeat(500), image_key: "../../etc/passwd" },
    ctas: [{ label: "a", href: "/a" }, { label: "b", href: "/b" }, { label: "c", href: "/c" }],
    features: Array.from({ length: 10 }, (_, i) => ({ title: `f${i}` })),
    contact: { email: "not-an-email", phone: "+66 (2) 123<script>" },
    extra: "dropped",
  });
  assert.equal(c.hero.headline.length, 120);
  assert.equal(c.hero.image_key, null);
  assert.equal(c.ctas.length, 2);
  assert.equal(c.features.length, 6);
  assert.equal(c.contact.email, "");
  assert.equal(c.contact.phone, "+66 (2) 123");
  assert.ok(!("extra" in c));
  assert.deepEqual(parseLandingContent("not json").ctas, []);
});

test("safeLandingHref allows only safe schemes and same-site paths", () => {
  assert.equal(safeLandingHref("/pages/about"), "/pages/about");
  assert.equal(safeLandingHref("mailto:a@b.co"), "mailto:a@b.co");
  assert.equal(safeLandingHref("https://shop.example/"), "https://shop.example/");
  for (const bad of ["javascript:alert(1)", "//evil.example", "/\\evil.example", "data:text/html,x", "vbscript:x"])
    assert.equal(safeLandingHref(bad), "", bad);
});
