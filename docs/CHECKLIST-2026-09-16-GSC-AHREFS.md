# GSC / Ahrefs Verification Checklist — Queued for 2026-09-16
Wire: 2026-09-15 (AP/BI) — verify next day. Parked SEO title changes until 2026-09-17/18.

Source context: SEO check 2026-09-07 saved in `docs/SEO-CHECK-2026-09-07.md` (Seobility 79% on-page, External 3% pre-wire).

## Google Search Console (GSC) — 2026-09-16

### Property & Sitemaps
- [ ] Confirm Domain property `blognice.com` verified (DNS TXT) — covers apex + www
- [ ] Submit `https://www.blognice.com/sitemap-index.xml` in GSC > Sitemaps (if not already)
- [ ] Submit `https://www.blognice.com/sitemap.xml` if present
- [ ] Check Sitemaps status = Success, Discovered URLs count

### URL Inspection (GSC > URL Inspection > Test Live URL)
- [ ] `https://www.blognice.com/` — Indexed, canonical `https://www.blognice.com/`
- [ ] `https://www.blognice.com/press` — Indexed
- [ ] `https://www.blognice.com/press/2026-09-blognice-launch` — Indexed, check Canonical, Last crawl, Mobile usability
- [ ] `https://www.blognice.com/llms.txt` — Should be 200 text/plain (not indexed, but crawlable)
- [ ] `https://blognice.com/llms.txt` — 200 text/plain (apex, no redirect)
- [ ] `https://www.blognice.com/robots.txt` — Fetch, confirm allows `/press/`

### Coverage / Indexing
- [ ] Pages > Indexed vs Not indexed — no unexpected errors for /press/*
- [ ] Check Crawl stats — spike after wire is ok
- [ ] Validate `press-launch.html` not blocked by robots / noindex

### Enhancements
- [ ] Core Web Vitals — Mobile/Desktop — no regressions (was 0.11s, 49kB)
- [ ] HTTPS — valid, no mixed content
- [ ] Sitelinks / Breadcrumbs — no errors

### Performance (after 24h)
- [ ] Note baseline impressions/clicks for `blognice` + `privacy-first blogging` (compare 09-17/18)
- [ ] Filter by Page: `/press/2026-09-blognice-launch` — impressions appearing

## Ahrefs Webmaster Tools (AWT) / Ahrefs — 2026-09-16

### AWT Setup
- [ ] Verify `blognice.com` in Ahrefs Webmaster Tools (if not already) — DNS or file
- [ ] Run Site Audit — check Health Score vs Seobility 79%, confirm title-length warning still flagged (750px)

### Backlinks — Expect 300+ syndication from AP/BI
- [ ] Site Explorer > Backlinks — count vs 2026-09-07 baseline (2 backlinks / 1 domain / 1 IP)
- [ ] Referring domains — list new domains (AP, BI, syndication network)
- [ ] Anchors — check `Blognice` / `privacy-first blogging` / URL anchors
- [ ] Check that `https://blognice.com/press/2026-09-blognice-launch` is top linked page after wire
- [ ] Export backlinks CSV to `docs/backlinks-2026-09-16.csv` (for archive)

### Keywords / Content
- [ ] Organic keywords — any new rankings for `blognice` brand
- [ ] Best by links — confirm press release appears

## Bing Webmaster Tools (optional, same day)
- [ ] Submit sitemap-index.xml
- [ ] URL Inspection for `/press/2026-09-blognice-launch`

## Manual Live Checks — 2026-09-16
- [ ] `curl -I https://www.blognice.com/llms.txt` → 200 text/plain; charset=utf-8
- [ ] `curl -I https://blognice.com/llms.txt` → 200 (not 301)
- [ ] `curl -I https://www.blognice.com/assets/press/2026-09-blognice-launch.docx` → 200
- [ ] View-source homepage — `<title>Blognice: Open-Source, Privacy-First Blogging Platform for Managing Multiple Blogs</title>` still intact (do not shorten yet)
- [ ] Seobility re-check — score should hold 79% until title fix 09-17/18

## IssueWire — Buy before 2026-09-15 to use coupon
- [ ] BEFORE 2026-09-15: Place IssueWire Tier 2 order ($65 → $58.50 with NEXTMOVE10) — purchase counts, not publish date
- [ ] Apply coupon `NEXTMOVE10` at checkout (valid 07-15 Sept, 10% off)
- [ ] Schedule publication for **2026-09-16 09:00 ET** (day after AP/BI 09-15) — do NOT publish before AP/BI
- [ ] Use same release file `https://www.blognice.com/assets/press/2026-09-blognice-launch.docx` — keep title identical for canonical, allow IssueWire to syndicate to FOX/CW
- [ ] If IssueWire requires distribution within coupon window, schedule for 2026-09-15 14:00 ET (afternoon after EasyPRWire AM push) — still staggered
- [ ] Save IssueWire order receipt + syndication report to `docs/`

## After Checklist
- [ ] Screenshot GSC Performance + AWT Backlinks overview → save to `docs/screenshots/2026-09-16/`
- [ ] Decide on IssueWire Tier 2 $65 (FOX/CW logos) if AP/BI report shows gaps
- [ ] 2026-09-17/18: execute parked SEO fixes (shorten title to ~520px, add H2 `Managing Multiple Blogs`, add 1× `open-source` sentence, Apple touch icon)

---
Queued: 2026-09-07 — run on 2026-09-16. Files: `docs/SEO-CHECK-2026-09-07.md`, `src/index.ts:839` (llms.txt), `press-launch.html`.
