# Could Blognice Run Without Cloudflare?

**Public author:** The Dev Team

## Draft

Blognice runs on Cloudflare Workers, D1, R2, the Cache API, Analytics Engine,
and a handful of services around them. That has been a productive foundation:
the application is close to the edge, the database and object storage are
available through Worker bindings, and deployment is pleasantly small.

But “we run on Cloudflare” is not the same as “the application can only run on
Cloudflare.” A useful engineering question is what would happen if we wanted a
second deployment target, a local installation, or simply a credible exit plan.
Could Blognice run on a Bun server?

The responsible answer is probably, but we have not demonstrated it yet. Bun
could run the
HTTP application and the JavaScript or TypeScript runtime. It would not replace
Cloudflare's global network, managed storage, queues, analytics, DNS, or
certificate automation by itself. Portability would be an exercise in replacing
platform services, not swapping one command in `package.json`.

## What Bun would give us

Bun documents a JavaScript runtime, a built-in HTTP server,
WebSocket support, a SQLite driver, a package manager, a bundler, and a test
runner. Its `Bun.serve` API accepts the same `Request` and `Response` style that
our Worker code already uses, which gives us a promising seam for an adapter—
not a drop-in replacement. Blognice also relies on Worker-specific environment
bindings, execution contexts and `waitUntil`, cache behavior, event handlers,
and isolate lifecycle. Those would need explicit interfaces and compatibility
tests. The [Bun server documentation](https://bun.sh/docs/runtime/http/server)
documents database-backed HTTP examples and deployment paths through Docker.

That means the first prototype would not need to rewrite every renderer or
route. We could extract the application core into functions that receive an
explicit environment object, then provide two entry points:

1. a Worker adapter that supplies Cloudflare bindings; and
2. a Bun adapter that supplies ordinary services such as SQLite, an S3 API,
   filesystem-backed development storage, and a job queue.

The core would know about tenants, posts, sessions, Markdown, and rendering;
adapters would handle storage, scheduling, and mail.

## The parts that are easy to move

The public HTML renderer, Markdown handling, authentication rules, API
validation, post metadata, and much of the admin UI look like good candidates
for ordinary application logic. That is a portability hypothesis, not a result
we have measured; the Worker-specific calls must first be isolated behind
interfaces and exercised under Bun.
The same is true of tests that exercise pure functions and request handlers.

The account API could continue to use bearer tokens. Sessions could remain
HTTP-only cookies backed by a database. A reverse proxy or a Bun HTTPS listener
could terminate TLS. A Docker image could package the application and its
runtime; Bun documents an official container image and a multi-stage production
build pattern in its [Docker guide](https://bun.sh/docs/guides/ecosystem/docker).

## The parts Cloudflare is quietly doing for us

Cloudflare is valuable here because several capabilities arrive as one
platform. Cloudflare describes bindings as both permissions and APIs: a Worker
can access D1, R2, Queues, AI, and other services without putting provider
credentials into application code. That convenience is a real architectural
dependency, even when the application code looks simple. See the
[Cloudflare bindings documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/).

For a Bun deployment, we would need to choose replacements deliberately:

In the production configuration, Blognice currently has two D1 bindings (`DB`
for accounts, tenants, sessions, and domains, and `POSTS` for post data), two
Analytics Engine datasets (`METRICS` and `EVENTS`), two R2 buckets (`MEDIA` and
`METRICS_ARCHIVE`), the `AI` binding, and separate `AUDIO_QUEUE`,
`EMAIL_QUEUE`, and `INDEXNOW_QUEUE` bindings. The staff Worker has its own
configuration and AI/database bindings. This inventory is a starting point for
an adapter contract; it is not a claim that each replacement has identical
semantics.

| Blognice need | Cloudflare today | Possible Bun deployment | Main trade-off |
| --- | --- | --- | --- |
| HTTP runtime | Workers | Bun.serve behind a proxy | We operate hosts, patches, scaling, and failover |
| Relational data | D1 | SQLite for one host, or Postgres for multiple writers | D1 semantics, concurrency, migrations, replication, backups, and connection pooling must be compared and operated |
| Media | R2 | S3-compatible storage or local disk | Storage credentials, lifecycle rules, and public delivery need design |
| Application cache | Workers Cache API (`caches.default`) | Redis, a process cache, or a database-backed cache | Cache API entries are data-centre-local; scope, keys, expiry, purge, and invalidation need an explicit equivalent |
| CDN/edge delivery | Cloudflare edge cache and routing | A separate CDN or reverse proxy | CDN caching, origin routing, and purge behavior need their own comparison |
| Async delivery | Queues for audio, email, and IndexNow work | Redis, a database-backed queue, or a hosted queue | Retry/backoff, at-least-once delivery, idempotency, visibility, dead letters, and concurrency become ours |
| Scheduling | Scheduled Workers for maintenance | Cron, a scheduler, or a job runner | Schedules, overlap control, retries, and observability become ours |
| Analytics | Analytics Engine | Postgres tables, ClickHouse, or an analytics service | Cost and retention decisions move into our system |
| Domains and TLS | Cloudflare DNS and certificates | DNS provider plus a proxy or ACME automation | Certificate renewal and domain onboarding become product work |
| AI image and narration jobs | Worker bindings and provider APIs | A job worker calling provider APIs | Secrets, timeouts, retries, and billing need explicit controls |

## Two plausible architectures

The smallest experiment would be a single-host Bun deployment: SQLite for the
index and posts, an S3-compatible bucket for media, and a reverse proxy in
front. A process supervisor would restart Bun, and a scheduled job would run
maintenance tasks. This could be excellent for a private Blognice installation,
an inexpensive small blog, or a development environment.

The more serious design would use Bun containers behind a load balancer,
Postgres for shared state, S3-compatible object storage, Redis or a managed
queue, and an external CDN. It could scale, but would have more moving parts
than the current Worker deployment. Choosing the components also means
operating them.

There is also a useful middle path: keep Cloudflare as the delivery and storage
platform while making the application core portable. A Bun process could run
against local adapters, while a Worker gateway or supported remote APIs expose
Cloudflare-backed services when the process is outside Workers. That gateway
would add credentials, network latency, failure modes, and attack surface; R2,
D1, Queues, AI, and Cache API behavior cannot simply be passed into an external
Bun process as if they were local bindings.

## The operations we would inherit

Self-hosting would also move platform responsibilities into our runbook. We
would need secret storage and rotation, tenant-isolation reviews, rate limits,
WAF or DDoS protection, patching, process and container isolation, structured
logs, metrics and traces, alerting, backups, point-in-time recovery, restore
drills, incident response, and a plan for capacity and failover. For custom
domains, that includes ownership verification, routing, certificate issuance
and renewal, abuse controls, and safe removal. These are not reasons the
migration is impossible; they are part of its cost.

## What we should prototype first

We should not begin by rewriting Blognice. The first experiment should answer
whether the seams are real:

- extract a small storage interface for tenants, posts, sessions, and media;
- run the public renderer and a read-only post route under `Bun.serve`;
- use a temporary SQLite database and local media directory;
- run the existing tests against the extracted core;
- measure cold start, memory, request latency, and operational steps; and
- document every behavior that is currently supplied by a Cloudflare binding.

If that prototype is clean, the next step is a draft-only admin flow. Publishing,
email delivery, custom domains, AI jobs, analytics, and maintenance scheduling
should follow one at a time. Each new adapter should have contract tests so that portability does not
quietly create a second, less-tested Blognice.

The evidence should include D1 migration and concurrency tests; backup and
restore tests; queue duplicate-delivery, timeout, retry, ordering, and
dead-letter tests; cache expiry and invalidation comparisons; custom-domain and
TLS renewal exercises; a threat model; and a cost and performance benchmark.

## The honest conclusion

Blognice could probably run without Cloudflare, but that remains a proposal
until a working prototype and contract tests exist. Bun is a credible candidate
for the application runtime, and the existing request/response shape gives us a
useful starting point. But a production migration would trade Cloudflare's integrated
edge platform for a collection of services we would need to select, secure,
monitor, back up, and pay for separately.

The best reason to explore this is not distrust of Cloudflare. It is good
architecture. If Blognice can run its core on Bun with explicit storage and job
interfaces, then Cloudflare becomes a deployment choice rather than a hidden
assumption. That makes the project easier to test, easier to self-host, and
more honest about where its real complexity lives.

## Publication notes

- This is an architecture proposal, not a completed migration.
- Validate the exact Bun APIs and provider choices before publication.
- Add a small benchmark from a real prototype if we build one.
- Keep the comparison honest about the operational work Cloudflare currently
  absorbs.
- Treat every performance, compatibility, and cost expectation as unvalidated
  until the prototype produces evidence.
