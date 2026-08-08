import { analyticsSql, type MetricsEnv } from "./metrics.ts";

export const POPULARITY_WINDOW_DAYS = 90;
export const POPULARITY_HALF_LIFE_DAYS = 21;
export const POPULARITY_ENGAGEMENT_BONUS = 1.5;
export const POPULARITY_MIN_READER_DAYS = 3;

export type PopularityEnv = MetricsEnv & { DB: D1Database };

export type DailyPopularity = {
  tenantId: number;
  path: string;
  day: string;
  readerDays: number;
  engagedReaders: number;
};

export type PopularityScore = {
  tenantId: number;
  path: string;
  score: number;
  readerDays30: number;
  readerDays90: number;
  engagedReaders30: number;
};

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function dayBefore(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return dateOnly(date);
}

function daysBetween(later: string, earlier: string): number {
  const end = Date.parse(`${later}T00:00:00.000Z`);
  const start = Date.parse(`${earlier}T00:00:00.000Z`);
  return Math.floor((end - start) / 86_400_000);
}

function integer(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function validPostPath(path: string): boolean {
  return /^\/[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(path);
}

export function calculatePopularity(rows: DailyPopularity[], today: string): PopularityScore[] {
  const scores = new Map<string, PopularityScore>();
  for (const row of rows) {
    const age = daysBetween(today, row.day);
    if (!Number.isSafeInteger(row.tenantId) || row.tenantId < 1 || !validPostPath(row.path) || age < 1 || age > POPULARITY_WINDOW_DAYS) continue;
    const key = `${row.tenantId}\n${row.path}`;
    const current = scores.get(key) || {
      tenantId: row.tenantId,
      path: row.path,
      score: 0,
      readerDays30: 0,
      readerDays90: 0,
      engagedReaders30: 0,
    };
    const readers = integer(row.readerDays);
    // Engagement is a bonus on top of a recorded read, never a way to create
    // popularity without readership. This also bounds forged event traffic.
    const engaged = Math.min(readers, integer(row.engagedReaders));
    const decay = 0.5 ** (age / POPULARITY_HALF_LIFE_DAYS);
    current.score += (readers + POPULARITY_ENGAGEMENT_BONUS * engaged) * decay;
    current.readerDays90 += readers;
    if (age <= 30) {
      current.readerDays30 += readers;
      current.engagedReaders30 += engaged;
    }
    scores.set(key, current);
  }
  return [...scores.values()]
    .filter((row) => row.readerDays30 >= POPULARITY_MIN_READER_DAYS)
    .sort((a, b) => b.score - a.score || b.readerDays30 - a.readerDays30 || a.path.localeCompare(b.path));
}

async function batches(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let start = 0; start < statements.length; start += 50)
    await db.batch(statements.slice(start, start + 50));
}

/**
 * Materialize anonymous Analytics Engine traffic into a tiny D1 ranking table.
 * The first successful run backfills 90 days; later runs only revisit days
 * since the last success. A failure leaves the previous snapshot untouched.
 */
export async function refreshPostPopularity(env: PopularityEnv, now = new Date()): Promise<number> {
  const today = dateOnly(now);
  const state = await env.DB.prepare("SELECT value FROM popularity_state WHERE key = 'last_success_day'")
    .first<{ value: string }>();
  const elapsed = state?.value && /^\d{4}-\d{2}-\d{2}$/.test(state.value)
    ? daysBetween(today, state.value)
    : POPULARITY_WINDOW_DAYS;
  const lookback = Math.max(1, Math.min(POPULARITY_WINDOW_DAYS, elapsed));
  const startDay = dayBefore(today, lookback);
  const range = `timestamp >= toDateTime('${startDay} 00:00:00') AND timestamp < toDateTime('${today} 00:00:00')`;

  const pageRows = await analyticsSql(env, `
    SELECT index1 AS tenant_id, blob1 AS path,
           formatDateTime(timestamp, '%Y-%m-%d') AS day,
           count(DISTINCT blob4) AS readers
      FROM blognice_pageviews
     WHERE ${range} AND blob1 != '/'
     GROUP BY tenant_id, path, day`);
  const engagedRows = await analyticsSql(env, `
    SELECT index1 AS tenant_id, blob2 AS path,
           formatDateTime(timestamp, '%Y-%m-%d') AS day,
           count(DISTINCT blob3) AS engaged
      FROM blognice_events
     WHERE ${range} AND blob1 = 'engaged_read'
     GROUP BY tenant_id, path, day`).catch((error) => {
       console.error(JSON.stringify({
         message: "popularity engagement query failed; using readership only",
         error: error instanceof Error ? error.message : String(error),
       }));
       return [];
     });

  const daily = new Map<string, DailyPopularity>();
  for (const row of pageRows) {
    const tenantId = integer(row.tenant_id);
    const path = String(row.path ?? "");
    const day = String(row.day ?? "");
    if (!tenantId || !validPostPath(path) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    daily.set(`${tenantId}\n${path}\n${day}`, {
      tenantId, path, day, readerDays: integer(row.readers), engagedReaders: 0,
    });
  }
  for (const row of engagedRows) {
    const tenantId = integer(row.tenant_id);
    const path = String(row.path ?? "");
    const day = String(row.day ?? "");
    const entry = daily.get(`${tenantId}\n${path}\n${day}`);
    if (entry) entry.engagedReaders = integer(row.engaged);
  }

  const updatedAt = Math.floor(now.getTime() / 1000);
  const upserts = [...daily.values()].map((row) => env.DB.prepare(
    `INSERT INTO post_popularity_daily
       (tenant_id, path, day, reader_days, engaged_readers, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, path, day) DO UPDATE SET
       reader_days = excluded.reader_days,
       engaged_readers = excluded.engaged_readers,
       updated_at = excluded.updated_at`
  ).bind(row.tenantId, row.path, row.day, row.readerDays, row.engagedReaders, updatedAt));
  await batches(env.DB, upserts);

  const windowStart = dayBefore(today, POPULARITY_WINDOW_DAYS);
  const stored = await env.DB.prepare(
    `SELECT tenant_id, path, day, reader_days, engaged_readers
       FROM post_popularity_daily WHERE day >= ? AND day < ?`
  ).bind(windowStart, today).all<{
    tenant_id: number; path: string; day: string; reader_days: number; engaged_readers: number;
  }>();
  const scores = calculatePopularity(stored.results.map((row) => ({
    tenantId: row.tenant_id,
    path: row.path,
    day: row.day,
    readerDays: row.reader_days,
    engagedReaders: row.engaged_readers,
  })), today);
  const scoreUpserts = scores.map((row) => env.DB.prepare(
    `INSERT INTO post_popularity
       (tenant_id, path, score, reader_days_30, reader_days_90, engaged_readers_30, calculated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, path) DO UPDATE SET
       score = excluded.score,
       reader_days_30 = excluded.reader_days_30,
       reader_days_90 = excluded.reader_days_90,
       engaged_readers_30 = excluded.engaged_readers_30,
       calculated_at = excluded.calculated_at`
  ).bind(row.tenantId, row.path, row.score, row.readerDays30, row.readerDays90, row.engagedReaders30, updatedAt));
  await batches(env.DB, scoreUpserts);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM post_popularity WHERE calculated_at < ?").bind(updatedAt),
    env.DB.prepare("DELETE FROM post_popularity_daily WHERE day < ?").bind(windowStart),
    env.DB.prepare(
      `INSERT INTO popularity_state (key, value, updated_at) VALUES ('last_success_day', ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(today, updatedAt),
  ]);
  return scores.length;
}
