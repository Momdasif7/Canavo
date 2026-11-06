-- QA Phase 7 (dbc-3): canavo_outlets() named "Outlet" and canavo_business() without a schema, so it
-- depended on the caller's search_path: pg_dump (which empties search_path) could not dump the
-- outlet-scoped tables. Schema-qualify the references. Kept a plain SQL function (no SET clause) so
-- the planner can still inline it inside the row-level security policies.
CREATE OR REPLACE FUNCTION canavo_outlets() RETURNS text[] LANGUAGE sql STABLE AS
  $$ SELECT coalesce(array_agg("id"), '{}') FROM public."Outlet" WHERE "businessId" = public.canavo_business() $$;
