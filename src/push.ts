import webpush from "web-push";

export type BrowserPushSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export type PushPayload = {
  title: string;
  body: string;
  url: string;
  tag: string;
};

export type PushConfig = {
  VAPID_SUBJECT?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
};

const PUSH_SERVICE_HOSTS = new Set(["fcm.googleapis.com", "web.push.apple.com", "updates.push.services.mozilla.com"]);

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
  try {
    const padded = value + "=".repeat((4 - value.length % 4) % 4);
    const raw = atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(raw, (character) => character.charCodeAt(0));
  } catch { return null; }
}

export function pushConfigured(env: PushConfig): boolean {
  return Boolean(env.VAPID_SUBJECT && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

export async function validBrowserPushSubscription(value: unknown): Promise<boolean> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const keys = candidate.keys as Record<string, unknown> | undefined;
  if (typeof candidate.endpoint !== "string" || candidate.endpoint.length > 2048) return false;
  let endpoint: URL;
  try { endpoint = new URL(candidate.endpoint); } catch { return false; }
  const host = endpoint.hostname.toLowerCase();
  if (endpoint.protocol !== "https:" || (endpoint.port && endpoint.port !== "443") || endpoint.username || endpoint.password || endpoint.hash || endpoint.hostname.includes(":")) return false;
  if (!PUSH_SERVICE_HOSTS.has(host) && !host.endsWith(".notify.windows.com")) return false;
  if (!keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") return false;
  const p256dh = decodeBase64Url(keys.p256dh);
  const auth = decodeBase64Url(keys.auth);
  if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 4 || !auth || auth.length !== 16) return false;
  try {
    await crypto.subtle.importKey("raw", p256dh, { name: "ECDH", namedCurve: "P-256" }, false, []);
    return true;
  } catch { return false; }
}

export async function sendBrowserPush(env: PushConfig, subscription: BrowserPushSubscription, payload: PushPayload): Promise<number> {
  if (!pushConfigured(env)) throw new Error("Browser push is not configured.");
  const response = await Promise.race([
    webpush.sendNotification(subscription, JSON.stringify(payload), {
    TTL: 86400,
    vapidDetails: { subject: env.VAPID_SUBJECT!, publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY! },
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(Object.assign(new Error("Push provider timeout."), { statusCode: 408 })), 10_000)),
  ]);
  return response.statusCode;
}
