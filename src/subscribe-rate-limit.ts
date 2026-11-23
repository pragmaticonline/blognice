// Rate limiting for the public `POST /subscribe` endpoint (reader newsletter
// signups). Two bounded buckets in the existing `signup_rate_limits` table:
// one per client IP, one per tenant. Deliberately no per-email key: the email
// address is attacker-controlled, so a per-email bucket would let an attacker
// dictate table cardinality. Raw emails are never stored here.

const WINDOW_SECONDS = 3600;

// Generous for humans (subscribing is infrequent), tight enough that one IP
// cannot turn the confirmation mailer into a spam cannon.
export const SUBSCRIBE_IP_MAX = 20;
// Per-blog ceiling so a distributed flood against one blog is capped while a
// genuine viral spike still mostly fits; excess attempts retry next hour.
export const SUBSCRIBE_TENANT_MAX = 200;

type RateLimitContext = { env: { DB: D1Database } };

function windowStart(now: number): number {
  return now - (now % WINDOW_SECONDS);
}

async function hit(
  db: D1Database,
  key: string,
  start: number,
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO signup_rate_limits (ip, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(ip) DO UPDATE SET
         count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
         window_start = excluded.window_start
       RETURNING count`,
    )
    .bind(key, start)
    .first<{ count: number }>()
    .catch(() => null);
  return row?.count ?? 0;
}

export async function checkSubscribeRateLimit(
  c: RateLimitContext,
  ip: string,
  tenantId: number,
): Promise<{ allowed: boolean; retryAfter?: number }> {
  const now = Math.floor(Date.now() / 1000);
  const start = windowStart(now);
  const keys: Array<[string, number]> = [
    [`sub:ip:${ip.slice(0, 64)}`, SUBSCRIBE_IP_MAX],
    [`sub:tenant:${tenantId}`, SUBSCRIBE_TENANT_MAX],
  ];
  try {
    for (const [key, maximum] of keys) {
      const count = await hit(c.env.DB, key, start);
      if (count > maximum) {
        return { allowed: false, retryAfter: Math.max(1, start + WINDOW_SECONDS - now) };
      }
    }
  } catch {
    // Fail open: a D1 outage should not take down the subscribe box.
    return { allowed: true };
  }
  return { allowed: true };
}
