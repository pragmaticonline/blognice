export type ReferralCandidate = {
  affiliateId: number;
  source: "link" | "code";
  interactedAt: number;
  policyVersion?: string;
};

export type ReferralAccountState = {
  accountId: number;
  attributionId: number | null;
  eligibilityClosedAt: number | null;
};

export type ReferralPolicy = {
  attributionWindowSeconds: number;
};

export type CaptureReferralResult =
  | {
      accepted: true;
      attribution: {
        affiliateId: number;
        referredAccountId: number;
        source: "link" | "code";
        interactedAt: number;
        capturedAt: number;
      };
    }
  | { accepted: false; reason: "interaction_expired" | "already_attributed" | "eligibility_closed" | "related_account" | "self_referral" };

export function captureReferral(
  candidate: ReferralCandidate,
  account: ReferralAccountState,
  policy: ReferralPolicy,
  now: number,
): CaptureReferralResult {
  if (candidate.affiliateId === account.accountId) {
    return { accepted: false, reason: "self_referral" };
  }
  if (account.attributionId !== null) {
    return { accepted: false, reason: "already_attributed" };
  }
  if (account.eligibilityClosedAt !== null) {
    return { accepted: false, reason: "eligibility_closed" };
  }
  if (now - candidate.interactedAt >= policy.attributionWindowSeconds) {
    return { accepted: false, reason: "interaction_expired" };
  }
  return {
    accepted: true,
    attribution: {
      affiliateId: candidate.affiliateId,
      referredAccountId: account.accountId,
      source: candidate.source,
      interactedAt: candidate.interactedAt,
      capturedAt: now,
    },
  };
}

export async function captureReferralInDb(
  db: D1Database,
  candidate: ReferralCandidate,
  account: ReferralAccountState,
  policy: ReferralPolicy,
  now: number,
): Promise<CaptureReferralResult> {
  const decision = captureReferral(candidate, account, policy, now);
  if (!decision.accepted) return decision;

  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO affiliate_attributions
       (referred_account_id, affiliate_id, source, interacted_at, captured_at, policy_version)
     SELECT ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM accounts
         WHERE id = ? AND affiliate_eligibility_closed_at IS NULL
      )
       AND NOT EXISTS (
         SELECT 1 FROM affiliate_account_relationships
          WHERE (affiliate_id = ? AND related_account_id = ?)
             OR (affiliate_id = ? AND related_account_id = ?)
       )`,
  ).bind(
    account.accountId,
    candidate.affiliateId,
    candidate.source,
    candidate.interactedAt,
    now,
    candidate.policyVersion || "affiliate-1",
    account.accountId,
    candidate.affiliateId,
    account.accountId,
    account.accountId,
    candidate.affiliateId,
  ).run();

  if (inserted.meta.changes === 1) return decision;
  const existing = await db.prepare(
    "SELECT id FROM affiliate_attributions WHERE referred_account_id = ?",
  ).bind(account.accountId).first();
  if (existing) return { accepted: false, reason: "already_attributed" };
  const related = await db.prepare(
    `SELECT 1 FROM affiliate_account_relationships
      WHERE (affiliate_id = ? AND related_account_id = ?)
         OR (affiliate_id = ? AND related_account_id = ?)`,
  ).bind(candidate.affiliateId, account.accountId, account.accountId, candidate.affiliateId).first();
  if (related) return { accepted: false, reason: "related_account" };
  return { accepted: false, reason: "eligibility_closed" };
}

export type AffiliateAccountRelationship = {
  affiliateId: number;
  relatedAccountId: number;
  relationshipKind: "same_person" | "same_organization" | "controlled_account";
  actorSubject: string;
  actorRole: "admin";
  reason: string;
  recordedAt: number;
};

export async function recordAffiliateAccountRelationshipInDb(
  db: D1Database,
  relationship: AffiliateAccountRelationship,
): Promise<{ recorded: boolean }> {
  const results = await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO affiliate_account_relationships
       (affiliate_id, related_account_id, relationship_kind, actor_subject,
        actor_role, reason, recorded_at)
     SELECT affiliate.id, related.id, ?, ?, ?, ?, ?
       FROM accounts AS affiliate, accounts AS related
      WHERE affiliate.id = ? AND related.id = ? AND affiliate.id != related.id
        AND NOT EXISTS (
          SELECT 1 FROM affiliate_account_relationships AS existing
           WHERE (existing.affiliate_id = affiliate.id
                  AND existing.related_account_id = related.id)
              OR (existing.affiliate_id = related.id
                  AND existing.related_account_id = affiliate.id)
        )`,
    ).bind(
      relationship.relationshipKind,
      relationship.actorSubject,
      relationship.actorRole,
      relationship.reason,
      relationship.recordedAt,
      relationship.affiliateId,
      relationship.relatedAccountId,
    ),
    db.prepare(
      `UPDATE affiliate_profiles SET status = 'suspended'
        WHERE account_id IN (?, ?) AND status IN ('active', 'terms_required')
          AND EXISTS (
            SELECT 1 FROM affiliate_account_relationships
             WHERE affiliate_id = ? AND related_account_id = ?
          )`,
    ).bind(
      relationship.affiliateId,
      relationship.relatedAccountId,
      relationship.affiliateId,
      relationship.relatedAccountId,
    ),
    db.prepare(
      `INSERT OR IGNORE INTO affiliate_relationship_reversals
         (id, occurrence_id, relationship_affiliate_id, related_account_id,
          commission_reversal_minor, recorded_at)
       SELECT lower(hex(randomblob(16))), occurrence.id, ?, ?,
              -SUM(entry.amount_minor), ?
         FROM affiliate_revenue_occurrences AS occurrence
         JOIN affiliate_ledger_entries AS entry ON entry.occurrence_id = occurrence.id
        WHERE ((occurrence.affiliate_id = ? AND occurrence.referred_account_id = ?)
            OR (occurrence.affiliate_id = ? AND occurrence.referred_account_id = ?))
          AND EXISTS (
            SELECT 1 FROM affiliate_account_relationships
             WHERE affiliate_id = ? AND related_account_id = ?
          )
       GROUP BY occurrence.id
       HAVING SUM(entry.amount_minor) > 0`,
    ).bind(
      relationship.affiliateId,
      relationship.relatedAccountId,
      relationship.recordedAt,
      relationship.affiliateId,
      relationship.relatedAccountId,
      relationship.relatedAccountId,
      relationship.affiliateId,
      relationship.affiliateId,
      relationship.relatedAccountId,
    ),
    db.prepare(
      `INSERT OR IGNORE INTO affiliate_ledger_entries
         (id, occurrence_id, adjustment_id, dispute_loss_id,
          relationship_reversal_id, entry_kind, affiliate_id, currency,
          amount_minor, available_at, created_at)
       SELECT lower(hex(randomblob(16))), reversal.occurrence_id, NULL, NULL,
              reversal.id, 'relationship_reversal', occurrence.affiliate_id,
              occurrence.currency, reversal.commission_reversal_minor,
              reversal.recorded_at, reversal.recorded_at
         FROM affiliate_relationship_reversals AS reversal
         JOIN affiliate_revenue_occurrences AS occurrence
           ON occurrence.id = reversal.occurrence_id
        WHERE reversal.relationship_affiliate_id = ?
          AND reversal.related_account_id = ?
          AND reversal.recorded_at = ?`,
    ).bind(
      relationship.affiliateId,
      relationship.relatedAccountId,
      relationship.recordedAt,
    ),
  ]);
  return { recorded: results[0].meta.changes === 1 };
}

export async function closeAttributionOpportunityInDb(
  db: D1Database,
  accountId: number,
  closedAt: number,
): Promise<{ closedAt: number }> {
  await db.prepare(
    `UPDATE accounts
        SET affiliate_eligibility_closed_at = COALESCE(affiliate_eligibility_closed_at, ?)
      WHERE id = ?`,
  ).bind(closedAt, accountId).run();
  const account = await db.prepare(
    "SELECT affiliate_eligibility_closed_at AS closed_at FROM accounts WHERE id = ?",
  ).bind(accountId).first<{ closed_at: number }>();
  if (!account) throw new Error("Affiliate attribution account was not found.");
  return { closedAt: account.closed_at };
}

export type CheckoutAttribution = {
  attributionId: number;
  affiliateId: number;
  policyVersion: string;
  stripePromotionCodeId: string | null;
};

export async function beginCheckoutAttributionInDb(
  db: D1Database,
  accountId: number,
  startedAt: number,
): Promise<{ attribution: CheckoutAttribution | null; closedAt: number }> {
  const results = await db.batch([
    db.prepare(
      `UPDATE accounts
          SET affiliate_eligibility_closed_at = COALESCE(affiliate_eligibility_closed_at, ?)
        WHERE id = ?`,
    ).bind(startedAt, accountId),
    db.prepare(
      `SELECT account.affiliate_eligibility_closed_at AS closed_at,
              attribution.id AS attribution_id,
              attribution.affiliate_id,
              attribution.policy_version,
              profile.account_id AS active_affiliate_id,
              profile.stripe_promotion_code_id
         FROM accounts AS account
         LEFT JOIN affiliate_attributions AS attribution
           ON attribution.referred_account_id = account.id
         LEFT JOIN affiliate_profiles AS profile
           ON profile.account_id = attribution.affiliate_id AND profile.status = 'active'
        WHERE account.id = ?`,
    ).bind(accountId),
  ]);
  const row = results[1].results[0] as {
    closed_at: number;
    attribution_id: number | null;
    affiliate_id: number | null;
    policy_version: string | null;
    active_affiliate_id: number | null;
    stripe_promotion_code_id: string | null;
  } | undefined;
  if (!row) throw new Error("Affiliate checkout account was not found.");
  const attribution = row.attribution_id !== null && row.affiliate_id !== null
    && row.policy_version !== null && row.active_affiliate_id !== null
    ? {
        attributionId: row.attribution_id,
        affiliateId: row.affiliate_id,
        policyVersion: row.policy_version,
        stripePromotionCodeId: row.stripe_promotion_code_id,
      }
    : null;
  return { attribution, closedAt: row.closed_at };
}

export type EnableAffiliateProfileInput = {
  accountId: number;
  referralCode: string;
  termsVersion: string;
  termsDocumentDigest: string;
  policyVersion: string;
  acceptedAt: number;
};

export async function enableAffiliateProfileInDb(
  db: D1Database,
  input: EnableAffiliateProfileInput,
): Promise<{ enabled: true; status: "active"; referralCode: string }> {
  const acceptanceId = crypto.randomUUID();
  await db.batch([
    db.prepare(
      `INSERT INTO affiliate_terms_acceptances
         (id, account_id, terms_version, terms_document_digest, policy_version, accepted_at)
       SELECT ?, id, ?, ?, ?, ? FROM accounts
        WHERE id = ? AND status = 'active' AND email_verified = 1`,
    ).bind(
      acceptanceId,
      input.termsVersion,
      input.termsDocumentDigest,
      input.policyVersion,
      input.acceptedAt,
      input.accountId,
    ),
    db.prepare(
      `INSERT INTO affiliate_profiles
         (account_id, referral_code, status, terms_acceptance_id, enabled_at)
       SELECT account_id, ?, 'active', id, ?
         FROM affiliate_terms_acceptances WHERE id = ?`,
    ).bind(input.referralCode, input.acceptedAt, acceptanceId),
  ]);
  const profile = await db.prepare(
    "SELECT status, referral_code FROM affiliate_profiles WHERE account_id = ?",
  ).bind(input.accountId).first<{ status: "active"; referral_code: string }>();
  if (!profile) throw new Error("Affiliate Profile could not be enabled.");
  return { enabled: true, status: profile.status, referralCode: profile.referral_code };
}

