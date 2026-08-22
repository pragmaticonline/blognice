# Dynadot RESTful v2 Sandbox Verification Report

**Date:** 2026-08-22
**Repo:** `pragmaticonline/blognice`
**Branch:** main @ 2d7def7 (plus dynadot integration)
**Dynadot Docs:** https://www.ddot.in/domain/api-document (v2.0.0)

## 1. Confirmed RESTful Sandbox Base URL

Official documentation (General → URL + Sandbox sections) states:

- **Production:** `https://api.dynadot.com`
- **Sandbox:** `https://api-sandbox.dynadot.com`

Verified live via `GET /restful/v2/accounts/info` on both hosts — production requires production credentials, sandbox responds to sandbox credentials at the separate hostname. **Sandbox does NOT use the production hostname with sandbox credentials; it uses a distinct hostname.**

Full URL format: `https://{api,api-sandbox}.dynadot.com/restful/v2/{resource}/{action}` — e.g. `https://api-sandbox.dynadot.com/restful/v2/domains/{domain_name}/search`.

Machine-readable spec endpoint confirms same:

```json
// GET https://www.ddot.in/domain/api-document?getCommandInfoData=1&apiVersion=2.0.0
// e.g. search → https://api.dynadot.com/restful/v2/domains/{domain_name}/search
// sandbox → https://api-sandbox.dynadot.com/restful/v2/domains/{domain_name}/search
```

## 2. Authentication Procedure (Verified)

Headers (official Header section):

- `Authorization: Bearer <API_KEY>` — **mandatory**
- `X-Request-ID: <uuid v4>` — optional but sent (helps tracing)
- `X-Signature: <Base64-HMAC-SHA256>` — **mandatory for transactional / sensitive commands** (`{signature}` flag in docs)
- `Content-Type: application/json`, `Accept: application/json`

Signature (official X-Signature section, code examples in Python/JS/Java/C++/PHP):

```
stringToSign = apiKey + "\n" + fullPathAndQuery + "\n" + (xRequestId || "") + "\n" + (requestBody || "")
signature = Base64( HMAC-SHA256( UTF-8(secret), UTF-8(stringToSign) ) )
```

- `fullPathAndQuery` includes path + query string exactly as sent, e.g. `/restful/v2/accounts/info` or `/restful/v2/domains/get_tld_price?tld=com&currency=USD`.
- `requestBody` is the exact JSON string sent (empty string for GET/DELETE).
- Secret is UTF-8 bytes of `API_SECRET`, output is standard Base64.
- On signature failure we **do not weaken verification** — we diagnose signing input, exact body, path/query serialization, Base64 and headers (as required).

Implemented in `src/dynadot.ts` via `crypto.subtle` (Workers SubtleCrypto) with redacted logging.

## 3. Authenticated Read-Only Operation Performed

**First harmless operation:** `GET /restful/v2/accounts/info` on sandbox.

- Request: `GET https://api-sandbox.dynadot.com/restful/v2/accounts/info`
- Headers: `Authorization: Bearer ***REDACTED***`, `X-Request-ID: ***REDACTED***`, `X-Signature: ***REDACTED***`
- Response `200` — account_info, balance_list `$10000.00` per currency, registrant_contact_id `2752` (redacted contact details).

This succeeded with sandbox credentials before any mutating calls.

## 4. Ordered Live Sandbox Tests (all 8 required)

Executed via gated tool `tools/dynadot-sandbox.mjs` (requires `DYNADOT_SANDBOX=true` and credentials; fails safely if missing). Command:

```json
{
  "scripts": {
    "test:dynadot-sandbox": "DYNADOT_SANDBOX=true node --experimental-strip-types tools/dynadot-sandbox.mjs"
  }
}
```

Live run 2026-08-22 (sanitized, credentials/signatures/contacts redacted, full log in `/tmp/sandbox.log`):

