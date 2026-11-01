# ADR 0001: PostgreSQL row-level security under the Prisma tenant filter

| | |
|---|---|
| Status | Accepted (Phase 1.1, 2026-11-01) |
| Decision refs | D10 (with a deviation, below) |

## Context

Before Phase 1, tenant isolation was application code only. A Prisma extension added `businessId` to 11 models. The other 40 models (orders, payments, KOTs, stock…) depended on every route filtering by `outletId`. One forgotten filter would leak another hotel's data.

## Decision

Keep the Prisma filter as layer 1, and add **PostgreSQL RLS as layer 2** on 48 tables, all with `FORCE ROW LEVEL SECURITY`.

**Settings.** Each statement runs with three transaction-local settings, `set_config(…, true)`, which are safe with connection pooling:

| Setting | Meaning |
|---|---|
| `app.business_id` | The current hotel. |
| `app.platform` | `on` for platform-admin requests. They see only rows with `businessId IS NULL` (platform users and platform audit), so they fail closed. |
| `app.bypass_rls` | `on` only for infrastructure: the platform client, jobs outside a hotel, scripts, login and public routes. |

With no setting at all, a query returns **no rows**.

**Policies.** Each table gets one of three kinds:
- `"businessId" = canavo_business()`;
- `"outletId" = ANY ((SELECT canavo_outlets())::text[])`;
- for child tables, `EXISTS` on the parent. `StockTransfer` matches on either its from-outlet or its to-outlet.

**Clients** (in `apps/api/src/db.ts`):
- `prisma`: the tenant client. It derives its settings from the request's TenantContext.
- `platformPrisma`: always bypasses RLS. It's used for cross-hotel work only: platform console, backups, realtime auth.
- `rawPrisma`: no settings. For tests only.

**Mechanics:**
- A single query runs as a batch `[set_config, query]`.
- An interactive transaction runs `set_config` first, through a Proxy.
- Raw queries are wrapped the same way.
- The array form `$transaction([...])` throws. The two places that used it were converted to the callback form.

## Deviation from D10

D10 recommended adding `businessId` to the 40 outlet-level tables. I chose **outlet-membership policies** instead (`outletId ∈ outlets of the current hotel`):
- They need **no backfill and no schema change** on the largest tables.
- They're equally strict.
- `canavo_outlets()` runs once per statement.

Measured on the dev data: menu p95 was 10 ms and `POST /orders` p95 was 35 ms. Adding `businessId` columns stays an option for Phase 9 (reporting performance) if profiling calls for it.

The brief's "permissive + logging first" step was skipped. Policies are enforced from the start, because the integration suite already runs as a non-superuser role over every route family. **This needs your OK.**

## Consequences

- **Production must connect as a non-superuser role without `BYPASSRLS`.** Superusers ignore RLS. The local Docker user `canavo` is a superuser, so locally only the integration suite (role `canavo_app_it`) proves enforcement.
  - Render's and Neon's default roles are fine.
  - Check with: `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;` Both must be `f`.
- **Data migrations written as SQL** that touch tenant tables must start with `SELECT set_config('app.bypass_rls','on',true);`. Without it they see no rows. DDL is unaffected.
- **A new tenant table** needs a policy in a migration. The RLS integration test lists the protected tables, so a missing policy fails CI.
- **Rollback:** for each table, run `ALTER TABLE "<T>" NO FORCE ROW LEVEL SECURITY; ALTER TABLE "<T>" DISABLE ROW LEVEL SECURITY;`, or `DROP POLICY tenant_isolation ON "<T>"`. The app keeps working on layer 1 alone.
