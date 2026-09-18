// Duplicate-post cleanup for autopilot double-publishes.
//
// Overlapping autopilot runs can publish the same story twice (same title,
// distinct slugs). This module is the kept logic for that cleanup: pure
// library functions with no UI wired up yet, so a user-facing
// "remove duplicates" feature can build on it later.
//
// A duplicate group is posts of one tenant with equal normalized titles.
// The earliest-published post (lowest created_at, ties broken by lowest id)
// is the keeper; every later row is reported for deletion. Only published
// posts take part: drafts are never auto-flagged.

export type DuplicatePost = {
  id: number;
  title: string;
  createdAt: number;
};

export function normalizePostTitle(title: string): string {
  return title
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export async function findDuplicatePosts(
  postsDb: D1Database,
  tenantId: number
): Promise<DuplicatePost[]> {
  const rows = await postsDb
    .prepare(
      "SELECT id, title, created_at FROM posts WHERE tenant_id = ? AND published = 1 ORDER BY created_at ASC, id ASC"
    )
    .bind(tenantId)
    .all<{ id: number; title: string; created_at: number }>();
  const seen = new Set<string>();
  const dupes: DuplicatePost[] = [];
  for (const row of rows.results ?? []) {
    const key = normalizePostTitle(row.title);
    if (seen.has(key)) {
      dupes.push({ id: row.id, title: row.title, createdAt: row.created_at });
    } else {
      seen.add(key);
    }
  }
  return dupes;
}

const DELETE_CHUNK = 100;

export async function deleteDuplicatePosts(
  postsDb: D1Database,
  tenantId: number,
  ids: number[]
): Promise<number> {
  const targets = [...new Set(ids)].filter((id) => Number.isSafeInteger(id) && id > 0);
  let deleted = 0;
  for (let i = 0; i < targets.length; i += DELETE_CHUNK) {
    const chunk = targets.slice(i, i + DELETE_CHUNK);
    const res = await postsDb
      .prepare(`DELETE FROM posts WHERE tenant_id = ? AND id IN (${chunk.map(() => "?").join(",")})`)
      .bind(tenantId, ...chunk)
      .run();
    deleted += res.meta.changes ?? 0;
  }
  return deleted;
}

// The runs history lives in the INDEX database while posts live in POSTS, so
// no foreign key can null these links automatically. Call after deleting.
export async function unlinkAutopilotPostLinks(
  indexDb: D1Database,
  tenantId: number,
  postIds: number[]
): Promise<number> {
  const targets = [...new Set(postIds)].filter((id) => Number.isSafeInteger(id) && id > 0);
  let unlinked = 0;
  for (let i = 0; i < targets.length; i += DELETE_CHUNK) {
    const chunk = targets.slice(i, i + DELETE_CHUNK);
    const res = await indexDb
      .prepare(
        `UPDATE autopilot_runs SET post_id = NULL WHERE tenant_id = ? AND post_id IN (${chunk.map(() => "?").join(",")})`
      )
      .bind(tenantId, ...chunk)
      .run();
    unlinked += res.meta.changes ?? 0;
  }
  return unlinked;
}
