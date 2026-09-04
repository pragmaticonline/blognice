import type { Tenant } from "./render";

// --- The data split + sharding seam ----------------------------------------
//
// Blog Nice uses two databases from day one:
//   env.DB     the INDEX database: tenants, users, sessions, domains.
//   env.POSTS  the POSTS database: tenant-scoped posts, pages, and delivery state.
//
// Account metadata is small and always queried per tenant; content is the data
// that grows without bound, so it gets its own database. Keeping this
// boundary from the start means the posts table can later be split across
// several databases with no migration of the metadata and no change to URLs or
// the read pattern.
//
// `tenantDb()` is the ONE place that maps a tenant to the database holding its
// posts. Today every tenant's `shard` is "primary", which resolves to the
// single POSTS database. To scale past 10 GB of post text later: create another
// posts database, bind it (e.g. `POSTS_2`), point some tenants at it by setting
// their `shard`, and add a `case` below. Because `shard` lives on the tenant
// record -- resolved from the hostname on every request -- routing adds no
// lookup, and moving a tenant is a one-field update that breaks no post URLs.
//
// NOTE ON INTEGRITY: because posts live in a different database, there is no
// cross-database foreign key from posts to tenants. Every posts query is scoped
// by tenant_id, and when you delete a tenant you must also delete its posts
// from the POSTS database -- SQLite's ON DELETE CASCADE cannot reach across
// databases. See deleteTenantPosts() below.

export type DbEnv = {
  DB: D1Database;
  POSTS: D1Database;
} & Record<string, unknown>;

// The database holding a given tenant's posts.
export function tenantDb(env: DbEnv, tenant: Tenant): D1Database {
  switch (tenant.shard) {
    // Example future posts shard, bound in wrangler.jsonc as `POSTS_2`:
    //   case "posts-2": return env.POSTS_2 as D1Database;
    case "primary": return env.POSTS;
    default: throw new Error(`Unknown posts shard: ${tenant.shard}`);
  }
}

// Cross-database cleanup: call this when deleting a tenant, since the FK
// cascade in the index database cannot delete rows in the POSTS database.
export async function deleteTenantPosts(
  env: DbEnv,
  tenant: Tenant
): Promise<void> {
  const db = tenantDb(env, tenant);
  await db.batch([
    db.prepare("DELETE FROM posts WHERE tenant_id = ?").bind(tenant.id),
    db.prepare("DELETE FROM pages WHERE tenant_id = ?").bind(tenant.id),
  ]);
}
