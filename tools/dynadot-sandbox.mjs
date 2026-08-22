// Live Dynadot sandbox verification — gated behind DYNADOT_SANDBOX=true and explicit credentials.
// Never runs in ordinary npm test / CI.
// Usage: DYNADOT_SANDBOX=true node tools/dynadot-sandbox.mjs
// Or: npm run test:dynadot-sandbox
//
// Performs in order:
//  1. Authentication / signature generation (GET /restful/v2/accounts/info)
//  2. TLD-price retrieval (GET /restful/v2/domains/get_tld_price)
//  3. Domain availability (GET /restful/v2/domains/{domain}/search)
//  4. Contact creation (POST /restful/v2/contacts)
//  5. Simulated domain registration (POST /restful/v2/domains/{domain}/register)
//  6. Domain-information retrieval (GET /restful/v2/domains/{domain})
//  7. DNS / nameserver configuration (PUT /nameservers, POST /records)
//  8. Simulated renewal (POST /renew)

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import crypto from "node:crypto";

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  const txt = readFileSync(path, "utf8");
  for (const line of txt.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!(k in process.env) || !process.env[k]) process.env[k] = v.replace(/^"|"$/g, "");
  }
}
const explicitSandboxFlag = process.env.DYNADOT_SANDBOX === "true";
loadDotEnv(resolve(".dev.vars"));
loadDotEnv(resolve("/tmp/blognice/.dev.vars"));

const isSandboxFlag = explicitSandboxFlag || process.env.DYNADOT_SANDBOX === "true";
const apiKey = process.env.DYNADOT_API_KEY;
const apiSecret = process.env.DYNADOT_API_SECRET;

function fail(msg) {
  console.error(`[dynadot-sandbox] FAIL: ${msg}`);
  process.exit(1);
}

if (!isSandboxFlag) {
  fail("DYNADOT_SANDBOX must be 'true' to run live sandbox tests. Use: DYNADOT_SANDBOX=true npm run test:dynadot-sandbox");
}
if (!apiKey || !apiSecret) {
  fail("Missing DYNADOT_API_KEY / DYNADOT_API_SECRET. Configure them in .dev.vars (ignored by Git) or environment. Example: see .dev.vars.example (placeholders only).");
}
if (!apiKey.startsWith("sandbox_") || !apiSecret.startsWith("sandbox_")) {
  console.warn("[dynadot-sandbox] WARNING: credentials do not look like sandbox_ prefix — ensure you are using sandbox credentials for sandbox tests.");
}

function redact(str) {
  if (!str) return str;
  return str.replace(/sandbox_[A-Za-z0-9]+/g, "***REDACTED***")
            .replace(/Bearer\s+\S+/gi, "Bearer ***REDACTED***")
            .replace(/X-Signature:\s*\S+/gi, "X-Signature: ***REDACTED***");
}

function createSignature(apiKey, apiSecret, fullPathAndQuery, xRequestId, requestBody = "") {
  const stringToSign = apiKey + "\n" + fullPathAndQuery + "\n" + (xRequestId || "") + "\n" + (requestBody || "");
  return crypto.createHmac("sha256", Buffer.from(apiSecret, "utf8")).update(Buffer.from(stringToSign, "utf8")).digest("base64");
}

