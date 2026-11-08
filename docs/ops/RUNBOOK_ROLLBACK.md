# Runbook: rollback

Decide fast: roll back when a release causes a P0/P1 (billing, payments, data visibility across tenants, login) and no
fix is ready within 15 min. Rolling back code is cheap; rolling back the database is not.

## 1. Web (instant)
Vercel → Deployments → previous production deployment → **Promote to Production**.

## 2. API and worker (≈ 3–5 min)
Render → canavo-api → Deploys → previous deploy → **Rollback**; then the same on canavo-worker. Always both, same commit.
Verify `/ready`, one bill, KDS Live.

## 3. Database
Migrations are forward-only (Prisma has no down migrations).

| Release migrations | Action |
|---|---|
| None | Code rollback only. |
| Additive only (new tables, nullable / defaulted columns, indexes) — the normal case | Code rollback only; the old code ignores the new columns. Leave the migration applied. |
| A migration **failed** mid-deploy | Nothing was left behind (one transaction per file) except a failed `CONCURRENTLY` index: `DROP INDEX CONCURRENTLY IF EXISTS "<name>"`, then `npx prisma migrate resolve --rolled-back <name>` ([migration runbook §4](../qa/phase-7/migration-runbook.md)). |
| Destructive / incompatible (dropped or renamed column, type change) | Prefer a **forward fix** (new migration). If impossible: restore the DB to just before the deploy (PITR, [BACKUP_RESTORE.md](BACKUP_RESTORE.md)) and roll back API + worker together. Data written since the deploy is lost → incident comms. |

Never edit an applied migration file (checksum mismatch blocks later deploys).

## 4. Mobile (Expo)
The app has no OTA updates (no `expo-updates`): store builds cannot be rolled back — ship a fix build. Keep API changes backward compatible with the previous mobile release.

## 5. After
Open a bug (BUGS.csv / tracker) with the failure, add a regression test, write the incident note
([RUNBOOK_INCIDENT.md](RUNBOOK_INCIDENT.md)).
