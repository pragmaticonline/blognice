# Autopilot — Spec (Draft 2026-09-10)

Status: draft. TDD seams pre-agreed here; implementation vertical-slices follow.

## Summary
Per-blog automated publishing: at owner-configured cadence (max 1/day) the Worker searches the web for a fresh source matching criteria, generates a post (title/slug/body_md/excerpt/meta/tags), creates AI editorial image + narration audio, and publishes (or drafts) using existing post + AI pipelines. Pro/VIP only. Staff-portal toggle gates internal testing.

## Domain terms
- **Autopilot Config**: per-`tenant_id` row controlling schedule/criteria/output.
- **Autopilot Run**: per-execution row + Analytics Engine event for staff observability.
- **Criteria**: topic/include/exclude, freshness, allow/block domains, tone, audience, length.
- **Sources**: dedup + freshness-filtered web results (Brave/Tavily), Browser Rendering fallback only for JS-heavy fetch.

## Gating & roles
- `tenantHasPaidPlan` / `accountHasPaidPlan` (VIP counts) is required for owner-facing config + scheduled runs.
- **Phase 1 (internal)**: Staff Workers toggle `staff_enabled` per blog; scheduled runner requires `staff_enabled=1 AND enabled=1` AND paid plan. Owner API returns 403 until staff-enabled.
- **Phase 2**: flip to owner-self-serve; `staff_enabled` becomes kill-switch / override.

## Data model (D1 `DB`)
```sql
-- migration 056-autopilot.sql
CREATE TABLE autopilot_configs (
  tenant_id INTEGER PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  staff_enabled INTEGER NOT NULL DEFAULT 0 CHECK (staff_enabled IN (0,1)),
  interval_days INTEGER NOT NULL DEFAULT 1 CHECK (interval_days BETWEEN 1 AND 7),
  run_hour_utc INTEGER NOT NULL DEFAULT 9 CHECK (run_hour_utc BETWEEN 0 AND 23),
  criteria_json TEXT NOT NULL DEFAULT '{}',
  image_style TEXT NOT NULL DEFAULT 'editorial-photo',
  voice TEXT, -- nullable, defaults to tenant TTS voice
  auto_publish INTEGER NOT NULL DEFAULT 1 CHECK (auto_publish IN (0,1)),
  max_length INTEGER NOT NULL DEFAULT 900 CHECK (max_length BETWEEN 400 AND 2000),
  next_run_at INTEGER, -- unix seconds, nullable until first enable
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE TABLE autopilot_runs (
  id TEXT PRIMARY KEY, -- randomUUID
  tenant_id INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending','success','skipped','failed')),
  source_url TEXT,
  source_title TEXT,
  post_id INTEGER,
  error TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX idx_autopilot_runs_tenant ON autopilot_runs(tenant_id, started_at DESC);
CREATE INDEX idx_autopilot_configs_next ON autopilot_configs(enabled, staff_enabled, next_run_at);
```

`criteria_json` schema (validated in app, stored as JSON string):
```json
{
  "topic": "string 3-120 chars, required",
  "include": ["keyword"],
  "exclude": ["keyword"],
  "freshness": "24h|7d|30d (default 7d)",
  "allowDomains": ["example.com"],
  "blockDomains": ["spam.example"],
  "tone": "neutral|concise|friendly|authoritative (default neutral)",
  "audience": "string 0-120",
  "tags": ["tag"],
  "dedup_days": 30
}
```
Limits: `topic` required; `include/exclude` ≤10 each, ≤40 chars each; `allow/block` ≤20 domains each; `tags` ≤5; `dedup_days` 7-90.

