// Paid-ads funnel helpers: Google and X tag snippets, click-parameter
// passthrough, and the D1 ledger tables. Ad tags live ONLY on funnel pages
// (a landing page and, when firing, the billing success page) — never
// globally and never on customer blogs.

export const ADS_TAG_ID = "AW-16852730460";
export const ADS_CONVERSION_SEND_TO = "AW-16852730460/HbVaCKq-iYkdENyEgeQ-";

export const X_PIXEL_ID = "rgaz3";
export const X_CONVERSION_EVENT_ID = "tw-rgaz3-rgb4j";

export type AdsClickParams = { gclid?: string; gbraid?: string; wbraid?: string };

const CLICK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function cleanClickId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return CLICK_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

// Read and validate Google click parameters from a request URL. Invalid values
// are dropped so junk never reaches stored attribution or rendered links.
export function parseAdsClickParams(url: URL): AdsClickParams | null {
  const params: AdsClickParams = {
    gclid: cleanClickId(url.searchParams.get("gclid")),
    gbraid: cleanClickId(url.searchParams.get("gbraid")),
    wbraid: cleanClickId(url.searchParams.get("wbraid")),
  };
  if (!params.gclid && !params.gbraid && !params.wbraid) return null;
  return params;
}

// X click id, validated like the Google click ids. Captured on the /x
// landing page, forwarded into signup links, stored on the attribution row,
// and sent back as the Conversion API identifier for server-side purchase
// events. Absent for organic visits.
export function parseXClickId(url: URL): string | null {
  return cleanClickId(url.searchParams.get("twclid")) ?? null;
}

export function hasXClickId(url: URL): boolean {
  return parseXClickId(url) !== null;
}

// Rewrite bare /signup links so the X click id survives the landing →
// signup hop without JavaScript. Only exact href="/signup" links are touched.
export function injectXClickParams(html: string, twclid: string | null, landing: string | null): string {
  if (!twclid) return html;
  const query = new URLSearchParams();
  query.set("twclid", twclid);
  if (landing) query.set("ads_landing", landing);
  return html.replaceAll('href="/signup"', `href="/signup?${query.toString()}"`);
}

export interface XServerConversion {
  conversionTime: string;
  eventId: string;
  eventSourceUrl?: string;
  conversionId?: string;
  twclid?: string | null;
  ipAddress?: string;
  userAgent?: string;
}

