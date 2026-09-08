# Custom Domains — user perspective

Blognice blogs work immediately at `yourname.blognice.com`. To use your own domain:

1. Open **Blog Settings → Domains** at `https://www.blognice.com/admin/b/:blogId/domains` (paid plan).
2. Enter hostname (e.g. `blog.yourcompany.com`). Blognice shows the exact `CNAME` to create.
3. Add the `CNAME` in your DNS provider and click **Check** — verification and SSL are automatic.
4. Remove/replace anytime from the same page.

No API keys, no Cloudflare dashboard, no manual certificates — everything is managed in the UI. Free plan is `blognice.com` only.

For platform self-hosters, the underlying implementation is Cloudflare for SaaS (`src/cloudflare.ts`), but hosted users never need it.
