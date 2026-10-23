# Same tab or new tab: your header links, your choice

**Public author:** The Dev Team
**Topics:** navigation, pages, ux, blognice
**Status:** Published 2026-10-23 as post 734 — https://development.blognice.com/same-tab-or-new-tab-your-header-links-your-choice (feature PR #134 merged and deployed; production posts migration 092 applied)
**Related PRs:** #134 `b2b085b`

## Draft body (body_md — title not repeated)

Your blog header menu used to decide for you. Pages always opened in the same tab. Custom links to another site always opened in a new one. That is a reasonable default, but it is not always what you want — a shop link you would rather keep your blog open behind, or an About page on a partner domain you would rather not lose your place to.

Now each menu item decides for itself. In **Pages**, edit a page and look in the Blog navigation section: alongside the label and position there is now an **Open in** choice — Same tab or New tab. The same choice appears in the **Custom navigation links** form when you add a link, and existing links show their setting in the list.

Nothing changes for menus you already have. Custom links saved before this option existed keep behaving exactly as they did: external links open in a new tab, same-site paths in the same tab. The new setting only takes effect where you pick one, and changing your mind is just editing the item again — no republishing, no theme changes.

Developers get the same control. Pages accept `navigation_new_tab` in the API, and `navigation_links` entries accept `new_tab`. Both are in the OpenAPI schema and the MCP tools, so scripted blogs can set it too.

Small change, deliberately. A header menu is one of the few things every visitor touches; it should open links the way the blog owner intended, not the way we guessed.

## Verification

- `test/navigation-target.test.mjs`: legacy defaults preserved, both header renderers honour the choice, and an end-to-end run (admin save → database → public header) passes.
- Full suite 691/691 and `tsc --noEmit` clean at `b2b085b`.
