# Zuck complete-context review: browser push

Review the browser push implementation as a read-only security, reliability, and operational audit. This is a multi-pass review: do not issue PASS until every section below has been inspected. Treat omitted context as unreviewed, not as evidence of a defect.

## Required verdict

Return `PASS` or `NEEDS CHANGES`. Group confirmed findings by critical, high, medium, and low severity. For each finding include the file and line, exploit or failure scenario, and recommended fix. Separate confirmed defects from context or test gaps. Also list missing behavioral tests and the exact sections reviewed.

## Review questions

1. Subscription ingress: exact tenant resolution, owner opt-in, Origin checks, bounded JSON parsing, HMAC rate limiting, quota enforcement, endpoint allowlist, P-256/auth validation, and tenant-scoped upsert/delete.
2. Publication: idempotent first-publication detection, publish-time campaign snapshot, subscription high-water mark, and no retroactive notification.
3. Fan-out: tenant/topic scoping, delivery claim leases, idempotency, 404/410 removal, permanent versus transient error classification, queue continuation, retry exhaustion, DLQ behavior, and replay safety.
4. Operations: VAPID secret handling, queue configuration, migration ordering, cleanup retention, disabled-owner behavior, observability, and operator recovery.
5. Client behavior: service worker scope, permission handling, owner opt-in gate, unsubscribe after disablement, malformed public-key behavior, and notification click handling.
6. Tests: identify behavioral tests still needed beyond source-oriented assertions.

## Source packet map

Review every listed range, in order, across separate passes if necessary. Line numbers are from the current working tree.

- `src/index.ts:100-125` — bindings and queue types.
- `src/index.ts:530-700` — push configuration, subscription validation ingress, service worker, public key, subscribe, unsubscribe.
- `src/index.ts:1060-1105`, `1295-1320`, `1365-1395`, `2450-2485` — all publication triggers.
- `src/index.ts:3130-3150` — push queue message type.
- `src/index.ts:3450-3540` — owner settings Origin protection and campaign replay.
- `src/index.ts:4300-4380` — fan-out state machine and cleanup.
- `src/index.ts:4905-4960` — queue consumer, retry/DLQ interaction, and scheduled cleanup.
- `src/push.ts:1-120` — endpoint/key validation and provider timeout.
- `src/render.ts` — complete browser push opt-in client and service worker registration.
- `migrations/047-browser-push.sql`, `migrations/048-post-browser-push.sql`, `migrations/049-browser-push-owner-opt-in.sql` — schema and rollout state.
- `wrangler.production.jsonc` — queue consumer and DLQ configuration.
- `test/browser-push.test.mjs` — regression coverage.
- `README.md` — operational setup and safety instructions.

## Constraints

## Review results — 2026-08-11

### Zuck multi-pass review

Verdict: `NEEDS CHANGES`. The text-packet method reached the previously hidden areas, but the bridge still imposed a global context budget on individual passes, so Zuck would not issue an unqualified PASS. Confirmed or actionable findings were:

- the push fan-out currently shares `EMAIL_QUEUE` and the email-labelled DLQ;
- the replay endpoint needs the same exact Origin protection as other privileged mutations;
- replay delivery reset should express tenant correlation rather than relying only on globally unique campaign IDs;
- subscription quota admission is a count-then-upsert race under concurrent requests;
- runtime behavioral tests are still missing.

Zuck also flagged that error classification and queue recovery need explicit behavioral coverage, especially for status 0/network failures and permanent 4xx responses.

### BIG complete-context review

Verdict: `NEEDS CHANGES`. BIG confirmed no critical exploit, but recommends keeping browser push disabled and undeployed until these are addressed:

1. Create a dedicated `PUSH_QUEUE` and `blognice-push-dlq`; sharing email capacity and DLQ can delay email delivery and contaminate operational recovery.
2. Add exact canonical-admin Origin protection to campaign replay; the current empty-body POST is vulnerable to same-site sibling-subdomain CSRF when cookies are available.
3. Make the 1,000-subscription quota atomic while allowing existing subscriptions to refresh keys at capacity.
4. Treat unknown/network failures as retryable and distinguish systemic provider/configuration failures from recipient-specific dead subscriptions; preserve sanitized failure categories and campaign failure state.
5. Tenant-correlate replay delivery resets.
6. Add behavioral tests for CSRF, tenant isolation, concurrent quota admission, delivery claim concurrency, provider status classification, retry exhaustion/DLQ isolation, replay idempotency, high-water marks, and owner disablement.

BIG’s provisional positives: endpoint/P-256 validation, campaign snapshots, subscription high-water marks, and the delivery-ledger design appear sound from the complete review. No files were edited by either reviewer.

### Final implementation re-review

The reviewed fixes are implemented and validated:

- failed campaigns are terminal until explicit replay;
- every non-`404/410` 4xx is a campaign-level failure with no continuation;
- status `0`, `408`, `425`, `429`, and `5xx` remain retryable;
- push uses its own queue and DLQ;
- replay has exact-Origin protection and tenant-correlated delivery reset;
- quota admission is atomic and existing subscriptions can refresh at capacity.