export async function requireCurrentAffiliateTermsInDb(
  db: D1Database,
  input: { accountId: number; termsVersion: string; policyVersion: string; requiredAt: number },
): Promise<{ required: boolean }> {
  const results = await db.batch([
    db.prepare(`UPDATE affiliate_profiles AS profile SET status = 'terms_required'
      WHERE profile.account_id = ? AND profile.status = 'active'
        AND EXISTS (
          SELECT 1 FROM affiliate_terms_acceptances AS acceptance
           WHERE acceptance.id = profile.terms_acceptance_id
             AND (acceptance.terms_version != ? OR acceptance.policy_version != ?)
        )`).bind(input.accountId, input.termsVersion, input.policyVersion),
    db.prepare(`INSERT OR IGNORE INTO affiliate_email_outbox
        (idempotency_key, affiliate_id, payout_id, kind, status, created_at)
      SELECT 'affiliate-terms-required:' || profile.account_id || ':' || ? || ':' || ?,
             profile.account_id, NULL, 'affiliate-terms-required', 'pending', ?
        FROM affiliate_profiles AS profile
       WHERE profile.account_id = ? AND profile.status = 'terms_required'`)
      .bind(input.termsVersion, input.policyVersion, input.requiredAt, input.accountId),
  ]);
  return { required: results[0].meta.changes === 1 };
}

export async function requireOutdatedAffiliateTermsInDb(
  db: D1Database,
  input: { termsVersion: string; policyVersion: string; requiredAt: number },
): Promise<{ requiredCount: number }> {
  const results = await db.batch([
    db.prepare(`UPDATE affiliate_profiles AS profile SET status = 'terms_required'
      WHERE profile.status = 'active'
        AND EXISTS (
          SELECT 1 FROM affiliate_terms_acceptances AS acceptance
           WHERE acceptance.id = profile.terms_acceptance_id
             AND (acceptance.terms_version != ? OR acceptance.policy_version != ?)
        )`).bind(input.termsVersion, input.policyVersion),
    db.prepare(`INSERT OR IGNORE INTO affiliate_email_outbox
        (idempotency_key, affiliate_id, payout_id, kind, status, created_at)
      SELECT 'affiliate-terms-required:' || profile.account_id || ':' || ? || ':' || ?,
             profile.account_id, NULL, 'affiliate-terms-required', 'pending', ?
        FROM affiliate_profiles AS profile
       WHERE profile.status = 'terms_required'`)
      .bind(input.termsVersion, input.policyVersion, input.requiredAt),
  ]);
  return { requiredCount: results[0].meta.changes };
}

export async function reacceptAffiliateTermsInDb(
  db: D1Database,
  input: Omit<EnableAffiliateProfileInput, "referralCode">,
): Promise<{ accepted: boolean; status: "active" | "suspended" | "closed" | "terms_required" }> {
  const acceptanceId = crypto.randomUUID();
  const results = await db.batch([
    db.prepare(
      `INSERT INTO affiliate_terms_acceptances
         (id, account_id, terms_version, terms_document_digest, policy_version, accepted_at)
       SELECT ?, profile.account_id, ?, ?, ?, ?
         FROM affiliate_profiles AS profile
         JOIN accounts AS account ON account.id = profile.account_id
        WHERE profile.account_id = ? AND profile.status = 'terms_required'
          AND account.status = 'active' AND account.email_verified = 1`,
    ).bind(
      acceptanceId, input.termsVersion, input.termsDocumentDigest,
      input.policyVersion, input.acceptedAt, input.accountId,
    ),
    db.prepare(
      `UPDATE affiliate_profiles SET terms_acceptance_id = ?, status = 'active'
        WHERE account_id = ? AND status = 'terms_required'
          AND EXISTS (SELECT 1 FROM affiliate_terms_acceptances WHERE id = ?)`,
    ).bind(acceptanceId, input.accountId, acceptanceId),
  ]);
  if (results[1].meta.changes === 1) return { accepted: true, status: "active" };
  const profile = await db.prepare(
    "SELECT status FROM affiliate_profiles WHERE account_id = ?",
  ).bind(input.accountId).first<{ status: "active" | "suspended" | "closed" | "terms_required" }>();
  return { accepted: false, status: profile?.status || "terms_required" };
}

export async function attachStripePromotionCodeInDb(
  db: D1Database,
  input: { accountId: number; promotionCodeId: string },
): Promise<{ attached: boolean }> {
  const updated = await db.prepare(
    `UPDATE OR IGNORE affiliate_profiles
        SET stripe_promotion_code_id = ?
      WHERE account_id = ? AND status = 'active'
        AND stripe_promotion_code_id IS NULL`,
  ).bind(input.promotionCodeId, input.accountId).run();
  return { attached: updated.meta.changes === 1 };
}

export type NormalizedRevenueOccurrence = {
  provider: "stripe" | "nowpayments";
  currency: string;
  eligibleRevenueMinor: number;
  processingFeeMinor: number;
  commissionRateNumerator: number;
  commissionRateDenominator: number;
  paidAt: number;
  maturationSeconds: number;
};

export function affiliateAnnualPriceMinor(hasAttribution: boolean, standardPriceMinor: number): number {
  if (!Number.isSafeInteger(standardPriceMinor) || standardPriceMinor < 0) {
    throw new Error("Annual price must be a non-negative integer minor-unit amount.");
  }
  return hasAttribution ? Math.round(standardPriceMinor * 9 / 10) : standardPriceMinor;
}

export type RecognizedRevenue = {
  eligibleRevenueMinor: number;
  commissionMinor: number;
  availableAt: number;
  commissionRateNumerator: number;
  commissionRateDenominator: number;
};

export function recognizeRevenue(
  occurrence: NormalizedRevenueOccurrence,
): RecognizedRevenue {
  const commissionMinor = occurrence.currency === "usd" ? Math.floor(
    (occurrence.eligibleRevenueMinor * occurrence.commissionRateNumerator
      + occurrence.commissionRateDenominator / 2)
      / occurrence.commissionRateDenominator,
  ) : 0;

  return {
    eligibleRevenueMinor: occurrence.eligibleRevenueMinor,
    commissionMinor,
    availableAt: occurrence.paidAt + occurrence.maturationSeconds,
    commissionRateNumerator: occurrence.commissionRateNumerator,
    commissionRateDenominator: occurrence.commissionRateDenominator,
  };
}

export type PersistedRevenueOccurrence = NormalizedRevenueOccurrence & {
  sourceKey: string;
  providerPaymentId: string | null;
  providerInvoiceId: string | null;
  providerLineId: string | null;
  affiliateId: number;
  referredAccountId: number;
  attributionId: number;
  cadence: "monthly" | "annual";
  policyVersion: string;
  serviceStartAt?: number;
  serviceEndAt?: number;
};

export type AffiliatePaymentContext = {
  affiliateId: number;
  referredAccountId: number;
  attributionId: number;
  policyVersion: string;
  commissionRateNumerator: number;
  commissionRateDenominator: number;
  maturationSeconds: number;
};

export type StripeAffiliatePayment = {
  invoiceId: string;
  paymentId: string;
  currency: "usd";
  paidAt: number;
  processingFeeMinor: number;
  line: {
    id: string;
    priceId: string;
    cadence: "monthly" | "annual";
    discountedAmountExcludingTaxMinor: number;
    serviceStartAt: number;
    serviceEndAt: number;
  };
};

export function normalizeStripeAffiliatePayment(
  payment: StripeAffiliatePayment,
  context: AffiliatePaymentContext,
): PersistedRevenueOccurrence {
  return {
    provider: "stripe",
    sourceKey: `invoice:${payment.invoiceId}:line:${payment.line.id}`,
    providerPaymentId: payment.paymentId,
    providerInvoiceId: payment.invoiceId,
    providerLineId: payment.line.id,
    affiliateId: context.affiliateId,
    referredAccountId: context.referredAccountId,
    attributionId: context.attributionId,
    cadence: payment.line.cadence,
    currency: payment.currency,
    eligibleRevenueMinor: payment.line.discountedAmountExcludingTaxMinor,
    processingFeeMinor: payment.processingFeeMinor,
    policyVersion: context.policyVersion,
    commissionRateNumerator: context.commissionRateNumerator,
    commissionRateDenominator: context.commissionRateDenominator,
    paidAt: payment.paidAt,
    serviceStartAt: payment.line.serviceStartAt,
    serviceEndAt: payment.line.serviceEndAt,
    maturationSeconds: context.maturationSeconds,
  };
}

export type NowPaymentsAffiliatePayment = {
  paymentId: string;
  orderId: string;
  currency: "usd";
  paidAt: number;
  processingFeeMinor: number;
  expectedDiscountedAmountMinor: number;
  cadence: "annual";
  serviceStartAt: number;
  serviceEndAt: number;
};

export function normalizeNowPaymentsAffiliatePayment(
  payment: NowPaymentsAffiliatePayment,
  context: AffiliatePaymentContext,
): PersistedRevenueOccurrence {
  return {
    provider: "nowpayments",
    sourceKey: `order:${payment.orderId}:payment:${payment.paymentId}`,
    providerPaymentId: payment.paymentId,
    providerInvoiceId: payment.orderId,
    providerLineId: null,
    affiliateId: context.affiliateId,
    referredAccountId: context.referredAccountId,
    attributionId: context.attributionId,
    cadence: payment.cadence,
    currency: payment.currency,
    eligibleRevenueMinor: payment.expectedDiscountedAmountMinor,
    processingFeeMinor: payment.processingFeeMinor,
    policyVersion: context.policyVersion,
    commissionRateNumerator: context.commissionRateNumerator,
    commissionRateDenominator: context.commissionRateDenominator,
    paidAt: payment.paidAt,
    serviceStartAt: payment.serviceStartAt,
    serviceEndAt: payment.serviceEndAt,
    maturationSeconds: context.maturationSeconds,
  };
}

export async function attachStripeConnectedAccountInDb(
  db: D1Database,
  input: {
    affiliateAccountId: number;
    connectedAccountId: string;
    country: string;
    attachedAt: number;
  },
): Promise<{ attached: boolean; connectedAccountId: string }> {
  const updated = await db.prepare(
    `UPDATE affiliate_profiles
        SET stripe_connected_account_id = ?, stripe_connect_country = ?,
            stripe_connect_status = 'onboarding', stripe_connect_updated_at = ?
      WHERE account_id = ? AND stripe_connected_account_id IS NULL`,
  ).bind(
    input.connectedAccountId,
    input.country.toUpperCase(),
    input.attachedAt,
    input.affiliateAccountId,
  ).run();
  const profile = await db.prepare(
    "SELECT stripe_connected_account_id FROM affiliate_profiles WHERE account_id = ?",
  ).bind(input.affiliateAccountId).first<{ stripe_connected_account_id: string | null }>();
  if (!profile?.stripe_connected_account_id) throw new Error("Affiliate Profile could not attach a Stripe account.");
  return {
    attached: updated.meta.changes === 1,
    connectedAccountId: profile.stripe_connected_account_id,
  };
}

