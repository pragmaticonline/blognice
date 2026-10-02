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

function cleanClickId(value: unknown): string | undefined {
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

// X click id presence for landing-view reporting. Unlike Google, X needs
// no server-side passthrough: the base pixel's first-party cookie carries
// attribution, so this only labels the funnel event attributed/organic.
export function hasXClickId(url: URL): boolean {
  return cleanClickId(url.searchParams.get("twclid")) !== undefined;
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
export const ADS_LANDING_PATHS = ["/blogger-alternative"] as const;

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
    await db.prepare("CREATE TABLE IF NOT EXISTS ads_attributions (account_id INTEGER PRIMARY KEY, gclid TEXT, gbraid TEXT, wbraid TEXT, landing_path TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)").run();
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
