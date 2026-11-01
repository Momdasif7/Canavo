# Deploying CANAVO: frontend, backend and database separately

CANAVO runs as three independent pieces, each deployed, scaled and backed up on its own:

| Piece | What it is | Where | Config in the repo |
|---|---|---|---|
| **Frontend** | Next.js web app (`apps/web`) | **Vercel** | [`apps/web/vercel.json`](../../apps/web/vercel.json), [`apps/web/.env.production.example`](../../apps/web/.env.production.example) |
| **Backend** | Express API + Socket.io (`apps/api`) | **Render** (Docker web service `canavo-api`) | [`render.yaml`](../../render.yaml), [`apps/api/Dockerfile`](../../apps/api/Dockerfile), [`apps/api/.env.production.example`](../../apps/api/.env.production.example) |
| **Worker** | Scheduled background jobs on pg-boss (same image, `node dist/worker.js`) | **Render** (Background Worker `canavo-worker`) | `render.yaml` |
| **Database** | PostgreSQL 16 | **Render Postgres** (or Neon / Supabase / AWS RDS) | `databases:` block in `render.yaml` |
| Mobile | Expo app (`apps/mobile`) | EAS build → Play Store / App Store | `apps/mobile/eas.json` |

```
 Browser ──HTTPS──▶ Vercel (web)             Phone app ──HTTPS──┐
    │                                                           │
    └──────────── HTTPS + WebSocket ──▶ Render: canavo-api ◀────┘
                                          │  (REST, Socket.io, outbox publisher, uploads disk)
                                          └──TLS──▶ Render Postgres (canavo-db) ◀──TLS── Render: canavo-worker
                                                     (data + pg-boss job queue)              (scheduled jobs, backups)
                                                                                                  │
                                                                     off-site backup copies ◀─────┘  (S3 / R2 / B2)
```

Optional: **Redis** (`REDIS_URL`), only when you run more than one API instance. It shares Socket.io rooms between instances.

The web app calls the API directly at its own URL (`NEXT_PUBLIC_API_URL`). The API allows the web app's domain through `CORS_ORIGINS`.

---

## 1. Database (Render Postgres)

1. Render dashboard → **New → Blueprint** → pick this repository. The blueprint creates **canavo-db** (Postgres 16) and **canavo-api** together.
   To create only the database by hand: **New → PostgreSQL**, name `canavo-db`, region **Singapore** (closest to India), Postgres 16.
2. Plan: `basic-256mb` is enough to start. Move to a plan with **point-in-time recovery** before going live with real hotels.
3. Copy the **Internal Database URL**. The API uses it, and it never leaves Render's private network.
4. Leave **Access Control** empty so only Render services can connect.
5. **Row-level security needs a normal database role.** The database itself blocks one hotel from reading another hotel's rows, but superusers and roles with `BYPASSRLS` skip that check. Render's and Neon's default roles are fine. To confirm, run this once in a SQL shell connected with the API's `DATABASE_URL`:
   `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;` Both values must be `f`. On Supabase, or with RDS's master user, create a separate app role, grant it the tables, and use that role in `DATABASE_URL`.

**Using Neon / Supabase / RDS instead:** delete the `databases:` block from `render.yaml` and set `DATABASE_URL` on canavo-api to the provider's URL, adding `?sslmode=require`. Use the provider's **direct** (non-pooled) URL: migrations need it.

Migrations run automatically every time the API starts (`prisma migrate deploy` in the Dockerfile), so there is no manual step.

## 2. Backend (Render: canavo-api)

The blueprint creates it. Otherwise: **New → Web Service** → this repo → **Docker**, Dockerfile path `apps/api/Dockerfile`, Docker context `.` (repo root), region Singapore.