export async function updateStripeConnectedAccountStatusInDb(
  db: D1Database,
  input: {
    connectedAccountId: string;
    detailsSubmitted: boolean;
    payoutsEnabled: boolean;
    transfersStatus: string;
    eventCreated: number;
    eventId: string;
  },
): Promise<{ updated: boolean; status: "onboarding" | "ready" | "restricted" }> {
  const status = !input.detailsSubmitted
    ? "onboarding"
    : input.payoutsEnabled && input.transfersStatus === "active"
      ? "ready"
      : "restricted";
  const results = await db.batch([
    db.prepare(`UPDATE affiliate_profiles
        SET stripe_connect_status = ?, stripe_connect_details_submitted = ?,
            stripe_connect_payouts_enabled = ?, stripe_connect_updated_at = ?,
            stripe_connect_event_id = ?
      WHERE stripe_connected_account_id = ?
        AND (stripe_connect_updated_at IS NULL OR stripe_connect_updated_at < ?
          OR (stripe_connect_updated_at = ? AND COALESCE(stripe_connect_event_id, '') < ?))`).bind(
    status,
    input.detailsSubmitted ? 1 : 0,
    input.payoutsEnabled ? 1 : 0,
    input.eventCreated,
    input.eventId,
    input.connectedAccountId,
    input.eventCreated,
    input.eventCreated,
    input.eventId),
    db.prepare(`INSERT OR IGNORE INTO affiliate_email_outbox
        (idempotency_key, affiliate_id, payout_id, kind, status, created_at)
      SELECT 'affiliate-connect-' || ? || ':' || account_id || ':' || ?, account_id, NULL,
             'affiliate-connect-' || ?, 'pending', ?
        FROM affiliate_profiles
       WHERE stripe_connected_account_id = ? AND stripe_connect_status = ?
         AND ? IN ('ready', 'restricted')
         AND stripe_connect_event_id = ?`)
      .bind(status, input.eventId, status, input.eventCreated, input.connectedAccountId, status, status, input.eventId),
  ]);
  const profile = await db.prepare(
    "SELECT stripe_connect_status FROM affiliate_profiles WHERE stripe_connected_account_id = ?",
  ).bind(input.connectedAccountId).first<{ stripe_connect_status: "onboarding" | "ready" | "restricted" }>();
  if (!profile) throw new Error("Stripe connected account could not be mapped to an Affiliate Profile.");
  return { updated: results[0].meta.changes === 1, status: profile.stripe_connect_status };
}

export type CreateNowPaymentsCheckout = {
  accountId: number;
  attributionId: number | null;
  expectedDiscountedAmountMinor: number;
  policyVersion: string;
  discountRateNumerator: number;
  discountRateDenominator: number;
  commissionRateNumerator: number;
  commissionRateDenominator: number;
  createdAt: number;
  expiresAt: number;
};

