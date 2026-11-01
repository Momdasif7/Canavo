# Build programme status (`feat/market-leader`)

Updated 2026-11-01. Each phase ends with `docs/build/phase-N.md`, a commit and a full test run, then waits for the owner's "continue".

| Phase | Items (exists / partial / missing at Phase 0) | Status | Report |
|---|---|---|---|
| 0 Recon and gap confirmation | — | ✅ Done | [phase-0.md](phase-0.md) |
| 1 Foundation and data safety | 8 (0 / 3 / 5) + indexes + delivery route guards | ✅ Done | [phase-1.md](phase-1.md) |
| 2 Security and accounts | 8 (0 / 6 / 2) | ✅ Done; **awaiting your review** | [phase-2.md](phase-2.md) |
| 3 Money integrity | 8 (2 / 2 / 4) | Not started (pilot set) | — |
| 4 Roles and owner experience | 4 (1 / 1 / 2) | Not started (pilot set) | — |
| 5 Canteen and institutional | 5 (0 / 2 / 3) | Not started | — |
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

## Open decisions carried forward

- D1 (needed for Phase 3), D3, D5, D6: needed before their phases (see [phase-0.md §7](phase-0.md#7-decisions-needed-batched)). D2, D7, D13 and D16 were answered on 2026-11-01.
- Please confirm the deviations in [phase-2.md §Decisions](phase-2.md#decisions-and-deviations-please-confirm).
