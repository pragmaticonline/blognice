# Blog Nice

A deliberately tiny multi-tenant blogging platform that runs entirely on
Cloudflare Workers. Each customer gets their own blog, addressed either by a
subdomain (`theirname.blognice.com`) or their own domain
(`blog.theircompany.com`). Posts are written in Markdown and served as clean,
fast, server-rendered pages.

## What's in the box

- **One Worker** ([Hono](https://hono.dev)) that routes every request to the
  right tenant based on the `Host` header, renders Markdown through a
  dependency-free HTML allowlist, and serves it server-side (good for SEO, with
  only small progressive scripts for editor, audio, and metrics behavior).
- **One D1 database** (Cloudflare's SQLite) holding two tables: `tenants` and
  `posts`. All queries filter by `tenant_id`.
- **Edge caching** via the Cache API. Reads are cached at the edge; publishing a
  post purges the pages it affects.
- **Accounts with multiple blogs** — a login (account) can own several blogs.
  After signing in you get a blog picker at `/admin`; each blog is managed at
  `/admin/b/<public-id>/…`. Access is enforced through a `memberships` table, so an
  account only ever sees and edits its own blogs.
- **Self-service signup** at `/signup` — a visitor picks a blog address, and an
  account, first blog, and session are created in one step; they land in their
  own editor. (No email verification yet — see notes.)
- **A minimal admin UI** — password login, server-side sessions, a blog picker,
  a post list, and a Markdown editor with a Write/Preview toggle. Every action
  is scoped to a blog the account owns.
- **Self-service custom domains** at `/admin/b/<public-id>/domains` — authors connect
  their own domain and see the exact DNS records to add, backed by Cloudflare
  for SaaS.
- **Blog settings** at `/admin/b/<public-id>/settings` — edit the blog title and
  tagline, and upload a **profile photo** that fills the byline circle on every
  post (falling back to a monogram when none is set). Photos are shrunk in the
  browser and stored in R2 like other images.
- **Subscriptions** — readers subscribe from a box on the home page and under
  every post; authors see the list at `/admin/b/<public-id>/subscribers` with CSV
  export. Capture and unsubscribe work with no dependencies. Add a Resend API
  key to also send a welcome email and notify subscribers on each new post.
- **Image uploads** — drag, paste, or pick images in the editor. They're
  downscaled and recompressed to WebP in the browser, stored in an R2 bucket,
  served through the Worker with a one-year immutable cache, and inserted into
  the post as Markdown. No image-processing entitlement required.
- **Media library** — browse and reuse a blog's existing R2 images from the
  editor or the Media admin page. Images referenced by any post cannot be
  deleted until those references are removed.
- **Featured images** — assign one media-library image to a post for a lead
  image on the article and a thumbnail in public and admin post lists.
- **AI-generated images** — Granite Micro privately turns a prompt, the
  current draft, or a blog-wide overview into an optimized visual brief;
  FLUX.1 Schnell then generates the image in one click. Use it as the featured
  image or insert it into the post. Generated JPEGs are saved in the media
  library.
- **A Medium-inspired reading theme** — a wide, comfortable measure, a large
  Charter serif body, bold sans headings, a byline with monogram and read time,
  a drop cap, and light/dark support. No web fonts, so it stays fast.
- **Per-tenant `sitemap.xml` and `robots.txt`** for search engines.
- **Privacy-conscious metrics** — a tiny first-party beacon sends anonymous
  page views to Workers Analytics Engine. Authors get 7/30/90-day views,
  visitors, pages, referrers, countries, device types, and browser families.
  Audio starts and completions go to a separate Analytics Engine dataset. A
  nightly cron stores aggregate daily JSON rollups in R2 for retention beyond
  Analytics Engine's 90-day window.
- **A token-protected API** to create/update posts, so you can write from a
  script, a form, or a future editor.
- **Per-account API keys** — every account holder generates their own key at
  `/admin/api-key` and manages their blogs and posts via `/api/v1/*`, scoped to
  blogs they own. Keys are stored hashed and shown only once.

## Project layout

    src/index.ts      Worker: routing, tenant resolution, caching, APIs, /admin
    src/render.ts     Public HTML + the one stylesheet (no Worker deps)
    src/admin.ts      Admin UI pages (blog list, post list, editor, domains)
    src/auth.ts       Password hashing, sessions, cookies
    src/db.ts         The data split + sharding seam (index vs posts database)
    src/cloudflare.ts Cloudflare for SaaS custom-hostname API wrapper
    src/email.ts      Optional transactional email via Resend
    src/metrics.ts    Analytics Engine writes/queries + daily R2 rollups
    schema.sql        Index database: accounts, memberships, tenants, sessions, domains
    schema-posts.sql  Posts database: post bodies
    seed.sql          Demo blog + account + membership (index database)
    seed-posts.sql    Demo posts (posts database)
    migrations/       One-off SQL migrations for existing databases
    wrangler.jsonc    Cloudflare config

## Two databases

Blog Nice uses two D1 databases from the start:

- **`DB`** (`blognice`) — the *index*: accounts, memberships, tenants, sessions,
  domains. Small, and always queried per account/blog. An **account** is a login;
  a **tenant** is a blog; **memberships** connect them (an account can own many
  blogs, and the `role` column leaves room for collaborators later).
- **`POSTS`** (`blognice-posts`) — every post body, and nothing else. This is the
  only data that grows without bound, so it gets its own database and can later
  be split across several without migrating any metadata or changing URLs.

`src/db.ts` is the single place that routes a tenant to its posts database.

## Migrating an existing deployment

If you deployed the earlier single-blog-per-login version, run the migration
once to move to accounts + memberships (it preserves every login and links it to
the blog it owns; existing sessions are cleared, so everyone signs in again):

    wrangler d1 execute blognice --remote --file=./migrations/001-accounts-multiblog.sql

Existing deployments created before featured images also need this one-time
POSTS database migration:

    wrangler d1 execute blognice-posts --remote --file=./migrations/002-post-featured-image.sql

Existing deployments also need the narration column before deploying the
text-to-speech feature:

    npx wrangler d1 execute blognice-posts --remote --file=./migrations/003-post-audio.sql --config wrangler.production.jsonc

Existing deployments also need the tenant slug-alias table before deploying
editable blog addresses:

    npx wrangler d1 execute blognice --remote --file=./migrations/008-tenant-slug-aliases.sql --config wrangler.production.jsonc

Owners can change a blog address from its settings. BlogNice keeps the former
address as a permanent alias and sends visitors to the new address with a
301 redirect; the old address remains reserved so it cannot be claimed by a
different blog.

Existing deployments also need the blog topics column before using topic
grouping in Settings:

    npx wrangler d1 execute blognice --remote --file=./migrations/009-tenant-topics.sql --config wrangler.production.jsonc

Existing posts databases also need the post-tags column:

    npx wrangler d1 execute blognice-posts --remote --file=./migrations/010-post-tags.sql --config wrangler.production.jsonc

Existing posts databases also need the public author-name column:

    npx wrangler d1 execute blognice-posts --remote --file=./migrations/011-post-author-name.sql --config wrangler.production.jsonc

The index database also needs blog-specific collaborator display names:

    npx wrangler d1 execute blognice --remote --file=./migrations/012-membership-display-name.sql --config wrangler.production.jsonc

Existing posts databases also need the author-visibility column:

    npx wrangler d1 execute blognice-posts --remote --file=./migrations/013-post-author-visibility.sql --config wrangler.production.jsonc

## Local development

    npm install

    # create + seed both local databases (index and posts) in one step
    npm run db:setup:local

    # for the create-post API locally
    cp .dev.vars.example .dev.vars    # then edit the token

    npm run dev

`db:setup:local` runs the four underlying steps (init index, init posts, seed
index, seed posts); run them individually if you prefer. `wrangler.jsonc` sets
`DEV_TENANT: "demo"`, so `http://localhost:8787` serves the demo blog directly
without any Host-header juggling. Remove that var before deploying to production.

## Deploying

To keep production resource IDs out of Git, copy
`wrangler.production.example.jsonc` to the ignored
`wrangler.production.jsonc`, fill in the real domain, zone, D1, and R2 values,
then run `npm run deploy:production:check` followed by
`npm run deploy:production`. Worker secret values still belong in Cloudflare
via `wrangler secret put`, not in either configuration file.

1. **Create both databases** and paste each returned `database_id` into
   `wrangler.jsonc` (the `DB` and `POSTS` bindings):

       npx wrangler d1 create blognice
       npx wrangler d1 create blognice-posts

2. **Load the schemas** (and demo data, if you want it):

       npm run db:init
       npm run db:init:posts
       npm run db:seed         # optional
       npm run db:seed:posts   # optional

3. **Create the image and metrics archive buckets:**

       npx wrangler r2 bucket create blognice-media
       npx wrangler r2 bucket create blognice-metrics

4. **Set the application API token** (a long random string):

       npx wrangler secret put API_TOKEN

5. **Enable metrics reporting.** Put your Cloudflare account ID in the
   `CF_ACCOUNT_ID` production var. Create a separate Cloudflare API token with
   `Account > Account Analytics > Read`, then enter it interactively:

       npx wrangler secret put CF_ANALYTICS_TOKEN --config wrangler.production.jsonc

   The `blognice_pageviews` Analytics Engine dataset is created automatically
   on the first page view; it does not have a database ID.

6. **Deploy:**

       npm run deploy

7. **Point your platform domain at the Worker.** Add a route for
   `*.blognice.com` (a wildcard) so every tenant subdomain hits this Worker, and
   set `ROOT_DOMAIN` in `wrangler.jsonc` to match your domain.

## Metrics

Public home and post pages include a small same-origin beacon. It stores the
tenant, path (without query parameters), external referring hostname, country
code, and a random first-party visitor ID in Workers Analytics Engine. It does
not store IP addresses, raw user agents, or full referrer URLs. The Worker
reduces the request user agent to a broad device category and browser family.
Cached page loads are still counted because collection happens independently
of HTML rendering.

Authors see their report at `/admin/b/<id>/metrics`. Analytics Engine reporting
uses the SQL API, so `CF_ANALYTICS_TOKEN` must remain a Worker secret. At 02:15
UTC each day, the scheduled handler writes the previous day's aggregate rows to
`blognice-metrics/daily/YYYY/MM/YYYY-MM-DD.json`; raw visitor IDs are excluded.
Audio starts and completions are stored separately in `blognice_events`, shown
as aggregate engagement on the same dashboard, and archived under
`events/daily/YYYY/MM/YYYY-MM-DD.json` without visitor identifiers.

## Images

Authors add images in the editor — the **Add image** button, drag-and-drop, or
paste. Before upload, the browser downscales each image to 1600px wide and
recompresses it to WebP (~200KB from a multi-megabyte phone photo); animated
GIFs are left untouched. The file goes to the R2 bucket under `<blogId>/<name>`,
is served from `/media/<blogId>/<name>` through the Worker with a one-year
immutable cache, and is inserted into the post as `![](/media/…)`.

This needs only the R2 bucket — no Images/Transformations entitlement. If you
later want per-context resizing (e.g. thumbnails, responsive `srcset`), enable
**Transformations** on the zone and serve variants via the
`/cdn-cgi/image/width=…/…` URL prefix, which works on your proxied domain with
no code change.

The editor's **Generate with AI** action uses the Wrangler `AI` binding (no
additional API key is required). It can derive context from the current draft
or from the 100 most recently updated posts. Granite's intermediate visual
brief is hidden from the author; if Granite is unavailable, the Worker uses a
deterministic fallback and continues automatically. The final image prompt is
capped at 2,048 characters. Both model calls count toward the Cloudflare
account's Workers AI usage.

## Audio narration

On a saved post, authors can select **Generate audio** to create English audio
with Cloudflare Workers AI's MeloTTS model. Generation uses the last saved title
and post body, strips Markdown syntax and code blocks, stores the result in the
existing R2 media bucket, and adds a compact audio player at the right of the
public post byline. Audio is generated once rather than on page views. To regenerate,
the author removes the existing narration and then generates a new one;
removing audio or deleting the post also deletes its generated R2 object.

Long posts are split at sentence boundaries into memory-safe model requests and
assembled into one WAV file. Narration is limited to 10,000 cleaned characters
in this initial version.
Before generation, deterministic preprocessing adds pauses at headings and
paragraphs, completes list-item punctuation, and expands a conservative set of
common abbreviations without rewriting the article through another AI model.
A small deterministic dictionary corrects known MeloTTS quirks (currently
`plugins` is sent as `plug inns`) and takes precedence over AI suggestions.
Pause hints are sent as paragraph breaks rather than ellipses, which avoids
MeloTTS occasionally vocalizing a pause as a hesitation sound.
Emoji are removed rather than spoken, and ordinary sentence-ending full stops
receive a slightly longer pause.
Headings always receive an explicit pause. Numbered Markdown list markers are
spoken as words (for example, `1.` becomes `one`) and followed by a pause before
the item text; those spoken forms also pass through pronunciation preprocessing.
Pauses before and after headings, and pauses after numbered markers, are encoded as 0.65 seconds of PCM silence,
so they do not depend on MeloTTS interpreting punctuation.
Before MeloTTS runs, Granite Micro identifies only likely pronunciation problems
and returns exact, validated phonetic replacements. It cannot rewrite the post;
invalid output is ignored, and narration continues unchanged if the text model
is unavailable.
The title is generated as its own short, neutral statement, followed by 1.5
seconds of silence encoded into the WAV before the article body begins.
MeloTTS usage is billed through the existing `AI` binding and requires no
additional API key. A short cooldown separates segment requests. Transient model
failures, including Cloudflare error 3043, are retried up to four times with
increasing delays before generation fails.

## Subscriptions & email

Readers subscribe from a box on each blog's home page and at the end of every
post. Subscriptions are stored in the `subscribers` table (per blog, with a
unique unsubscribe token). Authors manage the list at
`/admin/b/<id>/subscribers` — see the count, remove people, and **export CSV**.
Unsubscribe works via a tokened link (`/unsubscribe/<token>`), including
one-click `List-Unsubscribe` support in emails.

**Capture and unsubscribe need nothing extra.** Even with no email provider, the
subscribe box collects addresses (export them to any newsletter tool via CSV).

**To actually send email** — a welcome note on subscribe and a notification when
a post first goes live — connect [Resend](https://resend.com):

1. Verify your sending domain in Resend (SPF/DKIM) for deliverability.
2. Set the from-address as a var and the key as a secret:

       # in wrangler.jsonc vars:  "EMAIL_FROM": "Your Blog <hello@blognice.com>"
       npx wrangler secret put RESEND_API_KEY

Once both are set, `src/email.ts` starts sending; until then it's a silent no-op.
Notifications fire on the draft→published transition, so re-saving a live post
won't re-send. Note Resend's free tier caps (100/day, 3000/month) — fine to
start; add batching/queueing before large lists.

## How tenants and domains work

A tenant is one row in the `tenants` table:

- `slug` → serves the blog at `<slug>.blognice.com`.
- `custom_domain` (optional) → serves the same blog at the customer's own
  hostname.

### Letting customers bring their own domain

This is handled end to end via **Cloudflare for SaaS** (custom hostnames). The
`domains` table tracks each connected hostname and whether it's verified; a
domain only routes traffic once its `status` is `active`. First 100 hostnames
are free, then ~$0.10/hostname/month.

**Authors do this themselves** from `/admin/domains`: they enter a domain, the
page shows the DNS records to add, and a "Check status" button flips it live
once verified — all scoped to their own tenant. The JSON API below is the same
flow for operator/automation use. Either way, you do the one-time platform
setup once.

**One-time platform setup:** create a Cloudflare API token scoped to edit
SSL / custom hostnames and set it as the `CF_API_TOKEN` secret; put your
platform zone id in `CF_ZONE_ID`; and configure a fallback-origin hostname
(e.g. `cname.blognice.com`) in the Cloudflare dashboard, setting `CNAME_TARGET`
to match.

**JSON API (operator / automation — needs the platform token):**

1. **Connect** — register the customer's hostname and get back the DNS records
   they must add:

       curl -X POST https://blognice.com/api/domains \
         -H "authorization: Bearer YOUR_API_TOKEN" \
         -H "content-type: application/json" \
         -d '{"tenant_slug":"acme","hostname":"blog.acme.com"}'

   The response includes the `CNAME` the customer creates (pointing at
   `CNAME_TARGET`) plus any SSL/ownership validation records.

2. **Check status** — poll until `{ "active": true }`. This call flips the
   domain live in the database the moment Cloudflare confirms the hostname and
   its certificate are ready:

       curl https://blognice.com/api/domains/blog.acme.com \
         -H "authorization: Bearer YOUR_API_TOKEN"

3. **Disconnect** (optional):

       curl -X DELETE https://blognice.com/api/domains/blog.acme.com \
         -H "authorization: Bearer YOUR_API_TOKEN"

Once active, requests to `blog.acme.com` resolve straight to that tenant's blog.
Steer customers toward a subdomain (`blog.theircompany.com`) rather than a bare
apex — apex/wildcard custom hostnames generally need Cloudflare's enterprise
plan or CNAME-flattening support from the customer's DNS provider.

Docs: <https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/>

## Writing posts

### The admin UI (the normal way)

Go to `/admin` and sign in. The seeded demo login is:

    email:     demo@example.com
    password:  password

After signing in you land on your **blogs** list (or straight into the blog if
you only have one). Pick a blog to manage it at `/admin/b/<id>`, where you get
its posts and a Markdown editor with a Write/Preview toggle. Use **New blog** on
the list to create more blogs under the same account. Toggle **Published** off to
keep a post as a draft. Saving purges the affected cached pages automatically.
**Change the demo password before deploying.**

Admin pages are marked `noindex`, and every blog-scoped route verifies the
signed-in account owns that blog (via `memberships`), so one account can never
see or edit another account's blogs.

### Signing up (the self-service way)

Anyone can create a blog at `/signup`: they choose a blog address (which becomes
`address.blognice.com`), a title, an email, and a password. That creates their
**account** and their **first blog**, and drops them into the editor. They can
add more blogs later from the blog list. The slug is validated and checked
against a reserved-name list so it can't collide with your own hostnames.

Before promoting this publicly, add the two things the code marks as TODO:
**email verification** (send a confirm link and gate the blog until confirmed —
needs an email provider) and **rate limiting** on the endpoint.

### Provisioning access yourself (operator)

You can also create/reset a login and grant it a blog from the platform token —
handy for onboarding a customer manually, resetting a password, or adding a
co-owner to an existing blog:

    curl -X POST https://blognice.com/api/users \
      -H "authorization: Bearer YOUR_API_TOKEN" \
      -H "content-type: application/json" \
      -d '{"tenant_slug":"acme","email":"jane@acme.com","password":"a-strong-password"}'

(This needs the tenant to exist already; `/signup` is the path that also creates
the tenant.)

### The JSON API (for scripts / automation)

You can also create or update posts directly (upserts on `tenant_slug` + `slug`):

    curl -X POST https://demo.blognice.com/api/posts \
      -H "authorization: Bearer YOUR_API_TOKEN" \
      -H "content-type: application/json" \
      -d '{
            "tenant_slug": "demo",
            "slug": "my-first-post",
            "title": "My first post",
            "body_md": "Hello from **Markdown**.\n\n## A heading\n\nAnd a paragraph.",
            "published": true
          }'

Set `"published": false` for a draft. Publishing purges the affected cached pages.
APIs also accept `"featured_image_key": "<blogId>/<file>"`; the image must
already exist in that blog's media library. Send `null` or an empty string to
remove an assigned featured image.

## Account API keys

Two separate APIs live under `/api`:

- **Operator API** (`/api/posts`, `/api/domains`, `/api/users`) — authorized by
  the single platform-wide `API_TOKEN` secret. For provisioning and automation
  you run yourself.
- **Per-account API** (`/api/v1/*`) — authorized by an individual account's own
  key, and scoped to the blogs that account owns. This is what you hand to an
  account holder who wants to manage their own posts programmatically.

An account holder generates a key at **`/admin/api-key`** (linked in the admin
nav). Only the key's SHA-256 hash is stored, so it's shown exactly once at
generation — if it's lost, they regenerate (which replaces the old one).
Requests send it as a bearer token:

Set these variables first:

    export API="https://blognice.com/api/v1"
    export KEY="bnk_…"
    export BLOG_ID="ggh6gvgsgj4h"  # public_id from /me (not the internal numeric tenant id)

The `BLOG_ID` in every `/blogs/:id/...` path is the blog's opaque `public_id`
returned by `/me`. Post IDs remain numeric. For example, a response may include
`{"public_id":"ggh6gvgsgj4h","slug":"ray","title":"Ray's blog"}`.

List blogs and IDs:

    curl "$API/me" -H "Authorization: Bearer $KEY"

Create a published post:

    curl -X POST "$API/blogs/$BLOG_ID/posts" \
      -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
      -d '{"title":"Hello from the API","body_md":"# Hello\n\nWritten via Markdown.","published":true}'

Create a draft with a generated slug:

    curl -X POST "$API/blogs/$BLOG_ID/posts" \
      -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
      -d '{"title":"A draft","body_md":"Work in progress.","published":false}'

List posts, fetch one, update it, and delete it:

    curl "$API/blogs/$BLOG_ID/posts" -H "Authorization: Bearer $KEY"
    curl "$API/blogs/$BLOG_ID/posts/$POST_ID" -H "Authorization: Bearer $KEY"
    curl -X PATCH "$API/blogs/$BLOG_ID/posts/$POST_ID" \
      -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
      -d '{"title":"Updated title","published":true}'
    curl -X DELETE "$API/blogs/$BLOG_ID/posts/$POST_ID" \
      -H "Authorization: Bearer $KEY"

Assign an existing media-library image as the featured image (or send `null`
to remove it):

    curl -X PATCH "$API/blogs/$BLOG_ID/posts/$POST_ID" \
      -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
      -d '{"featured_image_key":"1/1785819096450-example-ai.jpg"}'

Generate an image asynchronously, optionally attaching it to a post:

    curl -X POST "$API/blogs/$BLOG_ID/images/generations" \
      -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
      -d '{"post_id":42,"style":"editorial-photo"}'

    curl "$API/blogs/$BLOG_ID/images/generations/$IMAGE_JOB_ID" \
      -H "Authorization: Bearer $KEY"

Generate narration asynchronously and poll it until complete:

    curl -X POST "$API/blogs/$BLOG_ID/posts/$POST_ID/audio/generations" \
      -H "Authorization: Bearer $KEY"

    curl "$API/blogs/$BLOG_ID/audio/generations/$AUDIO_JOB_ID" \
      -H "Authorization: Bearer $KEY"

Image and audio generation return `202` with a job ID. Poll the corresponding
status endpoint until `complete` or `failed`; ordinary post creation never
triggers paid AI work. Every request is checked against the account's
`memberships`, so a key can only touch blogs its owner controls.

## Notes for going further

- **Harden before a public launch.** Add rate limiting on `/admin/login` and
  `/signup`, email verification on signup (send a confirm link, gate the blog
  until confirmed), and CSRF tokens on the forms (the `SameSite=Lax` cookie
  already blocks the common cross-site case). The signup handler marks where
  verification goes.
- **Scaling capacity (the sharding seam).** Each D1 database maxes out at 10 GB.
  Post bodies already live in their own database (`POSTS`), separate from the
  index, so the growing data is isolated from day one. When that database fills,
  shard it by tenant: create another posts database, bind it (e.g. `POSTS_2`),
  set some tenants' `shard` to point at it, and add a `case` in `tenantDb()`
  (`src/db.ts`) — the only code change. Because `shard` is derived from the
  tenant (resolved from the hostname on every request), routing adds no lookup,
  and moving a tenant to a new shard is a one-field update that changes no post
  URLs. Shard by tenant, not by time or a fixed pool — a blog partitions
  naturally by tenant, and per-tenant databases never need re-sharding
  (Cloudflare allows up to 50,000 per account).
- **Deleting a tenant** must also delete its posts from the `POSTS` database:
  call `deleteTenantPosts()` (`src/db.ts`) alongside removing the tenant row.
  SQLite's `ON DELETE CASCADE` handles users/sessions/domains (same database as
  the tenant) but cannot reach across into the posts database.
- **Billing and customer onboarding** are the remaining pieces to turn this into
  a full product.

Built to run on Cloudflare Workers, D1, and Cloudflare for SaaS.

## Collaborators

Blog owners can invite existing BlogNice accounts from **Collaborators** in a
blog's admin navigation. Invitations are single-use links that expire after
seven days and are bound to the invited email address. Roles are:

- **Editor** — manage, publish, and delete any post; manage media.
- **Author** — create, edit, and publish their own posts; upload media.
- **Contributor** — create and edit their own drafts; cannot publish.

Owners retain control of members, settings, domains, subscribers, and API
credentials. Apply the collaborator migrations to both D1 databases before
deploying the new code:

```sh
npx wrangler d1 execute blognice --remote --file=./migrations/006-collaborators.sql
npx wrangler d1 execute blognice-posts --remote --file=./migrations/006-post-authorship.sql
```

## License

Copyright (C) 2026 Pragmatic Online Co., Ltd.

BlogNice is free software licensed under the **GNU Affero General Public License, version 3 or later** (`AGPL-3.0-or-later`). See [`LICENSE`](LICENSE) for the complete license terms.