export async function createNowPaymentsCheckoutInDb(
  db: D1Database,
  input: CreateNowPaymentsCheckout,
): Promise<{ orderId: string; expectedDiscountedAmountMinor: number }> {
  const orderId = `affiliate_${crypto.randomUUID()}`;
  const inserted = await db.prepare(
    `INSERT INTO affiliate_nowpayments_checkouts
       (order_id, account_id, attribution_id, expected_discounted_amount_minor,
        currency, policy_version, discount_rate_numerator, discount_rate_denominator,
        commission_rate_numerator, commission_rate_denominator, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, 'usd', ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).bind(
    orderId,
    input.accountId,
    input.attributionId,
    input.expectedDiscountedAmountMinor,
    input.policyVersion,
    input.discountRateNumerator,
    input.discountRateDenominator,
    input.commissionRateNumerator,
    input.commissionRateDenominator,
    input.createdAt,
    input.expiresAt,
  ).run();
  if (inserted.meta.changes !== 1) {
    throw new Error("NOWPayments checkout could not be created.");
  }
  return {
    orderId,
    expectedDiscountedAmountMinor: input.expectedDiscountedAmountMinor,
  };
}

export type CreateStripeCheckout = {
  accountId: number;
  attributionId: number;
  cadence: "monthly" | "annual";
  priceId: string;
  promotionCodeId: string;
  policyVersion: string;
  discountRateNumerator: number;
  discountRateDenominator: number;
  commissionRateNumerator: number;
  commissionRateDenominator: number;
  createdAt: number;
  expiresAt: number;
};

export async function createStripeCheckoutInDb(
  db: D1Database,
  input: CreateStripeCheckout,
): Promise<{ checkoutId: string; promotionCodeId: string }> {
  const checkoutId = crypto.randomUUID();
  const inserted = await db.prepare(
    `INSERT INTO affiliate_stripe_checkouts
       (id, account_id, attribution_id, cadence, price_id, promotion_code_id,
        policy_version, discount_rate_numerator, discount_rate_denominator,
        commission_rate_numerator, commission_rate_denominator, status,
        created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).bind(
    checkoutId,
    input.accountId,
    input.attributionId,
    input.cadence,
    input.priceId,
    input.promotionCodeId,
    input.policyVersion,
    input.discountRateNumerator,
    input.discountRateDenominator,
    input.commissionRateNumerator,
    input.commissionRateDenominator,
    input.createdAt,
    input.expiresAt,
  ).run();
  if (inserted.meta.changes !== 1) throw new Error("Stripe affiliate checkout could not be created.");
  return { checkoutId, promotionCodeId: input.promotionCodeId };
}

export type SettleStripeInvoice = {
  checkoutId: string;
  invoiceId: string;
  paymentId: string;
  subscriptionId: string;
  lineId: string;
  priceId: string;
  currency: "usd";
  discountedAmountExcludingTaxMinor: number;
  processingFeeMinor: number;
  serviceStartAt: number;
  serviceEndAt: number;
  paidAt: number;
  maturationSeconds: number;
};

export async function settleStripeInvoiceInDb(
  db: D1Database,
  input: SettleStripeInvoice,
): Promise<{ created: boolean }> {
  if (!Number.isSafeInteger(input.serviceStartAt)
    || !Number.isSafeInteger(input.serviceEndAt)
    || input.serviceEndAt <= input.serviceStartAt) return { created: false };
  const sourceKey = `invoice:${input.invoiceId}:line:${input.lineId}`;
  const occurrenceId = crypto.randomUUID();
  const ledgerEntryId = crypto.randomUUID();
  const results = await db.batch([
    db.prepare(
      `UPDATE affiliate_stripe_checkouts
          SET status = 'completed',
              stripe_subscription_id = COALESCE(stripe_subscription_id, ?),
              completed_at = COALESCE(completed_at, ?)
        WHERE id = ? AND price_id = ?
          AND status IN ('pending', 'created', 'completed')
          AND (stripe_subscription_id IS NULL OR stripe_subscription_id = ?)`,
    ).bind(input.subscriptionId, input.paidAt, input.checkoutId, input.priceId, input.subscriptionId),
    db.prepare(
      `UPDATE accounts
          SET affiliate_eligibility_closed_at = COALESCE(affiliate_eligibility_closed_at, ?)
        WHERE id = (
          SELECT account_id FROM affiliate_stripe_checkouts
           WHERE id = ? AND price_id = ? AND stripe_subscription_id = ?
        )`,
    ).bind(input.paidAt, input.checkoutId, input.priceId, input.subscriptionId),
    db.prepare(
      `INSERT OR IGNORE INTO affiliate_installments
         (attribution_id, cadence, installment_number, provider, source_key, claimed_at)
       SELECT checkout.attribution_id, checkout.cadence,
              COALESCE(MAX(installment.installment_number), 0) + 1,
              'stripe', ?, ?
         FROM affiliate_stripe_checkouts AS checkout
         LEFT JOIN affiliate_installments AS installment
           ON installment.attribution_id = checkout.attribution_id
          AND installment.cadence = checkout.cadence
        WHERE checkout.id = ? AND checkout.price_id = ?
          AND checkout.stripe_subscription_id = ?
       GROUP BY checkout.attribution_id, checkout.cadence
       HAVING COUNT(installment.id) < CASE checkout.cadence WHEN 'annual' THEN 1 ELSE 12 END`,
    ).bind(sourceKey, input.paidAt, input.checkoutId, input.priceId, input.subscriptionId),
    db.prepare(
      `INSERT OR IGNORE INTO affiliate_revenue_occurrences
         (id, provider, source_key, provider_payment_id, provider_invoice_id,
          provider_line_id, provider_subscription_id, provider_price_id,
          affiliate_id, referred_account_id, attribution_id, installment_id,
          currency, eligible_revenue_minor, processing_fee_minor, policy_version,
          commission_rate_numerator, commission_rate_denominator,
          service_start_at, service_end_at, paid_at)
       SELECT ?, 'stripe', ?, ?, ?, ?, ?, ?, attribution.affiliate_id,
              checkout.account_id, checkout.attribution_id, installment.id,
              ?, ?, ?, checkout.policy_version, checkout.commission_rate_numerator,
              checkout.commission_rate_denominator, ?, ?, ?
         FROM affiliate_stripe_checkouts AS checkout
         JOIN affiliate_attributions AS attribution ON attribution.id = checkout.attribution_id
         JOIN affiliate_installments AS installment
           ON installment.attribution_id = checkout.attribution_id
          AND installment.provider = 'stripe' AND installment.source_key = ?
        WHERE checkout.id = ? AND checkout.price_id = ?
          AND checkout.stripe_subscription_id = ?`,
    ).bind(
      occurrenceId,
      sourceKey,
      input.paymentId,
      input.invoiceId,
      input.lineId,
      input.subscriptionId,
      input.priceId,
      input.currency,
      input.discountedAmountExcludingTaxMinor,
      input.processingFeeMinor,
      input.serviceStartAt,
      input.serviceEndAt,
      input.paidAt,
      sourceKey,
      input.checkoutId,
      input.priceId,
      input.subscriptionId,
    ),
    db.prepare(
      `INSERT OR IGNORE INTO affiliate_ledger_entries
         (id, occurrence_id, adjustment_id, dispute_loss_id, entry_kind,
          affiliate_id, currency, amount_minor, available_at, created_at)
       SELECT ?, occurrence.id, NULL, NULL, 'earning', occurrence.affiliate_id,
              occurrence.currency,
              CAST((occurrence.eligible_revenue_minor * occurrence.commission_rate_numerator
                + occurrence.commission_rate_denominator / 2)
                / occurrence.commission_rate_denominator AS INTEGER), ?, ?
         FROM affiliate_revenue_occurrences AS occurrence
        WHERE occurrence.provider = 'stripe' AND occurrence.source_key = ?
          AND NOT EXISTS (
            SELECT 1 FROM affiliate_account_relationships AS relationship
             WHERE (relationship.affiliate_id = occurrence.affiliate_id
                    AND relationship.related_account_id = occurrence.referred_account_id)
                OR (relationship.affiliate_id = occurrence.referred_account_id
                    AND relationship.related_account_id = occurrence.affiliate_id)
          )`,
    ).bind(
      ledgerEntryId,
      input.paidAt + input.maturationSeconds,
      input.paidAt,
      sourceKey,
    ),
  ]);
  const created = results[3].meta.changes === 1;
  await replayPendingStripeFinancialEventsInDb(db);
  return { created };
}

export type SettleNowPaymentsCheckout = {
  orderId: string;
  paymentId: string;
  paidAt: number;
  entitlementSeconds: number;
  maturationSeconds: number;
};

export async function settleNowPaymentsCheckoutInDb(
  db: D1Database,
  input: SettleNowPaymentsCheckout,
): Promise<{ settled: boolean }> {
  const nonce = crypto.randomUUID();
  const occurrenceId = crypto.randomUUID();
  const ledgerEntryId = crypto.randomUUID();
  const sourceKey = `order:${input.orderId}:payment:${input.paymentId}`;
  const results = await db.batch([
    db.prepare(
      `UPDATE affiliate_nowpayments_checkouts
          SET status = 'paid', provider_payment_id = ?, payment_claim_nonce = ?, paid_at = ?
        WHERE order_id = ? AND status IN ('pending', 'invoiced')
          AND payment_claim_nonce IS NULL
          AND EXISTS (
            SELECT 1 FROM crypto_payments
             WHERE order_id = ? AND id = ? AND status = 'finished'
               AND credited_at IS NULL AND revoked_at IS NULL
          )`,
    ).bind(input.paymentId, nonce, input.paidAt, input.orderId, input.orderId, input.paymentId),
    db.prepare(
      `UPDATE crypto_payments
          SET credited_at = ?, credit_nonce = ?
        WHERE order_id = ? AND id = ? AND status = 'finished'
          AND credited_at IS NULL AND revoked_at IS NULL
          AND EXISTS (
            SELECT 1 FROM affiliate_nowpayments_checkouts
             WHERE order_id = ? AND payment_claim_nonce = ?
          )`,
    ).bind(input.paidAt, nonce, input.orderId, input.paymentId, input.orderId, nonce),
    db.prepare(
      `UPDATE accounts
          SET crypto_paid_through = CASE
            WHEN COALESCE(crypto_paid_through, 0) > ?
              THEN crypto_paid_through + ?
            ELSE ?
          END
        WHERE id = (
          SELECT account_id FROM affiliate_nowpayments_checkouts
           WHERE order_id = ? AND payment_claim_nonce = ?
        )`,
    ).bind(
      input.paidAt,
      input.entitlementSeconds,
      input.paidAt + input.entitlementSeconds,
      input.orderId,
      nonce,
    ),
    db.prepare(
      `UPDATE crypto_payments SET entitlement_through = ?
        WHERE order_id = ? AND credit_nonce = ?`,
    ).bind(input.paidAt + input.entitlementSeconds, input.orderId, nonce),
    db.prepare(
      `UPDATE accounts
          SET affiliate_eligibility_closed_at = COALESCE(affiliate_eligibility_closed_at, ?)
        WHERE id = (
          SELECT account_id FROM affiliate_nowpayments_checkouts
           WHERE order_id = ? AND payment_claim_nonce = ?
        )`,
    ).bind(input.paidAt, input.orderId, nonce),
    db.prepare(
      `INSERT OR IGNORE INTO affiliate_installments
         (attribution_id, cadence, installment_number, provider, source_key, claimed_at)
       SELECT attribution_id, 'annual', 1, 'nowpayments', ?, ?
         FROM affiliate_nowpayments_checkouts
        WHERE order_id = ? AND payment_claim_nonce = ? AND attribution_id IS NOT NULL`,
    ).bind(sourceKey, input.paidAt, input.orderId, nonce),
    db.prepare(
      `INSERT OR IGNORE INTO affiliate_revenue_occurrences
         (id, provider, source_key, provider_payment_id, provider_invoice_id,
          provider_line_id, affiliate_id, referred_account_id, attribution_id,
          installment_id, currency, eligible_revenue_minor, processing_fee_minor,
          policy_version, commission_rate_numerator, commission_rate_denominator,
          service_start_at, service_end_at, paid_at)
       SELECT ?, 'nowpayments', ?, ?, checkout.order_id, NULL,
              attribution.affiliate_id, checkout.account_id, checkout.attribution_id,
              installment.id, checkout.currency, checkout.expected_discounted_amount_minor,
              0, checkout.policy_version, checkout.commission_rate_numerator,
              checkout.commission_rate_denominator, ?, ?, ?
         FROM affiliate_nowpayments_checkouts AS checkout
         JOIN affiliate_attributions AS attribution ON attribution.id = checkout.attribution_id
         JOIN affiliate_installments AS installment
           ON installment.attribution_id = checkout.attribution_id
          AND installment.provider = 'nowpayments' AND installment.source_key = ?
        WHERE checkout.order_id = ? AND checkout.payment_claim_nonce = ?`,
    ).bind(
      occurrenceId,
      sourceKey,
      input.paymentId,
      input.paidAt,
      input.paidAt + input.entitlementSeconds,
      input.paidAt,
      sourceKey,
      input.orderId,
      nonce,
    ),
    db.prepare(
      `INSERT OR IGNORE INTO affiliate_ledger_entries
         (id, occurrence_id, adjustment_id, dispute_loss_id, entry_kind,
          affiliate_id, currency, amount_minor, available_at, created_at)
       SELECT ?, occurrence.id, NULL, NULL, 'earning', occurrence.affiliate_id,
              occurrence.currency,
              CAST((occurrence.eligible_revenue_minor * occurrence.commission_rate_numerator
                + occurrence.commission_rate_denominator / 2)
                / occurrence.commission_rate_denominator AS INTEGER), ?, ?
         FROM affiliate_revenue_occurrences AS occurrence
        WHERE occurrence.provider = 'nowpayments' AND occurrence.source_key = ?
          AND NOT EXISTS (
            SELECT 1 FROM affiliate_account_relationships AS relationship
             WHERE (relationship.affiliate_id = occurrence.affiliate_id
                    AND relationship.related_account_id = occurrence.referred_account_id)
                OR (relationship.affiliate_id = occurrence.referred_account_id
                    AND relationship.related_account_id = occurrence.affiliate_id)
          )`,
    ).bind(
      ledgerEntryId,
      input.paidAt + input.maturationSeconds,
      input.paidAt,
      sourceKey,
    ),
  ]);
  return { settled: results[0].meta.changes === 1 };
}

export type RefundNowPaymentsCheckout = {
  orderId: string;
  paymentId: string;
  sourceKey: string;
  refundedAt: number;
  entitlementSeconds: number;
};

export async function refundNowPaymentsCheckoutInDb(
  db: D1Database,
  input: RefundNowPaymentsCheckout,
): Promise<{ refunded: boolean }> {
  const nonce = crypto.randomUUID();
  const adjustmentId = crypto.randomUUID();
  const ledgerEntryId = crypto.randomUUID();
  const results = await db.batch([
    db.prepare(
      `UPDATE affiliate_nowpayments_checkouts
          SET status = 'refunded', refund_claim_nonce = ?, refunded_at = ?
        WHERE order_id = ? AND status = 'paid' AND provider_payment_id = ?
          AND refund_claim_nonce IS NULL
          AND EXISTS (
            SELECT 1 FROM crypto_payments
             WHERE order_id = ? AND id = ? AND status = 'refunded'
               AND credited_at IS NOT NULL AND revoked_at IS NULL
          )`,
    ).bind(nonce, input.refundedAt, input.orderId, input.paymentId, input.orderId, input.paymentId),
    db.prepare(
      `UPDATE crypto_payments SET revoked_at = ?, updated_at = ?
        WHERE order_id = ? AND id = ? AND revoked_at IS NULL
          AND EXISTS (
            SELECT 1 FROM affiliate_nowpayments_checkouts
             WHERE order_id = ? AND refund_claim_nonce = ?
          )`,
    ).bind(input.refundedAt, input.refundedAt, input.orderId, input.paymentId, input.orderId, nonce),
    db.prepare(
      `WITH RECURSIVE ordered AS (
         SELECT credited_at, ROW_NUMBER() OVER (ORDER BY credited_at, id) AS rn
           FROM crypto_payments
          WHERE account_id = (
            SELECT account_id FROM affiliate_nowpayments_checkouts
             WHERE order_id = ? AND refund_claim_nonce = ?
          )
            AND status = 'finished' AND revoked_at IS NULL AND credited_at IS NOT NULL
       ), timeline(rn, expiry) AS (
         SELECT rn, credited_at + ? FROM ordered WHERE rn = 1
         UNION ALL
         SELECT ordered.rn,
                CASE WHEN timeline.expiry > ordered.credited_at
                  THEN timeline.expiry ELSE ordered.credited_at END + ?
           FROM timeline JOIN ordered ON ordered.rn = timeline.rn + 1
       )
       UPDATE accounts
          SET crypto_paid_through = (SELECT expiry FROM timeline ORDER BY rn DESC LIMIT 1)
        WHERE id = (
          SELECT account_id FROM affiliate_nowpayments_checkouts
           WHERE order_id = ? AND refund_claim_nonce = ?
        )`,
    ).bind(
      input.orderId,
      nonce,
      input.entitlementSeconds,
      input.entitlementSeconds,
      input.orderId,
      nonce,
    ),
    db.prepare(
      `INSERT OR IGNORE INTO affiliate_revenue_adjustments
         (id, occurrence_id, provider, source_key, refunded_eligible_revenue_minor,
          commission_reversal_minor, recorded_at)
       SELECT ?, occurrence.id, 'nowpayments', ?, occurrence.eligible_revenue_minor,
              -CAST((occurrence.eligible_revenue_minor * occurrence.commission_rate_numerator
                + occurrence.commission_rate_denominator / 2)
                / occurrence.commission_rate_denominator AS INTEGER), ?
         FROM affiliate_revenue_occurrences AS occurrence
         JOIN affiliate_nowpayments_checkouts AS checkout
           ON checkout.order_id = occurrence.provider_invoice_id
        WHERE checkout.order_id = ? AND checkout.refund_claim_nonce = ?
          AND occurrence.provider = 'nowpayments'
          AND occurrence.provider_payment_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM affiliate_revenue_adjustments
             WHERE occurrence_id = occurrence.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM affiliate_dispute_losses AS loss
            JOIN affiliate_reserves AS reserve ON reserve.id = loss.reserve_id
             WHERE reserve.occurrence_id = occurrence.id
          )`,
    ).bind(adjustmentId, input.sourceKey, input.refundedAt, input.orderId, nonce, input.paymentId),
    db.prepare(
      `INSERT OR IGNORE INTO affiliate_ledger_entries
         (id, occurrence_id, adjustment_id, dispute_loss_id, entry_kind,
          affiliate_id, currency, amount_minor, available_at, created_at)
       SELECT ?, adjustment.occurrence_id, adjustment.id, NULL, 'refund',
              occurrence.affiliate_id, occurrence.currency,
              adjustment.commission_reversal_minor, adjustment.recorded_at,
              adjustment.recorded_at
         FROM affiliate_revenue_adjustments AS adjustment
         JOIN affiliate_revenue_occurrences AS occurrence
           ON occurrence.id = adjustment.occurrence_id
        WHERE adjustment.provider = 'nowpayments' AND adjustment.source_key = ?
          AND occurrence.currency = 'usd'
          AND NOT EXISTS (
            SELECT 1 FROM affiliate_relationship_reversals AS reversal
             WHERE reversal.occurrence_id = occurrence.id
          )`,
    ).bind(ledgerEntryId, input.sourceKey),
  ]);
  return { refunded: results[0].meta.changes === 1 };
}

export async function recognizeRevenueInDb(
  db: D1Database,
  occurrence: PersistedRevenueOccurrence,
): Promise<
  | { created: true; occurrenceId: string }
  | { created: false; occurrenceId: string | null }
> {
  const occurrenceId = crypto.randomUUID();
  const ledgerEntryId = crypto.randomUUID();
  const recognized = recognizeRevenue(occurrence);
  const installmentLimit = occurrence.cadence === "annual" ? 1 : 12;
  const serviceStartAt = occurrence.serviceStartAt ?? occurrence.paidAt;
  const serviceEndAt = occurrence.serviceEndAt
    ?? serviceStartAt + (occurrence.cadence === "annual" ? 365 : 30) * 24 * 60 * 60;
  if (!Number.isSafeInteger(serviceStartAt)
    || !Number.isSafeInteger(serviceEndAt)
    || serviceEndAt <= serviceStartAt) return { created: false, occurrenceId: null };
  const results = await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO affiliate_installments
         (attribution_id, cadence, installment_number, provider, source_key, claimed_at)
       SELECT attribution.id, ?, COALESCE(MAX(installment.installment_number), 0) + 1, ?, ?, ?
         FROM affiliate_attributions AS attribution
         LEFT JOIN affiliate_installments AS installment
           ON installment.attribution_id = attribution.id AND installment.cadence = ?
        WHERE attribution.id = ? AND attribution.affiliate_id = ?
          AND attribution.referred_account_id = ?
       GROUP BY attribution.id
       HAVING COUNT(installment.id) < ?`,
    ).bind(
      occurrence.cadence,
      occurrence.provider,
      occurrence.sourceKey,
      occurrence.paidAt,
      occurrence.cadence,
      occurrence.attributionId,
      occurrence.affiliateId,
      occurrence.referredAccountId,
      installmentLimit,
    ),
    db.prepare(
      `INSERT OR IGNORE INTO affiliate_revenue_occurrences
         (id, provider, source_key, provider_payment_id, provider_invoice_id,
          provider_line_id, affiliate_id, referred_account_id, attribution_id, installment_id,
          currency, eligible_revenue_minor, processing_fee_minor, policy_version,
          commission_rate_numerator, commission_rate_denominator,
          service_start_at, service_end_at, paid_at)
       SELECT ?, ?, ?, ?, ?, ?, attribution.affiliate_id,
              attribution.referred_account_id, attribution.id, installments.id,
              ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM affiliate_installments AS installments
         JOIN affiliate_attributions AS attribution
           ON attribution.id = installments.attribution_id
        WHERE installments.attribution_id = ?
          AND installments.cadence = ?
          AND installments.provider = ?
          AND installments.source_key = ?
          AND attribution.affiliate_id = ?
          AND attribution.referred_account_id = ?`,
    ).bind(
      occurrenceId,
      occurrence.provider,
      occurrence.sourceKey,
      occurrence.providerPaymentId,
      occurrence.providerInvoiceId,
      occurrence.providerLineId,
      occurrence.currency,
      occurrence.eligibleRevenueMinor,
      occurrence.processingFeeMinor,
      occurrence.policyVersion,
      occurrence.commissionRateNumerator,
      occurrence.commissionRateDenominator,
      serviceStartAt,
      serviceEndAt,
      occurrence.paidAt,
      occurrence.attributionId,
      occurrence.cadence,
      occurrence.provider,
      occurrence.sourceKey,
      occurrence.affiliateId,
      occurrence.referredAccountId,
    ),
    db.prepare(
      `INSERT OR IGNORE INTO affiliate_ledger_entries
         (id, occurrence_id, adjustment_id, entry_kind, affiliate_id, currency,
          amount_minor, available_at, created_at)
       SELECT ?, id, NULL, 'earning', affiliate_id, currency, ?, ?, ?
         FROM affiliate_revenue_occurrences
        WHERE provider = ? AND source_key = ? AND currency = 'usd'
          AND NOT EXISTS (
            SELECT 1 FROM affiliate_account_relationships AS relationship
             WHERE (relationship.affiliate_id = affiliate_revenue_occurrences.affiliate_id
                    AND relationship.related_account_id = affiliate_revenue_occurrences.referred_account_id)
                OR (relationship.affiliate_id = affiliate_revenue_occurrences.referred_account_id
                    AND relationship.related_account_id = affiliate_revenue_occurrences.affiliate_id)
          )`,
    ).bind(
      ledgerEntryId,
      recognized.commissionMinor,
      recognized.availableAt,
      occurrence.paidAt,
      occurrence.provider,
      occurrence.sourceKey,
    ),
  ]);
  const stored = await db.prepare(
    `SELECT id FROM affiliate_revenue_occurrences
      WHERE provider = ? AND source_key = ?`,
  ).bind(occurrence.provider, occurrence.sourceKey).first<{ id: string }>();
  if (!stored) return { created: false, occurrenceId: null };
  return results[1].meta.changes === 1
    ? { created: true, occurrenceId: stored.id }
    : { created: false, occurrenceId: stored.id };
}

export type RefundAdjustment = {
  occurrenceId: string;
  provider: "stripe" | "nowpayments";
  sourceKey: string;
  refundedEligibleRevenueMinor: number;
  recordedAt: number;
};

export async function recordRefundInDb(
  db: D1Database,
  refund: RefundAdjustment,
): Promise<{ recorded: boolean }> {
  const adjustmentId = crypto.randomUUID();
  const ledgerEntryId = crypto.randomUUID();
  const results = await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO affiliate_revenue_adjustments
         (id, occurrence_id, provider, source_key, refunded_eligible_revenue_minor,
          commission_reversal_minor, recorded_at)
       SELECT ?, occurrence.id, ?, ?,
              MIN(?, occurrence.eligible_revenue_minor - COALESCE(adjusted.refunded_minor, 0)),
              -CASE WHEN ledger.occurrence_id IS NULL OR EXISTS (
                SELECT 1 FROM affiliate_relationship_reversals AS reversal
                 WHERE reversal.occurrence_id = occurrence.id
              ) THEN
                CAST((MIN(?, occurrence.eligible_revenue_minor - COALESCE(adjusted.refunded_minor, 0)) * occurrence.commission_rate_numerator
                  + occurrence.commission_rate_denominator / 2)
                  / occurrence.commission_rate_denominator AS INTEGER)
              ELSE MIN(CAST((MIN(?, occurrence.eligible_revenue_minor - COALESCE(adjusted.refunded_minor, 0)) * occurrence.commission_rate_numerator
                  + occurrence.commission_rate_denominator / 2)
                  / occurrence.commission_rate_denominator AS INTEGER), ledger.remaining_minor)
              END, ?
         FROM affiliate_revenue_occurrences AS occurrence
         LEFT JOIN (
           SELECT occurrence_id, SUM(amount_minor) AS remaining_minor
             FROM affiliate_ledger_entries GROUP BY occurrence_id
         ) AS ledger ON ledger.occurrence_id = occurrence.id
         LEFT JOIN (
           SELECT occurrence_id, SUM(refunded_eligible_revenue_minor) AS refunded_minor
             FROM affiliate_revenue_adjustments GROUP BY occurrence_id
         ) AS adjusted ON adjusted.occurrence_id = occurrence.id
        WHERE occurrence.id = ?
          AND occurrence.provider = ?
          AND ? > 0
          AND (ledger.occurrence_id IS NULL OR ledger.remaining_minor > 0 OR EXISTS (
            SELECT 1 FROM affiliate_relationship_reversals AS reversal
             WHERE reversal.occurrence_id = occurrence.id
          ))
          AND occurrence.eligible_revenue_minor - COALESCE(adjusted.refunded_minor, 0) > 0
          AND NOT EXISTS (
            SELECT 1 FROM affiliate_dispute_losses AS loss
            JOIN affiliate_reserves AS reserve ON reserve.id = loss.reserve_id
             WHERE reserve.occurrence_id = occurrence.id
          )`,
    ).bind(
      adjustmentId,
      refund.provider,
      refund.sourceKey,
      refund.refundedEligibleRevenueMinor,
      refund.refundedEligibleRevenueMinor,
      refund.refundedEligibleRevenueMinor,
      refund.recordedAt,
      refund.occurrenceId,
      refund.provider,
      refund.refundedEligibleRevenueMinor,
    ),
    db.prepare(
      `INSERT OR IGNORE INTO affiliate_ledger_entries
         (id, occurrence_id, adjustment_id, entry_kind, affiliate_id, currency,
          amount_minor, available_at, created_at)
       SELECT ?, adjustment.occurrence_id, adjustment.id, 'refund',
              occurrence.affiliate_id, occurrence.currency,
              adjustment.commission_reversal_minor, adjustment.recorded_at,
              adjustment.recorded_at
         FROM affiliate_revenue_adjustments AS adjustment
         JOIN affiliate_revenue_occurrences AS occurrence
           ON occurrence.id = adjustment.occurrence_id
        WHERE adjustment.provider = ? AND adjustment.source_key = ?
          AND occurrence.currency = 'usd'
          AND NOT EXISTS (
            SELECT 1 FROM affiliate_relationship_reversals AS reversal
             WHERE reversal.occurrence_id = occurrence.id
          )`,
    ).bind(ledgerEntryId, refund.provider, refund.sourceKey),
  ]);
  return { recorded: results[0].meta.changes === 1 };
}

