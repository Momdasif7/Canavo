# Phase 4: Roles and owner experience (pilot set complete)

| | |
|---|---|
| Branch | `feat/market-leader`. Built in parallel by three agents on branches `agent/roles`, `agent/owner` and `agent/left`, then reviewed and merged. |
| Date | 2026-11-01 |
| Tests | Unit **185** (shared 41, API 144) · Integration **128** on real Postgres as a non-superuser · Smoke **17** · Browser check · typecheck (API, web, mobile) and lint clean |

## Summary

With Phase 4 done, the **pilot set (Phases 1–4) is complete**.

**New roles:**
- **Waiter / Captain:** takes orders at tables and sends KOTs; can't take payments, see bills or see reports.
- **Accountant:** reports, GSTR-1, bills, stock and settlements; no billing, refunds or staff management.
- **Auditor:** read-only. The server refuses every change from an auditor.
- **Custom roles:** owners can create roles that only remove permissions from a built-in role. For example, "Manager without refunds".
- **Platform Support:** CANAVO staff who can view businesses and open owner-granted support views, but can't change the platform.

**Owners:**
- One summary across all outlets, on mobile and the web dashboard: today vs the same weekday last week, voids, refunds, cash difference, unapproved offline bills, top items and low stock.
- Optional push alerts when something looks wrong (`ANOMALY_ALERTS`, off by default).

**Phase 3 leftovers, finished:**
- The web POS also prints final invoice numbers offline. Web and mobile share one numbering function.
- Credit notes appear in the GSTR-1 document summary (nature 5).

**Behaviour changes for existing hotels:** none to existing roles. A table bill now explicitly needs `payment:collect`, which cashiers, managers and owners already have; only the new Waiter role is affected.

## What was built

| # | Item | What changed | Proven by |
|---|---|---|---|
| 4.1 | Waiter / Captain | Role `WAITER`: table:serve, order:create, menu:view, kot:view, attendance:self, customer:view. The table is assigned to the waiter who opened it. Billing and payment need payment:collect; the POS menu entry is hidden without it. Managers and owners create waiters. Lands on Tables. | `roles.test.ts` |
| 4.2 | Accountant, Auditor, custom roles, Platform Support | Built-in `ACCOUNTANT` and `AUDITOR`. Auditor writes are refused in authenticate (except /auth). `CustomRole` per business (RLS); `User.customRoleId`. Effective permissions = custom ∩ base role ∩ modules, enforced by one `userCan()` used by every guard. Owner CRUD at /staff/roles, a role picker on staff, and a Roles section on the Staff page. A role still in use can't be deleted. `PLATFORM_SUPPORT` role with `platform:view` (reads, support views with grant + own 2FA). `platform:manage` stays Super Admin only. The console hides write actions; the Super Admin IP whitelist applies. | `roles.test.ts` (16) |
| 4.3 | Owner dashboard + anomaly push | GET /reports/owner-summary (all the user's outlets, per-outlet rows and totals, today vs same weekday last week up to now). /reports/daily adds voids and cash difference. Mobile owner home with tiles and per-outlet cards (pull to refresh); web dashboard tiles. Anomaly job every 15 min behind `ANOMALY_ALERTS`: pure rules with named thresholds; pushes to owners only, at most once per outlet per day (dedupe in the existing Setting store; no migration). | `anomaly-rules.test.ts`, `owner-summary.test.ts` |
| 4.4 | Role home screens | Existed. Accountant/Auditor land on the dashboard and waiters on Tables (when the Tables module is on). | browser check |
| 3.4+ | Web offline invoice series | `nextSeriesNumber` / `mergeSeriesState` in shared (used by web and mobile). Stable per-browser device id. Number shown in "Saved offline" and "Waiting to sync". | `invoice.test.ts` |
| 3.1+ | GSTR-1 credit notes | Document summary nature 5 with series ranges (shared `docRanges` helper). | `gstr1.test.ts`, `money-integrity.test.ts` |

## Migrations

| Migration | Change | Rollback |
|---|---|---|
| `20261101170508_roles_custom_roles` | `Role` += WAITER, ACCOUNTANT, AUDITOR, PLATFORM_SUPPORT; `User.customRoleId`; table `CustomRole` (+ forced RLS) | Move users off the new roles first. Then `ALTER TABLE "User" DROP COLUMN "customRoleId"; DROP TABLE "CustomRole";`. Enum values can't be dropped; unused they are harmless. |

## Decisions (please confirm)

1. **Waiters can't print the table bill.** Raising the bill needs payment:collect, so it's done by the cashier or captain-with-cashier rights.
2. **Only the owner creates Accountant and Auditor accounts.** Managers can't.
3. **A custom role can only remove permissions** from its base role. It can never add one.
4. **Platform Support** sees business account info and, with the owner's grant, a read-only support view. Nothing else.
5. **Anomaly alerts:** an alert counts as sent before the push goes out, so a failed push isn't retried that day (no repeats every 15 minutes). The "cash difference" total on the owner summary uses each outlet's last closed shift, which may be from an earlier day.

## Known gaps

- When a page is unavailable, the web message decides "role" vs "module" from the base role. A custom-role user may see "module not enabled" when their role removed the permission. It's cosmetic; access is enforced correctly.
- Mobile shows the new roles by permission. There's no waiter-specific mobile screen beyond the existing table tabs.

## Could not verify

Push delivery of anomaly alerts to real phones (Expo token needed), plus everything carried over from earlier phases (see phase-3.md).

## Next

The pilot set is done. Recommended next: a **QA pass**. Resume the paused QA prompt (Phase 2 UI smoke, then Phases 3–16) on everything built in Phases 1–4, then go to Phase 5 (canteen and institutional). Or continue straight to Phase 5 if you prefer.
