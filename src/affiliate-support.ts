export type AffiliateSupportSummary = {
  accountId: number;
  email: string;
  referralCode: string;
  status: "active" | "suspended" | "closed" | "terms_required";
  enabledAt: number;
  termsVersion: string;
  policyVersion: string;
  termsAcceptedAt: number;
  stripeConnectedAccountId: string | null;
  stripeConnectCountry: string | null;
  stripeConnectStatus: "not_started" | "onboarding" | "ready" | "restricted";
  stripeConnectPayoutsEnabled: boolean;
  attributionCount: number;
  ledgerBalanceMinor: number;
  maturedBalanceMinor: number;
  openReserveMinor: number;
  paidPayoutMinor: number;
  currency: "usd";
};

export type AffiliateSupportActivity = {
  uncommissionedOccurrences: Array<{
    id: string;
    provider: "stripe" | "nowpayments";
    providerPaymentId: string | null;
    providerInvoiceId: string | null;
    referredAccountId: number;
    currency: string;
    eligibleRevenueMinor: number;
    refundedEligibleRevenueMinor: number;
    reason: "non_usd" | "related_account";
    policyVersion: string;
    paidAt: number;
  }>;
  attributions: Array<{
    id: number;
    referredAccountId: number;
    referredEmail: string;
    source: "link" | "code";
    interactedAt: number;
    capturedAt: number;
    policyVersion: string;
  }>;
  ledgerEntries: Array<{
    id: string;
    occurrenceId: string;
    entryKind: "earning" | "refund" | "dispute_loss" | "relationship_reversal";
    provider: "stripe" | "nowpayments";
    providerPaymentId: string | null;
    referredAccountId: number;
    currency: string;
    amountMinor: number;
    availableAt: number;
    createdAt: number;
  }>;
  reserves: Array<{
    id: string;
    occurrenceId: string;
    provider: "stripe" | "nowpayments";
    disputeId: string;
    currency: string;
    amountMinor: number;
    status: "open" | "released" | "lost";
    openedAt: number;
    resolvedAt: number | null;
  }>;
  payouts: Array<{
    id: string;
    currency: string;
    amountMinor: number;
    status: "prepared" | "reconciliation" | "paid" | "cancelled";
    cutoffAt: number;
    createdAt: number;
    externalReference: string | null;
  }>;
};

export type AffiliatePayoutQueueItem = {
  payoutId: string;
  affiliateId: number;
  affiliateEmail: string;
  referralCode: string;
  amountMinor: number;
  currency: "usd";
  status: "prepared" | "reconciliation";
  createdAt: number;
  connectedAccountId: string | null;
  latestAttemptOutcome: "paid" | "ambiguous" | null;
  latestExternalReference: string | null;
  latestAttemptAt: number | null;
  latestDispatchActorSubject: string | null;
  latestDispatchReason: string | null;
  approvalCount: number;
  latestApproverSubject: string | null;
  latestApprovalReason: string | null;
  latestApprovedAt: number | null;
};

