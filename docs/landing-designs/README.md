# Contributing a landing page design

A landing design is **one folder of HTML and CSS**. You don't write TypeScript,
touch the router, or write tests: the shared engine renders your design and the
conformance suite checks it automatically.

```
src/landing-designs/
  index.ts              ← add one line here
  <your-id>/
    design.html         ← markup + CSS with {{placeholders}}
    design.json         ← name, description, author, sections used
    sample.json         ← demo content for previews (not shipped to the Worker)
```

The `.html` files in this `docs/landing-designs/` folder are **generated previews**.
Don't edit them; edit `src/landing-designs/<id>/` and run `npm run landing:preview`.

## Quick start

1. Copy the closest existing design: `cp -r src/landing-designs/hero src/landing-designs/my-design`.
2. Set `"id": "my-design"` in `design.json` and fill in `label`, `description`, `author`.
3. Add it to `DESIGN_SOURCES` in `src/landing-designs/index.ts` (two imports + one line).
4. `npm run landing:preview -- my-design`, then open `docs/landing-designs/my-design.html`.
   Add `--dark` to preview dark mode.
5. `npm test`. Every check under `[my-design]` must pass.
6. Open a PR with 375px and 1280px screenshots (light and dark).

## Placeholder syntax

| syntax | meaning |
|---|---|
| `{{a.b}}` | value, always HTML-escaped |
| `{{{x_html}}}` | raw HTML, allowed **only** for keys ending in `_html` (pre-sanitized by the platform) |
| `{{#a}}…{{/a}}` | list: repeat for each item. Anything else truthy: show once |
| `{{^a}}…{{/a}}` | show when `a` is empty or missing |
| `{{! note }}` | comment, removed |

Inside a loop, item fields are available directly (`{{title}}`), and outer values
still work (`{{site.title}}`). As in Mustache, the innermost context that has the first
part of a path wins (no further fall-through). There are no helpers or expressions. If you need a
computed value, ask for it to be added to `buildLandingView()` in `src/landing-view.ts`.

## Data available to your template

| key | type | notes |
|---|---|---|
| `head_html` | raw | **Required** in `<head>`, **after** your `<style>`. Title, meta, theme script, owner's custom CSS. |
| `body_attrs_html` | raw | **Required**: `<body {{{body_attrs_html}}}>` |
| `body_end_html` | raw | **Required** immediately before `</body>`: consent banner and metrics. |
| `site.title`, `site.footer_name`, `site.year` | text | |
| `site.avatar_url` | url or empty | the blog's profile photo |
| `blog_url` | url | **Must** be linked somewhere: `/blog` or `/` |
| `nav_all` | list `{label, href, new_tab}` | all menu items (desktop) |
| `nav` / `nav_more` / `has_nav_more` | lists / flag | phones: `nav` inline, `nav_more` in the `.lp-menu` |
| `hero.headline`, `hero.subheadline` | text | fall back to `site.title` when headline is empty |
| `hero.image_url`, `hero_image_url` | url or empty | `hero_image_url` falls back to the avatar |
| `ctas` / `has_ctas` / `cta_primary` | list `{label, href, primary, secondary}` | 0–2 buttons |
| `intro_html` | raw | owner's Markdown, sanitized |
| `features` / `has_features` | list `{title, body_html, image_url, number}` | 0–6; `number` is "01", "02"… |
| `contact.*` | text | `email`, `email_href`, `phone`, `phone_href`, `address`, `hours`, `map_url`, `has_any`, `has_quick` (hours or phone) |
| `posts` / `has_posts` | list `{title, url, date}` | up to 3 latest posts, when the owner enables it |
| `social` / `has_social` | list `{label, url}` | the blog's social links |

Wrap each optional section in its `has_*` flag (or the value itself) so empty
sections disappear completely; the suite checks this.

## Rules (checked by `npm test`)

**Safety**
- No `<script>`, `<iframe>`, `<object>`, `<embed>`, or `<form>`.
- No external resources: no CDN fonts, stylesheets, images, or `@import`. Use system font stacks.
  Images only ever come from `{{…image_url}}` placeholders.
- Never use triple braces except on `*_html` keys.
- Put images in `<img>` tags, never in inline `style="background:url(...)"`.

**Customization contract** (so the owner's Pro custom CSS keeps working)
- Use the shared tokens: `--accent`, `--accent-ink`, `--bg`, `--panel`, `--ink`,
  `--muted`, `--rule` (plus optional `--soft`, `--sans`, `--serif`). The platform sets
  `--accent` from the owner's brand colour.
- Dark mode via `html[data-theme=dark]{…}` token overrides, never
  `@media (prefers-color-scheme)`. For text links, use `color:var(--link,var(--accent))` and set
  `--link` lighter in dark mode for contrast.
- Give each section you declare in `design.json` its class: `lp-hero`, `lp-ctas`,
  `lp-intro`, `lp-features` (items `lp-feature`), `lp-contact`, `lp-posts`. Buttons:
  `lp-cta lp-cta--primary|--secondary`. Also use `lp-nav`, `lp-menu`, `lp-footer`.
  These names are a public API for owners' CSS; don't rename them.

**Mobile** (most visitors are on phones)
- Include `@media (max-width: …)` phone styles. No horizontal scroll at 320px.
- Every link and button is at least 44px tall to tap.
- If you render the nav, render `nav_more` in a `<details class="lp-menu">` and hide
  inline items after the first on phones, so every page stays reachable.
- Main buttons are full-width on phones. Images get `width`/`height` attributes and
  `height:auto`, and `loading="lazy"` except the hero image.

## Review checklist (maintainers)

- [ ] `npm test` green, including all `[id]` checks.
- [ ] Screenshots at 375px and 1280px, light and dark, look right with sample **and** empty content.
- [ ] Visually distinct from existing designs: not a recolour.
- [ ] Author credited in `design.json`.
