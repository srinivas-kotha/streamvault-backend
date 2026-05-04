/**
 * Phase 0.3 migration: rename generic 'xtream' provider_id in sv_catalog to
 * the namespaced form xtream:<sha1(host:port:user)[:8]>.
 *
 * Idempotent: if no rows have provider_id='xtream', exits cleanly.
 *
 * Run via: npm run migrate:provider-id-namespacing
 * Or in container: docker exec streamvault_api sh -c "cd /app && node dist/scripts/migrations/apply-provider-id-namespacing.js"
 */

import { ACTIVE_PROVIDER_ID } from "../../config";
import { query, closePool } from "../../services/db.service";

async function main() {
  console.log(
    `[migrate:provider-id-namespacing] target provider_id = ${ACTIVE_PROVIDER_ID}`,
  );

  const before = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM sv_catalog WHERE provider_id = 'xtream'`,
  );
  const beforeCount = before.rows[0]?.count ?? "0";
  console.log(
    `[migrate:provider-id-namespacing] rows with provider_id='xtream': ${beforeCount}`,
  );

  if (beforeCount === "0") {
    console.log(
      "[migrate:provider-id-namespacing] nothing to do (already migrated or no rows)",
    );
    await closePool();
    return;
  }

  const r = await query(
    `UPDATE sv_catalog SET provider_id = $1 WHERE provider_id = 'xtream'`,
    [ACTIVE_PROVIDER_ID],
  );
  console.log(`[migrate:provider-id-namespacing] updated rows: ${r.rowCount}`);

  const remaining = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM sv_catalog WHERE provider_id = 'xtream'`,
  );
  const remainingCount = remaining.rows[0]?.count ?? "0";
  if (remainingCount !== "0") {
    throw new Error(
      `[migrate:provider-id-namespacing] FAILED — ${remainingCount} stale 'xtream' rows remain`,
    );
  }

  console.log(
    `[migrate:provider-id-namespacing] SUCCESS — all rows now use ${ACTIVE_PROVIDER_ID}`,
  );
  await closePool();
}

// CommonJS main-module detection (compiled JS runs as CJS)
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
