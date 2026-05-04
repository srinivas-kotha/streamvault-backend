/**
 * Phase 2.2 migration runner: applies revived_at trigger.
 *
 * SQL is inlined here (matches `apply-provider-id-namespacing.ts` pattern)
 * because tsc only emits .ts → .js; .sql files are not copied to dist/ by the
 * Docker build, so a readFileSync on a sibling .sql ENOENTs in the container.
 * The .sql sibling file is kept as a checked-in human-readable record and can
 * be applied directly with `psql -f` if needed.
 *
 * Idempotent: CREATE OR REPLACE FUNCTION + DROP/CREATE TRIGGER pattern.
 *
 * Run via: npm run migrate:revived-at-trigger
 * Or in container:
 *   docker exec streamvault_api sh -c "cd /app && node dist/scripts/migrations/apply-revived-at-trigger.js"
 */

import { getClient, closePool, query } from "../../services/db.service";

const SQL = `
BEGIN;

CREATE OR REPLACE FUNCTION sv_history_set_revived_at() RETURNS trigger AS $func$
BEGIN
  IF (OLD.content_uid IS NULL AND NEW.content_uid IS NOT NULL) THEN
    NEW.revived_at = now();
  END IF;
  RETURN NEW;
END $func$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sv_history_revived_at ON sv_watch_history;
CREATE TRIGGER sv_history_revived_at
  BEFORE UPDATE ON sv_watch_history
  FOR EACH ROW EXECUTE FUNCTION sv_history_set_revived_at();

COMMIT;
`;

async function main(): Promise<void> {
  console.log(
    `[migrate:revived-at-trigger] applying inlined trigger SQL (${SQL.length} bytes)`,
  );

  const client = await getClient();
  try {
    await client.query(SQL);
    console.log("[migrate:revived-at-trigger] OK");
  } finally {
    client.release();
  }

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
