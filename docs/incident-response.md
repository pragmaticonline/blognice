# Incident response

Use this runbook for security, privacy, availability, data-integrity, billing,
affiliate, or deployment incidents. The incident lead owns the timeline and
decision log; a second person reviews financial or destructive recovery actions.

## Severity and first response

- **SEV-1:** Active security/privacy exposure, incorrect money movement,
  widespread outage, or destructive data loss. Stop the affected operation,
  disable affiliate experiments and payout dispatch where relevant, preserve
  evidence, and notify the accountable operator immediately.
- **SEV-2:** Material customer journey failure or bounded integrity issue with
  no active exposure. Contain it, identify affected tenants/accounts, and set a
  review time.
- **SEV-3:** Degraded or recoverable behavior with a safe workaround. Record,
  monitor, and repair through the normal release path.

Record UTC detection time, reporter, affected Workers/routes/tenants, last known
good deployment, current Cloudflare deployment IDs, migrations recently
applied, queue backlogs/DLQs, provider event IDs, and every intervention. Keep
tokens, post bodies, customer identity, and raw provider payloads out of shared
incident notes.

## Containment

1. Confirm impact with read-only queries and logs. Separate application failure
   from Cloudflare, Stripe, MailNice, NOWPayments, Dynadot, or push-provider
   failure.
2. Freeze the smallest unsafe surface: pause an experiment, stop payout
   dispatch, disable a provider integration, or route back to a known-good
   Worker. Preserve webhook ingestion when possible so events can be replayed.
3. Snapshot both D1 databases before corrective data work. Export relevant
   Analytics Engine aggregates and record R2/queue state where useful.
4. Require independent review for SQL corrections, credential rotation,
   customer deletion, entitlement changes, commission adjustments, and payout
   reconciliation.

## Recovery and verification

For code regressions, redeploy the last known-good commit with the unchanged
production configs. D1 migrations are forward-only: restore a verified backup
to a controlled target or apply a separately reviewed corrective migration.
Reconcile asynchronous boundaries by durable event/idempotency identity rather
than replaying requests blindly.

Before resolving the incident, verify the affected journey end to end, inspect
queues and DLQs, confirm scheduled work, reconcile financial/provider state,
and monitor error rates after traffic resumes. Record customer notification and
regulatory decisions with their owner and deadline.

## Closeout

Within the agreed review window, write a blameless summary containing impact,
timeline, root cause, contributing controls, detection gap, recovery evidence,
and owned follow-ups. Update tests, monitoring, runbooks, and deployment gates
before marking preventive work complete.
