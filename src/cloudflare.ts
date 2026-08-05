// Thin wrapper around the Cloudflare for SaaS "custom hostnames" API.
// Docs: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/
//
// Needs two things in the environment:
//   CF_API_TOKEN  (secret) — a token scoped to edit SSL/custom hostnames
//   CF_ZONE_ID    (var)    — the zone id of your platform domain (blognice.com)

export type CfEnv = {
  CF_API_TOKEN: string;
  CF_ZONE_ID: string;
  CNAME_TARGET: string; // what customers CNAME to, e.g. "cname.blognice.com"
};

export type CfResult = { ok: boolean; status: number; result: any; errors: any[] };

async function cf(
  env: CfEnv,
  path: string,
  init?: RequestInit
): Promise<CfResult> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    }
  );
  const data: any = await res.json().catch(() => ({}));
  return {
    ok: res.ok && data?.success === true,
    status: res.status,
    result: data?.result ?? null,
    errors: data?.errors ?? [],
  };
}

// Register a customer hostname. We use DV certificates with HTTP validation,
// which completes automatically once the customer's CNAME points at us.
export function createCustomHostname(env: CfEnv, hostname: string) {
  return cf(env, "/custom_hostnames", {
    method: "POST",
    body: JSON.stringify({
      hostname,
      ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
    }),
  });
}

export function getCustomHostname(env: CfEnv, id: string) {
  return cf(env, `/custom_hostnames/${id}`);
}

export function findCustomHostname(env: CfEnv, hostname: string) {
  return cf(env, `/custom_hostnames?hostname=${encodeURIComponent(hostname)}`);
}

export function deleteCustomHostname(env: CfEnv, id: string) {
  return cf(env, `/custom_hostnames/${id}`, { method: "DELETE" });
}

// A hostname is only safe to route to once BOTH the hostname is active and its
// certificate is issued.
export function isActive(result: any): boolean {
  return result?.status === "active" && result?.ssl?.status === "active";
}

// Turn a raw Cloudflare custom-hostname record into a tidy set of instructions
// the customer's onboarding screen can display.
export function instructions(env: CfEnv, hostname: string, result: any) {
  const sslErrors = (result?.ssl?.validation_errors ?? []).map(
    (e: any) => e.message
  );
  return {
    hostname,
    active: isActive(result),
    status: result?.status ?? "unknown", // pending | active | ...
    ssl_status: result?.ssl?.status ?? "unknown",
    // The DNS record the customer must create.
    dns: { type: "CNAME", name: hostname, value: env.CNAME_TARGET },
    // Extra records Cloudflare may require while validating.
    ssl_validation: result?.ssl?.validation_records ?? [],
    ownership_verification: result?.ownership_verification ?? null,
    errors: [...(result?.verification_errors ?? []), ...sslErrors],
  };
}
