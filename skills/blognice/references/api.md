# Blognice API Details

Base: `https://www.blognice.com/api/v1` · Live docs at `https://www.blognice.com/admin/api-key`.
Full human: `github.com/pragmaticonline/blognice/blob/main/docs/API.md` · Machine: `docs/openapi.yaml`.

## Auth
`Authorization: Bearer YOUR_KEY` (per-account, `GET /admin/api-key`, paid plan required).

## Endpoints

### Account
- `GET /api/v1/me` → `{id, email, blogs:[{public_id, slug, title}]}`

### Blogs
- `GET /api/v1/blogs/:blogId` → `Blog`
- `PATCH /api/v1/blogs/:blogId` — `settings.manage` — fields: `slug, title, description, footer_name, accent_color, topics[], social_links{}, navigation_links[{label, href, order}], header_link_url, browser_push_enabled`
- `POST /api/v1/blogs` `{slug, title}` → `201 {blog}`

### Posts
- `GET /api/v1/blogs/:blogId/posts` · `GET .../posts/:id`
- `POST .../posts` — `posts.create` (`posts.publish` to publish) `{title, body_md, slug?, published?, tags?, author_name?, author_visible?, featured_image_key?, meta_description?}`
- `PATCH .../posts/:id` — `posts.edit.*`
- `DELETE .../posts/:id` — `posts.delete`
- `POST .../indexnow` `{post_ids?, paths?}` ≤1000 each

### Pages
- `GET .../pages` · `GET .../pages/:id`
- `POST .../pages` `{title, body_md, slug?, published?, show_in_navigation?, navigation_label?, navigation_order?, meta_description?}`
- `PATCH .../pages/:id` · `DELETE .../pages/:id`

### Media
- `GET .../media` · `POST .../media` (`multipart file`) · `DELETE .../media?key=KEY`

### AI
- `POST .../images/generations {prompt|post_id, style}` → `202 {job_id}` · `GET .../images/generations/:jobId`
- `POST .../posts/:id/audio/generations` → `202` · `GET .../audio/generations/:jobId` · `DELETE .../posts/:id/audio`
  Styles: editorial-photo, editorial-illustration, cinematic, child-crayon, arcade-action, risograph, paper-collage, watercolor, minimal, auto. Paid, 1k credits/mo.

### Metrics
- `GET .../metrics?days=7|30|90` · `GET .../tags`

## Errors
401 unauthorized, 403 forbidden/suspended/role, 400 validation, 404 not found, 409 taken/limit, 402 paid-only.

## Custom domains
Not an API — use **Blog Settings → Domains** (`/admin/b/:blogId/domains`). Add `blog.yourcompany.com`, create the shown CNAME, click Check. See `references/domains.md`.
