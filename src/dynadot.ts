// Dynadot RESTful v2 client — Cloudflare Workers compatible.
// Docs: https://www.ddot.in/domain/api-document
// Production: https://api.dynadot.com
// Sandbox   : https://api-sandbox.dynadot.com (DYNADOT_SANDBOX=true, sandbox_ prefix keys)
// Auth: Authorization: Bearer <API_KEY>, X-Request-ID: <uuid>, X-Signature: Base64(HMAC-SHA256(secret, apiKey + "\n" + fullPathAndQuery + "\n" + xRequestId + "\n" + requestBody))

export type DynadotEnv = {
  DYNADOT_API_KEY?: string;
  DYNADOT_API_SECRET?: string;
  DYNADOT_SANDBOX?: string;
};

export const DYNADOT_PRODUCTION_BASE_URL = "https://api.dynadot.com";
export const DYNADOT_SANDBOX_BASE_URL = "https://api-sandbox.dynadot.com";

export function isSandboxEnabled(env: DynadotEnv): boolean {
  return env.DYNADOT_SANDBOX === "true";
}

export function getDynadotBaseUrl(env: DynadotEnv): string {
  if (isSandboxEnabled(env) || isSandboxCredential(env.DYNADOT_API_KEY) || isSandboxCredential(env.DYNADOT_API_SECRET)) {
    return DYNADOT_SANDBOX_BASE_URL;
  }
  return DYNADOT_PRODUCTION_BASE_URL;
}

export function dynadotConfigured(env: DynadotEnv): boolean {
  return Boolean(env.DYNADOT_API_KEY && env.DYNADOT_API_SECRET);
}

export function isSandboxCredential(value: string | undefined): boolean {
  return typeof value === "string" && value.startsWith("sandbox_");
}

export function assertProductionDynadotReady(env: DynadotEnv): void {
  if (!env.DYNADOT_API_KEY || !env.DYNADOT_API_SECRET) throw new Error("Dynadot is not configured.");
  if (isSandboxEnabled(env) || isSandboxCredential(env.DYNADOT_API_KEY) || isSandboxCredential(env.DYNADOT_API_SECRET)) {
    throw new Error("Refusing production Dynadot operation with sandbox credentials. Configure production DYNADOT_API_KEY/SECRET and set DYNADOT_SANDBOX != \"true\".");
  }
}

export function redactValue(value: string): string {
  if (!value) return "***REDACTED***";
  return "***REDACTED***";
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower === "authorization" || lower === "x-signature" || lower === "api-key" || lower === "x-api-key") {
      out[k] = "***REDACTED***";
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function redactUrl(url: string): string {
  return url;
}

export function sanitizeDynadotErrorMessage(message: string): string {
  return message.replace(/Bearer\s+\S+/gi, "Bearer ***REDACTED***").replace(/X-Signature:\s*\S+/gi, "X-Signature: ***REDACTED***");
}

async function hmacSha256Base64(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const subtle = (globalThis as any).crypto.subtle as SubtleCrypto;
  const key = await subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await subtle.sign("HMAC", key, enc.encode(message));
  const bytes = new Uint8Array(sig);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export async function createDynadotSignature(
  apiKey: string,
  apiSecret: string,
  fullPathAndQuery: string,
  xRequestId: string,
  requestBody: string
): Promise<string> {
  const stringToSign = apiKey + "\n" + fullPathAndQuery + "\n" + (xRequestId || "") + "\n" + (requestBody || "");
  return hmacSha256Base64(apiSecret, stringToSign);
}

export type DynadotResult<T> = { ok: boolean; status: number; data: T | null; error: string | null; raw: any };

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const q = sp.toString();
  return q ? `?${q}` : "";
}

async function dynadotFetch<T>(
  env: DynadotEnv,
  method: string,
  fullPathAndQuery: string,
  bodyObj?: unknown
): Promise<DynadotResult<T>> {
  if (!dynadotConfigured(env)) throw new Error("Dynadot is not configured.");
  const baseUrl = getDynadotBaseUrl(env);
  const bodyStr = bodyObj !== undefined && bodyObj !== null && method !== "GET" && method !== "DELETE" ? JSON.stringify(bodyObj) : "";
  const gCrypto = (globalThis as any).crypto as Crypto | undefined;
  const xRequestId = gCrypto?.randomUUID ? gCrypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const signature = await createDynadotSignature(env.DYNADOT_API_KEY!, env.DYNADOT_API_SECRET!, fullPathAndQuery, xRequestId, bodyStr);
  const url = `${baseUrl}${fullPathAndQuery}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.DYNADOT_API_KEY}`,
    "X-Request-ID": xRequestId,
    "X-Signature": signature,
    Accept: "application/json",
  };
  if (bodyStr) headers["Content-Type"] = "application/json";
  const res = await fetch(url, { method, headers, body: bodyStr || undefined });
  const raw: any = await res.json().catch(() => ({}));
  if (!res.ok || raw?.code && raw.code >= 400) {
    const desc = raw?.error?.description || raw?.message || `Dynadot returned HTTP ${res.status}`;
    const sanitized = sanitizeDynadotErrorMessage(desc);
    return { ok: false, status: res.status, data: null, error: sanitized, raw };
  }
  return { ok: true, status: res.status, data: (raw?.data ?? raw) as T, error: null, raw };
}

