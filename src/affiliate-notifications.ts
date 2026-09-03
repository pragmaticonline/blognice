import { affiliateConnectReadyEmail, affiliateConnectRestrictedEmail, affiliateEnrollmentEmail, affiliatePayoutCancelledEmail, affiliatePayoutSentEmail, affiliateTermsRequiredEmail } from "./email";

export type AffiliateEmailJob = {
  kind: "email-delivery";
  emailKind: "affiliate-enrolled" | "affiliate-terms-required" | "affiliate-connect-ready" | "affiliate-connect-restricted" | "affiliate-payout-sent" | "affiliate-payout-cancelled";
  idempotencyKey: string;
  to: string;
  subject: string;
  plainText: string;
  html: string;
};

type EmailQueue = { send(body: AffiliateEmailJob): Promise<unknown> };

export async function enqueueAffiliateEnrollmentEmailInDb(
  db: D1Database,
  affiliateId: number,
  createdAt: number,
): Promise<{ enqueued: boolean }> {
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO affiliate_email_outbox
       (idempotency_key, affiliate_id, payout_id, kind, status, created_at)
     SELECT 'affiliate-enrolled:' || profile.account_id, profile.account_id, NULL,
            'affiliate-enrolled', 'pending', ?
       FROM affiliate_profiles AS profile WHERE profile.account_id = ?`,
  ).bind(createdAt, affiliateId).run();
  return { enqueued: inserted.meta.changes === 1 };
}

export async function relayAffiliateEmailOutboxInDb(
  db: D1Database,
  queue: EmailQueue,
  limit = 50,
): Promise<{ queued: number }> {
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const claimedAt = Math.floor(Date.now() / 1000);
  await db.prepare(
    "UPDATE affiliate_email_outbox SET status = 'pending', queued_at = NULL WHERE status = 'processing' AND queued_at < ?",
  ).bind(claimedAt - 300).run();
  const pending = await db.prepare(
    `SELECT outbox.idempotency_key, outbox.kind, payout.id AS payout_id,
            payout.amount_minor, payout.currency, account.email, profile.referral_code,
            COALESCE(reconciliation.external_reference, attempt.external_reference) AS transfer_id
       FROM affiliate_email_outbox AS outbox
       JOIN accounts AS account ON account.id = outbox.affiliate_id
       JOIN affiliate_profiles AS profile ON profile.account_id = outbox.affiliate_id
       LEFT JOIN affiliate_payouts AS payout ON payout.id = outbox.payout_id
       LEFT JOIN affiliate_payout_reconciliations AS reconciliation
         ON reconciliation.payout_id = payout.id AND reconciliation.decision = 'confirm_paid'
       LEFT JOIN affiliate_payout_attempts AS attempt ON attempt.id = (
         SELECT latest.id FROM affiliate_payout_attempts AS latest
          WHERE latest.payout_id = payout.id AND latest.outcome = 'paid'
          ORDER BY latest.recorded_at DESC, latest.id DESC LIMIT 1
       )
      WHERE outbox.status = 'pending'
        AND (outbox.kind IN ('affiliate-enrolled', 'affiliate-terms-required', 'affiliate-connect-ready', 'affiliate-connect-restricted', 'affiliate-payout-cancelled') OR payout.status = 'paid')
      ORDER BY outbox.created_at, outbox.idempotency_key LIMIT ?`,
  ).bind(boundedLimit).all<{
    idempotency_key: string;
    kind: AffiliateEmailJob["emailKind"];
    payout_id: string | null;
    amount_minor: number | null;
    currency: string | null;
    email: string;
    referral_code: string;
    transfer_id: string | null;
  }>();
  let queued = 0;
  for (const row of pending.results) {
    const claimed = await db.prepare(
      "UPDATE affiliate_email_outbox SET status = 'processing', queued_at = ? WHERE idempotency_key = ? AND status = 'pending'",
    ).bind(claimedAt, row.idempotency_key).run();
    if (claimed.meta.changes !== 1) continue;
    const message = row.kind === "affiliate-enrolled"
      ? affiliateEnrollmentEmail({ referralCode: row.referral_code, dashboardUrl: "https://www.blognice.com/admin/affiliate" })
      : row.kind === "affiliate-terms-required"
        ? affiliateTermsRequiredEmail({ dashboardUrl: "https://www.blognice.com/admin/affiliate" })
      : row.kind === "affiliate-connect-ready"
        ? affiliateConnectReadyEmail({ dashboardUrl: "https://www.blognice.com/admin/affiliate" })
      : row.kind === "affiliate-connect-restricted"
        ? affiliateConnectRestrictedEmail({ dashboardUrl: "https://www.blognice.com/admin/affiliate" })
      : row.kind === "affiliate-payout-cancelled" && row.amount_minor != null && row.currency
        ? affiliatePayoutCancelledEmail({ amountMinor: row.amount_minor, currency: row.currency, dashboardUrl: "https://www.blognice.com/admin/affiliate" })
      : row.transfer_id && row.amount_minor != null && row.currency
        ? affiliatePayoutSentEmail({ amountMinor: row.amount_minor, currency: row.currency, transferId: row.transfer_id })
        : null;
    if (!message) {
      await db.prepare("UPDATE affiliate_email_outbox SET status = 'pending', queued_at = NULL WHERE idempotency_key = ? AND status = 'processing'")
        .bind(row.idempotency_key).run();
      continue;
    }
    try {
      await queue.send({
        kind: "email-delivery",
        emailKind: row.kind,
        idempotencyKey: row.idempotency_key,
        to: row.email,
        ...message,
      });
    } catch (error) {
      await db.prepare("UPDATE affiliate_email_outbox SET status = 'pending', queued_at = NULL WHERE idempotency_key = ? AND status = 'processing'")
        .bind(row.idempotency_key).run();
      throw error;
    }
    const updated = await db.prepare(
      "UPDATE affiliate_email_outbox SET status = 'queued', queued_at = ? WHERE idempotency_key = ? AND status = 'processing'",
    ).bind(Math.floor(Date.now() / 1000), row.idempotency_key).run();
    if (updated.meta.changes === 1) queued += 1;
  }
  return { queued };
}
