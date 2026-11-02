# Post-deployment SANITY checklist

Run after **every** deployment (staging and production), once the deploy job reports success. Target time: **≤ 20 minutes**. Stop at the first ❌ in sections A–B and roll back (see the runbook in Phase 16). Failures in C–E get a bug and a go/rollback decision from the release owner.

| | |
|---|---|
| Release / commit SHA | |
| Environment | staging / production |
| Executed by / date-time (IST) | |
| Result | ✅ GO · ❌ ROLLBACK |

## A. Platform is up (automated where possible)

| ID | Check | How | Expected | ✅/❌ |
|---|---|---|---|---|
| SAN-001 | API health | `curl -s https://<api>/health` | `{"ok":true,"service":"canavo-api"}` within 1 s | |
| SAN-002 | API version is the one deployed | Deploy log / image tag | Matches release SHA | |
| SAN-003 | Migrations applied | Deploy log shows `prisma migrate deploy` → "No pending migrations" or the new ones applied, no errors | | |
| SAN-004 | Web app loads | Open `https://<web>/login` | Login page renders, no console errors (DevTools) | |
| SAN-005 | HTTPS + security headers | `curl -sI https://<api>/health` | `strict-transport-security`, `x-content-type-options: nosniff`, `content-security-policy` present | |
| SAN-006 | CORS locked | `curl -sI -H 'Origin: https://evil.example' https://<api>/health` | No `access-control-allow-origin: https://evil.example` | |
| SAN-007 | Swagger / dev routes | `GET /orders/x/payments/y/dev-simulate` (prod) | 404 in production | |
| SAN-008 | Non-staging only: automated smoke | `SMOKE_BASE_URL=<staging> npm run test:smoke` | 24/24 pass (staging only, never prod with demo users) | |

## B. Configuration safety (production)

| ID | Check | Expected | ✅/❌ |
|---|---|---|---|
| SAN-010 | Demo accounts absent | Login with `owner@canavo.local` / `Canavo@123` → **401** | |
| SAN-011 | Encryption key set | API boot log has **no** "derived key" warning for `DATA_ENCRYPTION_KEY` | |
| SAN-012 | `NODE_ENV=production` | Error bodies contain no stack traces (request `GET /orders/does-not-exist` with a valid token → JSON error, no stack) | |
| SAN-013 | OTP dev code hidden | `POST /auth/otp/request` for a real staff phone → response has **no** `devCode` | |
| SAN-014 | Single API instance (jobs) | Platform dashboard shows exactly 1 instance (until jobs move to a worker) | |
| SAN-015 | Backups | Latest automatic backup is < 24 h old (Admin → Backups as Super Admin) | |

## C. Core business flow — use a real staff test account on a **test outlet** (or the staging tenant)

| ID | Role | Check | Expected | ✅/❌ |
|---|---|---|---|---|
| SAN-020 | Cashier | Log in on web POS | POS opens on the right outlet; menu photos load | |
| SAN-021 | Cashier | Bill 1 item takeaway, pay **Cash** | Receipt shows correct GST split and round-off; invoice number continues the sequence (no gap/reset unless 1 Apr) | |
| SAN-022 | Kitchen | Open Kitchen display | The KOT from SAN-021 appears within 3 s; indicator shows **Live** | |
| SAN-023 | Kitchen | Mark KOT Ready | Cashier/manager sees the update | |
| SAN-024 | Cashier | Cancel the test bill (reason "sanity") | Bill CANCELLED; stock restored (Inventory → item movement) | |
| SAN-025 | Manager | Reports → Daily summary for today | Loads < 3 s; test bill shown as cancelled | |
| SAN-026 | Any | Log out | Returned to login; Back button doesn't reopen POS | |

## D. Role and privacy walls (quick probes)

| ID | Check | Expected | ✅/❌ |
|---|---|---|---|
| SAN-030 | Super Admin opens the platform console | Sees businesses; **no** POS, bills, reports menu | |
| SAN-031 | Kitchen user | Has no Bills or Settings menu | |
| SAN-032 | Delivery partner (mobile or `/delivery`) | Sees only own deliveries | |

## E. Mobile (if a mobile release is part of the deploy)

| ID | Check | Expected | ✅/❌ |
|---|---|---|---|
| SAN-040 | App opens and logs in against production API | Home loads | |
| SAN-041 | Offline queue: airplane mode → bill → online | Bill syncs once, single invoice number | |
| SAN-042 | Push test notification (Admin → Notifications) | Arrives on device | |

Sign-off: ______________________ (release owner) · ______________________ (QA)
