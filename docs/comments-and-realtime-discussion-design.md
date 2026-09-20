# Comments and realtime discussion design

This document parks the discussion-system ideas while Blognice starts with a smaller, useful first step: opt-in browser notifications for new blog posts.

## Product direction

Blognice should support active, moderated discussions without making the first release dependent on realtime infrastructure. The source of truth remains ordinary HTTP reads and writes; realtime delivery is an enhancement.

## Proposed comment MVP

- A commenter verifies an email address before their first comment.
- A secure, scoped browser cookie lets the same browser submit later comments without repeating verification.
- A profile is tied to a tenant and a privacy-preserving email identity, so the commenter can recover access if the cookie is lost.
- Comments are plain text initially. No arbitrary HTML, links, attachments, or embedded media.
- All comments are automatically approved on submission in this version — there is no pre-publication queue and no trusted-commenter tier. Moderation is post-hoc (removal, see below), with per-tenant rate limits, duplicate detection, abuse reporting, and an emergency disable switch. Locked rate values: 5 verification starts/hour per address, 20 submits/10min per identity, 200 submits/hour per tenant, duplicates (same identity + body) rejected within 10 minutes, bodies capped at 2000 plain-text characters, verification links live 24 hours.
- Turnstile or an equivalent challenge is applied to suspicious/high-volume submissions, not as an always-on barrier.
- The design must include deletion, retention, export/access handling, and accessible keyboard/screen-reader flows.

## Rendering and realtime

The initial page should server-render approved comments for fast first paint and accessibility. JavaScript can load additional comments with a cursor.

## Realtime update stream (continued design)

Comments are enabled per blog with a `comments_enabled` tenant setting defaulting off, mirroring `browser_push_enabled`. Everything below is inert while the flag is off, including the socket endpoint and the approval broadcast.

### Transport

- One Durable Object room per post, named `comment-room:{tenant_id}:{post_id}`, using the WebSocket Hibernation API so idle rooms cost nothing.
- The Durable Object is coordination only: it holds connections and ephemeral typing state. It never stores comments and never touches D1. Approved comment bodies are public data, so subscribing needs no auth.
- Comment writes always go over HTTP POST into D1 (the database of record, through moderation). The socket is read-mostly: clients never send comment content over it.
- Fallback when WebSockets are unavailable: poll `GET /:slug/comments?cursor=` every 15 seconds. Same shape, same cursor.

### Message protocol

Server to client JSON frames, each with `type`:

- `comment-approved` — carries the full approved comment `{id, author_name, body, created_at}`. Sent when moderation approves (or immediately for trusted commenters once that exists).
- `comment-removed` — carries `{id}`. Clients replace the comment with a “removed by moderator” tombstone; the body is never sent.
- `presence` — aggregate `{viewers, writers}` counts only, throttled to one broadcast per 5 seconds per room.
- Typing: clients send `{type:"typing"}` at most once per 5 seconds; the room keeps a 10-second expiry per connection and broadcasts only the aggregate writer count, never identities. Typing state is never persisted and never triggers push notifications.

### Submit to broadcast path

1. HTTP POST validates (verified identity, rate limits, duplicate check, parent checks) and writes the comment as `approved` in POSTS D1.
2. The worker POSTs the event to the room's internal endpoint; the room broadcasts `comment-approved` to subscribers.
3. On removal, the row is tombstoned (`removed`) and the room broadcasts `comment-removed`.

If the broadcast POST fails, the comment is still approved and visible on next page load or poll — broadcast is best-effort enhancement, never required for correctness. The `pending` status is reserved for a future pre-moderation mode and unused in this version.

### Broadcast endpoint authentication (Disqus-style)

Following the Disqus server-signing pattern (HMAC over a normalized request with a timestamped nonce), worker-to-room calls authenticate with a shared secret that never leaves the server:

- Secret stored as a worker env var (`COMMENTS_ROOM_SECRET`), per environment.
- Each broadcast POST carries `X-Bn-Nonce: {unix_ms}:{random_16}` and `X-Bn-Mac: hex(HMAC-SHA256(secret, nonce + "\n" + method + "\n" + path + "\n" + sha256(body)))`.
- The room rejects missing nonces, nonces older than 5 minutes, reused nonces (small in-memory LRU, evicted on hibernate — replay across hibernation is bounded by the 5-minute window), and MAC mismatches compared with a constant-time equality check (same `timingSafeEqual` helper family as the payment webhooks).
- Unsigned requests, including all browser traffic, can only open WebSockets — never inject events.

### Connection cap (platform-derived)

The Hibernation WebSocket API permits 32,768 connections per Durable Object, with CPU/memory as the practical limit. Our frames are tiny (a comment payload, a count), so the room will not approach the platform ceiling on any realistic post. The app-level cap exists only as abuse protection: **2,000 concurrent connections per room with oldest-first eviction**, plus per-IP connection rate limiting. Revisit on observed data, not before.

### Moderation UI (two surfaces)