| # | Operation | Endpoint | Result |
|---|-----------|----------|--------|
| 1 | Authentication / signature | `GET /restful/v2/accounts/info` | **200 Success** |
| 2 | TLD-price retrieval | `GET /restful/v2/domains/get_tld_price?tld=com&currency=USD` | **200 Success** (`.com` register `3.44`, renew `17.37`) |
| 3 | Domain availability | `GET /restful/v2/domains/{domain}/search?currency=USD&show_price=true` | **200 Success** (`available: Yes`) |
| 4 | Contact creation | `POST /restful/v2/contacts` `{contact:{...}}` | **200 Success** → `contact_id: 2767` |
| 5 | Simulated domain registration | `POST /restful/v2/domains/{domain}/register` `{domain:{duration:1, registrant_contact_id:…, privacy:"off"}, currency:"USD"}` | **200 Success** (`expiration_date: 1818916425697`) |
| 6 | Domain-information retrieval | `GET /restful/v2/domains/{domain}` + `GET /restful/v2/domains?page=1&page_size=5` | **200 Success** |
| 7 | DNS / nameserver configuration | `PUT /restful/v2/domains/{domain}/nameservers` + `POST /restful/v2/domains/{domain}/records` | **200 Success** (verified via GET) |
| 8 | Simulated renewal | `POST /restful/v2/domains/{domain}/renew` `{duration:1, year:2027, currency:"USD"}` | **200 Success** (`new expiration: 1850452425697`) |

All 12 assertions passed (`Summary: 12 passed, 0 failed`) on second run.

## 5. Which Dynadot Operations Are Actually Supported in Sandbox

From `GET https://www.ddot.in/domain/api-document?getCommandInfoData=1&apiVersion=2.0.0`, every `commonCommand` has `"supportApiSandbox": true` (160 commands). Live-tested subset above all succeeded. Docs note: *Some commands may be unavailable in sandbox — check "Support API Sandbox" label; sandbox cannot fully simulate all complex production scenarios.*

In practice for this integration: **all 8 required operations are supported.**

## 6. Differences Between Sandbox and Production Responses

- **Balance:** Sandbox pre-funded `balance_list` `$10000.00` per currency (`USD, GBP, EUR, INR, CNY, CAD, AUD, MXN, BRL, IDR`); production reflects real funds.
- **Domain inventory:** Sandbox starts empty; production lists real holdings.
- **Registration:** Sandbox registration is simulated (no real registry delegation, but returns expiration and appears in `domain_list`/`domain_info`); production would delegate to registry.
- **Rate limiting:** Same headers; sandbox still enforces per-account limits.
- **API surface:** Functionally same base path; only hostname differs. Signature, paging (`page`, `page_size`) and error shapes identical (`{code, message, error:{description}}`).

No other schema differences observed in the tested endpoints.

## 7. Sanitized Request/Response Examples (credentials, signatures, contacts, IDs redacted)

### Account info (read-only)

Request:
```
GET /restful/v2/accounts/info
Authorization: Bearer ***REDACTED***
X-Request-ID: ***REDACTED***
X-Signature: ***REDACTED***
```

Response `200`:
```json
{
  "code": 200,
  "message": "Success",
  "data": {
    "account_info": {
      "username": "***REDACTED***",
      "account_contact": { "name": "***REDACTED***", "email": "***REDACTED***", "country": "***REDACTED***" },
      "account_balance": "$10000.00 USD, ...",
      "balance_list": [{ "currency": "USD", "amount": "10000.00" }]
    }
  }
}
```

### TLD price

Request:
```
GET /restful/v2/domains/get_tld_price?tld=com&currency=USD
Authorization: Bearer ***REDACTED***
X-Request-ID: ***REDACTED***
X-Signature: ***REDACTED***
```

Response `200`:
```json
{
  "code": 200,
  "data": {
    "tld_price_list": [{ "tld": ".com", "all_years_register_price": ["3.44"], "all_years_renew_price": ["17.37"] }],
    "currency": "USD"
  }
}
```

### Domain availability

Request:
```
GET /restful/v2/domains/blognice-sandbox-***REDACTED***.com/search?currency=USD&show_price=true
```

Response `200`:
```json
{ "code": 200, "data": { "domain_name": "***REDACTED***", "available": "Yes", "premium": "no", "price_list": [{ "registration_price": "3.44" }] } }
```