export type StripeRefund = {
  paymentId: string;
  refundId: string;
  refundedChargeMinor: number;
  originalChargeMinor: number;
  recordedAt: number;
};

export async function recordStripeRefundInDb(
  db: D1Database,
  refund: StripeRefund,
): Promise<{ recorded: boolean }> {
  if (refund.refundedChargeMinor <= 0 || refund.originalChargeMinor <= 0) {
    return { recorded: false };
  }
  const occurrence = await db.prepare(
    `SELECT id, eligible_revenue_minor
       FROM affiliate_revenue_occurrences
      WHERE provider = 'stripe' AND provider_payment_id = ?`,
  ).bind(refund.paymentId).first<{
    id: string;
    eligible_revenue_minor: number;
  }>();
  if (!occurrence) return { recorded: false };
  const refundedEligibleRevenueMinor = Math.min(
    occurrence.eligible_revenue_minor,
    Math.floor(
      (occurrence.eligible_revenue_minor * refund.refundedChargeMinor
        + refund.originalChargeMinor / 2)
        / refund.originalChargeMinor,
    ),
  );
  if (refundedEligibleRevenueMinor <= 0) return { recorded: false };
  return recordRefundInDb(db, {
    occurrenceId: occurrence.id,
    provider: "stripe",
    sourceKey: `refund:${refund.refundId}`,
    refundedEligibleRevenueMinor,
    recordedAt: refund.recordedAt,
  });
}