export async function getAffiliatePayoutQueueInDb(
  db: D1Database,
  status: "prepared" | "reconciliation" | "all" = "all",
): Promise<AffiliatePayoutQueueItem[]> {
  const statusFilter = status === "all" ? "payout.status IN ('prepared', 'reconciliation')" : "payout.status = ?";
  const query = db.prepare(
    `SELECT payout.id, payout.affiliate_id, account.email AS affiliate_email,
            profile.referral_code, payout.amount_minor, payout.currency, payout.status,
            payout.created_at, profile.stripe_connected_account_id,
            attempt.outcome AS latest_attempt_outcome,
            attempt.external_reference AS latest_external_reference,
            attempt.recorded_at AS latest_attempt_at,
            attempt.actor_subject AS latest_dispatch_actor_subject,
            attempt.reason AS latest_dispatch_reason,
            (SELECT COUNT(*) FROM affiliate_payout_approvals AS approval
              WHERE approval.payout_id = payout.id) AS approval_count,
            approval.actor_subject AS latest_approver_subject,
            approval.reason AS latest_approval_reason,
            approval.approved_at AS latest_approved_at
       FROM affiliate_payouts AS payout
       JOIN affiliate_profiles AS profile ON profile.account_id = payout.affiliate_id
       JOIN accounts AS account ON account.id = payout.affiliate_id
       LEFT JOIN affiliate_payout_attempts AS attempt ON attempt.id = (
         SELECT latest.id FROM affiliate_payout_attempts AS latest
          WHERE latest.payout_id = payout.id
          ORDER BY latest.recorded_at DESC, latest.id DESC LIMIT 1
       )
       LEFT JOIN affiliate_payout_approvals AS approval ON approval.rowid = (
         SELECT latest.rowid FROM affiliate_payout_approvals AS latest
          WHERE latest.payout_id = payout.id
          ORDER BY latest.approved_at DESC, latest.actor_subject DESC LIMIT 1
       )
      WHERE ${statusFilter}
      ORDER BY payout.created_at ASC, payout.id ASC LIMIT 100`,
  );
  const rows = status === "all" ? await query.all() : await query.bind(status).all();
  return (rows.results as any[]).map((row) => ({
    payoutId: row.id,
    affiliateId: row.affiliate_id,
    affiliateEmail: row.affiliate_email,
    referralCode: row.referral_code,
    amountMinor: row.amount_minor,
    currency: row.currency,
    status: row.status,
    createdAt: row.created_at,
    connectedAccountId: row.stripe_connected_account_id,
    latestAttemptOutcome: row.latest_attempt_outcome,
    latestExternalReference: row.latest_external_reference,
    latestAttemptAt: row.latest_attempt_at,
    latestDispatchActorSubject: row.latest_dispatch_actor_subject,
    latestDispatchReason: row.latest_dispatch_reason,
    approvalCount: row.approval_count,
    latestApproverSubject: row.latest_approver_subject,
    latestApprovalReason: row.latest_approval_reason,
    latestApprovedAt: row.latest_approved_at,
  }));
}