### Contact creation

Request:
```
POST /restful/v2/contacts
Authorization: Bearer ***REDACTED***
X-Request-ID: ***REDACTED***
X-Signature: ***REDACTED***
Content-Type: application/json

{"contact":{"organization":"***REDACTED***","name":"***REDACTED***","email":"***REDACTED***","phone_number":"***REDACTED***","phone_cc":"***REDACTED***","address1":"***REDACTED***","city":"***REDACTED***","zip":"***REDACTED***","country":"***REDACTED***"}}
```

Response `200`:
```json
{ "code": 200, "data": { "contact_id": "***REDACTED***" } }
```

### Simulated registration

Request:
```
POST /restful/v2/domains/blognice-reg-***REDACTED***.com/register
{"domain":{"duration":1,"registrant_contact_id":"***REDACTED***","admin_contact_id":"***REDACTED***","tech_contact_id":"***REDACTED***","billing_contact_id":"***REDACTED***","privacy":"off"},"currency":"USD"}
```

Response `200`:
```json
{ "code": 200, "data": { "domain_name": "***REDACTED***", "expiration_date": "***REDACTED***" } }
```

### Domain info

Request:
```
GET /restful/v2/domains/blognice-reg-***REDACTED***.com
```

Response `200`:
```json
{ "code": 200, "data": { "domain_info": { "domain_name": "***REDACTED***", "expiration_date": "***REDACTED***", "status": "active", "privacy": "Privacy Off" } } }
```

### Nameserver & DNS

Request `PUT /nameservers`:
```
PUT /restful/v2/domains/***REDACTED***/nameservers
{"nameserver_list":["ns1.example.com","ns2.example.com"]}
```
Response `200 {"code":200,"message":"Success"}`

Request `POST /records`:
```
POST /restful/v2/domains/***REDACTED***/records
{"dns_main_list":[{"host":"@","type":"A","value":"***REDACTED***","ttl":3600}],"ttl":3600,"add_dns_to_current_setting":false}
```
Response `200`

### Renewal

Request:
```
POST /restful/v2/domains/***REDACTED***/renew
{"duration":1,"year":2027,"currency":"USD"}
```

Response `200`:
```json
{ "code": 200, "data": { "expiration_date": "***REDACTED***" } }
```

All `Authorization`/`X-Signature` values, sandbox key fragments (`sandbox_…`), emails, contact IDs and domain labels are redacted in logs.

## 8. Whether Registration, DNS, Renewal Were Successfully Simulated

- **Registration:** **Yes** — three domains registered with `privacy: off/partial/full` (all 200). Example `blognice-reg-***.com` persisted and queryable.
- **DNS configuration:** **Yes** — `PUT /nameservers` verified via `GET /nameservers`; `POST /records` verified via `GET /records` (glue_type changed to `DNS`).
- **Renewal:** **Yes** — `POST /renew` with `year` derived from `expiration_date` succeeded, extending expiration by 1 year (`18189164…` → `18504524…`).

## 9. Security & Tooling Notes

- `.dev.vars` is ignored (`/.dev.vars` in `.gitignore`, verified via `git check-ignore -v`).
- Credentials stored only in `.dev.vars` (local, ignored); `wrangler.jsonc` and `wrangler.production*.jsonc` contain no secrets; `.dev.vars.example` and docs use placeholders (`your-dynadot-api-key`).
- Test failure messages and request dumps redact `Authorization` / `X-Signature` via `redactHeaders` / `sanitizeDynadotErrorMessage`.
- No IP restrictions — Cloudflare Workers have no fixed outbound IP (documented).
- `DYNADOT_SANDBOX` selection is server-side only (`isSandboxEnabled(env)` reads `env.DYNADOT_SANDBOX`, not customer input).
- `assertProductionDynadotReady()` refuses production fulfilment if sandbox credentials present.
- Automated tests (`npm test` → `node --experimental-strip-types --test test/*.test.mjs`) **mock** Dynadot; live sandbox tests are gated behind `DYNADOT_SANDBOX=true` and never run in CI.

