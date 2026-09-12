# OpenAI plugin submission — Blognice

MCP server: `https://www.blognice.com/mcp` (Universal URL)
Auth: OAuth 2.1 + PKCE (`blog:read blog:write`, plus `openid email` for UserInfo).
No credentials in tool inputs — auth is `Authorization: Bearer` header only.

## Suggested listing copy (paste into the portal)

- **Name:** Blognice
- **Short description:** Manage your blogs, posts, pages, and media on Blognice from ChatGPT.
- **Long description:** Blognice is a privacy-first blogging platform. Connect your
  account to list your blogs, read and publish posts and pages, upload media and
  avatars, update blog settings and navigation, and check media and AI-job status —
  all in conversation. Read tools never change anything; publishing tools confirm
  before they act.
- **Category:** Productivity
- **Website:** https://www.blognice.com
- **Support:** https://www.blognice.com (contact page) / support@blognice.com
- **Privacy:** https://www.blognice.com/privacy
- **Terms:** https://www.blognice.com/terms

## Starter prompts (suggested)

1. "List my Blognice blogs."
2. "Show the latest posts on my blog."
3. "Draft a post titled 'Hello from ChatGPT' on my blog and keep it unpublished."

## Reviewer test cases (suggested)

1. Connect with the demo account via OAuth, then ask "list my blogs" —
   expect the seeded blogs with their `public_id` values.
2. "Show posts on <blog>" — expect titles, no internal identifiers.
3. "Create a draft post titled 'Review test' on <blog>" — expect success;
   confirm the draft appears in the demo account's admin.

## Release notes (suggested)

Initial submission: 25 blog/post/page/media tools over OAuth, read/write
annotations on every tool, no credential inputs, UserInfo endpoint with
`email` + `email_verified` for workspace domain restrictions.

## Owner checklist (OpenAI dashboard — cannot be done in code)

- [ ] Org identity verified (individual or business) in Platform settings.
- [ ] Submitter has Owner role or a role with Apps Management = Write.
- [ ] Create plugin → With MCP → Universal URL `https://www.blognice.com/mcp`.
- [ ] Demo account: login + password for a fully featured account with sample
      blogs/posts (no signup or 2FA steps for the reviewer).
- [ ] Domain verification: portal shows a token → set Worker secret
      `OPENAI_APPS_CHALLENGE_TOKEN` to that token, deploy, then Scan Tools.
      Remove the secret after verification.
- [ ] Test in Developer Mode first; confirm tool scan is clean.
- [ ] Country availability + policy attestations in the portal form.