- **Blog admin** (`/admin/b/:id/...`): a Comments section listing recent comments across the blog's posts (newest first, filterable by post), each with Remove / Restore and a link to the post. Removal tombstones immediately and broadcasts `comment-removed`. The blog's `comments_enabled` switch and emergency disable live here, next to the existing `browser_push_enabled` control.
- **Staff** (platform worker): a cross-blog queue for abuse handling — recent removals, per-blog disable/enable override, and reporter summaries. Staff removal carries the same tombstone semantics; the owning blog sees it as a moderator removal.

### Reconnect and catch-up

- The client remembers the highest approved comment id it has rendered.
- On socket open, close, or error, it fetches `GET /:slug/comments?since_id=` over HTTP and renders anything missed, then resumes the socket. The room never replays history.
- Missed `comment-removed` frames converge the same way: the HTTP listing omits removed bodies, so a refetch corrects any stale client.

### Abuse and limits

- Connection rate limit per IP per room; cap concurrent connections per room (e.g. 500) with oldest-first eviction.
- `typing` frames beyond one per 5 seconds per connection are dropped silently and count toward abuse scoring.
- Comments inherit the MVP guards: email verification, Turnstile on suspicion, per-tenant rate limits, emergency disable.
- Draft posts never get a room: the socket endpoint 404s for `published = 0`, same as the page.

### Test plan (extends the MVP list)

Room isolation between posts and tenants, submit-to-broadcast delivery, removal tombstones, reconnect catch-up after missed frames, typing aggregation without identity leaks, typing expiry, connection caps and eviction, fallback polling parity, and disabled-blog silence.

## Enablement checklist (all slices implemented)

Status: implemented behind `comments_enabled` (default off). The earlier parked-until-push-hardening note is lifted: the hardening list (owner setting, ledger, DLQ, ingress limits) has landed since.

1. Apply migrations: `069-comments.sql` and `071-comment-reports.sql` to
   `blognice-posts`; `070-tenant-comments-enabled.sql` to `blognice`.
2. Set the secret: `wrangler secret put COMMENTS_ROOM_SECRET --config
   wrangler.production.jsonc` (any long random string). Without it, rooms
   answer 503 and clients stay on 15-second polling — nothing breaks.
3. Deploy (push to main; the workflow tests, typechecks, and ships both the
   worker with the `CommentRoom` v1 migration and the staff worker).
4. Enable on a test blog first: blog admin Settings → Comments checkbox, or
   staff `POST /api/blogs/:id/comments-enabled`. Post, reply, remove, and
   restore from both surfaces; watch a second browser update live.
5. Roll out per blog. Staff keeps the platform override (`/api/blogs/:id/
   comments-enabled`) and the report queue (`/api/comment-reports`) for
   abuse waves; per-blog emergency disable is the Settings checkbox.

## Data placement and schema

Comment data lives in the POSTS database alongside posts, never in the index database. Comments are unbounded tenant content, exactly the class of data the POSTS database exists for; the index database stays small and fast for tenant resolution, sessions, and auth. Every comments query is scoped by `tenant_id`, so a future posts-shard move carries a tenant's comments with it for free.

```sql
CREATE TABLE comments (
  id          INTEGER PRIMARY KEY,
  tenant_id   INTEGER NOT NULL,              -- no cross-database FK; scoped in code like posts
  post_id     INTEGER NOT NULL,              -- the post ( drafts never accept comments; enforced in code )
  parent_id   INTEGER,                       -- NULL = top-level; otherwise the comment being replied to
  author_name TEXT    NOT NULL,              -- display name chosen at verification
  email_hash  TEXT    NOT NULL,              -- sha-256 of the verified email; the address itself is never stored
  body        TEXT    NOT NULL,              -- plain text, length-capped in code
  status      TEXT    NOT NULL DEFAULT 'approved', -- approved | removed (pending reserved for future pre-moderation)
  created_at  INTEGER NOT NULL,
  decided_at  INTEGER,                       -- when moderation approved or removed
  UNIQUE (tenant_id, post_id, id)
);
CREATE INDEX idx_comments_listing ON comments (tenant_id, post_id, status, id);
CREATE INDEX idx_comments_moderation ON comments (tenant_id, status, created_at);

CREATE TABLE comment_identities (
  tenant_id   INTEGER NOT NULL,
  email_hash  TEXT    NOT NULL,              -- matches comments.email_hash
  author_name TEXT    NOT NULL,
  token_hash  TEXT,                          -- pending verification/recovery token, NULL when none
  token_expires_at INTEGER,                  -- verification links live 24 hours
  cookie_hash TEXT,                          -- bn_comment browser cookie (sha-256), set on verify
  verified_at INTEGER,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, email_hash)
);

CREATE TABLE comment_attempts (
  tenant_id   INTEGER NOT NULL,
  email_hash  TEXT    NOT NULL,
  kind        TEXT    NOT NULL,              -- 'start' or 'submit'
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_comment_attempts ON comment_attempts (tenant_id, email_hash, created_at);
```

