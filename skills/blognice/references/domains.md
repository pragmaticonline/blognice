# Custom Domains — Cloudflare for SaaS

## Flow
1. `POST /api/domains {tenant_slug, hostname}` with `Authorization: Bearer $API_TOKEN` (platform).
2. Create DNS: `CNAME hostname → $CNAME_TARGET` (from `instructions.dns.value` or env `CNAME_TARGET`). Add any `ssl_validation` records if present.
3. Poll `GET /api/domains/:hostname` until `{active:true, status:"active", ssl_status:"active"}`. On active, code flips `domains.status` + `tenants.custom_domain` and purges `https://hostname/` + sitemap.

## Validation
- `validHostname`: must contain `.`, not `blognice.com` nor `*.blognice.com` (those are `slug.blognice.com`), `^[a-z0-9.-]+$`, not `.<root>`.
- `409` if claimed by other tenant.
- Handle `isActive(result)` = `result.status==="active" && result.ssl.status==="active"`.

## Secrets
Requires `CF_API_TOKEN` (`SSL and Certificates: Edit`) + `CF_ZONE_ID` + Cloudflare for SaaS enabled. `findCustomHostname` fallback if `create` 409s. See `src/cloudflare.ts`.

## UI
`/admin/b/:blogId/domains` — connect, check, remove. Dynadot search/buy also available `POST /admin/b/:id/domains/search|buy`.
