# D1 restore drill

Run this drill at least quarterly and before relying on a materially changed
backup process. It verifies recovery in disposable resources; it never restores
over live production databases.

1. Record the drill owner, UTC start, source backup timestamps, expected RPO and
   RTO, and the production schema/migration version.
2. Create disposable index and posts databases with unmistakably non-production
   names. Import the selected backups into them.
3. Bind a disposable Worker configuration to the restored databases and
   isolated R2/queue resources. Keep production routes, provider credentials,
   email, push, indexing, payouts, and webhooks disabled.
4. Compare required tables, columns, indexes, and representative row counts with
   the expected schema. Verify accounts-to-tenants membership, tenant shard
   routing, posts/pages isolation, billing entitlements, affiliate ledger
   invariants, and migration history evidence.
5. Run read-only smoke journeys for login, blog listing, posts, pages, staff
   lookup, and affiliate reporting. Exercise a write only with synthetic drill
   data.
6. Record achieved RPO/RTO, discrepancies, failed assumptions, evidence links,
   and owners/dates for corrective work. A drill passes only when both databases
   restore together and the tested journeys use the restored state.
7. Delete the disposable Worker, routes, queues, buckets, and databases after
   evidence is retained according to policy.

R2 object recovery and provider reconciliation are separate exercises. Add them
to the drill whenever the incident model requires media, narration, webhook, or
financial recovery rather than D1-only recovery.
