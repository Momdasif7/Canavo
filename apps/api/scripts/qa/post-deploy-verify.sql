-- Post-deploy database checks (QA Phase 7; see docs/qa/phase-7/migration-runbook.md).
--   psql "$DATABASE_URL" -f apps/api/scripts/qa/post-deploy-verify.sql
-- Every query returns rows ONLY when something needs attention, except the summary at the end.
\pset footer off
\echo '1. Failed or rolled-back migrations (must be empty)'
SELECT migration_name, started_at, finished_at, rolled_back_at, left(logs, 200) AS logs
FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL;

\echo '2. INVALID indexes left by a failed CREATE INDEX CONCURRENTLY (must be empty; IF NOT EXISTS will NOT rebuild them)'
SELECT i.indexrelid::regclass AS index, i.indrelid::regclass AS "table"
FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
WHERE c.relnamespace = 'public'::regnamespace AND (NOT i.indisvalid OR NOT i.indisready);

\echo '3. Business tables without FORCE row-level security (expected: Business, IdempotencyKey, OtpCode, OutboxEvent, Setting, _prisma_migrations)'
SELECT relname FROM pg_class
WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND NOT relforcerowsecurity
  AND relname NOT IN ('Business', 'IdempotencyKey', 'OtpCode', 'OutboxEvent', 'Setting', '_prisma_migrations');

\echo '4. RLS helper functions reading tables by unqualified name with no pinned search_path (break pg_dump; see dbc-3)'
SELECT p.proname FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'canavo\_%'
  AND p.prosrc ~* 'from\s+"' AND NOT coalesce(p.proconfig::text LIKE '%search_path%', false);

\echo '5. The connected role must not bypass RLS (both f), and what it may do'
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
SELECT count(*) FILTER (WHERE NOT (has_table_privilege(c.oid, 'SELECT') AND has_table_privilege(c.oid, 'INSERT')
                                     AND has_table_privilege(c.oid, 'UPDATE') AND has_table_privilege(c.oid, 'DELETE'))) AS tables_missing_dml,
       count(*) FILTER (WHERE NOT has_table_privilege(c.oid, 'TRUNCATE')) AS tables_missing_truncate_for_restore
FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname <> '_prisma_migrations';

\echo '6. Summary'
SELECT (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS migrations_applied,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS rls_policies,
       (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relforcerowsecurity) AS force_rls_tables,
       (SELECT count(*) FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typtype = 'e') AS enums;
