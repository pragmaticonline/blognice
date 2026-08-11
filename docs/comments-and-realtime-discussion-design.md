# Comments and realtime discussion design

This document parks the discussion-system ideas while Blognice starts with a smaller, useful first step: opt-in browser notifications for new blog posts.

## Product direction

Blognice should support active, moderated discussions without making the first release dependent on realtime infrastructure. The source of truth remains ordinary HTTP reads and writes; realtime delivery is an enhancement.

## Proposed comment MVP

- A commenter verifies an email address before their first comment.
- A secure, scoped browser cookie lets the same browser submit later comments without repeating verification.
- A profile is tied to a tenant and a privacy-preserving email identity, so the commenter can recover access if the cookie is lost.
- Comments are plain text initially. No arbitrary HTML, links, attachments, or embedded media.
- New comments are moderated before publication, with per-tenant rate limits, duplicate detection, abuse reporting, and an emergency disable switch.
- Turnstile or an equivalent challenge is applied to suspicious/high-volume submissions, not as an always-on barrier.
- The design must include deletion, retention, export/access handling, and accessible keyboard/screen-reader flows.

## Rendering and realtime

The initial page should server-render approved comments for fast first paint and accessibility. JavaScript can load additional comments with a cursor.

Later, a Durable Object room per post can provide WebSockets for approved-comment events and presence. The Durable Object is coordination, not the database of record. Typing indicators are ephemeral, debounced, rate-limited, and expire automatically; they should never be written to D1 or sent as push notifications. An aggregate “Someone is writing” indicator is preferable to exposing individual activity.

## Notification architecture

Browser push is opt-in and topic-based. The first topic is `new-post`; future topics can include `comment-reply`, `comment-mention`, and `moderation-result`. Each subscription should be tenant-scoped, revocable, and stored with the minimum endpoint/key material needed for delivery.

Push delivery is queued, bounded, idempotent, and removes expired subscriptions. Comment notifications should reuse the same fan-out machinery but have independent user preferences and notification reasons. A commenter should never receive a notification merely because somebody is typing.

## Capacity and safety

D1 writes should be treated as a bounded resource: edge rate limits, moderation queues, batched fan-out, pagination, and indexes come before adding realtime features. A shared primary database is reasonable for an MVP, but the tenant/shard seam should remain intact for later growth.

Tests should cover tenant isolation, verification and cookie recovery, XSS/HTML rejection, rate limits, moderation transitions, notification preference filtering, WebSocket reconnects, typing expiry, expired push endpoints, and emergency disable behavior.

## Review record

### Zuck — final targeted QA review

Zuck found no critical or high-severity issue in the supplied implementation ranges after fixes for SQL placeholder count, base64url validation, DELETE CSRF/size/topic handling, topic-aware storage, and campaign-progress deduplication. The report remained provisional because the read-only bridge bounded context and did not include unrelated source ranges. Remaining non-blocking follow-ups are broader integration tests for tenant isolation, missing-Origin requests, browser permission states, and queue retry behavior.

### BIG — architecture/product review

BIG reviewed the implementation and returned **NEEDS CHANGES**. The direction is sound, but before production enablement BIG requires:

- Fix the missing braces around the draft-to-published browser-push trigger and backfill existing published posts so editing them cannot notify readers unexpectedly.
- Add a blog-owner enable/disable setting, defaulting off, with authenticated administration and audit coverage.
- Replace the single `last_push_campaign_id` progress marker with a durable per-campaign/per-subscription delivery ledger; document delivery as at-least-once across the external push boundary.
- Add durable campaign replay/DLQ handling and fail visibly on temporary configuration problems instead of acknowledging stranded jobs.
- Add rate limits and quotas to public subscription writes and monitor endpoint abuse.
- Harden malformed `Origin` parsing and use a `(tenant_id, topic, id)` fan-out index.

BIG also recommends future notification events carry recipient/topic/resource identity, with typing and presence structurally excluded from push delivery. These findings should be addressed before production rollout; comment implementation remains parked.

### Follow-up security review

Tackleberry, Zuck, and BIG subsequently agreed that the first release must remain disabled and undeployed until subscription ingress is bounded, push endpoints and P-256 keys are validated, outbound sends have timeouts, malformed requests count toward abuse limits, recipient failures cannot poison a whole fan-out, campaigns use publish-time snapshots, unsubscribe remains available after disablement, owner settings have Origin/CSRF protection, and retention/observability are defined. The implementation now contains the first hardening pass for these items: transient provider failures remain retryable, permanent failures are isolated per recipient, the production queue declares a DLQ, and an owner-only replay route resets unfinished delivery claims. Behavioral integration tests and final security sign-off remain before production enablement; the DLQ queue itself must also be created in the target Cloudflare account as an operational step.
