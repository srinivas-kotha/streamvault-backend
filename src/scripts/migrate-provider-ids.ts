import { writeFileSync, readFileSync } from "fs";
import { getClient, query, closePool } from "../services/db.service";

type ItemType = "live" | "vod" | "series";
type ContentType = "channel" | "vod" | "series";

interface CatalogSnapshotRow {
  provider_id: string;
  item_id: string;
  item_type: ItemType;
  name: string;
  category_id: string | null;
}

interface FavoriteRow {
  id: number;
  user_id: number;
  content_type: ContentType;
  content_id: number;
  content_name: string | null;
  category_name: string | null;
  sort_order: number;
}

interface HistoryRow {
  id: number;
  user_id: number;
  content_type: ContentType;
  content_id: number;
  content_name: string | null;
  progress_seconds: number;
  duration_seconds: number;
  watched_at: string;
}

interface CurrentCatalogRow {
  item_id: string;
  item_type: ItemType;
  name: string;
  category_id: string | null;
}

interface CategoryNameRow {
  category_id: string;
  category_type: ItemType;
  name: string;
}

const TYPE_MAP: Record<ContentType, ItemType> = {
  channel: "live",
  vod: "vod",
  series: "series",
};

function normalize(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

async function snapshot(outPath: string): Promise<void> {
  const res = await query<CatalogSnapshotRow>(
    `SELECT provider_id, item_id, item_type, name, category_id
     FROM sv_catalog
     ORDER BY provider_id, item_type, item_id`,
  );
  writeFileSync(outPath, JSON.stringify(res.rows, null, 2), "utf8");
  console.log(`[migrate] wrote ${res.rows.length} rows → ${outPath}`);
}

interface MatchIndex {
  byNameType: Map<string, CurrentCatalogRow[]>;
  byNameTypeCat: Map<string, CurrentCatalogRow>;
  categoryNameById: Map<string, string>;
}

async function buildCurrentIndex(providerId: string): Promise<MatchIndex> {
  const cat = await query<CurrentCatalogRow>(
    `SELECT item_id, item_type, name, category_id
     FROM sv_catalog
     WHERE provider_id = $1`,
    [providerId],
  );

  const cats = await query<CategoryNameRow>(
    `SELECT category_id, category_type, name
     FROM sv_catalog_categories
     WHERE provider_id = $1`,
    [providerId],
  );

  const categoryNameById = new Map<string, string>();
  for (const c of cats.rows) {
    categoryNameById.set(`${c.category_type}::${c.category_id}`, c.name);
  }

  const byNameType = new Map<string, CurrentCatalogRow[]>();
  const byNameTypeCat = new Map<string, CurrentCatalogRow>();

  for (const row of cat.rows) {
    const keyNT = `${row.item_type}::${normalize(row.name)}`;
    const list = byNameType.get(keyNT) ?? [];
    list.push(row);
    byNameType.set(keyNT, list);

    if (row.category_id) {
      const catName = categoryNameById.get(
        `${row.item_type}::${row.category_id}`,
      );
      if (catName) {
        const keyNTC = `${row.item_type}::${normalize(row.name)}::${normalize(catName)}`;
        byNameTypeCat.set(keyNTC, row);
      }
    }
  }

  return { byNameType, byNameTypeCat, categoryNameById };
}

interface ResolveResult {
  status: "matched" | "ambiguous" | "orphan" | "missing_name" | "unchanged";
  newId?: number;
  candidates?: number;
}

function resolve(
  contentType: ContentType,
  contentName: string | null,
  categoryName: string | null,
  currentId: number,
  idx: MatchIndex,
): ResolveResult {
  if (!contentName) return { status: "missing_name" };

  const itemType = TYPE_MAP[contentType];
  const name = normalize(contentName);

  if (categoryName) {
    const hit = idx.byNameTypeCat.get(
      `${itemType}::${name}::${normalize(categoryName)}`,
    );
    if (hit) {
      const newId = Number(hit.item_id);
      if (Number.isNaN(newId)) return { status: "orphan" };
      if (newId === currentId) return { status: "unchanged" };
      return { status: "matched", newId };
    }
  }

  const list = idx.byNameType.get(`${itemType}::${name}`) ?? [];
  if (list.length === 0) return { status: "orphan" };
  if (list.length > 1) return { status: "ambiguous", candidates: list.length };

  const newId = Number(list[0].item_id);
  if (Number.isNaN(newId)) return { status: "orphan" };
  if (newId === currentId) return { status: "unchanged" };
  return { status: "matched", newId };
}

interface MigrateSummary {
  matched: number;
  unchanged: number;
  ambiguous: number;
  orphan: number;
  missingName: number;
  merged: number;
}

async function migrateFavorites(
  apply: boolean,
  idx: MatchIndex,
): Promise<MigrateSummary> {
  const client = await getClient();
  const summary: MigrateSummary = {
    matched: 0,
    unchanged: 0,
    ambiguous: 0,
    orphan: 0,
    missingName: 0,
    merged: 0,
  };

  try {
    await client.query("BEGIN");
    const rows = await client.query<FavoriteRow>(
      `SELECT id, user_id, content_type, content_id, content_name, category_name, sort_order
       FROM sv_favorites`,
    );

    for (const fav of rows.rows) {
      const r = resolve(
        fav.content_type,
        fav.content_name,
        fav.category_name,
        fav.content_id,
        idx,
      );

      if (r.status === "unchanged") {
        summary.unchanged++;
        continue;
      }
      if (r.status === "ambiguous") {
        summary.ambiguous++;
        console.warn(
          `[fav] AMBIGUOUS id=${fav.id} user=${fav.user_id} name="${fav.content_name}" type=${fav.content_type} candidates=${r.candidates}`,
        );
        continue;
      }
      if (r.status === "orphan") {
        summary.orphan++;
        console.warn(
          `[fav] ORPHAN    id=${fav.id} user=${fav.user_id} name="${fav.content_name}" type=${fav.content_type}`,
        );
        continue;
      }
      if (r.status === "missing_name") {
        summary.missingName++;
        console.warn(
          `[fav] NO-NAME   id=${fav.id} user=${fav.user_id} old_id=${fav.content_id} type=${fav.content_type}`,
        );
        continue;
      }

      const newId = r.newId!;
      const collision = await client.query<{ id: number; sort_order: number }>(
        `SELECT id, sort_order FROM sv_favorites
         WHERE user_id = $1 AND content_type = $2 AND content_id = $3
           AND id <> $4`,
        [fav.user_id, fav.content_type, newId, fav.id],
      );

      if (collision.rows.length > 0) {
        const other = collision.rows[0];
        const keepId = fav.sort_order <= other.sort_order ? fav.id : other.id;
        const dropId = keepId === fav.id ? other.id : fav.id;
        summary.merged++;
        if (apply) {
          await client.query(`DELETE FROM sv_favorites WHERE id = $1`, [
            dropId,
          ]);
          await client.query(
            `UPDATE sv_favorites SET content_id = $1 WHERE id = $2`,
            [newId, keepId],
          );
        }
        console.log(
          `[fav] MERGE     user=${fav.user_id} name="${fav.content_name}" keep=${keepId} drop=${dropId} new_id=${newId}`,
        );
        continue;
      }

      summary.matched++;
      if (apply) {
        await client.query(
          `UPDATE sv_favorites SET content_id = $1 WHERE id = $2`,
          [newId, fav.id],
        );
      }
    }

    if (apply) {
      await client.query("COMMIT");
    } else {
      await client.query("ROLLBACK");
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return summary;
}

async function migrateHistory(
  apply: boolean,
  idx: MatchIndex,
): Promise<MigrateSummary> {
  const client = await getClient();
  const summary: MigrateSummary = {
    matched: 0,
    unchanged: 0,
    ambiguous: 0,
    orphan: 0,
    missingName: 0,
    merged: 0,
  };

  try {
    await client.query("BEGIN");
    const rows = await client.query<HistoryRow>(
      `SELECT id, user_id, content_type, content_id, content_name, progress_seconds, duration_seconds, watched_at
       FROM sv_watch_history`,
    );

    for (const h of rows.rows) {
      const r = resolve(
        h.content_type,
        h.content_name,
        null,
        h.content_id,
        idx,
      );

      if (r.status === "unchanged") {
        summary.unchanged++;
        continue;
      }
      if (r.status === "ambiguous") {
        summary.ambiguous++;
        console.warn(
          `[his] AMBIGUOUS id=${h.id} user=${h.user_id} name="${h.content_name}" type=${h.content_type} candidates=${r.candidates}`,
        );
        continue;
      }
      if (r.status === "orphan") {
        summary.orphan++;
        console.warn(
          `[his] ORPHAN    id=${h.id} user=${h.user_id} name="${h.content_name}" type=${h.content_type}`,
        );
        continue;
      }
      if (r.status === "missing_name") {
        summary.missingName++;
        continue;
      }

      const newId = r.newId!;
      const collision = await client.query<{ id: number; watched_at: string }>(
        `SELECT id, watched_at FROM sv_watch_history
         WHERE user_id = $1 AND content_type = $2 AND content_id = $3
           AND id <> $4`,
        [h.user_id, h.content_type, newId, h.id],
      );

      if (collision.rows.length > 0) {
        const other = collision.rows[0];
        const keepId =
          new Date(h.watched_at) >= new Date(other.watched_at)
            ? h.id
            : other.id;
        const dropId = keepId === h.id ? other.id : h.id;
        summary.merged++;
        if (apply) {
          await client.query(`DELETE FROM sv_watch_history WHERE id = $1`, [
            dropId,
          ]);
          await client.query(
            `UPDATE sv_watch_history SET content_id = $1 WHERE id = $2`,
            [newId, keepId],
          );
        }
        console.log(
          `[his] MERGE     user=${h.user_id} name="${h.content_name}" keep=${keepId} drop=${dropId} new_id=${newId}`,
        );
        continue;
      }

      summary.matched++;
      if (apply) {
        await client.query(
          `UPDATE sv_watch_history SET content_id = $1 WHERE id = $2`,
          [newId, h.id],
        );
      }
    }

    if (apply) {
      await client.query("COMMIT");
    } else {
      await client.query("ROLLBACK");
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return summary;
}

async function migrate(snapshotPath: string, apply: boolean): Promise<void> {
  const snap: CatalogSnapshotRow[] = JSON.parse(
    readFileSync(snapshotPath, "utf8"),
  );
  const providerIds = [...new Set(snap.map((r) => r.provider_id))];
  if (providerIds.length !== 1) {
    throw new Error(
      `snapshot must contain exactly one provider_id, got: ${providerIds.join(", ")}`,
    );
  }
  const providerId = providerIds[0];
  console.log(
    `[migrate] snapshot: ${snap.length} rows under provider_id="${providerId}"`,
  );

  const idx = await buildCurrentIndex(providerId);
  const currentCount = [...idx.byNameType.values()].reduce(
    (a, b) => a + b.length,
    0,
  );
  console.log(`[migrate] current catalog: ${currentCount} rows`);
  console.log(`[migrate] mode: ${apply ? "APPLY (writes)" : "DRY-RUN"}`);

  const favSummary = await migrateFavorites(apply, idx);
  const hisSummary = await migrateHistory(apply, idx);

  console.log("");
  console.log("=== sv_favorites ===");
  console.log(favSummary);
  console.log("=== sv_watch_history ===");
  console.log(hisSummary);

  if (!apply) {
    console.log("");
    console.log("[migrate] dry-run complete. Re-run with --apply to write.");
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  try {
    if (cmd === "snapshot") {
      const out = rest[0];
      if (!out) throw new Error("usage: snapshot <output.json>");
      await snapshot(out);
    } else if (cmd === "migrate") {
      const snapPath = rest[0];
      if (!snapPath) throw new Error("usage: migrate <snapshot.json> [--apply]");
      const apply = rest.includes("--apply");
      await migrate(snapPath, apply);
    } else {
      console.error("usage:");
      console.error("  migrate-provider-ids snapshot <output.json>");
      console.error(
        "  migrate-provider-ids migrate <snapshot.json> [--apply]",
      );
      process.exit(1);
    }
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error("[migrate] failed:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
