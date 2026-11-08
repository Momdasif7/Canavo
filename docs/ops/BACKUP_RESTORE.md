# Backup and restore

## Layers
| Layer | Schedule | Retention | Where |
|---|---|---|---|
| Provider backups / **PITR** (Render, Neon, RDS) | continuous / daily | provider plan (turn PITR on before go-live) | provider |
| Platform backup (all 82 Prisma tables, app-level, RLS-safe) | `daily-backup` job in canavo-worker: checks hourly, one backup per IST day | newest `BACKUP_RETENTION` (default **14**) on the worker disk | `/repo/apps/api/storage` |
| Off-site copy | right after each platform backup | bucket lifecycle rule (e.g. 90 days) — the app prunes only local disk | S3 / R2 / B2 (`BACKUP_S3_*` on API **and** worker) |
| Manual | Super Admin → Admin → Backups → Create | same as above | same |
| Secrets (`DATA_ENCRYPTION_KEY`, JWT secrets) | on change | forever | password manager — not recoverable from the DB |

Off-site bucket: versioning or object lock, and write-only keys (a compromised server must not be able to delete copies).
Not in the platform backup: `_prisma_migrations` (checked instead — restore refuses a different migration set) and the
`pgboss` schema (queued jobs after a restore are the current ones). Uploaded images: Cloudinary, or snapshot the disk
(see [UPLOADS_STORAGE.md](UPLOADS_STORAGE.md)).

## Restore drill evidence (QA Phase 7, [dbc.md](../qa/phase-7/dbc.md))
| Check | Result |
|---|---|
| `npm run backup:drill` on seeded DB | **PASSED**: 7,149 rows, backup 0.3 s, restore 2.0 s, total 3.9 s, paid total equal to the paisa |
| Drill on dev data (2026-11-01, DEPLOYMENT.md §6) | 13,646 rows ≈ 4 s, paid total matched |
| App backup → restore over a populated DB (`test/db/backup-restore.test.ts`) | counts of all 82 tables and money totals identical; app keeps billing after restore (after fix dbc-1) |
| Restore into a fresh empty DB as the app role | identical counts/totals; RLS policies, FORCE RLS, enums identical; RLS still enforced |
| Refusals (other migration set / truncated file / missing grants) | 409 / 400 / 409, nothing changed |
| `pg_dump` / `pg_restore` as superuser | exact (counts, totals, 77 policies, grants, enums, sequences) |
| `pg_dump` as non-superuser owner (Render/Neon) | **fails** (dbc-3, FORCE RLS binds owner) — rely on PITR + platform backup |

Repeat the drill **monthly and before go-live** against a staging copy (never production):
`DATABASE_URL=<staging> npm run backup:drill -w @canavo/api`. Record date, rows, timings and result in the ops log.

## RPO / RTO targets
| Target | Value | How |
|---|---|---|
| **RPO** | ≤ 5 min (PITR on) · ≤ 24 h worst case (platform backup only) | PITR is a go-live requirement |
| **RTO** | ≤ 1 h | PITR restore 10–30 min (provider) + redeploy/repoint `DATABASE_URL` 10 min + smoke 5 min |

Scaling note (dbc R2): the platform restore runs in one transaction (15-min timeout, ≈3,500 rows/s, ACCESS EXCLUSIVE on all
tables). ~3 M rows would hit the timeout — beyond pilot size use PITR as the primary restore path.

## Restore procedure (summary)
1. Declare an incident ([RUNBOOK_INCIDENT.md](RUNBOOK_INCIDENT.md)); stop the worker (no jobs during restore).
2. PITR: provider console → restore to a new DB at time T → set `DATABASE_URL` on API + worker → redeploy.
   Platform backup: Admin → Backups → pick (local or "Off-site only") → Restore (API queues while it runs).
3. `psql "$DATABASE_URL" -f apps/api/scripts/qa/post-deploy-verify.sql` (must list no problems), `/ready`, smoke bill.
4. Start the worker; tell outlets which window of data must be re-entered (bills still queued on offline POS devices sync when they reconnect).
