# StreamVault rollback infrastructure

Single-handle atomic rollback for FE + BE + DB. No paid services.

## Scripts

| Script | Purpose |
|---|---|
| `streamvault-snapshot.sh` | Capture coordinated snapshot of the running stack |
| `streamvault-deploy.sh` | Snapshot → deploy → smoke → auto-rollback on smoke fail |
| `streamvault-rollback.sh` | Restore a specific `deploy_id` atomically |
| `streamvault-drill.sh` | Safe production drill: deploy no-op → rollback → verify → redeploy |
| `lib/manifest.sh` | Manifest read/write/verify helpers |

## Deploy ID format

```
deploy-YYYYMMDDHHmmss-{fe-sha7}-{be-sha7}
```

Example: `deploy-20260429170142-abc1234-def5678`. Second resolution + both repo SHAs = no collisions.

## Snapshot scope

- `pg_dump --table='sv_*' --exclude-table='sv_feature_flags'` (custom format, gzip -Z 9)
- `sv_feature_flags` dumped separately to `{deploy-id}.flags.json` and **NOT** restored on rollback (so kill-switch flips survive)
- FE built dist directory copied from running container
- Manifest JSON joins it all by `deploy_id`

## Retention

14 days OR last 5 `smoke_passed: true` (whichever is longer). Disk-fill watchdog aborts deploy if `<5GB` free.

## Rollback safety

- DB restore is wrapped in a single transaction: drop sv_* tables (except feature_flags) + `pg_restore --single-transaction --exit-on-error`. Mid-restore failure leaves DB at pre-restore state.
- `sv_feature_flags` is never touched by rollback. Kill-switches survive code reverts.
- Idempotent: re-running `streamvault-rollback.sh <id>` is safe.
- On any step failure: stop, print recovery instructions, exit non-zero. Does NOT leave the system half-rolled-back.

## Drill protocol

The drill is the only way to know rollback works. **Must run before any FE PR ships in Phase 1.**

```bash
bash bin/streamvault-drill.sh
```

Steps:
1. No-op commit on BE
2. Deploy (creates new manifest)
3. Rollback to previous smoke_passed deploy
4. Verify smoke endpoints
5. Redeploy HEAD

Safe in production: pg_restore touches only `sv_*` tables (n8n/Mem0/Kokilla untouched), no-op commit changes no runtime behavior.

## Required environment

```bash
POSTGRES_USER     # default: postgres
POSTGRES_DB       # default: streamvault
POSTGRES_CONTAINER  # default: postgres (Docker container name)
FE_REPO           # default: /home/crawler/streamvault-v3-frontend
BE_REPO           # default: /home/crawler/streamvault-backend
COMPOSE_DIR       # default: /home/crawler/ai-orchestration
SV_SNAPSHOTS      # default: /home/crawler/snapshots
```

## CI integration

`.github/workflows/deploy.yml` calls `streamvault-deploy.sh` instead of running `docker compose up` directly. Auto-rollback on smoke fail.

`.github/workflows/drill.yml` (workflow_dispatch only) lets the operator trigger a drill from the GitHub UI.
