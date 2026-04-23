# Provider Swap Runbook

What to do when the upstream Xtream provider changes (new host/creds, or a
different Xtream seller). Covers the same-provider-type case — a full
`PROVIDER_TYPE` change (e.g. Xtream → M3U) still requires implementing the
new provider class per [adding-a-provider.md](./adding-a-provider.md).

## Why this exists

`sv_catalog.item_id` is assigned by the upstream provider. `sv_favorites` and
`sv_watch_history` store `content_id` as a raw pointer into that space.
Swapping providers invalidates every `content_id` — without a rewrite, every
user's favorites and continue-watching row silently breaks.

The rewrite is a name-match migration: we snapshot the old catalog *before*
the swap, then map old IDs → names → new IDs by looking up each saved row's
`content_name` in the freshly-synced catalog.

## Steps

### 1. Before the swap — snapshot the old catalog

Run against a live DB while the old provider is still configured:

```bash
npm run migrate:provider-ids -- snapshot /tmp/sv-catalog-pre-swap.json
```

This writes every `sv_catalog` row (provider_id, item_id, item_type, name,
category_id) to JSON. Keep the file somewhere durable — if the catalog gets
overwritten before you run the migrate step, there is no way to reconstruct
the old `content_id` → name mapping.

### 2. Swap credentials and resync

1. Update `XTREAM_HOST / XTREAM_PORT / XTREAM_USERNAME / XTREAM_PASSWORD` in
   the backend `.env`.
2. `docker compose up -d --build streamvault_api` (or let CI deploy).
3. Wait for the background catalog sync to populate `sv_catalog` under the
   new provider. Live refreshes every 2 hrs, VOD/series every 6 hrs — to
   force it sooner, bounce the container after confirming the new
   credentials with `/api/account`.
4. Sanity-check `sv_catalog` row count matches roughly what you saw in the
   snapshot.

### 3. Dry-run the migration

```bash
npm run migrate:provider-ids -- migrate /tmp/sv-catalog-pre-swap.json
```

Reads the snapshot, rebuilds a name→id index from the current catalog, and
prints a summary per table:

- `matched` — a clean rewrite (one candidate, or category tiebreak)
- `unchanged` — the new ID happens to equal the old one (skipped)
- `ambiguous` — more than one catalog row has the same (type, name); skipped
  so the operator can decide by hand
- `orphan` — no current catalog row matches the saved name (provider
  dropped the title, or the name changed); skipped
- `missingName` — the saved row has a null/empty `content_name`; can't match
- `merged` — the rewritten ID collides with another row for the same
  `(user_id, content_type, content_id)`; favorites keep the lower
  `sort_order`, history keeps the newer `watched_at`

The dry-run opens a transaction and rolls it back, so nothing is written.
Per-row warnings print to stdout with user_id + content_name — grep the log
for AMBIGUOUS / ORPHAN to decide if the match rate is acceptable before
applying.

### 4. Apply

```bash
npm run migrate:provider-ids -- migrate /tmp/sv-catalog-pre-swap.json --apply
```

Writes inside a single transaction per table (favorites + history are
separate transactions, not one combined). Ambiguous / orphan rows are left
untouched — the app surfaces them with missing artwork + dead stream, which
users can clean up via the existing ✕ buttons in Favorites/History.

### 5. Verify

1. Log into prod as a user who had favorites + watch history.
2. Favorites grid: tiles should render with correct artwork and open the
   detail sheet (i.e. the `content_id` now resolves against the new
   catalog).
3. Continue-watching chip: picks up where you left off.
4. For a known orphan, confirm the ✕ delete path still works.

## What this does NOT cover

- **EPG orphaning.** `sv_epg.channel_id` comes from the provider's stream_id
  for live channels. It repopulates on the next EPG refresh, no migration
  needed.
- **`stream_audio_tracks`** (Option B cache from v3 player spec) — not
  built yet. When it ships, add a third pass here.
- **Frontend tier-lock localStorage.** Keyed on old `content_id`. Self-heals
  the next time a stream succeeds / fails; not worth scripting.
- **Different `PROVIDER_TYPE`.** Requires a new provider class. The snapshot
  step still works (dump the old catalog), but the match step assumes both
  snapshots share a name space. Cross-provider name matching tends to be
  noisier (different casing, suffixes like "HD", "FHD", "4K"); expect a
  lower match rate and plan on more manual cleanup.

## File locations

- Script: [`src/scripts/migrate-provider-ids.ts`](../src/scripts/migrate-provider-ids.ts)
- Schema (catalog): [`postgres/03-phase3-services.sql`](../postgres/03-phase3-services.sql)
- Schema (favorites + history): `ai-orchestration/postgres/20-streamvault-schema.sql`
