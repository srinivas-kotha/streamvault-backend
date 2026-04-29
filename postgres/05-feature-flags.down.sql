-- Down migration for 05-feature-flags.sql
-- Reversible by design: drops only StreamVault-owned table; no co-tenant impact.

DROP INDEX IF EXISTS idx_sv_ff_scope_id;
DROP INDEX IF EXISTS idx_sv_ff_key_scope;
DROP TABLE IF EXISTS sv_feature_flags;
