/**
 * Phase 2.2 migration runner: applies 20260507-revived-at-trigger.sql.
 *
 * Idempotent: the SQL uses CREATE OR REPLACE FUNCTION + DROP/CREATE TRIGGER
 * so re-running is a no-op.
 *
 * Run via: npm run migrate:revived-at-trigger
 * Or in container:
 *   docker exec streamvault_api sh -c "cd /app && node dist/scripts/migrations/apply-revived-at-trigger.js"
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getClient, closePool, query } from "../../services/db.service";

async function main(): Promise<void> {
  // Resolve SQL file path relative to this script.
  // Project compiles to CommonJS (tsconfig module=commonjs), so __dirname is available.
  // tsx (the dev runner) also exposes __dirname for .ts files in CJS mode.
  const here = __dirname;
  const sqlPath = join(here, "20260507-revived-at-trigger.sql");
  const sql = readFileSync(sqlPath, "utf8");

  console.log(
    `[migrate:revived-at-trigger] applying ${sqlPath} (${sql.length} bytes)`,
  );

  const client = await getClient();
  try {
    await client.query(sql);
    console.log("[migrate:revived-at-trigger] OK");
  } finally {
    client.release();
  }

  // Verify trigger exists
  const r = await query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger WHERE tgname = 'sv_history_revived_at'`,
  );
  if (r.rows.length === 0) {
    throw new Error(
      "[migrate:revived-at-trigger] FAILED — trigger sv_history_revived_at not found after apply",
    );
  }
  console.log(
    `[migrate:revived-at-trigger] verified trigger present: ${r.rows[0]!.tgname}`,
  );
}

main()
  .catch((err) => {
    console.error(
      "[migrate:revived-at-trigger] failed:",
      err instanceof Error ? err.stack : err,
    );
    process.exit(1);
  })
  .finally(async () => {
    await closePool();
  });