export async function getAffiliateSupportActivityInDb(
  db: D1Database,
  accountId: number,
): Promise<AffiliateSupportActivity> {
  const results = await db.batch([
    db.prepare(
      `SELECT attribution.id, attribution.referred_account_id, account.email AS referred_email,
              attribution.source, attribution.interacted_at, attribution.captured_at,
              attribution.policy_version
         FROM affiliate_attributions AS attribution
         JOIN accounts AS account ON account.id = attribution.referred_account_id
        WHERE attribution.affiliate_id = ?
        ORDER BY attribution.captured_at DESC, attribution.id DESC LIMIT 100`,
    ).bind(accountId),
    db.prepare(
      `SELECT entry.id, entry.occurrence_id, entry.entry_kind, occurrence.provider,
              occurrence.provider_payment_id, occurrence.referred_account_id,
              entry.currency, entry.amount_minor, entry.available_at, entry.created_at
         FROM affiliate_ledger_entries AS entry
         JOIN affiliate_revenue_occurrences AS occurrence ON occurrence.id = entry.occurrence_id
        WHERE entry.affiliate_id = ?
        ORDER BY entry.created_at DESC, entry.id DESC LIMIT 200`,
    ).bind(accountId),
    db.prepare(
      `SELECT id, occurrence_id, provider, dispute_id, currency, amount_minor,
              status, opened_at, resolved_at
         FROM affiliate_reserves
        WHERE affiliate_id = ?
        ORDER BY opened_at DESC, id DESC LIMIT 100`,
    ).bind(accountId),
    db.prepare(
      `SELECT payout.id, payout.currency, payout.amount_minor, payout.status,
              payout.cutoff_at, payout.created_at,
              (SELECT attempt.external_reference FROM affiliate_payout_attempts AS attempt
                WHERE attempt.payout_id = payout.id AND attempt.external_reference IS NOT NULL
                ORDER BY attempt.recorded_at DESC LIMIT 1) AS external_reference
         FROM affiliate_payouts AS payout
        WHERE payout.affiliate_id = ?
        ORDER BY payout.created_at DESC, payout.id DESC LIMIT 100`,
    ).bind(accountId),
    db.prepare(
      `SELECT occurrence.id, occurrence.provider, occurrence.provider_payment_id,
              occurrence.provider_invoice_id, occurrence.referred_account_id,
              occurrence.currency, occurrence.eligible_revenue_minor,
              occurrence.policy_version, occurrence.paid_at,
              CASE WHEN occurrence.currency != 'usd' THEN 'non_usd'
                   ELSE 'related_account' END AS reason,
              COALESCE((SELECT SUM(adjustment.refunded_eligible_revenue_minor)
                FROM affiliate_revenue_adjustments AS adjustment
                WHERE adjustment.occurrence_id = occurrence.id), 0) AS refunded_eligible_revenue_minor
         FROM affiliate_revenue_occurrences AS occurrence
        WHERE occurrence.affiliate_id = ?
          AND NOT EXISTS (SELECT 1 FROM affiliate_ledger_entries AS entry
            WHERE entry.occurrence_id = occurrence.id)
          AND (occurrence.currency != 'usd' OR EXISTS (
            SELECT 1 FROM affiliate_account_relationships AS relationship
             WHERE (relationship.affiliate_id = occurrence.affiliate_id
                    AND relationship.related_account_id = occurrence.referred_account_id)
                OR (relationship.affiliate_id = occurrence.referred_account_id
                    AND relationship.related_account_id = occurrence.affiliate_id)
          ))
        ORDER BY occurrence.paid_at DESC, occurrence.id DESC LIMIT 100`,
    ).bind(accountId),
  ]);
  return {
    uncommissionedOccurrences: (results[4].results as any[]).map((row) => ({
      id: row.id,
      provider: row.provider,
      providerPaymentId: row.provider_payment_id,
      providerInvoiceId: row.provider_invoice_id,
      referredAccountId: row.referred_account_id,
      currency: row.currency,
      eligibleRevenueMinor: row.eligible_revenue_minor,
      refundedEligibleRevenueMinor: row.refunded_eligible_revenue_minor,
      reason: row.reason,
      policyVersion: row.policy_version,
      paidAt: row.paid_at,
    })),
    attributions: (results[0].results as any[]).map((row) => ({
      id: row.id,
      referredAccountId: row.referred_account_id,
      referredEmail: row.referred_email,
      source: row.source,
      interactedAt: row.interacted_at,
      capturedAt: row.captured_at,
      policyVersion: row.policy_version,
    })),
    ledgerEntries: (results[1].results as any[]).map((row) => ({
      id: row.id,
      occurrenceId: row.occurrence_id,
      entryKind: row.entry_kind,
      provider: row.provider,
      providerPaymentId: row.provider_payment_id,
      referredAccountId: row.referred_account_id,
      currency: row.currency,
      amountMinor: row.amount_minor,
      availableAt: row.available_at,
      createdAt: row.created_at,
    })),
    reserves: (results[2].results as any[]).map((row) => ({
      id: row.id,
      occurrenceId: row.occurrence_id,
      provider: row.provider,
      disputeId: row.dispute_id,
      currency: row.currency,
      amountMinor: row.amount_minor,
      status: row.status,
      openedAt: row.opened_at,
      resolvedAt: row.resolved_at,
    })),
    payouts: (results[3].results as any[]).map((row) => ({
      id: row.id,
      currency: row.currency,
      amountMinor: row.amount_minor,
      status: row.status,
      cutoffAt: row.cutoff_at,
      createdAt: row.created_at,
      externalReference: row.external_reference,
    })),
  };
}

