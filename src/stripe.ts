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

async function stripeRequest<T>(env: StripeEnv, path: string, params: URLSearchParams): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new Error("Stripe is not configured.");
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${env.STRIPE_SECRET_KEY}:`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
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

export function createCheckoutSession(env: StripeEnv, input: { accountId: number; email: string; successUrl: string; cancelUrl: string; priceId: string; customerId?: string | null }) {
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
