export const CACHE_VERSION = "20260905-20";

export function customDomainRedirectUrl(requestUrl: string, tenant: { slug: string; custom_domain: string | null }, rootDomain: string): string | null {
  const custom = (tenant.custom_domain || "").trim().toLowerCase();
  if (!custom) return null;
  const request = new URL(requestUrl);
  if (request.hostname.toLowerCase() !== `${tenant.slug}.${rootDomain}`.toLowerCase()) return null;
  request.protocol = "https:";
  request.host = custom;
  return request.toString();
}

export function cacheVariants(url: string): string[] {
  const versioned = new URL(url);
  versioned.searchParams.set("_bn_shell", CACHE_VERSION);
  return [url, versioned.toString()];
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export const MASTER_SITEMAP_PAGE_SIZE = 10000;

export function tenantSitemapLoc(tenant: { slug: string; custom_domain: string | null }, rootDomain: string): string {
  if (tenant.custom_domain) return `https://${xmlEscape(tenant.custom_domain.trim().toLowerCase())}/sitemap.xml`;
  return `https://${xmlEscape(tenant.slug)}.${xmlEscape(rootDomain)}/sitemap.xml`;
}

export function buildSitemapIndexXml(slugs: string[], rootDomain: string): string {
  const entries = slugs.map((slug) => `<sitemap><loc>https://${xmlEscape(slug)}.${xmlEscape(rootDomain)}/sitemap.xml</loc></sitemap>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</sitemapindex>`;
}

export function buildShardSitemapIndexXml(tenants: Array<{ slug: string; custom_domain: string | null }>, rootDomain: string): string {
  const entries = tenants.map((t) => `<sitemap><loc>${tenantSitemapLoc(t, rootDomain)}</loc></sitemap>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</sitemapindex>`;
}

export function buildMasterSitemapIndexXml(shardCount: number, rootDomain: string): string {
  const entries = Array.from({ length: shardCount }, (_, i) => {
    const page = i + 1;
    return `<sitemap><loc>https://www.${xmlEscape(rootDomain)}/sitemaps/blogs/${page}.xml</loc></sitemap>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</sitemapindex>`;
}

export async function indexNowKey(secret: string, host: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}:${host.toLowerCase()}`));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