export async function getAffiliateSupportSummaryInDb(
  db: D1Database,
  accountId: number,
  now: number,
): Promise<AffiliateSupportSummary | null> {
  const row = await db.prepare(
    `SELECT profile.account_id, account.email, profile.referral_code, profile.status,
            profile.enabled_at, profile.stripe_connected_account_id,
            profile.stripe_connect_country, profile.stripe_connect_status,
            profile.stripe_connect_payouts_enabled,
            acceptance.terms_version, acceptance.policy_version,
            acceptance.accepted_at,
            (SELECT COUNT(*) FROM affiliate_attributions AS attribution
              WHERE attribution.affiliate_id = profile.account_id) AS attribution_count,
            COALESCE((SELECT SUM(entry.amount_minor) FROM affiliate_ledger_entries AS entry
              WHERE entry.affiliate_id = profile.account_id AND entry.currency = 'usd'), 0) AS ledger_balance_minor,
            COALESCE((SELECT SUM(entry.amount_minor) FROM affiliate_ledger_entries AS entry
              WHERE entry.affiliate_id = profile.account_id AND entry.currency = 'usd'
                AND entry.available_at <= ?
                AND NOT EXISTS (SELECT 1 FROM affiliate_payout_entries AS allocation
                  WHERE allocation.ledger_entry_id = entry.id AND allocation.released_at IS NULL)
                AND (entry.amount_minor <= 0 OR NOT EXISTS (SELECT 1 FROM affiliate_reserves AS reserve
                  WHERE reserve.occurrence_id = entry.occurrence_id AND reserve.status = 'open'))), 0) AS matured_balance_minor,
            COALESCE((SELECT SUM(reserve.amount_minor) FROM affiliate_reserves AS reserve
              WHERE reserve.affiliate_id = profile.account_id AND reserve.currency = 'usd'
                AND reserve.status = 'open'), 0) AS open_reserve_minor,
            COALESCE((SELECT SUM(payout.amount_minor) FROM affiliate_payouts AS payout
              WHERE payout.affiliate_id = profile.account_id AND payout.currency = 'usd'
                AND payout.status = 'paid'), 0) AS paid_payout_minor
       FROM affiliate_profiles AS profile
       JOIN accounts AS account ON account.id = profile.account_id
       JOIN affiliate_terms_acceptances AS acceptance ON acceptance.id = profile.terms_acceptance_id
      WHERE profile.account_id = ?`,
  ).bind(now, accountId).first<{
    account_id: number;
    email: string;
    referral_code: string;
    status: AffiliateSupportSummary["status"];
    enabled_at: number;
    stripe_connected_account_id: string | null;
    stripe_connect_country: string | null;
    stripe_connect_status: AffiliateSupportSummary["stripeConnectStatus"];
    stripe_connect_payouts_enabled: number;
    terms_version: string;
    policy_version: string;
    accepted_at: number;
    attribution_count: number;
    ledger_balance_minor: number;
    matured_balance_minor: number;
    open_reserve_minor: number;
    paid_payout_minor: number;
  }>();
  if (!row) return null;
  return {
    accountId: row.account_id,
    email: row.email,
    referralCode: row.referral_code,
    status: row.status,
    enabledAt: row.enabled_at,
    stripeConnectedAccountId: row.stripe_connected_account_id,
    stripeConnectCountry: row.stripe_connect_country,
    stripeConnectStatus: row.stripe_connect_status,
    stripeConnectPayoutsEnabled: row.stripe_connect_payouts_enabled === 1,
    termsVersion: row.terms_version,
    policyVersion: row.policy_version,
    termsAcceptedAt: row.accepted_at,
    attributionCount: row.attribution_count,
    ledgerBalanceMinor: row.ledger_balance_minor,
    maturedBalanceMinor: row.matured_balance_minor,
    openReserveMinor: row.open_reserve_minor,
    paidPayoutMinor: row.paid_payout_minor,
    currency: "usd",
  };
}
