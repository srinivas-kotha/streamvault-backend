import { query } from "./db.service";

export type FlagValue = boolean | number | string | object | null;

export interface FlagRow {
  key: string;
  scope: "global" | "user" | "device";
  scope_id: string | null;
  value: FlagValue;
  description: string | null;
  updated_at: string;
  updated_by: string;
}

export interface FlagMap {
  [key: string]: FlagValue;
}

const KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

export function isValidFlagKey(key: string): boolean {
  return KEY_PATTERN.test(key) && key.length <= 128;
}

export async function getGlobalFlags(): Promise<FlagMap> {
  const result = await query<{ key: string; value: FlagValue }>(
    `SELECT key, value
       FROM sv_feature_flags
      WHERE scope = 'global' AND scope_id IS NULL`,
  );
  return Object.fromEntries(result.rows.map((r) => [r.key, r.value]));
}

export async function getUserFlags(userId: number): Promise<FlagMap> {
  if (!Number.isInteger(userId) || userId <= 0) return {};
  const result = await query<{ key: string; value: FlagValue }>(
    `SELECT key, value
       FROM sv_feature_flags
      WHERE scope = 'user' AND scope_id = $1`,
    [String(userId)],
  );
  return Object.fromEntries(result.rows.map((r) => [r.key, r.value]));
}

export async function getMergedFlags(userId?: number): Promise<FlagMap> {
  const globals = await getGlobalFlags();
  if (!userId || userId <= 0) return globals;
  const overrides = await getUserFlags(userId);
  return { ...globals, ...overrides };
}

export async function upsertFlag(args: {
  key: string;
  value: FlagValue;
  scope?: "global" | "user" | "device";
  scope_id?: string | null;
  updated_by: string;
}): Promise<void> {
  const scope = args.scope ?? "global";
  const scopeId = args.scope_id ?? null;
  if (!isValidFlagKey(args.key)) {
    throw new Error(`Invalid flag key: ${args.key}`);
  }
  await query(
    `INSERT INTO sv_feature_flags (key, scope, scope_id, value, updated_by, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
     ON CONFLICT ON CONSTRAINT sv_feature_flags_unique_key_scope
     DO UPDATE SET value = EXCLUDED.value,
                   updated_by = EXCLUDED.updated_by,
                   updated_at = NOW()`,
    [args.key, scope, scopeId, JSON.stringify(args.value), args.updated_by],
  );
}
