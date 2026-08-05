-- Demo posts for the POSTS database (tenant_id = 1, the demo blog).
-- Run with:  npm run db:seed:posts        (remote)
--            npm run db:seed:posts:local  (local dev)

INSERT INTO posts (tenant_id, slug, title, body_md, published, created_at, updated_at) VALUES
  (1, 'hello-world', 'Hello, world',
   'This is the first post on **Blog Nice**.

You write posts in plain Markdown, and the platform turns them into clean, fast, reading-first pages.

## Things that just work

- Headings, **bold**, and *italics*
- [Links](https://example.com)
- Lists, like this one
- `inline code` and code blocks

> Keep it simple. Write something worth reading.

That is the whole idea.',
   1, 1735689600, 1735689600),

  (1, 'why-minimal', 'Why minimal wins',
   'A blog is for reading. Everything that is not the words is a tax on the reader.

So the default theme here is deliberately quiet: a comfortable measure, a warm serif for the body, generous line spacing, and almost nothing else. No cookie banners, no popups, no five web fonts loading before the first paragraph.

Fast pages are also *good for search*. When there is nothing to block rendering, the page is ready the moment it arrives.',
   1, 1735776000, 1735776000);
