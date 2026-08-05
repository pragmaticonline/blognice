export type MediaUse = { id: number; title: string };

export function validLibraryFile(file: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(file) && !file.startsWith("avatar-");
}

export function mediaKey(tenantId: number, file: string): string {
  return `${tenantId}/${file}`;
}

export function mediaUrl(key: string): string {
  return `/media/${key}`;
}

// Keep the reference check in one tested place. The caller supplies the
// already tenant-routed posts database; tenant_id remains in the query as a
// second isolation boundary.
export async function findMediaUse(
  db: D1Database,
  tenantId: number,
  url: string
): Promise<MediaUse | null> {
  return db.prepare(
    "SELECT id, title FROM posts WHERE tenant_id = ? AND (instr(body_md, ?) > 0 OR featured_image_key = ?) LIMIT 1"
  ).bind(tenantId, url, url.slice("/media/".length)).first<MediaUse>();
}
