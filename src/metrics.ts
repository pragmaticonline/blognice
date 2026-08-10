export const METRICS_DATASET = "blognice_pageviews";
export const EVENTS_DATASET = "blognice_events";
export const ANALYTICS_CONSENT_VERSION = "v1";
const CONSENT_COUNTRIES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  "IS", "LI", "NO", "GB", "CH",
]);

/** Country-gated consent is a product decision, not proof of residency. */
export function analyticsConsentRequired(country: unknown): boolean {
  const code = String(country ?? "").trim().toUpperCase();
  return CONSENT_COUNTRIES.has(code);
}

/**
 * Analytics Engine schema for blognice_pageviews:
 *   index1: tenant id (sampling key)
 *   blob1: path
 *   blob2: external referring hostname, or an empty string
 *   blob3: visitor country code
 *   blob4: anonymous first-party visitor id
 *   blob5: broad device category (desktop/mobile/tablet)
 *   blob6: browser family (Chrome/Safari/Firefox/Edge/Other)
 *   double1: page-view count (always 1)
 */

export type MetricsEnv = {
  DB?: D1Database;
  METRICS: AnalyticsEngineDataset;
  EVENTS: AnalyticsEngineDataset;
  METRICS_ARCHIVE: R2Bucket;
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_TOKEN?: string;
};

export type MetricSummary = { views: number; visitors: number };
export type MetricDay = MetricSummary & { date: string };
export type MetricPage = MetricSummary & { path: string };
export type MetricReferrer = { referrer: string; views: number };
export type MetricBreakdown = { name: string; views: number };
export type AudioMetric = { path: string; starts: number; completions: number };
export type AuditEntry = { occurredAt: string; action: string; target: string; actor: string; events: number };

export type MetricsReport = {
  days: number;
  summary: MetricSummary;
  daily: MetricDay[];
  pages: MetricPage[];
  referrers: MetricReferrer[];
  countries: MetricBreakdown[];
  devices: MetricBreakdown[];
  browsers: MetricBreakdown[];
  audio: { starts: number; completions: number; pages: AudioMetric[] };
};

type SqlResponse = { data?: Record<string, unknown>[]; errors?: unknown[] };

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function analyticsConfig(env: MetricsEnv): { accountId: string; token: string } | null {
  const accountId = env.CF_ACCOUNT_ID?.trim();
  const token = env.CF_ANALYTICS_TOKEN?.trim();
  return accountId && token ? { accountId, token } : null;
}

export function metricsConfigured(env: MetricsEnv): boolean {
  return analyticsConfig(env) !== null;
}