export function getAccountInfo(env: DynadotEnv) {
  return dynadotFetch<{ account_info: any }>(env, "GET", "/restful/v2/accounts/info");
}

export function getTldPrice(env: DynadotEnv, tld: string, currency = "USD") {
  const q = buildQuery({ tld, currency });
  return dynadotFetch<any>(env, "GET", `/restful/v2/domains/get_tld_price${q}`);
}

export function searchDomain(env: DynadotEnv, domain: string, opts?: { currency?: string; show_price?: boolean }) {
  const q = buildQuery({ currency: opts?.currency, show_price: opts?.show_price });
  return dynadotFetch<any>(env, "GET", `/restful/v2/domains/${encodeURIComponent(domain)}/search${q}`);
}

export function bulkSearch(env: DynadotEnv, domainList: string[]) {
  const q = buildQuery({ domain_name_list: domainList.join(",") });
  return dynadotFetch<any>(env, "GET", `/restful/v2/domains/bulk_search${q}`);
}

export function listDomains(env: DynadotEnv, page = 1, page_size = 20) {
  const q = buildQuery({ page, page_size });
  return dynadotFetch<any>(env, "GET", `/restful/v2/domains${q}`);
}

export function getDomainInfo(env: DynadotEnv, domain: string) {
  return dynadotFetch<any>(env, "GET", `/restful/v2/domains/${encodeURIComponent(domain)}`);
}

export type DynadotContact = {
  organization?: string;
  name: string;
  email: string;
  phone_number: string;
  phone_cc: string;
  fax_number?: string;
  fax_cc?: string;
  address1: string;
  address2?: string;
  city: string;
  state?: string;
  zip: string;
  country: string;
};

export function listContacts(env: DynadotEnv, page = 1, page_size = 20) {
  const q = buildQuery({ page, page_size });
  return dynadotFetch<any>(env, "GET", `/restful/v2/contacts${q}`);
}

export function getContact(env: DynadotEnv, contactId: number | string) {
  return dynadotFetch<any>(env, "GET", `/restful/v2/contacts/${encodeURIComponent(String(contactId))}`);
}

export function createContact(env: DynadotEnv, contact: DynadotContact) {
  return dynadotFetch<{ contact_id: number }>(env, "POST", "/restful/v2/contacts", { contact });
}

export function updateContact(env: DynadotEnv, contactId: number | string, contact: Partial<DynadotContact>) {
  return dynadotFetch<any>(env, "PUT", `/restful/v2/contacts/${encodeURIComponent(String(contactId))}`, { contact });
}

export function deleteContact(env: DynadotEnv, contactId: number | string) {
  return dynadotFetch<any>(env, "DELETE", `/restful/v2/contacts/${encodeURIComponent(String(contactId))}`);
}

export function registerDomain(
  env: DynadotEnv,
  domain: string,
  input: { duration: number; registrant_contact_id: number; admin_contact_id: number; tech_contact_id: number; billing_contact_id: number; privacy?: "off" | "partial" | "full"; currency?: string }
) {
  const body = {
    domain: {
      duration: input.duration,
      registrant_contact_id: input.registrant_contact_id,
      admin_contact_id: input.admin_contact_id,
      tech_contact_id: input.tech_contact_id,
      billing_contact_id: input.billing_contact_id,
      privacy: input.privacy ?? "off",
    },
    currency: input.currency ?? "USD",
  };
  return dynadotFetch<any>(env, "POST", `/restful/v2/domains/${encodeURIComponent(domain)}/register`, body);
}

export function renewDomain(env: DynadotEnv, domain: string, input: { duration: number; year: number; currency?: string }) {
  return dynadotFetch<any>(env, "POST", `/restful/v2/domains/${encodeURIComponent(domain)}/renew`, {
    duration: input.duration,
    year: input.year,
    currency: input.currency ?? "USD",
  });
}

export function getNameservers(env: DynadotEnv, domain: string) {
  return dynadotFetch<any>(env, "GET", `/restful/v2/domains/${encodeURIComponent(domain)}/nameservers`);
}

export function setNameservers(env: DynadotEnv, domain: string, nameserverList: string[]) {
  return dynadotFetch<any>(env, "PUT", `/restful/v2/domains/${encodeURIComponent(domain)}/nameservers`, { nameserver_list: nameserverList });
}

export function getDnsRecords(env: DynadotEnv, domain: string) {
  return dynadotFetch<any>(env, "GET", `/restful/v2/domains/${encodeURIComponent(domain)}/records`);
}

export function setDnsRecords(
  env: DynadotEnv,
  domain: string,
  input: { dns_main_list?: Array<{ host: string; type: string; value: string; ttl?: number }>; dns_sub_list?: any[]; ttl?: number; add_dns_to_current_setting?: boolean }
) {
  return dynadotFetch<any>(env, "POST", `/restful/v2/domains/${encodeURIComponent(domain)}/records`, input);
}
