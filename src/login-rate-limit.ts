import { sha256hex } from "./auth";

const WINDOW_SECONDS = 3600;
const IP_MAX = 30;
const EMAIL_MAX = 10;

type RateLimitContext = { env: { DB: D1Database } };

async function emailKey(email: string): Promise<string> {
  return `login:email:${await sha256hex(email)}`;
}

export async function checkLoginRateLimit(
  c: RateLimitContext,
  ip: string,
  email: string,
): Promise<{ allowed: boolean; retryAfter?: number }> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % WINDOW_SECONDS);
  let emailMax = EMAIL_MAX;
  try {
    const override = await c.env.DB.prepare(
      "SELECT max_logins_per_hour FROM staff_rate_limit_overrides WHERE account_id = (SELECT id FROM accounts WHERE email = ? LIMIT 1)",
    ).bind(email).first<{ max_logins_per_hour: number | null }>();
    if (override?.max_logins_per_hour && override.max_logins_per_hour > 0) emailMax = override.max_logins_per_hour;
  } catch {}
  const keys: Array<[string, number]> = [[`login:ip:${ip}`, IP_MAX], [await emailKey(email), emailMax]];
  for (const [key, maximum] of keys) {
    const row = await c.env.DB.prepare("SELECT count, window_start FROM signup_rate_limits WHERE ip = ?")
      .bind(key).first<{ count: number; window_start: number }>().catch(() => null);
    if (row?.window_start === windowStart && row.count >= maximum) {
      return { allowed: false, retryAfter: Math.max(1, windowStart + WINDOW_SECONDS - now) };
    }
  }
  return { allowed: true };
}

export async function recordFailedLogin(c: RateLimitContext, ip: string, email: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % WINDOW_SECONDS);
  for (const key of [`login:ip:${ip}`, await emailKey(email)]) {
    await c.env.DB.prepare(
      `INSERT INTO signup_rate_limits (ip, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(ip) DO UPDATE SET
         count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
         window_start = excluded.window_start`,
    ).bind(key, windowStart).run().catch(() => undefined);
  }
}

export async function clearFailedLoginForEmail(c: RateLimitContext, email: string): Promise<void> {
  await c.env.DB.prepare("DELETE FROM signup_rate_limits WHERE ip = ?")
    .bind(await emailKey(email)).run().catch(() => undefined);
}