1. **Environment.** Set these (all keys are listed in `apps/api/.env.production.example`):

   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `DATABASE_URL` | from canavo-db (the blueprint links it) |
   | `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `RECEIPT_LINK_SECRET` | the blueprint generates them; otherwise `openssl rand -hex 32` each |
   | `DATA_ENCRYPTION_KEY` | `openssl rand -base64 32`. **Required.** The API refuses to start without it. **Store a copy in a password manager**: without it, encrypted Aadhaar numbers and WhatsApp tokens can't be read. |
   | `CORS_ORIGINS` | your web domain(s), e.g. `https://app.example.in,https://*.vercel.app` (the wildcard allows Vercel preview links) |
   | `PUBLIC_API_URL` | this service's URL, e.g. `https://canavo-api.onrender.com` (or your API domain) |
   | `CLOUDINARY_*` | recommended, so uploaded photos don't depend on one server's disk |
   | `MSG91_*`, `RAZORPAY_*`, `SMTP_*`, `EXPO_ACCESS_TOKEN` | optional; each feature falls back safely when empty |
   | `JOBS_MODE` | `worker` when canavo-worker runs the jobs (the blueprint sets it). `embedded` runs them inside the API instead, for a single small server without a worker. |
   | `LOG_FORMAT` | `json` (one JSON line per request with a request id; secrets redacted). `LOG_LEVEL` defaults to `info`. |
   | `METRICS_TOKEN` | 16+ characters. Prometheus scrapes `GET /metrics` with `Authorization: Bearer <token>`. In production, `/metrics` is closed without it. |
   | `REDIS_URL` | only if you run more than one API instance |
   | `BACKUP_S3_*` | off-site backup copies (§6). Strongly recommended. |

   The API **refuses to start in production** with placeholder or identical JWT secrets, no `DATA_ENCRYPTION_KEY`, a localhost `PUBLIC_API_URL` or `CORS_ORIGINS=*`. The log names each problem. `SKIP_PROD_CONFIG_CHECK=1` overrides this; use it for emergencies only.