export async function recordStripeCreditNoteInDb(
  db: D1Database,
  credit: {
    invoiceId: string;
    invoiceLineId: string;
    creditNoteId: string;
    creditedEligibleRevenueMinor: number;
    recordedAt: number;
  },
): Promise<{ recorded: boolean }> {
  if (!credit.invoiceId || !credit.invoiceLineId || !credit.creditNoteId
    || !Number.isSafeInteger(credit.creditedEligibleRevenueMinor)
    || credit.creditedEligibleRevenueMinor <= 0) return { recorded: false };
  const occurrence = await db.prepare(
    `SELECT id, provider, eligible_revenue_minor
       FROM affiliate_revenue_occurrences
      WHERE provider = 'stripe' AND provider_invoice_id = ? AND provider_line_id = ?`,
  ).bind(credit.invoiceId, credit.invoiceLineId).first<{
    id: string;
    provider: "stripe";
    eligible_revenue_minor: number;
  }>();
  if (!occurrence) return { recorded: false };
  return recordRefundInDb(db, {
    occurrenceId: occurrence.id,
    provider: "stripe",
    sourceKey: `credit_note:${credit.creditNoteId}:line:${credit.invoiceLineId}`,
    refundedEligibleRevenueMinor: Math.min(
      occurrence.eligible_revenue_minor,
      credit.creditedEligibleRevenueMinor,
    ),
    recordedAt: credit.recordedAt,
  });
}

export type ManualAffiliateAdjustment = {
  occurrenceId: string;
  sourceKey: string;
  amountMinor: number;
  actorSubject: string;
  actorRole: "admin";
  reason: string;
  recordedAt: number;
};

/** Appends an admin correction without rewriting provider or ledger history. */
export async function recordManualAffiliateAdjustmentInDb(
  db: D1Database,
  adjustment: ManualAffiliateAdjustment,
): Promise<{ recorded: boolean }> {
  const reason = adjustment.reason.trim();
  if (!adjustment.occurrenceId || !adjustment.sourceKey || !adjustment.actorSubject
    || adjustment.actorRole !== "admin" || !reason
    || !Number.isSafeInteger(adjustment.amountMinor) || adjustment.amountMinor === 0
    || !Number.isSafeInteger(adjustment.recordedAt) || adjustment.recordedAt < 0) {
    return { recorded: false };
  }
  const adjustmentId = crypto.randomUUID();
  const ledgerEntryId = crypto.randomUUID();
  const results = await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO affiliate_manual_adjustments
         (id, source_key, occurrence_id, affiliate_id, currency, amount_minor,
          actor_subject, actor_role, reason, recorded_at)
       SELECT ?, ?, occurrence.id, occurrence.affiliate_id, occurrence.currency, ?, ?, ?, ?, ?
         FROM affiliate_revenue_occurrences AS occurrence
        WHERE occurrence.id = ? AND occurrence.currency = 'usd'`,
    ).bind(
      adjustmentId, adjustment.sourceKey, adjustment.amountMinor,
      adjustment.actorSubject, adjustment.actorRole, reason, adjustment.recordedAt,
      adjustment.occurrenceId,
    ),
    db.prepare(
      `INSERT OR IGNORE INTO affiliate_ledger_entries
         (id, occurrence_id, manual_adjustment_id, entry_kind, affiliate_id,
          currency, amount_minor, available_at, created_at)
       SELECT ?, manual.occurrence_id, manual.id, 'manual_adjustment',
              manual.affiliate_id, manual.currency, manual.amount_minor,
              manual.recorded_at, manual.recorded_at
         FROM affiliate_manual_adjustments AS manual
        WHERE manual.source_key = ?`,
    ).bind(ledgerEntryId, adjustment.sourceKey),
  ]);
  return { recorded: results[0].meta.changes === 1 };
}

export type OpenStripeDispute = {
  paymentId: string;
  disputeId: string;
  sourceKey: string;
  openedAt: number;
};

export async function openStripeDisputeInDb(
  db: D1Database,
  dispute: OpenStripeDispute,
): Promise<{ reserved: boolean }> {
  const occurrence = await db.prepare(
    `SELECT id
       FROM affiliate_revenue_occurrences
      WHERE provider = 'stripe' AND provider_payment_id = ?`,
  ).bind(dispute.paymentId).first<{ id: string }>();
  if (!occurrence) return { reserved: false };
  return openDisputeReserveInDb(db, {
    occurrenceId: occurrence.id,
    provider: "stripe",
    disputeId: dispute.disputeId,
    sourceKey: dispute.sourceKey,
    openedAt: dispute.openedAt,
  });
}

export type ResolveStripeDispute = Omit<DisputeResolution, "provider">;

export async function resolveStripeDisputeInDb(
  db: D1Database,
  resolution: ResolveStripeDispute,
): Promise<{ resolved: boolean }> {
  return resolveDisputeInDb(db, { provider: "stripe", ...resolution });
}

export type PendingStripeFinancialEvent =
  | { kind: "refund"; sourceKey: string; paymentId: string; amountMinor: number; originalAmountMinor: number; occurredAt: number }
  | { kind: "credit_note"; sourceKey: string; invoiceId: string; invoiceLineId: string; amountMinor: number; occurredAt: number }
  | { kind: "dispute_open"; sourceKey: string; paymentId: string; disputeId: string; occurredAt: number }
  | { kind: "dispute_close"; sourceKey: string; disputeId: string; outcome: "won" | "lost"; occurredAt: number };

type StoredStripeFinancialEvent = {
  source_key: string;
  kind: PendingStripeFinancialEvent["kind"];
  payment_id: string | null;
  invoice_id: string | null;
  invoice_line_id: string | null;
  dispute_id: string | null;
  outcome: "won" | "lost" | null;
  amount_minor: number | null;
  original_amount_minor: number | null;
  occurred_at: number;
};

export async function replayPendingStripeFinancialEventsInDb(db: D1Database): Promise<number> {
  let applied = 0;
  while (true) {
    const candidates = await db.prepare(
      `SELECT event.source_key, event.kind, event.payment_id, event.invoice_id,
              event.invoice_line_id, event.dispute_id, event.outcome,
              event.amount_minor, event.original_amount_minor, event.occurred_at
         FROM affiliate_stripe_financial_events AS event
        WHERE event.applied_at IS NULL AND (
          (event.kind IN ('refund', 'dispute_open') AND EXISTS (
            SELECT 1 FROM affiliate_revenue_occurrences AS occurrence
             WHERE occurrence.provider = 'stripe'
               AND occurrence.provider_payment_id = event.payment_id
          )) OR
          (event.kind = 'credit_note' AND EXISTS (
            SELECT 1 FROM affiliate_revenue_occurrences AS occurrence
             WHERE occurrence.provider = 'stripe'
               AND occurrence.provider_invoice_id = event.invoice_id
               AND occurrence.provider_line_id = event.invoice_line_id
          )) OR
          (event.kind = 'dispute_close' AND EXISTS (
            SELECT 1 FROM affiliate_reserves AS reserve
             WHERE reserve.provider = 'stripe' AND reserve.dispute_id = event.dispute_id
          ))
        )
        ORDER BY CASE event.kind WHEN 'dispute_open' THEN 0 WHEN 'dispute_close' THEN 2 ELSE 1 END,
                 event.occurred_at, event.source_key
        LIMIT 100`,
    ).all<StoredStripeFinancialEvent>();
    if (!candidates.results.length) break;
    let completedInBatch = 0;
    for (const event of candidates.results) {
      let completed = false;
      if (event.kind === "refund") {
        completed = (await recordStripeRefundInDb(db, {
          paymentId: event.payment_id!, refundId: event.source_key.replace(/^refund:/, ""),
          refundedChargeMinor: event.amount_minor!, originalChargeMinor: event.original_amount_minor!,
          recordedAt: event.occurred_at,
        })).recorded;
      } else if (event.kind === "credit_note") {
        const prefix = "credit_note:";
        const creditNoteId = event.source_key.slice(prefix.length, event.source_key.indexOf(":line:"));
        completed = (await recordStripeCreditNoteInDb(db, {
          invoiceId: event.invoice_id!, invoiceLineId: event.invoice_line_id!, creditNoteId,
          creditedEligibleRevenueMinor: event.amount_minor!, recordedAt: event.occurred_at,
        })).recorded;
      } else if (event.kind === "dispute_open") {
        completed = (await openStripeDisputeInDb(db, {
          paymentId: event.payment_id!, disputeId: event.dispute_id!, sourceKey: event.source_key,
          openedAt: event.occurred_at,
        })).reserved;
      } else {
        completed = (await resolveStripeDisputeInDb(db, {
          disputeId: event.dispute_id!, outcome: event.outcome!, sourceKey: event.source_key,
          resolvedAt: event.occurred_at,
        })).resolved;
      }
      if (!completed) completed = await stripeFinancialEventIsTerminalInDb(db, event);
      if (!completed) continue;
      const marked = await db.prepare(
        "UPDATE affiliate_stripe_financial_events SET applied_at = ? WHERE source_key = ? AND applied_at IS NULL",
      ).bind(event.occurred_at, event.source_key).run();
      applied += marked.meta.changes;
      completedInBatch += marked.meta.changes;
    }
    if (!completedInBatch) break;
  }
  return applied;
}

async function stripeFinancialEventIsTerminalInDb(
  db: D1Database,
  event: StoredStripeFinancialEvent,
): Promise<boolean> {
  if (event.kind === "refund" || event.kind === "credit_note") {
    const state = await db.prepare(
      `SELECT
         EXISTS(SELECT 1 FROM affiliate_revenue_adjustments WHERE provider = 'stripe' AND source_key = ?) AS source_applied,
         COALESCE((SELECT SUM(entry.amount_minor) FROM affiliate_ledger_entries AS entry
                    WHERE entry.occurrence_id = occurrence.id), 0) AS remaining_minor,
         EXISTS(SELECT 1 FROM affiliate_relationship_reversals WHERE occurrence_id = occurrence.id) AS relationship_reversed,
         EXISTS(SELECT 1 FROM affiliate_dispute_losses AS loss JOIN affiliate_reserves AS reserve ON reserve.id = loss.reserve_id
                  WHERE reserve.occurrence_id = occurrence.id) AS dispute_lost
       FROM affiliate_revenue_occurrences AS occurrence
       WHERE occurrence.provider = 'stripe'
         AND ((? = 'refund' AND occurrence.provider_payment_id = ?)
           OR (? = 'credit_note' AND occurrence.provider_invoice_id = ? AND occurrence.provider_line_id = ?))`,
    ).bind(
      event.source_key, event.kind, event.payment_id,
      event.kind, event.invoice_id, event.invoice_line_id,
    ).first<{ source_applied: number; remaining_minor: number; relationship_reversed: number; dispute_lost: number }>();
    return Boolean(state && (state.source_applied || state.remaining_minor <= 0
      || state.relationship_reversed || state.dispute_lost));
  }
  if (event.kind === "dispute_open") {
    const state = await db.prepare(
      `SELECT
         EXISTS(SELECT 1 FROM affiliate_reserves WHERE provider = 'stripe' AND dispute_id = ?) AS reserve_exists,
         COALESCE((SELECT SUM(entry.amount_minor) FROM affiliate_ledger_entries AS entry
                    WHERE entry.occurrence_id = occurrence.id), 0) AS remaining_minor
       FROM affiliate_revenue_occurrences AS occurrence
       WHERE occurrence.provider = 'stripe' AND occurrence.provider_payment_id = ?`,
    ).bind(event.dispute_id, event.payment_id).first<{ reserve_exists: number; remaining_minor: number }>();
    return Boolean(state && (state.reserve_exists || state.remaining_minor <= 0));
  }
  const reserve = await db.prepare(
    "SELECT status FROM affiliate_reserves WHERE provider = 'stripe' AND dispute_id = ?",
  ).bind(event.dispute_id).first<{ status: "open" | "won" | "lost" }>();
  return Boolean(reserve && reserve.status !== "open");
}

export async function recordPendingStripeFinancialEventInDb(
  db: D1Database,
  event: PendingStripeFinancialEvent,
): Promise<{ recorded: boolean; applied: boolean }> {
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO affiliate_stripe_financial_events
       (source_key, kind, payment_id, invoice_id, invoice_line_id, dispute_id,
        outcome, amount_minor, original_amount_minor, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    event.sourceKey,
    event.kind,
    "paymentId" in event ? event.paymentId : null,
    "invoiceId" in event ? event.invoiceId : null,
    "invoiceLineId" in event ? event.invoiceLineId : null,
    "disputeId" in event ? event.disputeId : null,
    "outcome" in event ? event.outcome : null,
    "amountMinor" in event ? event.amountMinor : null,
    "originalAmountMinor" in event ? event.originalAmountMinor : null,
    event.occurredAt,
  ).run();
  await replayPendingStripeFinancialEventsInDb(db);
  const stored = await db.prepare(
    "SELECT applied_at FROM affiliate_stripe_financial_events WHERE source_key = ?",
  ).bind(event.sourceKey).first<{ applied_at: number | null }>();
  return { recorded: inserted.meta.changes === 1, applied: stored?.applied_at !== null && stored?.applied_at !== undefined };
}

export type OpenDisputeReserve = {
  occurrenceId: string;
  provider: "stripe" | "nowpayments";
  disputeId: string;
  sourceKey: string;
  openedAt: number;
};

export async function openDisputeReserveInDb(
  db: D1Database,
  dispute: OpenDisputeReserve,
): Promise<{ reserved: boolean }> {
  const reserveId = crypto.randomUUID();
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO affiliate_reserves
       (id, occurrence_id, affiliate_id, provider, dispute_id, source_key,
        currency, amount_minor, status, opened_at)
     SELECT ?, occurrence.id, occurrence.affiliate_id, ?, ?, ?,
            occurrence.currency, ledger.remaining_minor, 'open', ?
       FROM affiliate_revenue_occurrences AS occurrence
       JOIN (
         SELECT occurrence_id, SUM(amount_minor) AS remaining_minor
           FROM affiliate_ledger_entries
          GROUP BY occurrence_id
       ) AS ledger ON ledger.occurrence_id = occurrence.id
      WHERE occurrence.id = ?
        AND occurrence.provider = ?
        AND ledger.remaining_minor > 0
        AND NOT EXISTS (
          SELECT 1 FROM affiliate_reserves AS active
           WHERE active.occurrence_id = occurrence.id AND active.status = 'open'
        )`,
  ).bind(
    reserveId,
    dispute.provider,
    dispute.disputeId,
    dispute.sourceKey,
    dispute.openedAt,
    dispute.occurrenceId,
    dispute.provider,
  ).run();
  return { reserved: inserted.meta.changes === 1 };
}

