import bcrypt from "bcryptjs";
import { getPool, query } from "../services/db.service";

async function seedAdmin(): Promise<void> {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_INITIAL_PASSWORD;

  if (!username || !password) {
    console.error(
      "[seed-admin] ADMIN_USERNAME and ADMIN_INITIAL_PASSWORD env vars are required",
    );
    process.exit(1);
  }

  if (password.length < 6) {
    console.error("[seed-admin] password must be at least 6 characters");
    process.exit(1);
  }

  const dryRun = process.env.SEED_ADMIN_DRY_RUN === "1";
  const hash = await bcrypt.hash(password, 10);

  if (dryRun) {
    console.log(
      `[seed-admin] DRY RUN — would upsert username=${username} (hash length=${hash.length})`,
    );
    await getPool().end();
    return;
  }

  const result = await query<{ id: number; username: string }>(
    `INSERT INTO sv_users (username, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (username)
     DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id, username`,
    [username, hash],
  );

  const row = result.rows[0];
  console.log(
    `[seed-admin] upserted user id=${row.id} username=${row.username}`,
  );
  await getPool().end();
}

seedAdmin().catch((err) => {
  console.error(
    "[seed-admin] failed:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