async function dynadotFetch(method, fullPathAndQuery, bodyObj) {
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : "";
  const xRequestId = crypto.randomUUID();
  const signature = createSignature(apiKey, apiSecret, fullPathAndQuery, xRequestId, bodyStr);
  const base = "https://api-sandbox.dynadot.com";
  const url = base + fullPathAndQuery;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "X-Request-ID": xRequestId,
    "X-Signature": signature,
    Accept: "application/json",
  };
  if (bodyStr) headers["Content-Type"] = "application/json";
  const redactedHeaders = { ...headers, Authorization: "Bearer ***REDACTED***", "X-Signature": "***REDACTED***" };
  console.log(`\n→ ${method} ${fullPathAndQuery}`);
  console.log(`  headers: ${JSON.stringify(redactedHeaders)}`);
  if (bodyStr) console.log(`  body: ${redact(bodyStr).slice(0, 600)}`);
  console.log(`  signing input: apiKey\\nfullPathAndQuery\\nxRequestId\\nbodyLen=${bodyStr.length} — signature ${signature.slice(0,8)}... (redacted)`);
  const res = await fetch(url, { method, headers, body: bodyStr || undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const sanitizedText = redact(text).slice(0, 1500);
  console.log(`  ← ${res.status} ${sanitizedText.slice(0, 600)}`);
  if (!res.ok || (json && json.code && json.code >= 400)) {
    const desc = json?.error?.description || json?.message || `HTTP ${res.status}`;
    console.error(`  ✗ error: ${redact(desc)}`);
  } else {
    console.log(`  ✓ success`);
  }
  return { status: res.status, json, text, ok: res.ok && (!json || !json.code || json.code < 400), headers: res.headers };
}

let passed = 0;
let failed = 0;
function assertOk(name, result, expectOk = true) {
  if (expectOk && !result.ok) {
    console.error(`✗ ${name} failed (status ${result.status})`);
    failed++;
    return false;
  }
  if (!expectOk && result.ok) {
    console.error(`✗ ${name} unexpectedly succeeded`);
    failed++;
    return false;
  }
  console.log(`✓ ${name} passed`);
  passed++;
  return true;
}

console.log("=== Dynadot Sandbox Live Verification ===");
console.log(`Base URL: https://api-sandbox.dynadot.com (official sandbox, separate hostname from https://api.dynadot.com)`);
console.log(`Auth: Bearer + X-Request-ID (UUID) + X-Signature (Base64 HMAC-SHA256 of apiKey\\nfullPathAndQuery\\nxRequestId\\nbody)`);
console.log(`Sandbox credentials: present (redacted)`);

console.log("\n[1] Authentication / signature — GET /restful/v2/accounts/info (harmless read-only)");
const accountRes = await dynadotFetch("GET", "/restful/v2/accounts/info");
assertOk("auth/signature (accounts/info)", accountRes, true);
const contactIdFromAccount = accountRes.json?.data?.account_info?.registrant_contact_id || 2752;
console.log(`   account registrant_contact_id: ${contactIdFromAccount}`);

console.log("\n[2] TLD-price retrieval — GET /restful/v2/domains/get_tld_price?tld=com&currency=USD");
const tldRes = await dynadotFetch("GET", "/restful/v2/domains/get_tld_price?tld=com&currency=USD");
assertOk("TLD price (com/USD)", tldRes, true);

console.log("\n[3] Domain availability — GET /restful/v2/domains/{domain}/search");
const availDomain = `blognice-sandbox-${Date.now()}.com`;
const availRes = await dynadotFetch("GET", `/restful/v2/domains/${encodeURIComponent(availDomain)}/search?currency=USD&show_price=true`);
assertOk(`domain availability (${availDomain})`, availRes, true);
console.log(`   available: ${availRes.json?.data?.available}`);

console.log("\n[4] Contact creation — POST /restful/v2/contacts (if supported)");
const contactPayload = {
  contact: {
    organization: "Blognice Sandbox Test",
    name: "Sandbox Tester",
    email: `sandbox+${Date.now()}@example.invalid`,
    phone_number: "1234567890",
    phone_cc: "1",
    address1: "123 Sandbox St",
    city: "Test City",
    state: "CA",
    zip: "12345",
    country: "US"
  }
};
const contactRes = await dynadotFetch("POST", "/restful/v2/contacts", contactPayload);
let newContactId = null;
if (assertOk("contact creation", contactRes, true)) {
  newContactId = contactRes.json?.data?.contact_id;
  console.log(`   new contact_id: ${newContactId} (sanitized)`);
} else {
  console.log("   contact creation not supported or failed — continuing without new contact");
  newContactId = contactIdFromAccount;
}

console.log("\n[5] Simulated domain registration — POST /restful/v2/domains/{domain}/register");
const regDomain = `blognice-reg-${Date.now()}.com`;
const regBody = {
  domain: {
    duration: 1,
    registrant_contact_id: newContactId,
    admin_contact_id: newContactId,
    tech_contact_id: newContactId,
    billing_contact_id: newContactId,
    privacy: "off"
  },
  currency: "USD"
};
const regRes = await dynadotFetch("POST", `/restful/v2/domains/${encodeURIComponent(regDomain)}/register`, regBody);
let registeredDomain = null;
if (assertOk(`domain registration (${regDomain})`, regRes, true)) {
  registeredDomain = regDomain;
  console.log(`   registered: ${regRes.json?.data?.domain_name} exp ${regRes.json?.data?.expiration_date}`);
} else {
  console.log("   registration failed — sandbox may require different privacy or funds; diagnosing...");
  if (regRes.json?.error?.description?.includes("signature")) {
    console.error("   signature verification failed — diagnosing signing input, path/query serialization, Base64, headers (not weakening verification)");
    process.exit(1);
  }
}

console.log("\n[6] Domain-information retrieval — GET /restful/v2/domains/{domain} and GET /restful/v2/domains?page=1&page_size=5");
if (registeredDomain) {
  const infoRes = await dynadotFetch("GET", `/restful/v2/domains/${encodeURIComponent(registeredDomain)}`);
  assertOk("domain info retrieval", infoRes, true);
  const listRes = await dynadotFetch("GET", "/restful/v2/domains?page=1&page_size=5");
  assertOk("domain list", listRes, true);
} else {
  console.log("   skipping domain info — no registered domain");
  const listRes = await dynadotFetch("GET", "/restful/v2/domains?page=1&page_size=5");
  assertOk("domain list (fallback)", listRes, true);
}

console.log("\n[7] DNS / nameserver configuration — PUT /nameservers and POST /records");
if (registeredDomain) {
  const nsRes = await dynadotFetch("PUT", `/restful/v2/domains/${encodeURIComponent(registeredDomain)}/nameservers`, { nameserver_list: ["ns1.example.com", "ns2.example.com"] });
  assertOk("set nameservers", nsRes, true);
  const getNsRes = await dynadotFetch("GET", `/restful/v2/domains/${encodeURIComponent(registeredDomain)}/nameservers`);
  assertOk("get nameservers", getNsRes, true);
  const dnsRes = await dynadotFetch("POST", `/restful/v2/domains/${encodeURIComponent(registeredDomain)}/records`, {
    dns_main_list: [{ host: "@", type: "A", value: "1.2.3.4", ttl: 3600 }],
    ttl: 3600,
    add_dns_to_current_setting: false
  });
  assertOk("set DNS records", dnsRes, true);
  const getDnsRes = await dynadotFetch("GET", `/restful/v2/domains/${encodeURIComponent(registeredDomain)}/records`);
  assertOk("get DNS records", getDnsRes, true);
} else {
  console.log("   skipping DNS/nameserver — no registered domain");
}

console.log("\n[8] Simulated renewal — POST /restful/v2/domains/{domain}/renew (if supported)");
if (registeredDomain) {
  const infoBefore = await dynadotFetch("GET", `/restful/v2/domains/${encodeURIComponent(registeredDomain)}`);
  const exp = infoBefore.json?.data?.domain_info?.expiration_date;
  const year = exp ? new Date(Number(exp)).getUTCFullYear() : new Date().getUTCFullYear() + 1;
  console.log(`   renewal year derived from expiration ${exp} -> ${year}`);
  const renewRes = await dynadotFetch("POST", `/restful/v2/domains/${encodeURIComponent(registeredDomain)}/renew`, { duration: 1, year, currency: "USD" });
  assertOk("domain renewal", renewRes, true);
  if (renewRes.ok) console.log(`   new expiration: ${renewRes.json?.data?.expiration_date}`);
} else {
  console.log("   skipping renewal — no registered domain");
}

console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.error("Some sandbox operations failed — see sanitized output above (credentials/signatures redacted).");
  process.exit(1);
} else {
  console.log("All supported sandbox operations succeeded. Sandbox base URL confirmed: https://api-sandbox.dynadot.com");
  console.log("Note: sandbox pre-funded with $10,000 per currency; domain registration is simulated without affecting production.");
}
