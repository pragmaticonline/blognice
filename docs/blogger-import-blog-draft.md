# Migrate from Blogger to Blognice: Move Your Blogspot Blog in Minutes

**Target blog:** blognice.blognice.com (`public_id` 0e7ab8132e2e5a52)
**Public author:** TBD
**Topics:** blogger, migration, import, blogspot, announcements
**Status:** Post 415 (`migrate-from-blogger-to-blognice`, PUBLISHED) by RAY. User briefly retitled/re-slugged it to "Bring your Blogger blog home"; SEO title/slug/meta re-applied 2026-09-29 plus a URL-preservation paragraph (301s). IndexNow re-queued for the slug change. Audio narration not yet generated.
**Meta description:** Move your Blogspot blog to Blognice in one upload: posts, tags, dates, drafts — and your old Blogger URLs redirect to their new home.
**Related commit:** `92277d9` (Blogger import)
**Verified against:** `src/blogger-import.ts`, `src/index.ts` import routes, `test/blogger-import.test.mjs` (8/8), `docs/blogger-dissatisfaction-research.md`

## Draft body (body_md — title not repeated)

If your blog still lives on Blogger, August was a rough month. Google's automated systems [locked hundreds of legitimate Blogger sites](https://www.bleepingcomputer.com/news/google/google-blogger-locks-hundreds-of-blogs-in-malware-false-positive/) in a malware false positive — some were deleted outright — and owners were left filing "Request Review" tickets with no published restore timeline. Nobody chooses a platform expecting that phone call.

It wasn't an isolated bad week. It was the latest entry in a long pattern, and Blogger owners have noticed.

Google hasn't shipped a major Blogger update in years; the last widely covered change was [2018's removal round](https://techcrunch.com/2018/05/15/blogger-gets-a-spring-cleaning-web20-wants-its-headlines-back) — gadgets, polls, the Next Blog bar — followed by the [2021 shutdown of FeedBurner email subscriptions](https://techcrunch.com/?p=2138519). Custom domains remain a sore spot: the [official setup](https://support.google.com/blogger/answer/1233387?hl=en) demands two CNAME records, four A records, and CAA entries that include Let's Encrypt, and the help forum carries a standing crop of ["HTTPS not available"](https://support.google.com/blogger/thread/448219564?hl=en&msgid=448221952) and [missing-certificate](https://support.google.com/blogger/thread/440982442?hl=en&msgid=441218388) threads. And when something breaks, you're on your own in a specific sense: the Blogger Help Community [states plainly](https://support.google.com/blogger/community?hl=en) that it is staffed by volunteers who do not work for Google. Small wonder the "is Blogger dead?" essays keep coming — and that WordPress ships a [first-party Blogger importer](https://en-ca.wordpress.org/plugins/blogger-importer/).

So we built one too. Blognice can now import a Blogger blog in a single upload.

In Blogger, open **Settings → Back up content** and download your backup file — both the classic export and the Google Takeout `feed.atom` work. Then open your blognice blog's **Settings → Advanced → Import from Blogger** and upload it. Posts and pages arrive with their titles, tags, original publish dates, and authors; drafts stay drafts; published posts stay published. Post HTML is converted to clean Markdown, and images keep pointing at their Blogger addresses so nothing breaks mid-move.

A few things worth knowing: comments don't come over — Blogger comments stay with Blogger. Uploading the same file twice won't duplicate anything; the import remembers what it already brought over and skips it. Imports are silent, so your subscribers won't get a flood of notifications for decade-old posts. Backups are capped at 10 MB and 2,000 entries, so very large blogs should split the file and import it in parts. And like export, importing is owner-only.

Your words deserve a platform that treats them as the point, not as legacy inventory. If you've been waiting for an excuse to leave Blogspot, this is a good one: [try your first blog free](https://www.blognice.com/signup) and bring your archive with you.

## Featured image

**Prompt (16:9, no text/logos/watermarks):** warm editorial photograph of a small potted plant being carried in a cardboard moving box across a bright room, soft morning light, shallow depth of field, muted greens and neutrals, quiet optimistic mood, no text.

**Generation:** via `POST /api/v1/blogs/:blogId/images/generations` with the above prompt. Requires `API_TOKEN`. Not yet generated; to be added before publication.

## Audio

Narration via `POST /api/v1/blogs/:blogId/posts/:id/audio/generations` after the draft exists. Requires `API_TOKEN`. Technical terms to pronunciation-check: Blogspot, Blogspot, CNAME, Let's Encrypt, FeedBurner, Markdown.

## Verification

- Import behavior claims verified against `src/blogger-import.ts` (both Atom flavours, tag rules, HTML→Markdown), the import routes in `src/index.ts` (owner-only, 10 MB cap, rerun skip, silent), and `test/blogger-import.test.mjs` (8/8 passing).
- Blogger dissatisfaction claims verified against `docs/blogger-dissatisfaction-research.md`; each keeps its source link in the body.
- Full suite 588/588 and `tsc --noEmit` passed on the import commit; no measurements or deployments are claimed in the post.
