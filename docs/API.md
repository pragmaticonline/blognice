# Blognice API Reference

> Base URL: `https://www.blognice.com/api/v1` · Live reference also at `https://www.blognice.com/admin/api-key` (when logged in on a paid plan). All `/api/v1/*` routes are scoped to blogs you own.

GitHub source: [`src/index.ts`](../src/index.ts) · [`src/admin.ts`](../src/admin.ts) · OpenAPI: [`./openapi.yaml`](./openapi.yaml)

---

## 1. Authentication

All blog APIs use a per-account bearer token.

```
Authorization: Bearer YOUR_KEY
```

- Generate/revoke at `GET /admin/api-key` (paid plan required — free plan `402`).
- Keys are stored hashed, shown once. `POST /admin/api-key/regenerate`, `POST /admin/api-key/revoke`.
- Suspended accounts return `403`.

`BLOG_ID` in every example is the **opaque `public_id`** returned by `GET /me` (e.g. `ggh6gvgsgj4h`), not the internal numeric `tenant.id`. Post/page IDs are numeric.

---

## 2. Account

### `GET /api/v1/me` — list your blogs

```bash
curl https://www.blognice.com/api/v1/me -H "Authorization: Bearer YOUR_KEY"
```

```json
{ "id": 123, "email": "you@example.com", "blogs": [{ "public_id": "ggh6gvgsgj4h", "slug": "myblog", "title": "My Blog" }] }
```

---

## 3. Blogs — settings, navigation, icon link

### `GET /api/v1/blogs/:blogId`

Returns `slug`, `title`, `description`, `footer_name`, `accent_color`, `topics`, `social_links`, `navigation_links`, `header_link_url`, `theme`, `custom_css`, `promo_enabled`, `promo_placement`, `promo_image`, `promo_body_md`, `promo_cta_text`, `promo_cta_url`, `browser_push_enabled`, `custom_domain`, `role`.

### `PATCH /api/v1/blogs/:blogId` — update settings (requires `settings.manage`)

All fields optional (patch semantics — check `has()`). Validates slug, colour, topics, social, navigation, header link.

```bash
curl -X PATCH https://www.blognice.com/api/v1/blogs/ggh6gvgsgj4h \
  -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" \
  -d '{
    "title": "New title",
    "description": "A calmer blog.",
    "footer_name": "Acme Co.",
    "accent_color": "#2563eb",
    "topics": ["travel","photography"],
    "social_links": {"x": "https://x.com/acme"},
    "navigation_links": [{"label":"Shop","href":"https://www.domain.com/shop","order":0}],
    "header_link_url": "https://www.domain.com",
    "browser_push_enabled": true
  }'
```

| Field | Type | Validation |
|---|---|---|
| `slug` | string 3–40, `a-z0-9-`, not `--`, not reserved | `Address may use only...` |
| `title` | string | required if sent |
| `description` | string | tagline / meta description |
| `footer_name` | string ≤160 | shown in footer; falls back to title |
| `accent_color` | `#rrggbb` hex | `Brand colour must be...` |
| `topics` | `string[]` ≤10, each ≤40 | letters/numbers/space/`_-` |
| `social_links` | object `x,facebook,instagram,linkedin,youtube,tiktok,bluesky,mastodon,bitchute,telegram` → `https://` ≤500 | https only |
| `navigation_links` | `Array<{label ≤40, href ≤200, order 0-999, new_tab bool}>` ≤20 | `href` must be `https://...` or `/path` (no spaces); `new_tab` chooses new tab vs same tab (omitted: external = new tab, path = same tab) |
| `header_link_url` | string ≤500 | `"/"` or `/path` or `https://...` — **where the header logo/title links**. Use `"/"` for blog home, or `https://www.domain.com` when blog lives at `blog.domain.com`. External opens in new tab. Default `"/"` |
| `theme` | `'modern'` \| `'blogspot'` | public blog look; `blogspot` is the old-Blogspot-style theme. Default `'modern'` |
| `custom_css` | string ≤20000 | Pro-only owner stylesheet, appended after the theme styles. Rejects `</style>`, `javascript:` URLs, `expression(...)` |
| `promo_enabled` | boolean | Pro-only: show the promo popup to visitors |
| `promo_placement` | `'home'` \| `'all'` | popup on the home page only, or every public page. Default `'home'` |
| `promo_image` | string ≤500 | popup graphic: own-blog media key, `/media/…` URL, or `https://` image URL. Empty = text only |
| `promo_body_md` | string ≤2000 | popup Markdown text (sanitized). Empty = no popup |
| `promo_cta_text` | string ≤80 | popup button label |
| `promo_cta_url` | string ≤500 | popup button target: `/path` or `https://…`. Button shows only with text + URL |
| `browser_push_enabled` | boolean | owner opt-in for reader notifications |

