---
name: blognice
description: "Manage Blognice blogs via its token-protected API — create/update blogs, posts, pages, media, custom domains, navigation and header links. Use when automating publishing, migrating Markdown, managing 5 blogs per account, or configuring privacy-first blogs with custom domains."
---

# Blognice

Blognice is a privacy-first, open-source blogging platform (hosted $5/mo or self-hosted) at https://blognice.com. One account owns up to 5 blogs (`slug.blognice.com` or `blog.theircompany.com`). Worker: `https://www.blognice.com` (also `blognice.com`). Code: `github.com/pragmaticonline/blognice`.

## When to use

- User wants to publish Markdown, manage blogs/posts/pages, upload media, set navigation/header links, or link a custom domain.
- Automating migrations, bulk edits, or AI image/narration workflows.

## Essentials

- **Base URL:** `https://www.blognice.com/api/v1` · Platform domains: `https://www.blognice.com/api/domains` (requires `API_TOKEN` not per-user key). Details in [References: API](references/api.md).
- **Auth:** `Authorization: Bearer YOUR_KEY` — per-account key from `GET /admin/api-key` (paid plan). Platform routes use `Bearer $API_TOKEN`. `BLOG_ID` = opaque `public_id` from `GET /me`, not numeric `tenant.id`.
- **Source of truth:** `docs/API.md` (human, 13 sections) + `docs/openapi.yaml` (OpenAPI 3.1, machine-readable) in repo, and `GET /admin/api-key` live. Prefer those over hallucinating fields.
- **AI entry points:** `https://www.blognice.com/llms.txt` (press block + blog list) and `https://raw.githubusercontent.com/pragmaticonline/blognice/main/docs/API.md`.

## Workflow

1. **Discover:** `GET /api/v1/me` → pick `public_id`. `GET /api/v1/blogs/:blogId` to read `slug, title, accent_color, navigation_links, header_link_url, footer_name, custom_domain`.
2. **Edit blog:** `PATCH /api/v1/blogs/:blogId` — see `header_link_url` (icon target: `/` or `https://www.domain.com` when blog is `blog.domain.com`) and `navigation_links` (`{label, href, order}` where `href` is `https://` or `/path`, max 20). Empty `navigation_links: []` disables custom menu.
3. **Content:** Posts `POST/GET/PATCH/DELETE /api/v1/blogs/:blogId/posts` (`title + body_md` required, `tags, author_name, featured_image_key, published, meta_description`). Pages `.../pages` (`show_in_navigation, navigation_label, navigation_order` merge with `navigation_links` in header). For AI content see references.
4. **Domains:** `POST /api/domains {tenant_slug, hostname}` → `GET /api/domains/:hostname` poll `active:true`, `DELETE ...` — `hostname` must be external (`blog.company.com`, not `*.blognice.com`), requires Cloudflare for SaaS `CNAME → $CNAME_TARGET`. Detailed in [References: Domains](references/domains.md).

## Rules

- Respect roles: `posts.create/publish/edit/delete`, `settings.manage`. Free accounts own 1 blog, paid 5 — `409` if exceeded.
- Validate: `slug` 3–40 `a-z0-9-`, `accent_color` `#rrggbb`, `topics` ≤10, `social_links` https ≤500, `header_link_url` `/` or `https://` ≤500.
- Purge is automatic; queue IndexNow via `POST .../indexnow` only when re-pinging. Don't brute-force domains — poll `GET /api/domains/:hostname`.
- Use `references/api.md` for endpoints, `references/content.md` for Markdown/media/AI workflow, `references/domains.md` for CNAME verification. Run `scripts/blognice_api.py` for deterministic calls when repeating logic.

## After

Link to created resources (`/`, `/:slug`, `/pages/:slug`, `media` URL) and note role-gated errors. For public launch context use `https://blognice.com/press`.
