# Smoke suite (automated, < 15 min)

**File:** [`apps/api/test/smoke/smoke.test.ts`](../../apps/api/test/smoke/smoke.test.ts) · **Config:** `apps/api/vitest.smoke.config.ts` · **Tag:** `@smoke`

It is a black-box HTTP suite against a **running** API, so the same suite runs on local, staging-Docker and CI. It needs no repo internals and no database access. Typical run time is about 1 s for 24 checks; the suite fails itself if it takes longer than 15 minutes.

## Run

```bash
# API must be running (npm run dev, or the Docker image)
npm run test:smoke                                        # default http://localhost:4000
SMOKE_BASE_URL=http://localhost:4100 npm run test:smoke   # QA instance
SMOKE_READONLY=1 SMOKE_BASE_URL=https://staging.example npm run test:smoke   # no writes
```

| Variable | Default | Meaning |
|---|---|---|
| `SMOKE_BASE_URL` | `http://localhost:4000` | API base URL (with `/api` when behind the gateway) |
| `SMOKE_PASSWORD` | `Canavo@123` | Password for the 7 role accounts (dev/staging seed only) |
| `SMOKE_DOMAIN` | `canavo.local` | Email domain of the role accounts (`<role>@<domain>`) |
| `SMOKE_READONLY` | unset | `1` skips the 6 write steps (create bill, resend, KOT, KOT update, payment, receipt) |

> ⚠️ **Never run against production with the demo accounts.** Production must not contain them (RTM `SEC-010`). Use the manual [SANITY_CHECKLIST.md](SANITY_CHECKLIST.md) on production.

## Cases

| ID | Check | Role | Covers (RTM) |
|---|---|---|---|
| SMK-001 | `/health` returns `{ok:true}` | — | OPS-006 |
| SMK-002 | Unauthenticated `/orders` → 401 | — | AUTH |
| SMK-003 | Wrong password → 401, generic message | — | AUTH-002 |
| SMK-01x ×7 | Login per role; `/auth/me` role correct, no hashes, outlets (none for Super Admin) | all 7 | AUTH-001, AUTH-017 |
| SMK-020 | Super Admin: platform summary 200, hotel bills 403 | Super Admin | PLAT-005 |
| SMK-021 | Menu loads | Cashier | MENU |
| SMK-030 | Create takeaway bill; integer paise; rounded to rupee; invoice ≤ 16 chars | Cashier | BIL-001/003/009 |
| SMK-031 | Same `clientOrderId` → 200, same bill (idempotent) | Cashier | BIL-010 |
| SMK-040 | Bill's KOT appears on KDS as RECEIVED | Kitchen | KOT-001 |
| SMK-041 | KOT → PREPARING → READY | Kitchen | KOT-002 |
| SMK-050 | Full cash payment with change; bill PAID | Cashier | BIL-006/007 |
| SMK-051 | Receipt renders | Cashier | BIL-012 |
| SMK-060 | Sales report + daily summary load | Manager | REP-001 |
| SMK-061 | Bill history shows the new bill | Owner | RBAC-005 |
| SMK-070 | Inventory: stock 200, sales report 403 | Inventory | RBAC-007 |
| SMK-071 | Kitchen cannot create bills (403) | Kitchen | RBAC-008 |
| SMK-072 | Delivery: `/delivery/mine` 200, `/delivery` 403 | Delivery | DEL-010/011 |
| SMK-080 | Logout → refresh token rejected (401) | Cashier | AUTH-010 |

The **web UI** smoke (login screen → POS → bill → KDS) is added as a Playwright `@smoke` project in Phase 11. Until then, the UI part of smoke is items SAN-020 to SAN-026 in the sanity checklist.
