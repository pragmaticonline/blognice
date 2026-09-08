# Content Workflow — Posts, Pages, Media

## Markdown
Posts/pages use `body_md` (Markdown → sanitized HTML). Keep frontmatter out; use API fields. Slug auto-generated via `slugify(title)` if omitted, made unique.

## Posts vs Pages
- **Posts:** `published` notifies subscribers + push + IndexNow + sitemap. Use `tags`, `author_name` (null clears), `featured_image_key` (must exist in media).
- **Pages:** evergreen (`About`, `Contact`), `published` but no subscriber email. `show_in_navigation` + `navigation_label`/`navigation_order` controls header nav. Merges with `navigation_links`.

## Media
Browser-downscales to WebP, R2 with 1yr immutable, served `GET /media/:blogId/:file`. `featured_image_key` must be exact R2 key (`public_id/filename.jpg`). Cannot delete media referenced by a post.

## AI
Image: `POST .../images/generations` with `prompt` or `post_id` → poll job. Audio: `POST .../posts/:id/audio/generations` → poll. Both 202 async. Handle `402` credits, `503` not configured.

## Navigation
`PATCH /blogs/:id {navigation_links, header_link_url}` — custom menu. See api.md. Admin UI also `POST /admin/b/:id/navigation-links`.
