# Blognice Skill — for leading AI models

Portable skill so ChatGPT, Claude, Gemini, Codex, Cursor, etc. become proficient in Blognice.

## Install

- **Codex:** copy `skills/blognice` → `$CODEX_HOME/skills/blognice` (`~/.codex/skills`)
- **Claude Code:** copy `skills/blognice` → `~/.claude/skills/blognice` or `.claude/skills/blognice`
- **Cursor / Any LLM:** point your agent at `skills/blognice/SKILL.md` + `references/*.md`; `docs/API.md` + `docs/openapi.yaml` are source of truth.
- **ChatGPT Custom GPT:** paste `SKILL.md` into Instructions + upload `openapi.yaml` as Action schema.

## What's inside

- `SKILL.md` — when/how to use Blognice API (5 blogs/account, `public_id`, `header_link_url`, `navigation_links`, custom domains)
- `references/api.md` — endpoints (posts/pages/media/AI/metrics/domains)
- `references/content.md` — Markdown → posts/pages/media workflow
- `references/domains.md` — Cloudflare for SaaS CNAME verification
- `scripts/blognice_api.py` — deterministic helper (`METHOD PATH TOKEN [JSON]`)
- Source: `github.com/pragmaticonline/blognice` — `docs/API.md` (13 sections, human) · `docs/openapi.yaml` (OpenAPI 3.1, machine)

## Quick test

```bash
python skills/blognice/scripts/blognice_api.py GET /api/v1/me YOUR_KEY
```

Also discover via `https://www.blognice.com/llms.txt` + `https://raw.githubusercontent.com/pragmaticonline/blognice/main/docs/openapi.yaml`
