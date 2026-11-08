# Install / upgrade / rollback runbook (manual verification)

This page does **not** repeat the procedures. It tells the tester which existing runbook step to run and what to
check. Sources:
- [docs/deployment/DEPLOYMENT.md](../../deployment/DEPLOYMENT.md) — database, API, worker, web, mobile, after-deploy
  checks (§5), backups (§6), rollback (§7), per-store integrations (§2a)
- [docs/qa/phase-7/migration-runbook.md](../phase-7/migration-runbook.md) — before deploy (§1), deploy (§2), verify (§3),
  recover / forward fix (§4), scripts (§5)
- [docs/qa/phase-7-database.md](../phase-7-database.md) — migration and restore drill results

Record for each run: date, tester, from-SHA → to-SHA, environment, timings, result, evidence (screenshots / logs).

| # | Scenario | Do (link) | Verify manually | Result |
|---|---|---|---|---|
| R1 | **Fresh deploy** (empty DB) | DEPLOYMENT §1–3 in order; migrations per migration-runbook §2 | `/health` and `/ready` OK; web login page loads over HTTPS; Super Admin signs in; onboard a business; owner bills one order; receipt link opens; no demo users in production (`SEC-07`) | |
| R2 | **Upgrade with live data** | migration-runbook §1 (backup + pre-checks) → §2 → §3 | Before: note counts (businesses, bills, today's total, khata balances, stock of Milk). After: same counts and totals; open bills still payable; offline mobile bills made during the deploy sync once; WhatsApp setup moved into Integrations (`20261107120000_business_integrations`); delivery settings default to Map pin (`20261107130000_delivery_address_mode`); customer consents default off (`20261109120000_customer_consent_erasure`) | |
| R3 | **Upgrade during service** | Deploy while a cashier bills every 30 s | At most a short "reconnecting" banner; no lost or duplicate bill; KDS resyncs | |
| R4 | **Rollback (app only)** | DEPLOYMENT §7 — redeploy the previous web + API build | App works on the newer schema (migrations are additive); bills made after the upgrade still visible | |
| R5 | **Rollback (bad migration)** | migration-runbook §4 — forward fix, or restore | Data from before the deploy intact; documented data-loss window respected | |
| R6 | **Restore from backup** | DEPLOYMENT §6; Super Admin → Admin → Backups → Restore (staging copy) | Bills, customers, stock match the backup time; users can sign in; integration secrets still decrypt (same `DATA_ENCRYPTION_KEY`) | |
| R7 | **DNS / SSL** | Point the staging domain; certificate via Vercel / Render | Valid certificate (no browser warning) on web, API and public receipt / online-ordering links; HTTP → HTTPS redirect; HSTS header; webhooks reach the API | |
| R8 | **Env misconfiguration** | Start the API with each mistake (one at a time): missing `DATA_ENCRYPTION_KEY`; weak `JWT_SECRET`; wrong `DATABASE_URL`; `PUBLIC_API_URL` wrong; CORS origin missing the web URL; SMTP unset | Production boot **refuses** to start for missing/weak secrets (clear log line); DB error is clear; wrong public URL → receipt/webhook links broken (detectable in after-deploy check); CORS → web shows "can't reach server", not a blank page; SMTP unset → file outbox, no crash | |
| R9 | **Worker down** | Stop the worker | Billing unaffected; scheduled reports / wishes queue and run when it returns | |
| R10 | **Mobile upgrade** | DEPLOYMENT §4; install the old build, then the new one | Login kept or cleanly asked again; offline queue survives the upgrade | |
| R11 | **Per-store integrations after upgrade** | DEPLOYMENT §2a | Owner adds Razorpay keys; webhook URL works; `RAZORPAY_SHARED_ACCOUNT` behaviour as documented | |

Sign-off: Ops ________ QA ________ Date ______