BIG’s final verdict remains `NEEDS CHANGES` solely because `test/browser-push.test.mjs` is source-pattern based and does not execute the routes, D1 admission, queue state machine, concurrent claims, retry/DLQ behavior, replay, or tenant isolation. No remaining implementation defect was confirmed. Zuck’s focused pass confirmed the corrected state-machine paths but could not issue an unqualified PASS because the bridge still reports omitted context outside the supplied ranges.

### Tackleberry final security review

Verdict: `NEEDS CHANGES`. Tackleberry confirmed no remaining implementation vulnerability in the reviewed controls:

- exact Origin checks protect settings, replay, subscribe, and unsubscribe;
- replay lookup and delivery reset are tenant-correlated;
- quota admission is one SQL statement and allows existing endpoint refreshes;
- endpoint, P-256, authentication-key, VAPID-secret, queue isolation, and provider-error controls are present.

The remaining blocker is executable production-behavior coverage. The current tests do not run Worker routes, D1 operations, concurrent requests, queue messages, retries, DLQ isolation, replay, or tenant boundaries. Tackleberry recommends Worker integration tests with real D1 migrations and queue-consumer tests using mocked push-provider responses. No files were edited by the review.

### Coverage update

`src/push-state.ts` now provides production-used provider classification, and `test/browser-push.test.mjs` executes classification, quota-boundary policy, and delivery-lease policy tests. BIG correctly noted that the quota and lease helper policies alone do not prove the SQL and route behavior; they are useful unit coverage but do not replace the required Worker/D1/Queue integration suite.

Do not recommend storing secrets in source or configuration committed to Git. Do not recommend deployment or file edits as part of this review. The feature is opt-in and must remain disabled until confirmed review and runtime tests are complete.
## Final integration coverage update — 2026-08-11

The production Worker is now bundled and exercised in Miniflare with the real browser-push migrations applied to the corresponding D1 bindings. The integration suite has nine passing scenarios covering same-origin enforcement, revoke, tenant isolation, malformed provider credentials, owner disablement, quota refresh and concurrent admission, high-water fan-out, terminal endpoint/campaign outcomes, transient retry behavior, and concurrent delivery claims.

Validation: `npm run typecheck` passed; `npm test` passed with 193 tests and one Windows-only symlink skip; `git diff --check` passed. No deployment was performed.

### BIG final review

**PASS.** BIG found no remaining concrete security, reliability, or test-coverage blocker and confirmed the migration-backed integration scenarios.

### Tackleberry final review

**NEEDS CHANGES.** Tackleberry confirmed the original production-behavior blocker is substantially resolved and confirmed the new migration, queue, quota, tenant, high-water, expiry, failure, retry, and concurrent-claim coverage. It identified three remaining coverage requests: executable privileged replay-route tests (Origin, tenant isolation, idempotency), direct DLQ exhaustion/recovery verification, and replay-specific recovery behavior. These are test-coverage gaps, not newly confirmed implementation vulnerabilities.

### Zuck final review

**NEEDS CHANGES — provisional context limitation.** Zuck confirmed that the visible nine-scenario integration coverage addresses the prior blocker, but the bridge truncated the supplied packet before it could verify the full source/replay/DLQ context. This is an incomplete-context review result, not a confirmed defect.

## Replay hardening and final test update — 2026-08-11

The follow-up review found and fixed a real replay race: a duplicate replay request could reset an in-flight campaign and allow a second delivery attempt. The replay route now queues only when it atomically transitions a failed campaign to pending; repeated requests return successfully without requeueing. The integration harness now executes the privileged route with session and membership fixtures and covers exact Origin rejection, tenant isolation, duplicate replay idempotency, and concurrent delivery claims.

Validation: integration suite 10/10 passed; `npm run typecheck` passed; `npm test` passed with 194 tests and one Windows-only symlink skip; `git diff --check` passed. No deployment was performed.

Tackleberry re-review has been requested. The only previously outstanding item not directly observable through the Miniflare API is inspection of the platform-created DLQ message itself; retry exhaustion and the configured isolated `blognice-push-dlq` target remain covered by the queue configuration plus behavioral retry tests.

## Final all-team review — 2026-08-11

The final recovery changes added two safeguards: `retry-exhausted` campaigns are terminal until an explicit replay, and a failed replay queue submission restores the campaign to `failed` so it remains recoverable. The integration suite now verifies delayed duplicate messages after exhaustion, DLQ-exhaustion recovery through replay, replay idempotency, and concurrent delivery claims.

### BIG

**PASS.** No remaining concrete blocker. Confirmed both recovery fixes and the validation results.

### Tackleberry

**PASS.** Final security and recovery sign-off. Confirmed retry exhaustion, DLQ recovery, replay queue-send recovery, queue isolation, tenant isolation, Origin protection, quota concurrency, validation, high-water marks, and claim concurrency.

### Zuck

**NEEDS CHANGES — provisional context limitation.** Zuck’s bridge review again truncated the source packet before the relevant ranges and therefore withheld a qualified PASS. It reported no confirmed defect in the visible helper code; this is a tooling/context-budget limitation rather than a finding against the implementation.

Final validation: integration 11/11 passed; `npm run typecheck` passed; `npm test` passed with 195 tests and one Windows-only symlink skip; `git diff --check` passed. No deployment or commit was performed.
