import { canonicalArticle } from "../server/network.js";
import type { ArticleRef } from "../shared/types.js";
export function parsePublishResponse(
  input: any,
): { items: ArticleRef[]; total?: number; groups: number } | null {
  try {
    const page =
      typeof input.publish_page === "string"
        ? JSON.parse(input.publish_page)
        : input.publish_page;
    if (!page || !Array.isArray(page.publish_list)) return null;
    const items: ArticleRef[] = [];
    for (const entry of page.publish_list) {
      const info =
        typeof entry.publish_info === "string"
          ? JSON.parse(entry.publish_info)
          : entry.publish_info;
      if (!Array.isArray(info?.appmsgex)) return null;
      for (const a of info.appmsgex) {
        const c = canonicalArticle(a.link || a.url);
        const t = a.publish_time || info.publish_time;
        items.push({
          ...c,
          title: a.title || "未命名文章",
          author: a.author || null,
          publishedAt: t ? new Date(Number(t) * 1000).toISOString() : null,
          source: "browser",
          sourceId: c.key,
          deleted: !!a.is_deleted,
        });
      }
    }
    return {
      items,
      total:
        typeof page.total_count === "number"
          ? page.total_count
          : typeof page.publish_count === "number"
            ? page.publish_count
            : undefined,
      groups: page.publish_list.length,
    };
  } catch {
    return null;
  }
}
export function identityMatches(
  expected: { original_id: string; app_id?: string },
  found: { originalId?: string; appId?: string },
) {
  if (found.originalId && found.originalId !== expected.original_id)
    return false;
  if (found.appId && expected.app_id && found.appId !== expected.app_id)
    return false;
  return !!(
    found.originalId === expected.original_id ||
    (expected.app_id && found.appId === expected.app_id)
  );
}
