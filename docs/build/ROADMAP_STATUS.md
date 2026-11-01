# Build programme status (`feat/market-leader`)

Updated 2026-11-01. Each phase ends with `docs/build/phase-N.md`, a commit and a full test run, then waits for the owner's "continue".

| Phase | Items (exists / partial / missing at Phase 0) | Status | Report |
|---|---|---|---|
| 0 Recon and gap confirmation | — | ✅ Done | [phase-0.md](phase-0.md) |
| 1 Foundation and data safety | 8 (0 / 3 / 5) + indexes + delivery route guards | ✅ Done | [phase-1.md](phase-1.md) |
| 2 Security and accounts | 8 (0 / 6 / 2) | ✅ Done | [phase-2.md](phase-2.md) |
| 3 Money integrity | 8 (2 / 2 / 4) | ✅ Done | [phase-3.md](phase-3.md) |
| 4 Roles and owner experience | 4 (1 / 1 / 2) | ✅ Done (pilot set complete) | [phase-4.md](phase-4.md) |
| 5 Canteen and institutional | 5 (0 / 2 / 3) | ✅ Done; **awaiting your review** | [phase-5.md](phase-5.md) |
| 6 Sales channels | 4 (0 / 0 / 4) | Not started; needs vendor decision D3 | — |
| 7 Kitchen, tables, delivery | 4 (0 / 4 / 0) | Not started | — |
| 8 Back office | 5 (0 / 4 / 1) | Not started | — |
| 9 Reports and performance | 3 (0 / 2 / 1) | Not started | — |
| 10 Customer engagement | 3 (0 / 2 / 1) | Not started | — |
| 11 SaaS business layer | 6 (0 / 2 / 4) | Not started | — |
| 12 POS, hardware, engineering quality | 6 (0 / 5 / 1) | Not started | — |

**Pilot set (D15):** Phases 1–4. After the build phases, the QA programme (`qa/full-testing`, Phases 2–16) resumes.

## Phase 1 items

| # | Item | Result |
|---|---|---|
| 1.1 | Postgres RLS | ✅ 48 tables, FORCE, fail closed; [ADR 0001](adr/0001-row-level-security.md) |
| 1.2 | Job queue and worker | ✅ pg-boss, separate worker, `JOBS_MODE`; [ADR 0002](adr/0002-pg-boss-job-queue.md) |
| 1.3 | Transactional outbox | ✅ [ADR 0003](adr/0003-transactional-outbox.md) |
| 1.4 | Idempotency keys | ✅ every authenticated mutation; web and mobile send keys |
| 1.5 | Socket.io Redis adapter | ✅ behind `REDIS_URL` |
| 1.6 | Atomic tab split | ✅ |
| 1.7 | Backups off-site, PITR, drill | ✅ S3 / directory adapters, drill script; PITR is the provider's (could not verify) |
| 1.8 | Observability | ✅ JSON logs, request ids, error hook, `/metrics`, production fail-fast |
| + | 12 hot-path indexes | ✅ |
| + | Delivery guards at route level | ✅ |
| + | Feature flags (D11/D14) | ✅ [FEATURE_FLAGS.md](FEATURE_FLAGS.md) |

## Phase 2 items

| # | Item | Result |
|---|---|---|
| 2.1 | 2FA TOTP + recovery codes | ✅ opt-in; `REQUIRE_2FA` flag for owners/managers |
| 2.2 | Reset links | ✅ the platform never sets or sees a password |
| 2.3 | Sessions, lockout, policy | ✅ device list and sign-out, policy for new passwords |
| 2.4 | Consented support access | ✅ [ADR 0005](adr/0005-consented-support-access.md) |
| 2.5 | Aadhaar minimisation | ✅ last 4 + consent by default (D2) |
| 2.6 | Clock-in anti-spoofing | ✅ PIN lockout; `STRICT_CLOCK_IN`, `CLOCK_IN_SELFIE` flags (D7) |
| 2.7 | Tokens / deep links | ✅ cookie sessions with fallback, [ADR 0006](adr/0006-web-session-cookies.md) |
| 2.8 | Production seed guard | ✅ |

## Phase 3 items

| # | Item | Result |
|---|---|---|
| 3.1 | Refunds / credit notes | ✅ own CN series, items or value, tax reversal, restock, khata / gift card refunds |
| 3.2 | Cash shifts / Z-report | ✅ float, pay-ins/outs, expected vs counted; `REQUIRE_CASH_SHIFT` flag |
| 3.3 | Approval PINs, exceptions report | ✅ `APPROVAL_PINS` flag; Reports → Exceptions |
| 3.4 | Offline invoice numbering | ✅ existed; per-device series behind `OFFLINE_INVOICE_SERIES` (mobile) |
| 3.5 | Round-off | ✅ existed (verified) |
| 3.6 | 0% GST safeguard, coupon GST (D1) | ✅ menu warnings; GST-inclusive ₹ discounts setting |
| 3.7 | Why this offer won, combining | ✅ comparison on the POS; per-offer "can combine" |
| 3.8 | Card ref, settlement, tips, gift cards | ✅ `GIFT_CARDS` flag; Reports → Settlements |

## Phase 4 items

| # | Item | Result |
|---|---|---|
| 4.1 | Waiter / Captain role | ✅ tables and KOTs only, no payments |
| 4.2 | Custom roles, Accountant / Auditor, platform Support | ✅ custom roles only narrow a base role; Auditor read-only server-side; `platform:view` vs `platform:manage` |
| 4.3 | Owner dashboard + anomaly push | ✅ owner summary (mobile + web tiles); `ANOMALY_ALERTS` flag |
| 4.4 | Role-specific home screens | ✅ existed; new roles land correctly |

## Open decisions carried forward

- D3, D5: needed before their phases (see [phase-0.md §7](phase-0.md#7-decisions-needed-batched)). D2, D7, D13, D16 were answered on 2026-11-01. D1 and D6 were applied as recommended in Phase 3: please confirm.
- Please confirm the decisions in [phase-4.md](phase-4.md#decisions-please-confirm) and [phase-5.md](phase-5.md#decisions-please-confirm).
