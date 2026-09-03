export type NowPaymentsEnv = {
  NOWPAYMENTS_API_KEY?: string;
  NOWPAYMENTS_IPN_SECRET?: string;
};

export const NOWPAYMENTS_ANNUAL_USD = 36;
export const NOWPAYMENTS_ANNUAL_SECONDS = 365 * 24 * 60 * 60;

export function nowPaymentsConfigured(env: NowPaymentsEnv): boolean {
  return Boolean(env.NOWPAYMENTS_API_KEY && env.NOWPAYMENTS_IPN_SECRET);
}

/** NOWPayments signs JSON after recursively sorting object keys. */
export function canonicalizeIpn(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalizeIpn).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeIpn((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function request<T>(env: NowPaymentsEnv, path: string, init?: RequestInit): Promise<T> {
  if (!env.NOWPAYMENTS_API_KEY) throw new Error("NOWPayments is not configured.");
  const response = await fetch(`https://api.nowpayments.io/v1/${path}`, {
    ...init,
    headers: {
      "x-api-key": env.NOWPAYMENTS_API_KEY,
      "content-type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({})) as { message?: string } & T;
  if (!response.ok) throw new Error(body.message || `NOWPayments returned HTTP ${response.status}.`);
  return body;
}

export type NowPaymentsInvoice = { id: string | number; invoice_url?: string; payment_url?: string; pay_url?: string };

export function createAnnualInvoice(env: NowPaymentsEnv, input: { orderId: string; priceUsdMinor: number; callbackUrl: string; successUrl: string; cancelUrl: string; experimentKey?: string | null; experimentVariant?: "control" | "focused" | null }) {
  return request<NowPaymentsInvoice>(env, "invoice", {
    method: "POST",
    body: JSON.stringify({
      price_amount: input.priceUsdMinor / 100,
      price_currency: "usd",
      order_id: input.orderId,
      order_description: input.experimentKey && input.experimentVariant
        ? `blognice pro yearly (${input.experimentKey}/${input.experimentVariant})`
        : "blognice pro yearly",
      ipn_callback_url: input.callbackUrl,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    }),
  });
}

export type NowPaymentsPayment = {
  payment_id?: string | number;
  payment_status?: string;
  order_id?: string;
  price_amount?: number;
  price_currency?: string;
  pay_currency?: string;
  pay_amount?: string;
  actually_paid?: string;
};

export function getPayment(env: NowPaymentsEnv, paymentId: string) {
  return request<NowPaymentsPayment>(env, `payment/${encodeURIComponent(paymentId)}`);
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeHexEqual(actual: string, expected: string): boolean {
  if (!/^[0-9a-f]{128}$/.test(actual) || !/^[0-9a-f]{128}$/.test(expected)) return false;
  let difference = 0;
  for (let i = 0; i < 128; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

export async function verifyNowPaymentsIpn(rawBody: string, signature: string | undefined, secret: string | undefined): Promise<boolean> {
  if (!signature || !secret) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(rawBody); } catch { return false; }
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const digest = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonicalizeIpn(parsed))));
  return constantTimeHexEqual(digest, signature.trim().toLowerCase());
}

export function isTerminalPaidStatus(status: string | undefined): boolean {
  return status === "finished";
}

function decimalParts(value: string | number | undefined): { coefficient: bigint; scale: number } | null {
  const raw = String(value ?? "").trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) return null;
  const fraction = match[2] || "";
  const coefficient = BigInt(`${match[1]}${fraction}`);
  return coefficient > 0n ? { coefficient, scale: fraction.length } : null;
}

/** Compare provider-denominated amounts exactly; missing or malformed facts fail closed. */
export function isNowPaymentsAmountFullyPaid(payment: Pick<NowPaymentsPayment, "pay_amount" | "actually_paid">): boolean {
  const expected = decimalParts(payment.pay_amount);
  const actual = decimalParts(payment.actually_paid);
  if (!expected || !actual) return false;
  const scale = Math.max(expected.scale, actual.scale);
  const normalizedExpected = expected.coefficient * 10n ** BigInt(scale - expected.scale);
  const normalizedActual = actual.coefficient * 10n ** BigInt(scale - actual.scale);
  return normalizedActual >= normalizedExpected;
}

export function replayCryptoEntitlements(grants: Array<{ creditedAt: number }>, now: number): number | null {
  let expiry = now;
  for (const grant of [...grants].sort((a, b) => a.creditedAt - b.creditedAt)) {
    expiry = Math.max(expiry, grant.creditedAt) + NOWPAYMENTS_ANNUAL_SECONDS;
  }
  return grants.length ? expiry : null;
}