Custom menu is **activated by sending `navigation_links`** — `[]` disables it. Pages with `show_in_navigation` merge with these links in the header.

### `POST /api/v1/blogs` — create blog

```bash
curl -X POST https://www.blognice.com/api/v1/blogs \
  -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" \
  -d '{"slug":"my-new-blog","title":"My New Blog"}'
```

Free accounts own 1 blog; paid own ≤5 (collaborations don't count). `409` if limit hit. Soft-deleted blogs don't count toward the limit.

### `DELETE /api/v1/blogs/:blogId` — soft-delete blog (owner only)

```bash
curl -X DELETE https://www.blognice.com/api/v1/blogs/ggh6gvgsgj4h \
  -H "Authorization: Bearer [REDACTED]" -H "Content-Type: application/json" \
  -d '{"confirm":"My New Blog"}'
```

`confirm` must be the exact blog title. The blog leaves the web (pages, listings, sitemaps, API) but all rows are kept for later expunge tooling; the slug stays reserved. `200 { deleted: true, slug }`.

---

## 4. Posts

### `GET /api/v1/blogs/:blogId/posts` · `GET /api/v1/blogs/:blogId/posts/:id`

Requires membership (`forbidden` 403 otherwise). Lists/returns posts. Responses include `scheduled_at` (unix seconds, `null` when unscheduled).

### `POST /api/v1/blogs/:blogId/posts` — create (requires `posts.create`, `posts.publish` to publish)

```bash
curl -X POST https://www.blognice.com/api/v1/blogs/ggh6gvgsgj4h/posts \
  -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" \
  -d '{"title":"Hello from the API","body_md":"# Hello\n\nWritten via Markdown.","tags":["api"],"author_name":"Fred & Bob AI","author_visible":true,"featured_image_key":"ggh6gvgsgj4h/image.jpg","meta_description":"Short summary","published":true}'
```

Body: `title` (required), `body_md` (required), `slug` (auto from title, ≤80, unique), `published` (default true), `scheduled_at` (ISO-8601 with explicit timezone offset, must be future; implies a draft), `tags` ≤20, `author_name` ≤120 (null clears), `author_visible` bool, `featured_image_key` (must exist in media, validated via `checkedFeaturedImage`), `meta_description` ≤155.

- `published: true` purges `/:slug`, `/sitemap.xml`, queues IndexNow, queues subscriber + browser-push notifications.
- Draft `published:false` skips notifications.
- Scheduled posts (`scheduled_at` set, `published:false`) go live on the per-minute tick with the same side effects as publishing. `published:true` combined with `scheduled_at` is a 400, as is a past time or a missing timezone offset.

### `PATCH /api/v1/blogs/:blogId/posts/:id` — update (requires `posts.edit.any`/`own`, `posts.publish` to publish)

Any of `title, body_md, slug, published, scheduled_at, tags, author_name, author_visible, featured_image_key, meta_description`. `scheduled_at` follows the POST rules; `scheduled_at:null` clears the schedule back to a plain draft, and publishing clears it. Scheduling a live post is a 400 — set `published:false` first.

### `DELETE /api/v1/blogs/:blogId/posts/:id` — delete (requires `posts.delete`)

### `POST /api/v1/blogs/:blogId/indexnow` — re-queue IndexNow

Automatic on publish; use to re-ping after external edits.

```bash
curl -X POST https://www.blognice.com/api/v1/blogs/ggh6gvgsgj4h/indexnow \
  -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" \
  -d '{"post_ids":[123]}'
# or {"paths":["/my-post"]} or {} → queues /, /sitemap.xml, /rss.xml
```

Optional body `post_ids: number[]` / `paths: string[]` ≤1000 each. `503` if `INDEXNOW_QUEUE` not configured.

---

## 5. Pages — evergreen content + custom menu integration

Pages don't trigger subscriber emails.

### `GET /api/v1/blogs/:blogId/pages` · `GET /api/v1/blogs/:blogId/pages/:id`

### `POST /api/v1/blogs/:blogId/pages` — create (requires `posts.create`)

```bash
curl -X POST https://www.blognice.com/api/v1/blogs/ggh6gvgsgj4h/pages \
  -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" \
  -d '{"title":"About","slug":"about","body_md":"# About\nWe love writing.","published":true,"show_in_navigation":true,"navigation_label":"About","navigation_order":0,"meta_description":"About us"}'
```

Fields: `title ≤200`, `body_md`, `slug ≤100` (auto, unique via `uniquePageSlug`), `published` bool, `show_in_navigation` bool, `navigation_label ≤40` (defaults to title), `navigation_order 0-999`, `navigation_new_tab` bool (open the header link in a new tab), `meta_description ≤300`. Purges `/:slug`, `/pages/:slug`, `/sitemap.xml`.

### `PATCH /api/v1/blogs/:blogId/pages/:id` — update (requires `posts.edit.*`)

### `DELETE /api/v1/blogs/:blogId/pages/:id` — delete (requires `posts.delete`)

Cleans `navigation_links` references and purges caches.

---

## 5b. Landing pages — designs + content (owner-only writes)

Same model as the admin editor: `design` must be `hero`, `business`, `shop`, or `minimal` (omitted defaults to `hero`). `content` carries `hero {headline ≤120, subheadline ≤300, image_key}`, `ctas` (up to 2 `{label ≤40, href}`), `intro_md ≤4000`, `features` (up to 6 `{title ≤80, body_md ≤600, image_key}`), `contact {email, phone, address, hours, map_url}`, `show_latest_posts` bool, `show_blog_link` bool (default true), `show_powered_by` bool (default true), and optional `features_heading` / `intro_heading` / `posts_heading` (≤80 chars; blank uses each design's default heading). Limits mirror `LANDING_LIMITS` in `src/landing-view.ts`; overlong strings are trimmed, bad hrefs dropped, invalid emails cleared. Image keys must already exist in the blog's media library. Every endpoint needs landing eligibility for the blog (`off`/`vip`/`paid`/`all` rollout) or it returns `403 Landing pages are not available on this account.` Reads need any membership role; create/update/delete need the `owner` role. At most 10 landing pages per blog (`409` past that). Publishing a page does not make it the homepage — that stays a separate admin step (`Make this my homepage`).

### `GET /api/v1/blogs/:blogId/landing` · `GET /api/v1/blogs/:blogId/landing/:id`

`200 { landing_pages: [...] }` / `{ landing_page: {...} }` with parsed `content`, or `404 { error: "landing page not found" }`.

### `POST /api/v1/blogs/:blogId/landing` — create (owner-only)

```bash
curl -X POST https://www.blognice.com/api/v1/blogs/ggh6gvgsgj4h/landing \
  -H "Authorization: Bearer [REDACTED]" -H "Content-Type: application/json" \
  -d '{"title":"Welcome","slug":"welcome","design":"hero","published":true,"content":{"hero":{"headline":"Small-batch coffee, roasted every Tuesday.","subheadline":"Single-origin beans."},"ctas":[{"label":"Shop beans","href":"https://shop.example.com"}],"intro_md":"Our story.","features":[{"title":"Direct trade","body_md":"Paid above Fair Trade."}],"contact":{"email":"hello@example.com"},"show_latest_posts":true}}'
```

Fields: `title ≤200` (required), `slug ≤100` (auto from title, auto-suffixed on clash), `design`, `content`, `meta_description ≤300`, `published` bool. `201 { landing_page }`. Purges `/landing/:slug`, `/sitemap.xml`.

### `PATCH /api/v1/blogs/:blogId/landing/:id` — update (owner-only)

Partial: `title`, `slug` (re-uniquified on change), `design`, `content` (replaces whole content; images re-validated), `meta_description`, `published`. Unpublishing the blog's homepage page clears the homepage pointer first, so the blog stays up. Purges old + new `/landing/:slug`, `/sitemap.xml`, and `/` when it was the homepage.

### `DELETE /api/v1/blogs/:blogId/landing/:id` — delete (owner-only)

Clears the homepage pointer first when deleting the homepage page, then deletes. Purges `/landing/:slug`, `/sitemap.xml`, and `/` when it was the homepage. `204` empty.

---

## 6. Custom navigation & icon link — how they work together

- **Pages** with `show_in_navigation:true` appear in header ordered by `navigation_order`.
- **`navigation_links`** (`PATCH /blogs/:id`) adds external/root-relative links alongside pages. Max 20, up to 40ch label, `https://` or `/path`.
- **`header_link_url`** sets **where the blog icon/title links when clicked** — `"/"` (blog home) or `https://www.domain.com` (parent site). Useful when blog is `blog.domain.com` but logo should go to `www.domain.com`.

Admin UI fallbacks: `POST /admin/b/:blogId/navigation-links`, `POST /admin/b/:blogId/navigation-links/delete/:idx`, `GET/POST /admin/b/:blogId/settings` (header_link_url text input).

---

## 7. Media library

### `GET /api/v1/blogs/:blogId/media` — list R2 keys
### `POST /api/v1/blogs/:blogId/media` — upload (`multipart/form-data` `file`, browser-downscaled WebP, 1-year immutable; MP3 audio also accepted and responds with `{ key, url, snippet }` where `snippet` is the bare URL to paste on its own line in `body_md` — it renders as a player)
### `DELETE /api/v1/blogs/:blogId/media?key=KEY` — delete (blocked if referenced by a post)

Media is per-blog in R2, served via `GET /media/:blogId/:file`.

Featured image on posts is just a `featured_image_key` pointing at a library key.

---

## 8. AI — images & audio narration (async, credit-gated)

Paid plan + 1,000 credits/mo. Endpoints are scope-checked and metered.

### Images
```bash
curl -X POST https://www.blognice.com/api/v1/blogs/ggh6gvgsgj4h/images/generations \
  -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" \
  -d '{"prompt":"A portrait of a watchmaker at work","style":"editorial-photo"}'
# or {"post_id":123,"style":"auto"} styles: editorial-photo, editorial-illustration, cinematic, child-crayon, arcade-action, risograph, paper-collage, watercolor, minimal, auto
curl https://www.blognice.com/api/v1/blogs/ggh6gvgsgj4h/images/generations/JOB_ID -H "Authorization: Bearer YOUR_KEY"
```
`POST` → `202 { job_id, status:"queued", status_url }`, poll `GET .../images/generations/:jobId`.

### Audio (narration)
```bash
curl -X POST https://www.blognice.com/api/v1/blogs/ggh6gvgsgj4h/posts/123/audio/generations -H "Authorization: Bearer YOUR_KEY"
curl https://www.blognice.com/api/v1/blogs/ggh6gvgsgj4h/audio/generations/JOB_ID -H "Authorization: Bearer YOUR_KEY"
curl -X DELETE https://www.blognice.com/api/v1/blogs/ggh6gvgsgj4h/posts/123/audio -H "Authorization: Bearer [REDACTED]"
```

### Audio (manual narration upload — no AI credits, any plan)

```bash
curl -X POST https://www.blognice.com/api/v1/blogs/ggh6gvgsgj4h/posts/123/audio \
  -H "Authorization: Bearer [REDACTED]" -F "file=@narration.mp3;type=audio/mpeg"
```
`POST` → `201 { key, url }`, attaches the MP3 as the post's narration (same player and analytics as generated narration). `audio/mpeg` required (`;type=` in curl, which otherwise guesses wrong); `audio/mp3` accepted as an alias. `409` when audio is already attached — `DELETE` first.
```

---

## 9. Metrics & tags

### `GET /api/v1/blogs/:blogId/metrics?days=7|30|90` — 7/30/90-day views, visitors, pages, referrers, countries, device families (Analytics Engine + nightly R2 rollups)
### `GET /api/v1/blogs/:blogId/tags` — tag cloud for posts

---

## 10. Custom domains — bring your own domain

Your blog works immediately at `yourname.blognice.com`. To use `blog.yourcompany.com` (or any domain you own):

1. Open **Blog Settings → Domains** at `https://www.blognice.com/admin/b/:blogId/domains` (requires paid plan).
2. Enter the hostname (e.g. `blog.yourcompany.com`). Blognice shows the exact DNS record to create.
3. Add the `CNAME` in your DNS provider and click **Check** — Blognice verifies and activates the domain (SSL is automatic).
4. Remove or replace it anytime from the same page.

Free plan includes only the `blognice.com` address. Paid plan allows custom domains. No API keys or separate infrastructure setup needed — everything is managed for you in the UI.

---

## 11. Errors & pagination

- `401 unauthorized` — missing/invalid bearer.
- `403 forbidden` — not a member, wrong role (`posts.create`, `posts.publish`, `posts.edit.*`, `posts.delete`, `settings.manage`), or suspended.
- `400` — validation (slug, colour, hostname, JSON).
- `404` — unknown tenant/blog/post/page/domain.
- `409` — slug/hostname taken or blog limit.
- `402` — custom domains/media generation on free plan.
- `502/503` — IndexNow not configured (or platform domain provider unavailable).

No cursor pagination yet; list endpoints return full arrays.

---

## 12. Changelog

- 2026-09-08: Added `header_link_url` + `footer_name` to `PATCH /blogs/:id` on `/admin/api-key` docs. Icon link controls where the header logo/title points.
- 2026-09-07: Queued `docs/SEO-CHECK-*.md`, `docs/CHECKLIST-*.md`.
- 2026-09-15: Public launch.

---

*Want SDK generation? Use `docs/openapi.yaml` with `openapi-generator` or import into Postman/Insomnia.*
