/**
 * Phase 0.3 rollback: revert namespaced provider_id back to generic 'xtream'.
 * Run ONLY if rolling back Phase 0 entirely (e.g. reverting PR #73).
 *
 * Idempotent: exits cleanly if no rows have the namespaced provider_id.
 *
 * Run via: tsx src/scripts/migrations/rollback-provider-id-namespacing.ts
 */

import { ACTIVE_PROVIDER_ID } from "../../config";
import { query, closePool } from "../../services/db.service";

async function main() {
  console.log(
    `[rollback:provider-id-namespacing] reverting ${ACTIVE_PROVIDER_ID} → 'xtream'`,
  );

  const before = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM sv_catalog WHERE provider_id = $1`,
    [ACTIVE_PROVIDER_ID],
  );
  const beforeCount = before.rows[0]?.count ?? "0";
  console.log(
    `[rollback:provider-id-namespacing] rows with provider_id='${ACTIVE_PROVIDER_ID}': ${beforeCount}`,
  );

  if (beforeCount === "0") {
    console.log(
      "[rollback:provider-id-namespacing] nothing to do (already reverted or no rows)",
    );
    await closePool();
    return;
  }

  const r = await query(
    `UPDATE sv_catalog SET provider_id = 'xtream' WHERE provider_id = $1`,
    [ACTIVE_PROVIDER_ID],
  );
  console.log(
    `[rollback:provider-id-namespacing] reverted rows: ${r.rowCount}`,
  );

  const remaining = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM sv_catalog WHERE provider_id = $1`,
    [ACTIVE_PROVIDER_ID],
  );
  if (remaining.rows[0]?.count !== "0") {
    throw new Error(
      `[rollback:provider-id-namespacing] FAILED — rows still have namespaced provider_id`,
    );
  }

  console.log(
    "[rollback:provider-id-namespacing] SUCCESS — all rows reverted to 'xtream'",
  );
  await closePool();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
