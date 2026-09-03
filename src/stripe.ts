export type StripeEnv = {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_ID?: string;
  STRIPE_MONTHLY_PRICE_ID?: string;
  STRIPE_YEARLY_PRICE_ID?: string;
  STRIPE_PORTAL_CONFIGURATION_ID?: string;
};

export function stripeConfigured(env: StripeEnv): boolean {
  return Boolean(env.STRIPE_SECRET_KEY && (env.STRIPE_PRICE_ID || env.STRIPE_MONTHLY_PRICE_ID || env.STRIPE_YEARLY_PRICE_ID));
}

async function stripeRequest<T>(env: StripeEnv, path: string, params: URLSearchParams, idempotencyKey?: string): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new Error("Stripe is not configured.");
  const headers: Record<string, string> = {
    Authorization: `Basic ${btoa(`${env.STRIPE_SECRET_KEY}:`)}`,
    "content-type": "application/x-www-form-urlencoded",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers,
    body: params,
  });
  const body = await response.json().catch(() => ({})) as { error?: { message?: string } } & T;
  if (!response.ok) throw new Error(body.error?.message || `Stripe returned HTTP ${response.status}.`);
  return body;
}

async function stripeGet<T>(env: StripeEnv, path: string): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new Error("Stripe is not configured.");
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Basic ${btoa(`${env.STRIPE_SECRET_KEY}:`)}` },
  });
  const body = await response.json().catch(() => ({})) as { error?: { message?: string } } & T;
  if (!response.ok) throw new Error(body.error?.message || `Stripe returned HTTP ${response.status}.`);
  return body;
}

export type StripeSubscription = {
  id: string;
  customer?: string;
  created?: number;
  status?: string;
  current_period_end?: number;
  cancel_at_period_end?: boolean;
  items?: { data?: Array<{ price?: { id?: string }; current_period_end?: number }> };
};

export type CheckoutSubscriptionDecision = "adopt" | "same" | "ignore";

/**
 * Decide whether a completed Checkout session may become the account's current
 * subscription. Stripe event delivery order is not authoritative: a delayed
 * Checkout event for an older subscription can arrive after a newer purchase.
 * The subscriptions' own creation timestamps provide the stable ordering.
 */
export function checkoutSubscriptionDecision(input: {
  currentId?: string | null;
  currentCreated?: number | null;
  incomingId: string;
  incomingCreated?: number | null;
}): CheckoutSubscriptionDecision {
  if (!input.currentId) return "adopt";
  if (input.currentId === input.incomingId) return "same";
  if (!input.currentCreated || !input.incomingCreated) return "ignore";
  return input.incomingCreated > input.currentCreated ? "adopt" : "ignore";
}

export function subscriptionEventMatchesCurrent(currentId: string | null | undefined, incomingId: string): boolean {
  return !currentId || currentId === incomingId;
}

export function retrieveSubscription(env: StripeEnv, subscriptionId: string) {
  return stripeGet<StripeSubscription>(env, `subscriptions/${encodeURIComponent(subscriptionId)}`);
}

export function createCheckoutSession(env: StripeEnv, input: { accountId: number; email: string; successUrl: string; cancelUrl: string; priceId: string; customerId?: string | null; affiliateCheckoutId?: string | null; promotionCodeId?: string | null; experimentKey?: string | null; experimentVariant?: "control" | "focused" | null }) {
  const params = new URLSearchParams();
  params.set("mode", "subscription");
  params.set("line_items[0][price]", input.priceId);
  params.set("line_items[0][quantity]", "1");
  params.set("client_reference_id", String(input.accountId));
  params.set("customer_email", input.email);
  if (input.customerId) { params.delete("customer_email"); params.set("customer", input.customerId); }
  params.set("success_url", input.successUrl);
  params.set("cancel_url", input.cancelUrl);
  params.set("metadata[account_id]", String(input.accountId));
  params.set("subscription_data[metadata][account_id]", String(input.accountId));
  if (input.affiliateCheckoutId) {
    params.set("metadata[affiliate_checkout_id]", input.affiliateCheckoutId);
    params.set("subscription_data[metadata][affiliate_checkout_id]", input.affiliateCheckoutId);
  }
  if (input.experimentKey && input.experimentVariant) {
    params.set("metadata[experiment_key]", input.experimentKey);
    params.set("metadata[experiment_variant]", input.experimentVariant);
    params.set("subscription_data[metadata][experiment_key]", input.experimentKey);
    params.set("subscription_data[metadata][experiment_variant]", input.experimentVariant);
  }
  if (input.promotionCodeId) {
    params.set("discounts[0][promotion_code]", input.promotionCodeId);
  }
  return stripeRequest<{ id: string; url: string }>(env, "checkout/sessions", params);
}

export async function createAffiliateConnectedAccount(
  env: StripeEnv,
  input: { affiliateAccountId: number; email: string; country: string; allowedCountries: ReadonlySet<string> },
): Promise<{ connectedAccountId: string }> {
  const country = input.country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new Error("A valid two-letter payout country is required.");
  if (!input.allowedCountries.has(country)) throw new Error("Affiliate payouts are unavailable in that country.");
  const params = new URLSearchParams();
  params.set("type", "express");
  params.set("country", country);
  params.set("email", input.email.trim().toLowerCase());
  params.set("capabilities[transfers][requested]", "true");
  params.set("metadata[blognice_affiliate_account_id]", String(input.affiliateAccountId));
  const account = await stripeRequest<{ id: string }>(
    env,
    "accounts",
    params,
    `blognice-affiliate-connect-${input.affiliateAccountId}`,
  );
  if (!account.id) throw new Error("Stripe did not return a connected account ID.");
  return { connectedAccountId: account.id };
}

export async function createAffiliateConnectOnboardingLink(
  env: StripeEnv,
  input: { connectedAccountId: string; refreshUrl: string; returnUrl: string },
): Promise<{ url: string; expiresAt: number }> {
  if (!/^acct_[A-Za-z0-9]+$/.test(input.connectedAccountId)) throw new Error("Stripe connected account ID is invalid.");
  for (const value of [input.refreshUrl, input.returnUrl]) {
    if (new URL(value).protocol !== "https:") throw new Error("Stripe onboarding return URLs must use HTTPS.");
  }
  const params = new URLSearchParams();
  params.set("account", input.connectedAccountId);
  params.set("refresh_url", input.refreshUrl);
  params.set("return_url", input.returnUrl);
  params.set("type", "account_onboarding");
  const link = await stripeRequest<{ url: string; expires_at: number }>(env, "account_links", params);
  if (!link.url || !link.expires_at) throw new Error("Stripe did not return an onboarding link.");
  return { url: link.url, expiresAt: link.expires_at };
}

export async function createAffiliateTransfer(
  env: StripeEnv,
  input: {
    payoutId: string;
    connectedAccountId: string;
    amountMinor: number;
    currency: "usd";
  },
): Promise<{ transferId: string }> {
  if (!/^acct_[A-Za-z0-9]+$/.test(input.connectedAccountId)) throw new Error("Stripe connected account ID is invalid.");
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new Error("Stripe transfer amount is invalid.");
  if (!input.payoutId || input.payoutId.length > 100) throw new Error("Affiliate payout ID is invalid.");
  const params = new URLSearchParams();
  params.set("amount", String(input.amountMinor));
  params.set("currency", input.currency);
  params.set("destination", input.connectedAccountId);
  params.set("transfer_group", `affiliate_payout:${input.payoutId}`);
  params.set("metadata[affiliate_payout_id]", input.payoutId);
  const transfer = await stripeRequest<{ id: string }>(
    env,
    "transfers",
    params,
    `affiliate-payout:${input.payoutId}`,
  );
  if (!transfer.id) throw new Error("Stripe did not return a transfer ID.");
  return { transferId: transfer.id };
}

type StripeAffiliateCoupon = {
  id: string;
  percent_off?: number | null;
  duration?: string;
  duration_in_months?: number | null;
  valid?: boolean;
};

export async function createAffiliatePromotionCode(
  env: StripeEnv,
  input: { couponId: string; referralCode: string; affiliateAccountId: number },
): Promise<{ promotionCodeId: string; customerCode: string }> {
  const customerCode = input.referralCode.toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(customerCode)) {
    throw new Error("Affiliate referral code is not valid for Stripe.");
  }
  const coupon = await stripeGet<StripeAffiliateCoupon>(
    env,
    `coupons/${encodeURIComponent(input.couponId)}`,
  );
  if (
    coupon.valid !== true
    || coupon.percent_off !== 10
    || coupon.duration !== "repeating"
    || coupon.duration_in_months !== 12
  ) {
    throw new Error("Stripe affiliate coupon must be valid and provide 10% off for 12 months.");
  }
  const params = new URLSearchParams();
  params.set("promotion[type]", "coupon");
  params.set("promotion[coupon]", coupon.id);
  params.set("code", customerCode);
  params.set("metadata[affiliate_account_id]", String(input.affiliateAccountId));
  const promotion = await stripeRequest<{ id: string; code: string }>(
    env,
    "promotion_codes",
    params,
    `affiliate-promotion:${input.affiliateAccountId}`,
  );
  return { promotionCodeId: promotion.id, customerCode: promotion.code };
}

export function createDomainCheckoutSession(env: StripeEnv, input: {
  accountId: number;
  tenantId: number;
  email: string;
  customerId?: string | null;
  domain: string;
  duration: number;
  privacy: string;
  amountCents: number;
  currency?: string;
  successUrl: string;
  cancelUrl: string;
  contact: { name: string; email: string; phone_cc: string; phone: string; address1: string; city: string; state: string; zip: string; country: string; org?: string };
}) {
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("line_items[0][price_data][currency]", (input.currency || "usd").toLowerCase());
  params.set("line_items[0][price_data][unit_amount]", String(input.amountCents));
  params.set("line_items[0][price_data][product_data][name]", `Domain ${input.domain} — ${input.duration} year${input.duration > 1 ? "s" : ""}`);
  params.set("line_items[0][price_data][product_data][description]", `Registration via Dynadot (${input.privacy} privacy)`);
  params.set("line_items[0][quantity]", "1");
  params.set("client_reference_id", String(input.accountId));
  params.set("customer_email", input.email);
  if (input.customerId) { params.delete("customer_email"); params.set("customer", input.customerId); }
  params.set("success_url", input.successUrl);
  params.set("cancel_url", input.cancelUrl);
  params.set("metadata[account_id]", String(input.accountId));
  params.set("metadata[tenant_id]", String(input.tenantId));
  params.set("metadata[domain]", input.domain);
  params.set("metadata[duration]", String(input.duration));
  params.set("metadata[privacy]", input.privacy);
  params.set("metadata[type]", "domain_purchase");
  params.set("metadata[contact_name]", input.contact.name.slice(0, 500));
  params.set("metadata[contact_email]", input.contact.email.slice(0, 500));
  params.set("metadata[contact_phone_cc]", input.contact.phone_cc.slice(0, 500));
  params.set("metadata[contact_phone]", input.contact.phone.slice(0, 500));
  params.set("metadata[contact_address1]", input.contact.address1.slice(0, 500));
  params.set("metadata[contact_city]", input.contact.city.slice(0, 500));
  params.set("metadata[contact_state]", (input.contact.state || "").slice(0, 500));
  params.set("metadata[contact_zip]", input.contact.zip.slice(0, 500));
  params.set("metadata[contact_country]", input.contact.country.slice(0, 500));
  if (input.contact.org) params.set("metadata[contact_org]", input.contact.org.slice(0, 500));
  return stripeRequest<{ id: string; url: string }>(env, "checkout/sessions", params);
}

export function createPortalSession(env: StripeEnv, customerId: string, returnUrl: string) {
  const params = new URLSearchParams({ customer: customerId, return_url: returnUrl });
  if (env.STRIPE_PORTAL_CONFIGURATION_ID) params.set("configuration", env.STRIPE_PORTAL_CONFIGURATION_ID);
  return stripeRequest<{ id: string; url: string }>(env, "billing_portal/sessions", params);
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeHexEqual(actual: string, expected: string): boolean {
  // Stripe sends a SHA-256 HMAC as 64 lowercase hexadecimal characters. Keep
  // the comparison length fixed so a valid-looking signature is not checked
  // with an ordinary short-circuiting string comparison.
  if (!/^[0-9a-f]{64}$/.test(actual) || !/^[0-9a-f]{64}$/.test(expected)) return false;
  const decode = (value: string) => Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
  const left = decode(actual);
  const right = decode(expected);
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean };
  if (typeof subtle.timingSafeEqual === "function") return subtle.timingSafeEqual(left, right);
  // Node's test Web Crypto currently lacks timingSafeEqual; retain a fixed-
  // length fallback so local tests exercise the same comparison semantics.
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function verifyStripeSignature(rawBody: string, signature: string | undefined, secret: string | undefined): Promise<boolean> {
  if (!signature || !secret) return false;
  const parts: Record<string, string[]> = {};
  for (const part of signature.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    (parts[name] ||= []).push(value);
  }
  const timestamp = Number(parts.t?.[0]);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300 || !parts.v1?.length) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`)));
  let matched = false;
  for (const candidate of parts.v1) matched = constantTimeHexEqual(digest, candidate) || matched;
  return matched;
}