export type DisputeResolution = {
  provider: "stripe" | "nowpayments";
  disputeId: string;
  outcome: "won" | "lost";
  sourceKey: string;
  resolvedAt: number;
};

export async function resolveDisputeInDb(
  db: D1Database,
  resolution: DisputeResolution,
): Promise<{ resolved: boolean }> {
  if (resolution.outcome === "lost") {
    const lossId = crypto.randomUUID();
    const ledgerEntryId = crypto.randomUUID();
    const results = await db.batch([
      db.prepare(
        `UPDATE OR IGNORE affiliate_reserves
            SET status = 'lost', resolution_source_key = ?, resolved_at = ?
          WHERE provider = ? AND dispute_id = ? AND status = 'open'`,
      ).bind(
        resolution.sourceKey,
        resolution.resolvedAt,
        resolution.provider,
        resolution.disputeId,
      ),
      db.prepare(
        `INSERT OR IGNORE INTO affiliate_dispute_losses
           (id, reserve_id, provider, source_key, commission_reversal_minor, recorded_at)
         SELECT ?, reserve.id, reserve.provider, ?, -ledger.remaining_minor, ?
           FROM affiliate_reserves AS reserve
           JOIN (
             SELECT occurrence_id, SUM(amount_minor) AS remaining_minor
               FROM affiliate_ledger_entries
              GROUP BY occurrence_id
           ) AS ledger ON ledger.occurrence_id = reserve.occurrence_id
          WHERE reserve.provider = ? AND reserve.dispute_id = ?
            AND reserve.status = 'lost' AND reserve.resolution_source_key = ?
            AND ledger.remaining_minor > 0`,
      ).bind(
        lossId,
        resolution.sourceKey,
        resolution.resolvedAt,
        resolution.provider,
        resolution.disputeId,
        resolution.sourceKey,
      ),
      db.prepare(
        `INSERT OR IGNORE INTO affiliate_ledger_entries
           (id, occurrence_id, adjustment_id, dispute_loss_id, entry_kind,
            affiliate_id, currency, amount_minor, available_at, created_at)
         SELECT ?, reserve.occurrence_id, NULL, loss.id, 'dispute_loss',
                reserve.affiliate_id, reserve.currency,
                loss.commission_reversal_minor, loss.recorded_at, loss.recorded_at
           FROM affiliate_dispute_losses AS loss
           JOIN affiliate_reserves AS reserve ON reserve.id = loss.reserve_id
          WHERE loss.provider = ? AND loss.source_key = ?`,
      ).bind(ledgerEntryId, resolution.provider, resolution.sourceKey),
    ]);
    return { resolved: results[0].meta.changes === 1 };
  }

  const updated = await db.prepare(
    `UPDATE OR IGNORE affiliate_reserves
        SET status = 'released', resolution_source_key = ?, resolved_at = ?
      WHERE provider = ? AND dispute_id = ? AND status = 'open'`,
  ).bind(
    resolution.sourceKey,
    resolution.resolvedAt,
    resolution.provider,
    resolution.disputeId,
  ).run();
  return { resolved: updated.meta.changes === 1 };
}

export type PreparePayout = {
  affiliateId: number;
  currency: "usd";
  cutoff: number;
  minimumMinor: number;
};

export function parsePayoutDualControlThreshold(
  raw: string | undefined,
): { configured: true; thresholdMinor: number } | { configured: false } {
  const value = String(raw || "").trim();
  if (!/^[0-9]+$/.test(value)) return { configured: false };
  const thresholdMinor = Number(value);
  return Number.isSafeInteger(thresholdMinor) && thresholdMinor > 0
    ? { configured: true, thresholdMinor }
    : { configured: false };
}

export function parseAffiliateStripeConnectCountries(
  raw: string | undefined,
): { configured: true; countries: ReadonlySet<string> } | { configured: false } {
  const values = String(raw || "").split(",").map((value) => value.trim().toUpperCase());
  if (!values.length || values.some((value) => !/^[A-Z]{2}$/.test(value))) {
    return { configured: false };
  }
  return { configured: true, countries: new Set(values) };
}

export async function preparePayoutInDb(
  db: D1Database,
  input: PreparePayout,
): Promise<
  | { prepared: true; payoutId: string; amountMinor: number }
  | { prepared: false; payoutId: null; amountMinor: 0 }
