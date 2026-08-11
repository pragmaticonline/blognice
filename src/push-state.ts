export type PushDeliveryDisposition = "sent" | "expired" | "retry" | "campaign-failed" | "dead";

export function classifyPushDelivery(status: number): PushDeliveryDisposition {
  if (status >= 200 && status < 300) return "sent";
  if (status === 404 || status === 410) return "expired";
  if (status === 0 || status === 408 || status === 425 || status === 429 || status >= 500) return "retry";
  if (status >= 400 && status < 500) return "campaign-failed";
  return "dead";
}

export function canAdmitPushSubscription(existing: boolean, count: number, limit = 1000): boolean {
  return existing || count < limit;
}

export function deliveryClaimable(status: string, claimedAt: number | null, now: number, leaseSeconds = 300): boolean {
  return status === "pending" || (status === "claimed" && claimedAt != null && claimedAt < now - leaseSeconds);
}
