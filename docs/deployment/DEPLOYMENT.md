# Deploying CANAVO: frontend, backend and database separately

CANAVO runs as three independent pieces, each deployed, scaled and backed up on its own:

| Piece | What it is | Where | Config in the repo |
|---|---|---|---|
| **Frontend** | Next.js web app (`apps/web`) | **Vercel** | [`apps/web/vercel.json`](../../apps/web/vercel.json), [`apps/web/.env.production.example`](../../apps/web/.env.production.example) |
| **Backend** | Express API + Socket.io + background jobs (`apps/api`) | **Render** (Docker web service) | [`render.yaml`](../../render.yaml), [`apps/api/Dockerfile`](../../apps/api/Dockerfile), [`apps/api/.env.production.example`](../../apps/api/.env.production.example) |
| **Database** | PostgreSQL 16 | **Render Postgres** (or Neon / Supabase / AWS RDS) | `databases:` block in `render.yaml` |
| Mobile | Expo app (`apps/mobile`) | EAS build → Play Store / App Store | `apps/mobile/eas.json` |

```
 Browser ──HTTPS──▶ Vercel (web)             Phone app ──HTTPS──┐
    │                                                           │
    └──────────── HTTPS + WebSocket ──▶ Render: canavo-api ◀────┘
                                          │  (REST, Socket.io, jobs, uploads disk)
                                          └──TLS──▶ Render Postgres (canavo-db)
```

The web app calls the API directly at its own URL (`NEXT_PUBLIC_API_URL`). The API allows the web app's domain through `CORS_ORIGINS`.

---

## 1. Database (Render Postgres)

1. Render dashboard → **New → Blueprint** → pick this repository. The blueprint creates **canavo-db** (Postgres 16) and **canavo-api** together.
   To create only the database by hand: **New → PostgreSQL**, name `canavo-db`, region **Singapore** (closest to India), Postgres 16.
2. Plan: `basic-256mb` is enough to start. Move to a plan with **point-in-time recovery** before going live with real hotels.
3. Copy the **Internal Database URL**. The API uses it, and it never leaves Render's private network.
4. Leave **Access Control** empty so only Render services can connect.

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

2. **Health check path:** `/ready`. It returns 200 only when the database answers, so Render won't route traffic to an instance that can't reach the DB. `/health` is a liveness ping.
3. **Disk:** 5 GB mounted at `/repo/apps/api/storage`. It holds uploaded images (if Cloudinary isn't set), platform backups and the email outbox.
4. **Instances: exactly 1.** Scheduled jobs (auto-assign deliveries, alerts, report emails, backups, stock checks) run inside the API process. A second instance would run them twice. Scale the instance size, not the count, until the jobs move to a separate worker. This is a tracked item in the QA programme.
5. **Do not run the demo seed in production.** `npm run seed` refuses when `NODE_ENV=production` (it would create demo logins with a published password).
6. **First Super Admin:** open the Render shell for canavo-api and run
   `ADMIN_NAME='…' ADMIN_EMAIL='…' ADMIN_PHONE='98xxxxxxxx' ADMIN_PASSWORD='…' npm run create-admin -w @canavo/api`.
   The password must be at least 12 characters with upper case, lower case and a digit. Then log in and onboard hotels from the platform console.

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
| Platform backup | The Super Admin creates backups in the app (Admin → Backups). They're stored on the API disk, and restoring works from the same screen. |
| Uploaded images | Cloudinary keeps them; without Cloudinary they're on the Render disk (snapshot the disk). |
| `DATA_ENCRYPTION_KEY` and JWT secrets | Keep copies in a password manager. They can't be recovered from the database. |

## 7. Rollback

- **Web:** Vercel → Deployments → pick the previous deployment → **Promote to Production** (instant).
- **API:** Render → canavo-api → Deploys → **Rollback** to the previous deploy.
- **Database:** migrations are forward-only. If a release added a migration, roll the API back only if the old code still works with the new columns (additive migrations do). Otherwise restore the database to just before the deploy and roll back both.

## 8. Costs to expect (starting point)

Render Starter web service + basic Postgres + 5 GB disk, plus Vercel Hobby/Pro. Prices change: check the providers' pages before you commit.