> {
  const payoutId = crypto.randomUUID();
  const eligibleEntries = `
    SELECT entry.id, entry.amount_minor
      FROM affiliate_ledger_entries AS entry
      JOIN affiliate_profiles AS profile ON profile.account_id = entry.affiliate_id
     WHERE entry.affiliate_id = ?
       AND entry.currency = ?
       AND entry.available_at <= ?
       AND profile.status = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM affiliate_payout_entries AS allocated
          WHERE allocated.ledger_entry_id = entry.id AND allocated.released_at IS NULL
       )
       AND (entry.amount_minor <= 0 OR NOT EXISTS (
         SELECT 1
           FROM affiliate_revenue_occurrences AS occurrence
           JOIN affiliate_account_relationships AS relationship
             ON (relationship.affiliate_id = occurrence.affiliate_id
                 AND relationship.related_account_id = occurrence.referred_account_id)
             OR (relationship.affiliate_id = occurrence.referred_account_id
                 AND relationship.related_account_id = occurrence.affiliate_id)
          WHERE occurrence.id = entry.occurrence_id
       ))
       AND (entry.entry_kind != 'relationship_reversal' OR EXISTS (
         SELECT 1
           FROM affiliate_ledger_entries AS earning
           JOIN affiliate_payout_entries AS allocation ON allocation.ledger_entry_id = earning.id
           JOIN affiliate_payouts AS paid_payout ON paid_payout.id = allocation.payout_id
          WHERE earning.occurrence_id = entry.occurrence_id
            AND earning.entry_kind = 'earning'
            AND paid_payout.status = 'paid'
       ))
       AND (
         entry.amount_minor <= 0
         OR NOT EXISTS (
           SELECT 1 FROM affiliate_reserves AS reserve
            WHERE reserve.occurrence_id = entry.occurrence_id
              AND reserve.status = 'open'
         )
       )`;
  const results = await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO affiliate_payouts
         (id, affiliate_id, currency, amount_minor, status, cutoff_at, created_at)
       SELECT ?, ?, ?, SUM(eligible.amount_minor), 'prepared', ?, ?
         FROM (${eligibleEntries}) AS eligible
       HAVING SUM(eligible.amount_minor) >= ?`,
    ).bind(
      payoutId,
      input.affiliateId,
      input.currency,
      input.cutoff,
      input.cutoff,
      input.affiliateId,
      input.currency,
      input.cutoff,
      input.minimumMinor,
    ),
    db.prepare(
      `INSERT OR IGNORE INTO affiliate_payout_entries (payout_id, ledger_entry_id)
       SELECT ?, eligible.id FROM (${eligibleEntries}) AS eligible
        WHERE EXISTS (SELECT 1 FROM affiliate_payouts WHERE id = ?)`,
    ).bind(
      payoutId,
      input.affiliateId,
      input.currency,
      input.cutoff,
      payoutId,
    ),
  ]);
  if (results[0].meta.changes !== 1) {
    return { prepared: false, payoutId: null, amountMinor: 0 };
  }
  const payout = await db.prepare(
    "SELECT amount_minor FROM affiliate_payouts WHERE id = ?",
  ).bind(payoutId).first<{ amount_minor: number }>();
  if (!payout) throw new Error("Prepared payout could not be loaded.");
  return { prepared: true, payoutId, amountMinor: payout.amount_minor };
}

export async function prepareAffiliatePayoutBatchInDb(
  db: D1Database,
  input: Omit<PreparePayout, "affiliateId">,
): Promise<Array<{ affiliateId: number; payoutId: string; amountMinor: number }>> {
  const profiles = await db.prepare(
    "SELECT account_id FROM affiliate_profiles WHERE status = 'active' ORDER BY account_id",
  ).all<{ account_id: number }>();
  const attempts = await Promise.all(profiles.results.map(async (profile) => ({
    affiliateId: profile.account_id,
    result: await preparePayoutInDb(db, {
      affiliateId: profile.account_id,
      currency: input.currency,
      cutoff: input.cutoff,
      minimumMinor: input.minimumMinor,
    }),
  })));
  return attempts.flatMap(({ affiliateId, result }) => result.prepared
    ? [{ affiliateId, payoutId: result.payoutId, amountMinor: result.amountMinor }]
    : []);
}

export type PayoutDispatchResult = {
  payoutId: string;
  provider: "stripe" | "nowpayments";
  idempotencyKey: string;
  outcome: "paid" | "ambiguous";
  externalReference: string | null;
  actorSubject: string;
  actorRole: "admin";
  reason: string;
  recordedAt: number;
};

export type PayoutApproval = {
  payoutId: string;
  actorSubject: string;
  actorRole: "admin";
  reason: string;
  approvedAt: number;
};

export async function approveAffiliatePayoutInDb(
  db: D1Database,
  approval: PayoutApproval,
): Promise<{ approved: boolean }> {
  const result = await db.prepare(
    `INSERT OR IGNORE INTO affiliate_payout_approvals
       (payout_id, actor_subject, actor_role, reason, approved_at)
     SELECT payout.id, ?, ?, ?, ?
       FROM affiliate_payouts AS payout
      WHERE payout.id = ? AND payout.status = 'prepared'`,
  ).bind(
    approval.actorSubject,
    approval.actorRole,
    approval.reason,
    approval.approvedAt,
    approval.payoutId,
  ).run();
  return { approved: result.meta.changes === 1 };
}

export async function hasIndependentPayoutApprovalInDb(
  db: D1Database,
  payoutId: string,
  dispatchActorSubject: string,
): Promise<boolean> {
  const approval = await db.prepare(
    `SELECT 1 AS approved
       FROM affiliate_payout_approvals
      WHERE payout_id = ? AND actor_subject != ? AND actor_role = 'admin'
      LIMIT 1`,
  ).bind(payoutId, dispatchActorSubject).first<{ approved: number }>();
  return approval?.approved === 1;
}

export async function loadStripePayoutDispatchInDb(
  db: D1Database,
  payoutId: string,
  allowedCountries: ReadonlySet<string>,
): Promise<
  | {
      dispatchable: true;
      payoutId: string;
      affiliateId: number;
      connectedAccountId: string;
      amountMinor: number;
      currency: "usd";
    }
  | { dispatchable: false }
> {
  const payout = await db.prepare(
    `SELECT payout.id, payout.affiliate_id, payout.amount_minor, payout.currency,
            profile.stripe_connected_account_id, profile.stripe_connect_country
       FROM affiliate_payouts AS payout
       JOIN affiliate_profiles AS profile ON profile.account_id = payout.affiliate_id
      WHERE payout.id = ? AND payout.status = 'prepared' AND payout.currency = 'usd'
        AND profile.status = 'active' AND profile.stripe_connect_status = 'ready'
        AND profile.stripe_connect_payouts_enabled = 1
        AND profile.stripe_connected_account_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM affiliate_payout_entries WHERE payout_id = payout.id AND released_at IS NULL)
        AND payout.amount_minor = (SELECT SUM(entry.amount_minor)
          FROM affiliate_payout_entries AS allocation
          JOIN affiliate_ledger_entries AS entry ON entry.id = allocation.ledger_entry_id
          WHERE allocation.payout_id = payout.id AND allocation.released_at IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM affiliate_payout_entries AS allocation
          JOIN affiliate_ledger_entries AS entry ON entry.id = allocation.ledger_entry_id
          JOIN affiliate_revenue_occurrences AS occurrence ON occurrence.id = entry.occurrence_id
          WHERE allocation.payout_id = payout.id AND allocation.released_at IS NULL
            AND entry.amount_minor > 0
            AND (occurrence.provider != 'stripe' OR EXISTS (
              SELECT 1 FROM affiliate_account_relationships AS relationship
               WHERE (relationship.affiliate_id = occurrence.affiliate_id
                      AND relationship.related_account_id = occurrence.referred_account_id)
                  OR (relationship.affiliate_id = occurrence.referred_account_id
                      AND relationship.related_account_id = occurrence.affiliate_id)
            ))
        )`,
  ).bind(payoutId).first<{
    id: string;
    affiliate_id: number;
    amount_minor: number;
    currency: "usd";
    stripe_connected_account_id: string;
    stripe_connect_country: string | null;
  }>();
  if (!payout || !payout.stripe_connect_country
      || !allowedCountries.has(payout.stripe_connect_country.toUpperCase())) {
    return { dispatchable: false };
  }
  return {
    dispatchable: true,
    payoutId: payout.id,
    affiliateId: payout.affiliate_id,
    connectedAccountId: payout.stripe_connected_account_id,
    amountMinor: payout.amount_minor,
    currency: payout.currency,
  };
}

export async function recordPayoutDispatchResultInDb(
  db: D1Database,
  dispatch: PayoutDispatchResult,
): Promise<{
  recorded: boolean;
  payoutStatus: "prepared" | "reconciliation" | "paid" | "cancelled";
}> {
  const attemptId = crypto.randomUUID();
  const nextStatus = dispatch.outcome === "paid" ? "paid" : "reconciliation";
  const results = await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO affiliate_payout_attempts
         (id, payout_id, provider, idempotency_key, outcome, external_reference,
          actor_subject, actor_role, reason, recorded_at)
       SELECT ?, payout.id, ?, ?, ?, ?, ?, ?, ?, ?
         FROM affiliate_payouts AS payout
        WHERE payout.id = ? AND payout.status = 'prepared'`,
    ).bind(
      attemptId,
      dispatch.provider,
      dispatch.idempotencyKey,
      dispatch.outcome,
      dispatch.externalReference,
      dispatch.actorSubject,
      dispatch.actorRole,
      dispatch.reason,
      dispatch.recordedAt,
      dispatch.payoutId,
    ),
    db.prepare(
      `UPDATE affiliate_payouts SET status = ?
        WHERE id = ? AND status = 'prepared'
          AND EXISTS (SELECT 1 FROM affiliate_payout_attempts WHERE id = ?)`,
    ).bind(nextStatus, dispatch.payoutId, attemptId),
    db.prepare(
      `INSERT OR IGNORE INTO affiliate_email_outbox
         (idempotency_key, affiliate_id, payout_id, kind, status, created_at)
       SELECT 'affiliate-payout-sent:' || payout.id, payout.affiliate_id, payout.id,
              'affiliate-payout-sent', 'pending', ?
         FROM affiliate_payouts AS payout
        WHERE payout.id = ? AND payout.status = 'paid' AND ? = 'paid'
          AND EXISTS (SELECT 1 FROM affiliate_payout_attempts WHERE id = ?)`,
    ).bind(dispatch.recordedAt, dispatch.payoutId, dispatch.outcome, attemptId),
  ]);
  const payout = await db.prepare(
    "SELECT status FROM affiliate_payouts WHERE id = ?",
  ).bind(dispatch.payoutId).first<{
    status: "prepared" | "reconciliation" | "paid" | "cancelled";
  }>();
  if (!payout) throw new Error("Payout was not found.");
  return {
    recorded: results[0].meta.changes === 1,
    payoutStatus: payout.status,
  };
}

type PayoutReconciliationBase = {
  payoutId: string;
  actorSubject: string;
  actorRole: "admin";
  evidence: string;
  reconciledAt: number;
};

export type PayoutReconciliation = PayoutReconciliationBase & (
  | { decision: "confirm_paid"; externalReference: string }
  | { decision: "cancel"; externalReference: null }
);

export async function reconcilePayoutInDb(
  db: D1Database,
  reconciliation: PayoutReconciliation,
): Promise<{ reconciled: boolean }> {
  const reconciliationId = crypto.randomUUID();
  const nextStatus = reconciliation.decision === "confirm_paid" ? "paid" : "cancelled";
  const results = await db.batch([
    db.prepare(
      `UPDATE OR IGNORE affiliate_payouts
          SET status = ?, reconciliation_token = ?
        WHERE id = ? AND status = 'reconciliation'`,
    ).bind(nextStatus, reconciliationId, reconciliation.payoutId),
    db.prepare(
      `INSERT OR IGNORE INTO affiliate_payout_reconciliations
         (id, payout_id, decision, actor_subject, actor_role, evidence,
          external_reference, reconciled_at)
       SELECT ?, payout.id, ?, ?, ?, ?, ?, ?
         FROM affiliate_payouts AS payout
        WHERE payout.id = ? AND payout.reconciliation_token = ?`,
    ).bind(
      reconciliationId,
      reconciliation.decision,
      reconciliation.actorSubject,
      reconciliation.actorRole,
      reconciliation.evidence,
      reconciliation.externalReference,
      reconciliation.reconciledAt,
      reconciliation.payoutId,
      reconciliationId,
    ),
    db.prepare(
      `UPDATE affiliate_payout_entries SET released_at = ?
        WHERE payout_id = ? AND released_at IS NULL
          AND EXISTS (
            SELECT 1 FROM affiliate_payouts
             WHERE id = ? AND status = 'cancelled' AND reconciliation_token = ?
          )`,
    ).bind(
      reconciliation.reconciledAt,
      reconciliation.payoutId,
      reconciliation.payoutId,
      reconciliationId,
    ),
    db.prepare(
      `INSERT OR IGNORE INTO affiliate_email_outbox
         (idempotency_key, affiliate_id, payout_id, kind, status, created_at)
       SELECT 'affiliate-payout-sent:' || payout.id, payout.affiliate_id, payout.id,
              'affiliate-payout-sent', 'pending', ?
         FROM affiliate_payouts AS payout
        WHERE payout.id = ? AND payout.status = 'paid' AND ? = 'confirm_paid'
          AND payout.reconciliation_token = ?`,
    ).bind(
      reconciliation.reconciledAt,
      reconciliation.payoutId,
      reconciliation.decision,
      reconciliationId,
    ),
    db.prepare(
      `INSERT OR IGNORE INTO affiliate_email_outbox
         (idempotency_key, affiliate_id, payout_id, kind, status, created_at)
       SELECT 'affiliate-payout-cancelled:' || payout.id, payout.affiliate_id, payout.id,
              'affiliate-payout-cancelled', 'pending', ?
         FROM affiliate_payouts AS payout
        WHERE payout.id = ? AND payout.status = 'cancelled' AND ? = 'cancel'
          AND payout.reconciliation_token = ?`,
    ).bind(
      reconciliation.reconciledAt,
      reconciliation.payoutId,
      reconciliation.decision,
      reconciliationId,
    ),
  ]);
  return { reconciled: results[0].meta.changes === 1 };
}

export type InstallmentCandidate = {
  cadence: "monthly" | "annual";
  qualifyingInstallmentsConsumed: number;
  lineKind: "subscription" | "proration" | "upgrade";
  eligibleRevenueMinor: number;
};

export type InstallmentEligibility =
  | { qualifies: true; installmentNumber: number }
  | { qualifies: false; reason: "zero_value" | "non_subscription_line" | "installment_limit_reached" };

export function decideInstallmentEligibility(
  candidate: InstallmentCandidate,
): InstallmentEligibility {
  if (candidate.eligibleRevenueMinor === 0) {
    return { qualifies: false, reason: "zero_value" };
  }
  if (candidate.lineKind !== "subscription") {
    return { qualifies: false, reason: "non_subscription_line" };
  }
  const installmentLimit = candidate.cadence === "annual" ? 1 : 12;
  if (candidate.qualifyingInstallmentsConsumed >= installmentLimit) {
    return { qualifies: false, reason: "installment_limit_reached" };
  }
  return {
    qualifies: true,
    installmentNumber: candidate.qualifyingInstallmentsConsumed + 1,
  };
}