## Seams (TDD — must agree before tests)
1. **Staff seam** — `POST /staff/api/autopilot/:tenantId/toggle` + `GET /staff/api/autopilot/:tenantId` + staff UI at `/staff/accounts/:id` blog list. Auth: `staff` (support/admin for read, admin for mutate). Tests: `test/autopilot.test.mjs` via `staff.ts` Hono + `getMiniflareBindings`.
2. **Owner API seam** — `GET /api/v1/blogs/:blogId/autopilot` + `PUT /api/v1/blogs/:blogId/autopilot`. Auth: `apiAccount`, owner role, `tenantHasPaidPlan` else 402. Validates criteria + staff_enabled gate (403 if not staff-enabled in phase 1). No new Cloudflare API keys exposed — uses existing Worker AI/R2/QUEUE bindings.
3. **Scheduled seam** — `export default.scheduled()` hourly cron: `SELECT ... WHERE enabled=1 AND staff_enabled=1 AND next_run_at <= now` (or null). For each: check paid plan still active, check `ai_credit_usage` (reserve 1 credit per post; 1000/mo allowance), dedup by `source_url` in last `dedup_days`, then pipeline. On success: `next_run_at = now + interval_days*86400` aligned to `run_hour_utc`. On skip/fail: backoff + AE event.
4. **Analytics seam** — `AUTOPILOT_EVENTS` AE dataset + `GET /staff/autopilot-runs` filtered list (tenant, status, date). Staff-only.

Out of scope for seams: internal `search→fetch→LLM→image→audio→createPost` adapters; tested indirectly via scheduled seam with mocked `fetch` + `env.AI`.

## Search & fetch
- Primary: Brave Search or Tavily (env var `AUTOPILOT_SEARCH_API_KEY`, else skip). Cost-optimized; no Browser by default.
- Fallback: `env.MYBROWSER` (Browser Rendering) only when fetch returns JS shell or 403 and `criteria` allows it. Free tier 10min/day, 3 concurrent, 3/min; Paid 10hrs/mo incl. — viable for <1/day per blog.
- Fetch validates `allowDomains/blockDomains`, freshness, excludes blocked.
- Dedup: `SELECT 1 FROM autopilot_runs WHERE tenant_id=? AND source_url=? AND started_at > now - dedup_days*86400`.

## Generation pipeline (per run, reuses existing code)
1. Fetch source HTML → extract text (≤12k like `buildSourceContext`).
2. LLM → markdown body (`AI_MARKDOWN_TEXT_MAX` bounds, 400-2000 words, default 900) + title/slug/tags/excerpt/meta via same prompts as manual.
3. `reserveAiCredits(env, tenantId, 1)` — fail → skip run, emit `skipped:credits`.
4. Image: `createVisualBrief` + `runFlux2Klein` → `MEDIA.put` → `featured_image_key`.
5. Audio: enqueue via `AUDIO_QUEUE` or inline `env.AI` TTS → `audio_key`.
6. Create post in `POSTS` DB: `POSTS.prepare("INSERT INTO posts (tenant_id, slug, title, body_md, tags_json, published, ... meta_description, featured_image_key, audio_key)")`. `published = auto_publish?1:0`. `slug` deduped with suffix.
7. Record `autopilot_runs` success + write AE `AUTOPILOT_EVENTS.writeDataPoint({blobs:[tenantId, status, sourceUrl], doubles:[durationMs], indexes:[tenantId]})`.

## Limits & safety
- Max 1/day per blog enforced at both API validation (`interval_days >=1`) and scheduler (`next_run_at`).
- Length: sensible limit **900 default, 400-2000 allowed, 1200 recommended cap for cost**; API rejects >2000.
- Content policy: same as ToS/AUP (no porn/gore except public-interest; illegal harassment) — reuses existing markdown sanitization.
- No badge needed; `auto_publish` default true, optional draft.
- Staff toggle is per-blog; no global kill needed beyond `staff_enabled`.

## Staff UI
- On `/staff/accounts/:id` blog row: `Autopilot: off/on — next run <date> — [Configure]` → form (topic, include/exclude, freshness, domains, tone/audience, tags, interval, hour, image_style, voice, auto_publish, max_length).
- `GET /staff/autopilot-runs?tenant=&status=&from=&to=` — AE-backed list (or D1 `autopilot_runs` fallback).

## Open questions (resolved for Phase 1)
- Max length: 2000 hard, 900 default, de facto 1200 for cost guidance.
- Credit cost: 1 per autopilot post (same as image+audio batch) — reuse `ai_credit_usage`.
- Browser: opt-in fallback, not primary.

## TDD plan (vertical slices)
1. Migration + staff toggle seam (this slice).
2. Owner API seam (paid gate + validation).
3. Scheduled runner skeleton (1/day, paid check, next_run_at).
4. Search/fetch mock + dedup.
5. LLM→post→AE + image/audio hookup + staff runs list.

Each slice: one failing `test/autopilot.test.mjs` → minimal `src/*` → `rtk npm test` → `code-review` (Bob).