export async function analyticsSql(
  env: MetricsEnv,
  query: string
): Promise<Record<string, unknown>[]> {
  const config = analyticsConfig(env);
  if (!config) throw new Error("Metrics reporting is not configured.");

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/analytics_engine/sql`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "text/plain; charset=utf-8",
      },
      body: query,
    }
  );
  const responseText = await response.text();
  let result: SqlResponse = {};
  try {
    result = JSON.parse(responseText) as SqlResponse;
  } catch {
    throw new Error(`Analytics Engine returned an invalid response (${response.status}).`);
  }
  if (!response.ok) {
    const detail = JSON.stringify(result.errors ?? result).slice(0, 600);
    // Cloudflare creates an Analytics Engine dataset on its first write. Until
    // that beacon arrives, querying the configured name reports a missing table;
    // for a new blog this is an empty report, not an operational failure.
    if (/unknown table|table .* (?:does not|doesn't) exist|not found/i.test(detail)) return [];
    throw new Error(`Analytics Engine query failed (${response.status}): ${detail}`);
  }
  if (!Array.isArray(result.data)) {
    throw new Error(`Analytics Engine response contained no data (${response.status}).`);
  }
  return result.data;
}

export function reportQueries(tenantId: number, days: number) {
  const tenant = sqlString(String(tenantId));
  const interval = Math.max(1, Math.min(90, Math.trunc(days)));
  const where = `index1 = ${tenant} AND timestamp >= NOW() - INTERVAL '${interval}' DAY`;
  const views = "SUM(_sample_interval)";
  const visitors = "count(DISTINCT blob4)";

  return {
    summary: `SELECT ${views} AS views, ${visitors} AS visitors FROM ${METRICS_DATASET} WHERE ${where}`,
    daily: `SELECT formatDateTime(timestamp, '%Y-%m-%d') AS date, ${views} AS views, ${visitors} AS visitors FROM ${METRICS_DATASET} WHERE ${where} GROUP BY date ORDER BY date`,
    pages: `SELECT blob1 AS path, ${views} AS views, ${visitors} AS visitors FROM ${METRICS_DATASET} WHERE ${where} GROUP BY path ORDER BY views DESC LIMIT 50`,
    referrers: `SELECT blob2 AS referrer, ${views} AS views FROM ${METRICS_DATASET} WHERE ${where} AND blob2 != '' GROUP BY referrer ORDER BY views DESC LIMIT 25`,
    countries: `SELECT blob3 AS name, ${views} AS views FROM ${METRICS_DATASET} WHERE ${where} AND blob3 != '' GROUP BY name ORDER BY views DESC LIMIT 25`,
    devices: `SELECT blob5 AS name, ${views} AS views FROM ${METRICS_DATASET} WHERE ${where} AND blob5 != '' GROUP BY name ORDER BY views DESC LIMIT 10`,
    browsers: `SELECT blob6 AS name, ${views} AS views FROM ${METRICS_DATASET} WHERE ${where} AND blob6 != '' GROUP BY name ORDER BY views DESC LIMIT 10`,
    audioSummary: `SELECT sumIf(_sample_interval, blob1 = 'audio_start') AS starts, sumIf(_sample_interval, blob1 = 'audio_complete') AS completions FROM ${EVENTS_DATASET} WHERE ${where}`,
    audioPages: `SELECT blob2 AS path, sumIf(_sample_interval, blob1 = 'audio_start') AS starts, sumIf(_sample_interval, blob1 = 'audio_complete') AS completions FROM ${EVENTS_DATASET} WHERE ${where} AND blob1 IN ('audio_start', 'audio_complete') GROUP BY path ORDER BY starts DESC LIMIT 25`,
  };
}

export async function metricsReport(
  env: MetricsEnv,
  tenantId: number,
  days: number
): Promise<MetricsReport> {
  const safeDays = [7, 30, 90].includes(days) ? days : 30;
  const queries = reportQueries(tenantId, safeDays);
  // The headline query is required. A secondary breakdown should not take the
  // entire report down if Cloudflare rejects one optional expression.
  const summaryRows = await analyticsSql(env, queries.summary);
  const optionalQuery = (name: string, query: string) =>
    analyticsSql(env, query).catch((error) => {
      console.error(JSON.stringify({
        message: "optional metrics query failed",
        query: name,
        error: error instanceof Error ? error.message : String(error),
      }));
      return [];
    });
  const [dailyRows, pageRows, referrerRows, countryRows, deviceRows, browserRows, audioSummaryRows, audioPageRows] = await Promise.all([
    optionalQuery("daily", queries.daily),
    optionalQuery("pages", queries.pages),
    optionalQuery("referrers", queries.referrers),
    optionalQuery("countries", queries.countries),
    optionalQuery("devices", queries.devices),
    optionalQuery("browsers", queries.browsers),
    optionalQuery("audio summary", queries.audioSummary),
    optionalQuery("audio pages", queries.audioPages),
  ]);
  const summary = summaryRows[0] ?? {};
  const audioSummary = audioSummaryRows[0] ?? {};
  return {
    days: safeDays,
    summary: {
      views: numberValue(summary.views),
      visitors: numberValue(summary.visitors),
    },
    daily: dailyRows.map((row) => ({
      date: String(row.date ?? ""),
      views: numberValue(row.views),
      visitors: numberValue(row.visitors),
    })),
    pages: pageRows.map((row) => ({
      path: String(row.path ?? "/"),
      views: numberValue(row.views),
      visitors: numberValue(row.visitors),
    })),
    referrers: referrerRows.map((row) => ({
      referrer: String(row.referrer ?? ""),
      views: numberValue(row.views),
    })),
    countries: countryRows.map((row) => ({ name: String(row.name ?? ""), views: numberValue(row.views) })),
    devices: deviceRows.map((row) => ({ name: String(row.name ?? "Other"), views: numberValue(row.views) })),
    browsers: browserRows.map((row) => ({ name: String(row.name ?? "Other"), views: numberValue(row.views) })),
    audio: {
      starts: numberValue(audioSummary.starts),
      completions: numberValue(audioSummary.completions),
      pages: audioPageRows.map((row) => ({
        path: String(row.path ?? "/"),
        starts: numberValue(row.starts),
        completions: numberValue(row.completions),
      })),
    },
  };
}

export async function auditReport(
  env: MetricsEnv,
  tenantId: number,
  days = 90
): Promise<AuditEntry[]> {
  const interval = Math.max(1, Math.min(90, Math.trunc(days)));
  const rows = await analyticsSql(
    env,
    `SELECT formatDateTime(timestamp, '%Y-%m-%d %H:%i:%S') AS occurred_at,
            blob1 AS action, blob2 AS target, blob3 AS actor,
            SUM(_sample_interval) AS events
       FROM ${EVENTS_DATASET}
      WHERE index1 = ${sqlString(String(tenantId))}
        AND timestamp >= NOW() - INTERVAL '${interval}' DAY
        AND blob1 LIKE 'audit:%'
      GROUP BY occurred_at, action, target, actor
      ORDER BY occurred_at DESC LIMIT 200`
  );
  return rows.map((row) => ({
    occurredAt: String(row.occurred_at ?? ""),
    action: String(row.action ?? "").replace(/^audit:/, ""),
    target: String(row.target ?? ""),
    actor: String(row.actor ?? ""),
    events: numberValue(row.events),
  }));
}

export function recordPageView(
  env: MetricsEnv,
  tenantId: number,
  event: { path: string; referrer: string; country: string; visitor: string; device: string; browser: string }
): void {
  env.METRICS.writeDataPoint({
    indexes: [String(tenantId)],
    blobs: [event.path, event.referrer, event.country, event.visitor, event.device, event.browser],
    doubles: [1],
  });
}

export function recordCustomEvent(
  env: MetricsEnv,
  tenantId: number,
  event: { name: "audio_start" | "audio_complete" | "engaged_read"; path: string; visitor: string; country: string; device: string; browser: string }
): void {
  env.EVENTS.writeDataPoint({
    indexes: [String(tenantId)],
    blobs: [event.name, event.path, event.visitor, event.country, event.device, event.browser],
    doubles: [1],
  });
}

export function recordAuditEvent(
  env: MetricsEnv,
  tenantId: number,
  event: { action: string; target: string; actor: string }
): void {
  env.EVENTS.writeDataPoint({
    indexes: [String(tenantId)],
    blobs: [`audit:${event.action}`, event.target.slice(0, 160), event.actor.slice(0, 80), "", "", ""],
    doubles: [1],
  });
}

export function metricsBeacon(consentRequired = true): string {
  const bannerMarkup = `<strong>Help us improve blognice (optional).</strong><span> We use pseudonymous, aggregate analytics to understand what readers find useful. This does not affect reading, listening, or subscribing. Declining only means we won’t collect optional usage analytics.</span><button type="button" data-consent="granted">Allow analytics</button><button type="button" data-consent="denied">Decline analytics</button><a href="https://www.blognice.com/privacy">Privacy details</a>`;
  const serializedBannerMarkup = JSON.stringify(bannerMarkup).replaceAll("<", "\\u003c");
  return `<script>(function(){
    if(navigator.webdriver||document.visibilityState==="prerender")return;
    var required=${consentRequired ? "true" : "false"},consentKey="blognice-analytics-consent-${ANALYTICS_CONSENT_VERSION}",visitorKey="blognice-visitor",visitor="",active=false,engagementStarted=false;
    function readConsent(){try{return localStorage.getItem(consentKey)||""}catch(e){return ""}}
    function writeConsent(value){try{localStorage.setItem(consentKey,value)}catch(e){}}
    function removeVisitor(){try{localStorage.removeItem(visitorKey)}catch(e){}visitor="";active=false}
    function send(url,payload){if(!active)return;payload.consent="${ANALYTICS_CONSENT_VERSION}";fetch(url,{method:"POST",headers:{"content-type":"application/json","x-blognice-consent":"${ANALYTICS_CONSENT_VERSION}"},body:JSON.stringify(payload),keepalive:true,credentials:"omit"}).catch(function(){})}
    function referrerHost(){try{var ref=document.referrer;if(!ref)return "";var host=new URL(ref).hostname.toLowerCase();return host===location.hostname.toLowerCase()?"":host}catch(e){return ""}}
    function setupEngagement(){if(engagementStarted||!document.querySelector("article.post-page"))return;engagementStarted=true;var sent=false,visible=0,visibleSince=document.visibilityState==="visible"?Date.now():0,timer=0;function elapsed(){return visible+(visibleSince?Date.now()-visibleSince:0)}function cleanup(){if(timer)clearInterval(timer);window.removeEventListener("scroll",check);document.removeEventListener("visibilitychange",visibility)}function check(){if(sent||!active)return;var root=document.documentElement,progress=(window.scrollY+window.innerHeight)/Math.max(1,root.scrollHeight);if(elapsed()>=30000&&progress>=.5){sent=true;send("/_blognice/events",{event:"engaged_read",path:location.pathname,visitor:visitor});cleanup()}}function visibility(){if(document.visibilityState==="visible"){visibleSince=Date.now()}else if(visibleSince){visible+=Date.now()-visibleSince;visibleSince=0}check()}window.addEventListener("scroll",check,{passive:true});document.addEventListener("visibilitychange",visibility);timer=setInterval(check,2500);check()}
    function start(){if(active)return;var choice=readConsent();if(required&&choice!=="granted")return;if(choice==="denied")return;try{visitor=localStorage.getItem(visitorKey)||"";if(!/^[0-9a-f-]{36}$/i.test(visitor)){visitor=crypto.randomUUID();localStorage.setItem(visitorKey,visitor)}}catch(e){return}active=true;window.__blogniceEvent=function(name,path){send("/_blognice/events",{event:name,path:path,visitor:visitor})};send("/_blognice/metrics",{path:location.pathname,referrer:referrerHost(),visitor:visitor});setupEngagement()}
    function setChoice(value){writeConsent(value);if(value==="granted"){start()}else{removeVisitor();window.__blogniceEvent=function(){}};hideBanner()}
    window.__blogniceEvent=function(){};
    var banner=document.createElement("div"),lastFocus=null;banner.id="blognice-consent";banner.hidden=true;banner.setAttribute("role","dialog");banner.setAttribute("aria-modal","true");banner.setAttribute("aria-label","Analytics preferences");banner.innerHTML=${serializedBannerMarkup};document.body.appendChild(banner);function showBanner(){lastFocus=document.activeElement;banner.hidden=false;var first=banner.querySelector("[data-consent]");if(first)first.focus()}function hideBanner(){banner.hidden=true;if(lastFocus&&lastFocus.focus)lastFocus.focus()}banner.addEventListener("click",function(event){var button=event.target.closest("[data-consent]");if(button)setChoice(button.getAttribute("data-consent"))});banner.addEventListener("keydown",function(event){if(event.key==="Escape")hideBanner()});
    if(required&&readConsent()!=="granted"&&readConsent()!=="denied")showBanner();start();window.addEventListener("storage",function(event){if(event.key===consentKey){if(event.newValue==="granted")start();else if(event.newValue==="denied"){removeVisitor();window.__blogniceEvent=function(){}}}});
  })();</script>`;
}

/** Materialize an anonymous, decayed popularity score for fast homepage reads. */
export async function refreshPopularity(env: MetricsEnv, now = new Date()): Promise<number> {
  if (!metricsConfigured(env) || !env.DB) return 0;
  const day = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const start = new Date(now.getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
  const nextDay = new Date(new Date(`${day}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
  const range = `timestamp >= toDateTime(${sqlString(`${start} 00:00:00`)}) AND timestamp < toDateTime(${sqlString(`${nextDay} 00:00:00`)})`;
  const [readers, engaged] = await Promise.all([
    analyticsSql(env, `SELECT index1 AS tenant_id, blob1 AS path, count(DISTINCT blob4) AS readers FROM ${METRICS_DATASET} WHERE ${range} GROUP BY tenant_id, path`),
    analyticsSql(env, `SELECT index1 AS tenant_id, blob2 AS path, count(DISTINCT blob3) AS engaged FROM ${EVENTS_DATASET} WHERE ${range} AND blob1 = 'engaged_read' GROUP BY tenant_id, path`),
  ]);
  const daily = new Map<string, { tenantId: number; path: string; readers: number; engaged: number }>();
  for (const row of readers) {
    const tenantId = Number(row.tenant_id), path = String(row.path || "");
    if (!Number.isSafeInteger(tenantId) || !path.startsWith("/") || path === "/") continue;
    daily.set(`${tenantId}\u0000${path}`, { tenantId, path, readers: numberValue(row.readers), engaged: 0 });
  }
  for (const row of engaged) {
    const tenantId = Number(row.tenant_id), path = String(row.path || ""), key = `${tenantId}\u0000${path}`;
    if (!Number.isSafeInteger(tenantId) || !path.startsWith("/") || path === "/") continue;
    const existing = daily.get(key) || { tenantId, path, readers: 0, engaged: 0 };
    existing.engaged = numberValue(row.engaged); daily.set(key, existing);
  }
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const dailyRows = [...daily.values()];
  for (let i = 0; i < dailyRows.length; i += 80) {
    await env.DB.batch(dailyRows.slice(i, i + 80).map((row) => env.DB!.prepare(
      `INSERT INTO post_popularity_daily (tenant_id, path, day, reader_days, engaged_readers, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, path, day) DO UPDATE SET reader_days = excluded.reader_days, engaged_readers = excluded.engaged_readers, updated_at = excluded.updated_at`
    ).bind(row.tenantId, row.path, day, row.readers, row.engaged, nowSeconds)));
  }
  const rows = await env.DB.prepare("SELECT tenant_id, path, day, reader_days, engaged_readers FROM post_popularity_daily WHERE day >= ?").bind(start).all<{ tenant_id: number; path: string; day: string; reader_days: number; engaged_readers: number }>();
  const scores = new Map<string, { tenantId: number; path: string; score: number; readers30: number; readers90: number; engaged30: number }>();
  for (const row of rows.results) {
    const age = Math.max(0, (now.getTime() - new Date(`${row.day}T00:00:00Z`).getTime()) / 86_400_000);
    const weight = Math.pow(0.5, age / 21);
    const key = `${row.tenant_id}\u0000${row.path}`;
    const item = scores.get(key) || { tenantId: row.tenant_id, path: row.path, score: 0, readers30: 0, readers90: 0, engaged30: 0 };
    item.score += (Number(row.reader_days) + 1.5 * Number(row.engaged_readers)) * weight;
    item.readers90 += Number(row.reader_days);
    if (age <= 30) { item.readers30 += Number(row.reader_days); item.engaged30 += Number(row.engaged_readers); }
    scores.set(key, item);
  }
  const updates = [...scores.values()];
  for (let i = 0; i < updates.length; i += 80) {
    await env.DB.batch(updates.slice(i, i + 80).map((row) => env.DB!.prepare(
      `INSERT INTO post_popularity (tenant_id, path, score, reader_days_30, reader_days_90, engaged_readers_30, calculated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, path) DO UPDATE SET score = excluded.score, reader_days_30 = excluded.reader_days_30, reader_days_90 = excluded.reader_days_90, engaged_readers_30 = excluded.engaged_readers_30, calculated_at = excluded.calculated_at`
    ).bind(row.tenantId, row.path, row.score, row.readers30, row.readers90, row.engaged30, nowSeconds)));
  }
  await env.DB.prepare("INSERT INTO popularity_state (key, value, updated_at) VALUES ('last_refresh', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(day, nowSeconds).run();
  return updates.length;
}

export async function archivePreviousDay(env: MetricsEnv, now = new Date()): Promise<string | null> {
  if (!metricsConfigured(env)) return null;
  const day = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const rows = await analyticsSql(
    env,
    `SELECT index1 AS tenant_id, blob1 AS path, blob2 AS referrer, blob3 AS country, blob5 AS device, blob6 AS browser, SUM(_sample_interval) AS views, count(DISTINCT blob4) AS visitors FROM ${METRICS_DATASET} WHERE timestamp >= toDateTime(${sqlString(`${day} 00:00:00`)}) AND timestamp < toDateTime(${sqlString(`${day} 00:00:00`)}) + INTERVAL '1' DAY GROUP BY tenant_id, path, referrer, country, device, browser ORDER BY tenant_id, views DESC`
  );
  const key = `daily/${day.slice(0, 4)}/${day.slice(5, 7)}/${day}.json`;
  await env.METRICS_ARCHIVE.put(key, JSON.stringify({ date: day, rows }), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { schema: "blognice-pageviews-v1" },
  });
  return key;
}

export async function archivePreviousDayEvents(env: MetricsEnv, now = new Date()): Promise<string | null> {
  if (!metricsConfigured(env)) return null;
  const day = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const rows = await analyticsSql(
    env,
    `SELECT index1 AS tenant_id, blob1 AS event, blob2 AS path, blob4 AS country, blob5 AS device, blob6 AS browser, SUM(_sample_interval) AS events FROM ${EVENTS_DATASET} WHERE timestamp >= toDateTime(${sqlString(`${day} 00:00:00`)}) AND timestamp < toDateTime(${sqlString(`${day} 00:00:00`)}) + INTERVAL '1' DAY GROUP BY tenant_id, event, path, country, device, browser ORDER BY tenant_id, events DESC`
  );
  const key = `events/daily/${day.slice(0, 4)}/${day.slice(5, 7)}/${day}.json`;
  await env.METRICS_ARCHIVE.put(key, JSON.stringify({ date: day, rows }), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { schema: "blognice-events-v1" },
  });
  return key;
}