// Server-side purchase event for the X Conversion API. The conversion_id
// must equal the transaction id the web pixel sends so X counts the pair
// once. Resolves false (never throws) when the token is missing or the
// call fails — server attribution is best-effort next to the pixel.
export async function sendXServerConversion(
  fetchImpl: typeof fetch,
  input: { token: string | undefined; conversion: XServerConversion },
): Promise<{ ok: boolean; status: number }> {
  const token = (input.token ?? "").trim();
  if (!token) return { ok: false, status: 0 };
  const c = input.conversion;
  const identifiers: Record<string, string> = {};
  if (c.twclid) identifiers.twclid = c.twclid;
  if (c.ipAddress) identifiers.ip_address = c.ipAddress;
  if (c.userAgent) identifiers.user_agent = c.userAgent;
  const body: Record<string, unknown> = {
    conversion_time: c.conversionTime,
    event_id: c.eventId,
    identifiers: [identifiers],
  };
  if (c.eventSourceUrl) body.event_source_url = c.eventSourceUrl;
  if (c.conversionId) body.conversion_id = c.conversionId;
  try {
    const res = await fetchImpl(`https://ads-api.x.com/12/measurement/conversions/${X_PIXEL_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Pixel-Token": token },
      body: JSON.stringify({ conversions: [body] }),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

export function parseAdsClickFields(fields: { gclid?: unknown; gbraid?: unknown; wbraid?: unknown }): AdsClickParams | null {
  const params: AdsClickParams = {
    gclid: cleanClickId(fields.gclid),
    gbraid: cleanClickId(fields.gbraid),
    wbraid: cleanClickId(fields.wbraid),
  };
  if (!params.gclid && !params.gbraid && !params.wbraid) return null;
  return params;
}

export function adsClickQuery(params: AdsClickParams, landing: string | null): string {
  const query = new URLSearchParams();
  if (params.gclid) query.set("gclid", params.gclid);
  if (params.gbraid) query.set("gbraid", params.gbraid);
  if (params.wbraid) query.set("wbraid", params.wbraid);
  if (landing) query.set("ads_landing", landing);
  return query.toString();
}

// Landing pages allowed to stamp attribution. Attribution links only ever
// originate from these pages, so anything else is dropped as forged.
export const ADS_LANDING_PATHS = ["/blogger-alternative", "/x"] as const;

export function parseAdsLanding(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return (ADS_LANDING_PATHS as readonly string[]).includes(value) ? value : null;
}

// Rewrite bare /signup links so click parameters survive the landing → signup
// hop without JavaScript. Only exact href="/signup" links are touched.
export function injectAdsClickParams(html: string, params: AdsClickParams | null, landing: string | null): string {
  if (!params) return html;
  const query = adsClickQuery(params, landing);
  if (!query) return html;
  return html.replaceAll('href="/signup"', `href="/signup?${query}"`);
}

export function adsBaseTag(): string {
  return `<script async src="https://www.googletagmanager.com/gtag/js?id=${ADS_TAG_ID}"></script>\n<script>\nwindow.dataLayer = window.dataLayer || [];\nfunction gtag(){dataLayer.push(arguments);}\ngtag('js', new Date());\ngtag('config', '${ADS_TAG_ID}');\n</script>`;
}

// Conversion event with the real transaction value and currency. Rendered only
// on the billing success page after the server verifies the Stripe session and
// claims the once-per-account conversion row. No enhanced conversions, no
// customer email — transaction_id lets Google dedupe any double delivery.
export function adsConversionScript(input: { valueMinor: number; currency: string; transactionId: string }): string {
  const value = (Math.max(0, Math.trunc(input.valueMinor)) / 100).toFixed(2);
  const currency = /^[A-Z]{3}$/.test(input.currency) ? input.currency : "USD";
  const transactionId = input.transactionId.replace(/[^A-Za-z0-9_:-]/g, "").slice(0, 128) || "unknown";
  return `<script>\ngtag('event', 'conversion', {'send_to': '${ADS_CONVERSION_SEND_TO}', 'value': ${value}, 'currency': '${currency}', 'transaction_id': '${transactionId}'});\n</script>`;
}

// X pixel base tag: loader plus account config. Baked into the landing page
// statically and rendered with the conversion below. No enhanced matching,
// no email — the pixel's first-party cookie attributes the click.
export function xAdsBaseTag(): string {
  return `<script>\n!function(e,t,n,s,u,a){e.twq||(s=e.twq=function(){s.exe?s.exe.apply(s,arguments):s.queue.push(arguments);},s.version='1.1',s.queue=[],u=t.createElement(n),u.async=!0,u.src='https://static.ads-twitter.com/uwt.js',a=t.getElementsByTagName(n)[0],a.parentNode.insertBefore(u,a))}(window,document,'script');\ntwq('config','${X_PIXEL_ID}');\n</script>`;
}

// X purchase event with the real transaction value and currency.
// conversion_id lets X dedupe any double delivery. Fired only for paid
// conversions (never $0 trials) under the once-per-account claim.
export function xAdsConversionScript(input: { valueMinor: number; currency: string; transactionId: string }): string {
  const value = (Math.max(0, Math.trunc(input.valueMinor)) / 100).toFixed(2);
  const currency = /^[A-Z]{3}$/.test(input.currency) ? input.currency : "USD";
  const conversionId = input.transactionId.replace(/[^A-Za-z0-9_:-]/g, "").slice(0, 128) || "unknown";
  return `<script>\ntwq('event', '${X_CONVERSION_EVENT_ID}', {value: ${value}, currency: '${currency}', conversion_id: '${conversionId}'});\n</script>`;
}

export async function ensureAdsTables(db: D1Database): Promise<void> {
  try {
    await db.prepare("CREATE TABLE IF NOT EXISTS ads_attributions (account_id INTEGER PRIMARY KEY, gclid TEXT, gbraid TEXT, wbraid TEXT, twclid TEXT, landing_path TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)").run();
  } catch {}
  try {
    // Migration 090 for databases created before the twclid column existed.
    // Throws (duplicate column) on databases that already have it.
    await db.prepare("ALTER TABLE ads_attributions ADD COLUMN twclid TEXT").run();
  } catch {}
  try {
    await db.prepare("CREATE TABLE IF NOT EXISTS ads_conversions (account_id INTEGER PRIMARY KEY, transaction_id TEXT NOT NULL, value_minor INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD', reported_at INTEGER NOT NULL)").run();
  } catch {}
  try {
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_ads_conversions_reported ON ads_conversions (reported_at)").run();
  } catch {}
  try {
    await db.prepare("CREATE TABLE IF NOT EXISTS x_ads_conversions (account_id INTEGER PRIMARY KEY, transaction_id TEXT NOT NULL, value_minor INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD', reported_at INTEGER NOT NULL)").run();
  } catch {}
  try {
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_x_ads_conversions_reported ON x_ads_conversions (reported_at)").run();
  } catch {}
}