2. **Health check path:** `/ready`. It returns 200 only when the database answers, so Render won't route traffic to an instance that can't reach the DB. `/health` is a liveness ping.
3. **Disk:** 5 GB mounted at `/repo/apps/api/storage`. It holds uploaded images (if Cloudinary isn't set), manual platform backups and the email outbox.
4. **Instances.** Start with 1. To run 2 or more, first set `REDIS_URL` (Render Key Value, or any Redis) so live updates reach users on every instance. Jobs never run twice: pg-boss creates one job per time window however many processes run.
   With more than one instance, uploads need Cloudinary, because each instance has its own disk.
5. **Do not run the demo seed in production.** `npm run seed` refuses when `NODE_ENV=production` (it would create demo logins with a published password).
6. **First Super Admin:** open the Render shell for canavo-api and run
   `ADMIN_NAME='…' ADMIN_EMAIL='…' ADMIN_PHONE='98xxxxxxxx' ADMIN_PASSWORD='…' npm run create-admin -w @canavo/api`.
   The password must be at least 12 characters with upper case, lower case and a digit. Then log in and onboard hotels from the platform console.

### 2b. Worker (Render: canavo-worker)

The blueprint creates it from the same Docker image, with the start command `node dist/worker.js`. It runs every scheduled job:
- delivery auto-assign;
- KOT release and reservations;
- late-delivery, attendance and daily-summary alerts;
- inventory stock checks and auto out-of-stock;
- CRM;
- scheduled report emails;
- the daily backup;
- clean-up of idempotency keys and delivered outbox rows.

- **Environment.** It shares the database and secrets with canavo-api (`fromService` in `render.yaml`). Set the `BACKUP_S3_*` variables on it too: the worker writes the daily backup to its own disk and then copies it off-site. The API's **Admin → Backups** screen lists those off-site copies, and restores them, marked "Off-site only".
- **Logs.** Each job logs a line, and failures show up in the logs and in `canavo_job_runs_total{result="error"}` on `/metrics`. A job that keeps failing goes to pg-boss's `<job>.dead` queue after 3 tries.
- **Skipping the worker** (single small server, lower cost): delete the worker from `render.yaml` and set `JOBS_MODE=embedded` on canavo-api.

**Custom domain:** Render → canavo-api → Settings → Custom Domains → add `api.example.in`, then create the CNAME it shows. Update `PUBLIC_API_URL`, and the web app's `NEXT_PUBLIC_API_URL`, to the new domain.

## 3. Frontend (Vercel)

1. Vercel → **Add New → Project** → import this repository.
2. **Root Directory:** `apps/web`. Keep "Include files outside the root directory" on, since the build needs `packages/shared`.
3. Framework: Next.js (auto). `apps/web/vercel.json` already sets these:
   - install: `npm ci` at the repo root (npm workspaces);
   - build: build `@canavo/shared`, then the web app.
4. **Environment Variables** (Production and Preview): `NEXT_PUBLIC_API_URL=https://canavo-api.onrender.com`, or your API domain, with no trailing slash. It is baked in at build time, so **redeploy** after changing it.
5. Deploy. Then add the Vercel domain (and any custom domain) to the API's `CORS_ORIGINS` and restart the API.

**Custom domain:** Vercel → Project → Settings → Domains → add `app.example.in`, then create the DNS record it shows. HTTPS certificates are automatic.

## 4. Mobile app

Set `EXPO_PUBLIC_API_URL=https://canavo-api.onrender.com` (or your API domain) in `apps/mobile/.env` or the EAS environment. Then run `eas build -p android --profile production` followed by `eas submit`. See `apps/mobile/STORE_RELEASE.md`.

## 5. After every deployment (5 minutes)

1. `https://<api>/ready` returns `{"ok":true,"db":"up"}`.
2. Open the web app, log in as an owner and check that the sidebar shows the hotel's logo and name.
3. Bill one item on the POS and check that the kitchen screen shows **Live** and receives the ticket. Then cancel the bill.
4. Open **Reports → Sales**.
5. Check Render logs for errors and Vercel for build warnings.

The scripted version of these checks is the API smoke suite (`SMOKE_API_URL=https://<api> npm run test:smoke -w @canavo/api`). Run it only against a staging environment that has a test hotel, never against production with demo logins.

## 6. Backups and recovery

| What | How |
|---|---|
| Database | Render Postgres daily backups (point-in-time recovery on paid plans). Restore: Render → canavo-db → Recovery. Neon / RDS have their own point-in-time recovery. |
| Platform backup | One automatic backup a day (Asia/Kolkata), written by the worker. The newest `BACKUP_RETENTION` (14) are kept on disk. The Super Admin can also create one in Admin → Backups. Restores run from the same screen. |
| Off-site copy | Set `BACKUP_S3_BUCKET` (plus `BACKUP_S3_REGION`, and `BACKUP_S3_ENDPOINT` for Cloudflare R2, Backblaze B2 or MinIO, plus the access keys) on **both** canavo-api and canavo-worker. Every backup is copied there right after it's written. Set a **lifecycle rule** on the bucket (for example, delete after 90 days), because the app prunes only its local disk. Use a bucket with versioning or object lock, and keys that can write but not delete, so a compromised server can't wipe the copies. |
| Uploaded images | Cloudinary keeps them; without Cloudinary they're on the Render disk (snapshot the disk). |
| `DATA_ENCRYPTION_KEY` and JWT secrets | Keep copies in a password manager. They can't be recovered from the database. |

**Restore drill (do it monthly, and before going live).** Run `npm run backup:drill -w @canavo/api` with `DATABASE_URL` pointing at a **staging copy**. Never point it at production. It takes a backup, restores it into a scratch database, and compares row counts per table and the total of paid bills. It prints the time each step took, which gives you your recovery time. On 2026-11-01, the dev data (13,646 rows) took about 4 s end to end, and the paid total matched to the paisa.

| Target | With these settings |
|---|---|
| RPO (data you can lose) | Up to 24 h with the daily app backup alone. **Minutes** with the provider's point-in-time recovery. Turn PITR on before going live. |
| RTO (time to restore) | About 4 s per 14k rows for the app restore (it grows with data), plus redeploy time. A PITR restore depends on the provider, typically 10–30 min. |

## 7. Rollback

- **Web:** Vercel → Deployments → pick the previous deployment → **Promote to Production** (instant).
- **API and worker:** Render → canavo-api (and canavo-worker) → Deploys → **Rollback** to the previous deploy. Roll back both together.
- **Database:** migrations are forward-only. The rollback SQL for each Phase 1 migration is in [docs/build/phase-1.md](../build/phase-1.md#migrations). If a release added a migration, roll the API back only if the old code still works with the new columns (additive migrations do). Otherwise restore the database to just before the deploy and roll back both.

## 8. Costs to expect (starting point)

Render Starter web service + Starter background worker + basic Postgres + two 5 GB disks, plus an S3-compatible bucket for off-site backups (a few GB costs very little on R2 or B2) and Vercel Hobby/Pro. Redis only when you scale the API past one instance. Prices change: check the providers' pages before you commit.
