// Landing page gating and posts-DB data access.
//
// Eligibility is always about the blog's OWNER account, never the
// logged-in delegate (spec: Gating & roles). Rollout is a platform
// switch in platform_settings ('landing.rollout'), defaulting to
// 'off' on any read failure, mirroring the TTS engine switch.

import { accountHasPaidPlan, accountIsVip, type Account } from "./auth";
import { tenantDb, type DbEnv } from "./db";
import type { Tenant } from "./render";

export type LandingRollout = "off" | "vip" | "paid" | "all";

export const LANDING_ROLLOUT_KEY = "landing.rollout";
export const MAX_LANDING_PAGES = 10;
export const LANDING_NOT_AVAILABLE = "Landing pages are not available on this account.";

export async function landingRollout(db: D1Database): Promise<LandingRollout> {
  try {
    const row = await db
      .prepare("SELECT value FROM platform_settings WHERE key = ?")
      .bind(LANDING_ROLLOUT_KEY)
      .first<{ value: string }>();
    const value = String(row?.value ?? "").trim().toLowerCase();
    return value === "vip" || value === "paid" || value === "all" ? value : "off";
  } catch {
    return "off";
  }
}

export function accountCanUseLandingPages(
  account: Pick<Account, "billing_status" | "crypto_paid_through" | "vip_granted_at" | "vip_expires_at" | "landing_access_override"> | null | undefined,
  rollout: LandingRollout,
): boolean {
  if (rollout === "all") return true;
  if (!account) return false;
  if (Number(account.landing_access_override ?? 0) === 1) return true;
  if (rollout === "off") return false;
  if (rollout === "vip") return accountIsVip(account);
  return accountHasPaidPlan(account);
}

type OwnerRow = Pick<Account, "billing_status" | "crypto_paid_through" | "vip_granted_at" | "vip_expires_at" | "landing_access_override">;

async function ownerAccountForTenant(db: D1Database, tenantId: number): Promise<OwnerRow | null> {
  try {
    return await db
      .prepare(
        `SELECT a.billing_status, a.crypto_paid_through, a.vip_granted_at, a.vip_expires_at, a.landing_access_override
           FROM memberships m JOIN accounts a ON a.id = m.account_id
          WHERE m.tenant_id = ? AND m.role = 'owner' LIMIT 1`,
      )
      .bind(tenantId)
      .first<OwnerRow>();
  } catch {
    // Pre-094 databases lack landing_access_override; fall back without it.
    const owner = await db
      .prepare(
        `SELECT a.billing_status, a.crypto_paid_through, a.vip_granted_at, a.vip_expires_at
           FROM memberships m JOIN accounts a ON a.id = m.account_id
          WHERE m.tenant_id = ? AND m.role = 'owner' LIMIT 1`,
      )
      .bind(tenantId)
      .first<OwnerRow>();
    return owner ? { ...owner, landing_access_override: 0 } : null;
  }
}

export async function tenantCanUseLandingPages(env: DbEnv, tenantId: number): Promise<boolean> {
  const [rollout, owner] = await Promise.all([
    landingRollout(env.DB),
    ownerAccountForTenant(env.DB, tenantId),
  ]);
  return accountCanUseLandingPages(owner, rollout);
}

// ---------------------------------------------------------------------------
// landing_pages rows (posts DB, always via tenantDb, always tenant-scoped)
// ---------------------------------------------------------------------------

export type LandingPage = {
  id: number;
  tenant_id: number;
  slug: string;
  title: string;
  design: string;
  content_json: string;
  meta_description: string | null;
  published: number;
  created_at: number;
  updated_at: number;
  published_at: number | null;
};

export async function listLandingPages(env: DbEnv, tenant: Tenant): Promise<LandingPage[]> {
  const { results } = await tenantDb(env, tenant)
    .prepare("SELECT * FROM landing_pages WHERE tenant_id = ? ORDER BY updated_at DESC")
    .bind(tenant.id)
    .all<LandingPage>();
  return results;
}

export async function getLandingPage(env: DbEnv, tenant: Tenant, id: number): Promise<LandingPage | null> {
  return tenantDb(env, tenant)
    .prepare("SELECT * FROM landing_pages WHERE id = ? AND tenant_id = ?")
    .bind(id, tenant.id)
    .first<LandingPage>();
}

export async function getLandingPageBySlug(env: DbEnv, tenant: Tenant, slug: string): Promise<LandingPage | null> {
  return tenantDb(env, tenant)
    .prepare("SELECT * FROM landing_pages WHERE tenant_id = ? AND slug = ?")
    .bind(tenant.id, slug)
    .first<LandingPage>();
}

export async function countLandingPages(env: DbEnv, tenant: Tenant): Promise<number> {
  const row = await tenantDb(env, tenant)
    .prepare("SELECT COUNT(*) AS count FROM landing_pages WHERE tenant_id = ?")
    .bind(tenant.id)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

function randomSuffix(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  // Rejection sampling: 252 is the largest multiple of 36 within a byte,
  // so accepted bytes map onto the alphabet without modulo bias.
  let out = "";
  while (out.length < 5) {
    for (const b of crypto.getRandomValues(new Uint8Array(8))) {
      if (b >= 252) continue;
      out += alphabet[b % alphabet.length];
      if (out.length === 5) break;
    }
  }
  return out;
}

// Modelled on uniquePageSlug (src/index.ts): caller normalises the base
// slug; this only resolves collisions within landing_pages.
export async function uniqueLandingSlug(
  pdb: D1Database,
  tenantId: number,
  base: string,
  excludeId?: number,
  maxLen = 100,
): Promise<string> {
  let slug = base.slice(0, maxLen);
  for (let i = 0; i < 10; i++) {
    const clash = excludeId
      ? await pdb.prepare("SELECT 1 FROM landing_pages WHERE tenant_id = ? AND slug = ? AND id != ?").bind(tenantId, slug, excludeId).first()
      : await pdb.prepare("SELECT 1 FROM landing_pages WHERE tenant_id = ? AND slug = ?").bind(tenantId, slug).first();
    if (!clash) return slug;
    slug = `${base.slice(0, maxLen - 6)}-${randomSuffix()}`;
  }
  return slug;
}

// The effective homepage landing page: home pointer set, row exists in
// this tenant's shard, published, and the owner is landing-eligible.
// Any inconsistency resolves to null (blog is homepage) — never throws
// for a missing table pre-093, so the blog stays up during rollout.
export async function getHomepageLandingPage(env: DbEnv, tenant: Tenant): Promise<LandingPage | null> {
  const id = Number((tenant as any).home_landing_page_id ?? 0);
  if (!id) return null;
  try {
    const [page, eligible] = await Promise.all([
      getLandingPage(env, tenant, id),
      tenantCanUseLandingPages(env, tenant.id),
    ]);
    if (!page || !page.published || !eligible) return null;
    return page;
  } catch {
    return null;
  }
}