- `comment_attempts` doubles as the rate-limit and duplicate-detection log: count recent rows per email identity (and per tenant) before accepting; prune rows older than the rate window on write.
- Email addresses are never stored, only hashes — recovery works by re-verifying the same address, which reproduces the hash.
- Nothing comment-related goes in the index database: no comment tables, no verification tokens, no counters. Abuse scoring beyond the attempts log lives in edge memory and Durable Object state, both ephemeral.

## Threading (Disqus-style)

One self-referencing tree per post via `parent_id`. No separate threads table; nesting is a property of each comment.

- **Reply anywhere**: every comment, top-level or nested, accepts one level of reply beneath it. There is no separate quote mechanism — a reply is always attached to its parent.
- **Top-level ordering is chronological** (oldest first), matching the blog reading order. (Disqus-style Best/vote sorting is deliberately out of the MVP: no votes, no scores, no ranking.)
- **Replies are chronological** under their parent, oldest first.
- **Visual depth is capped at 4**. Replies deeper than 4 render flattened at depth 4 with an “in reply to {name}” label, exactly the Disqus convention — the tree data is unbounded, only the indentation stops.
- **Collapse**: each subtree gets a collapse toggle, persisted per browser (localStorage), so long threads stay navigable.
- **Removed parents**: if a parent is removed but has approved children, the parent renders as a tombstone (“removed by moderator”) so the replies keep their context. Childless removed comments vanish from the listing.
- **Counts**: the visible comment count includes nested replies but excludes removed leaves.
- **Realtime**: `comment-approved` frames carry `parent_id`; clients insert the node into the rendered tree (or at depth-4 flattened form). `comment-removed` tombstones in place, preserving children.
- **Pagination**: the cursor endpoint pages top-level comments (e.g. 20 per page); each top-level node arrives with its full approved subtree. Deep viral threads therefore never break pagination.
- **Validation in code**: a reply's `parent_id` must reference an approved comment on the same post and tenant; replies to `pending` or `removed` comments are rejected, as are replies to drafts (no rooms, no writes).

## Notification architecture

Browser push is opt-in and topic-based. The first topic is `new-post`; future topics can include `comment-reply`, `comment-mention`, and `moderation-result`. Each subscription should be tenant-scoped, revocable, and stored with the minimum endpoint/key material needed for delivery.

Push delivery is queued, bounded, idempotent, and removes expired subscriptions. Comment notifications should reuse the same fan-out machinery but have independent user preferences and notification reasons. A commenter should never receive a notification merely because somebody is typing.

## Capacity and safety

D1 writes should be treated as a bounded resource: edge rate limits, moderation queues, batched fan-out, pagination, and indexes come before adding realtime features. A shared primary database is reasonable for an MVP, but the tenant/shard seam should remain intact for later growth.

Tests should cover tenant isolation, verification and cookie recovery, XSS/HTML rejection, rate limits, removal/restore transitions, notification preference filtering, WebSocket reconnects, typing expiry, expired push endpoints, and emergency disable behavior.

## Review record

### Final targeted QA review

The final targeted review found no critical or high-severity issue in the supplied implementation ranges after fixes for SQL placeholder count, base64url validation, DELETE CSRF/size/topic handling, topic-aware storage, and campaign-progress deduplication. The report remained provisional because its bounded context did not include unrelated source ranges. Remaining non-blocking follow-ups are broader integration tests for tenant isolation, missing-Origin requests, browser permission states, and queue retry behavior.

### Bob — architecture/product review

Bob reviewed the implementation and returned **NEEDS CHANGES**. The direction is sound, but before production enablement Bob requires:

- Fix the missing braces around the draft-to-published browser-push trigger and backfill existing published posts so editing them cannot notify readers unexpectedly.
- Add a blog-owner enable/disable setting, defaulting off, with authenticated administration and audit coverage.
- Replace the single `last_push_campaign_id` progress marker with a durable per-campaign/per-subscription delivery ledger; document delivery as at-least-once across the external push boundary.
- Add durable campaign replay/DLQ handling and fail visibly on temporary configuration problems instead of acknowledging stranded jobs.
- Add rate limits and quotas to public subscription writes and monitor endpoint abuse.
- Harden malformed `Origin` parsing and use a `(tenant_id, topic, id)` fan-out index.

Bob also recommends future notification events carry recipient/topic/resource identity, with typing and presence structurally excluded from push delivery. These findings should be addressed before production rollout; comment implementation remains parked.

### Follow-up security review

The subsequent security and technical reviews agreed that the first release must remain disabled and undeployed until subscription ingress is bounded, push endpoints and P-256 keys are validated, outbound sends have timeouts, malformed requests count toward abuse limits, recipient failures cannot poison a whole fan-out, campaigns use publish-time snapshots, unsubscribe remains available after disablement, owner settings have Origin/CSRF protection, and retention/observability are defined. The implementation now contains the first hardening pass for these items: transient provider failures remain retryable, permanent failures are isolated per recipient, the production queue declares a DLQ, and an owner-only replay route resets unfinished delivery claims. Behavioral integration tests and final security sign-off remain before production enablement; the DLQ queue itself must also be created in the target Cloudflare account as an operational step.
