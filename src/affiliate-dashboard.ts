export type AffiliateDashboard = {
  accountId: number;
  referralCode: string;
  status: "active" | "suspended" | "closed" | "terms_required";
  stripePromotionCodeReady: boolean;
  stripeConnectStatus: "not_started" | "onboarding" | "ready" | "restricted";
  stripeConnectCountry: string | null;
  stripeConnectDetailsSubmitted: boolean;
  stripeConnectPayoutsEnabled: boolean;
  attributionCount: number;
  conversionCount: number;
  netCommissionMinor: number;
  pendingCommissionMinor: number;
  availableCommissionMinor: number;
  openReserveMinor: number;
  paidPayoutMinor: number;
  currency: "usd";
  payouts: Array<{
    id: string;
    amountMinor: number;
    status: "prepared" | "reconciliation" | "paid" | "cancelled";
    createdAt: number;
  }>;
};

export async function getAffiliateDashboardInDb(
  db: D1Database,
  accountId: number,
  now: number,
): Promise<AffiliateDashboard | null> {
  const results = await db.batch([
    db.prepare(
      `SELECT profile.account_id, profile.referral_code, profile.status,
              profile.stripe_promotion_code_id,
              profile.stripe_connect_status, profile.stripe_connect_country,
              profile.stripe_connect_details_submitted, profile.stripe_connect_payouts_enabled,
              (SELECT COUNT(*) FROM affiliate_attributions AS attribution
                WHERE attribution.affiliate_id = profile.account_id) AS attribution_count,
              (SELECT COUNT(DISTINCT occurrence.referred_account_id)
                 FROM affiliate_revenue_occurrences AS occurrence
                WHERE occurrence.affiliate_id = profile.account_id) AS conversion_count,
              COALESCE((SELECT SUM(entry.amount_minor) FROM affiliate_ledger_entries AS entry
                WHERE entry.affiliate_id = profile.account_id AND entry.currency = 'usd'), 0) AS net_commission_minor,
              COALESCE((SELECT SUM(entry.amount_minor) FROM affiliate_ledger_entries AS entry
                WHERE entry.affiliate_id = profile.account_id AND entry.currency = 'usd'
                  AND entry.available_at > ?
                  AND NOT EXISTS (SELECT 1 FROM affiliate_payout_entries AS allocation
                    WHERE allocation.ledger_entry_id = entry.id AND allocation.released_at IS NULL)), 0) AS pending_commission_minor,
              COALESCE((SELECT SUM(entry.amount_minor) FROM affiliate_ledger_entries AS entry
                WHERE entry.affiliate_id = profile.account_id AND entry.currency = 'usd'
                  AND entry.available_at <= ?
                  AND NOT EXISTS (SELECT 1 FROM affiliate_payout_entries AS allocation
                    WHERE allocation.ledger_entry_id = entry.id AND allocation.released_at IS NULL)
                  AND (entry.amount_minor <= 0 OR NOT EXISTS (SELECT 1 FROM affiliate_reserves AS reserve
                    WHERE reserve.occurrence_id = entry.occurrence_id AND reserve.status = 'open'))), 0) AS available_commission_minor,
              COALESCE((SELECT SUM(reserve.amount_minor) FROM affiliate_reserves AS reserve
                WHERE reserve.affiliate_id = profile.account_id AND reserve.currency = 'usd'
                  AND reserve.status = 'open'), 0) AS open_reserve_minor,
              COALESCE((SELECT SUM(payout.amount_minor) FROM affiliate_payouts AS payout
                WHERE payout.affiliate_id = profile.account_id AND payout.currency = 'usd'
                  AND payout.status = 'paid'), 0) AS paid_payout_minor
         FROM affiliate_profiles AS profile
        WHERE profile.account_id = ?`,
    ).bind(now, now, accountId),
    db.prepare(
      `SELECT id, amount_minor, status, created_at
         FROM affiliate_payouts
        WHERE affiliate_id = ? AND currency = 'usd'
        ORDER BY created_at DESC, id DESC LIMIT 25`,
    ).bind(accountId),
  ]);
  const row = results[0].results[0] as any;
  if (!row) return null;
  return {
    accountId: row.account_id,
    referralCode: row.referral_code,
    status: row.status,
    stripePromotionCodeReady: Boolean(row.stripe_promotion_code_id),
    stripeConnectStatus: row.stripe_connect_status,
    stripeConnectCountry: row.stripe_connect_country,
    stripeConnectDetailsSubmitted: row.stripe_connect_details_submitted === 1,
    stripeConnectPayoutsEnabled: row.stripe_connect_payouts_enabled === 1,
    attributionCount: row.attribution_count,
    conversionCount: row.conversion_count,
    netCommissionMinor: row.net_commission_minor,
    pendingCommissionMinor: row.pending_commission_minor,
    availableCommissionMinor: row.available_commission_minor,
    openReserveMinor: row.open_reserve_minor,
    paidPayoutMinor: row.paid_payout_minor,
    currency: "usd",
    payouts: (results[1].results as any[]).map((payout) => ({
      id: payout.id,
      amountMinor: payout.amount_minor,
      status: payout.status,
      createdAt: payout.created_at,
    })),
  };
}
