#!/usr/bin/env bash
# QA Phase 7 — seed + upgrade-with-data + pg_dump/pg_restore checks (scratch databases only).
#   apps/api/scripts/qa/seed-upgrade-check.sh
# A. production guard: NODE_ENV=production seed refuses and creates no logins
# B. seed idempotency: seed twice on a fresh DB → identical row counts per table
# C. realism: 30-day order history, GST rates used, every role
# D. old state with data: the seed of release 2c38f75 (12 migrations) is run on a DB at that
#    migration, then the remaining migrations are deployed: row counts per table before/after
# E. pg_dump/pg_restore round trip (superuser, and as a non-superuser table owner like Render/Neon)
set -euo pipefail
export PRISMA_HIDE_UPDATE_MESSAGE=1
CONTAINER=${CONTAINER:-canavo-postgres-1}
HOSTURL=${HOSTURL:-postgresql://canavo:canavo@localhost:5433}
P=${PREFIX:-canavo_dbc}
OLD_COMMIT=${OLD_COMMIT:-2c38f75}
API_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
REPO="$(cd "$API_DIR/../.." && pwd)"
WORK=${WORK:-$(mktemp -d)}
mkdir -p "$WORK"
cd "$API_DIR"

sql() { docker exec -i "$CONTAINER" psql -U canavo -d "${2:-postgres}" -v ON_ERROR_STOP=1 -qAt -c "$1"; }
recreate() { sql "DROP DATABASE IF EXISTS \"$1\" WITH (FORCE)"; sql "CREATE DATABASE \"$1\"${2:+ OWNER \"$2\"}"; }
url() { echo "$HOSTURL/$1?schema=public"; }
# Exact row count of every table (superuser: RLS doesn't apply).
counts() {
  sql "SELECT table_name || '=' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text
       FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name <> '_prisma_migrations' ORDER BY 1" "$1"
}
recon() {
  sql "SELECT 'orders=' || count(*) || ' paid=' || coalesce(sum(\"grandTotal\") FILTER (WHERE status='PAID'),0) ||
         ' payments=' || (SELECT coalesce(sum(amount),0) FROM \"Payment\" WHERE status='SUCCESS') ||
         ' khata=' || (SELECT coalesce(sum(\"khataBalance\"),0) FROM \"Customer\") ||
         ' stock=' || (SELECT coalesce(round(sum(quantity)::numeric,3),0) FROM \"InventoryStock\") FROM \"Order\"" "$1"
}
seed() { DATABASE_URL="$(url "$1")" NODE_ENV=${2:-development} npm run -s seed > "$WORK/seed-$1-$3.log" 2>&1; }
deploy_all() { DATABASE_URL="$(url "$1")" npx prisma migrate deploy > "$WORK/deploy-$1.log" 2>&1; }

# ---------------- A + B + C
S=${P}_seed
recreate "$S"; deploy_all "$S"
echo "== A. production guard"
if seed "$S" production guard; then echo "FAIL: seed ran with NODE_ENV=production"; else echo "refused (exit≠0): $(grep -o 'Refusing[^.]*' "$WORK/seed-$S-guard.log")"; fi
echo "users after refused seed: $(sql 'SELECT count(*) FROM "User"' "$S"), outlets: $(sql 'SELECT count(*) FROM "Outlet"' "$S")"

echo "== B. idempotency"
t0=$(date +%s); seed "$S" development 1; echo "seed #1 ok in $(( $(date +%s) - t0 ))s"
counts "$S" > "$WORK/seed1.txt"; recon "$S" > "$WORK/seed1-recon.txt"
seed "$S" development 2; echo "seed #2 ok"
counts "$S" > "$WORK/seed2.txt"; recon "$S" > "$WORK/seed2-recon.txt"
if diff "$WORK/seed1.txt" "$WORK/seed2.txt" && diff "$WORK/seed1-recon.txt" "$WORK/seed2-recon.txt"; then echo "seed twice: identical counts ($(awk -F= '{s+=$2} END{print s}' "$WORK/seed1.txt") rows, $(awk -F= '$2>0' "$WORK/seed1.txt" | wc -l | tr -d ' ') non-empty tables)"; else echo "FAIL: second seed changed counts"; fi
cat "$WORK/seed1-recon.txt"

echo "== C. realism"
sql "SELECT 'order days=' || count(DISTINCT date(\"createdAt\" AT TIME ZONE 'Asia/Kolkata')) || ' span=' || (max(\"createdAt\")::date - min(\"createdAt\")::date) || 'd, statuses=' || string_agg(DISTINCT status::text, ',') || ', types=' || string_agg(DISTINCT \"orderType\"::text, ',') FROM \"Order\"" "$S"
sql "SELECT 'gst rates on bill lines=' || string_agg(DISTINCT \"gstRate\"::text, ',') FROM \"OrderItem\"" "$S"
sql "SELECT 'menu tax rates=' || string_agg(DISTINCT t.name, ' | ') FROM \"MenuItem\" m JOIN \"TaxRate\" t ON t.id = m.\"taxRateId\"" "$S"
sql "SELECT 'payment modes=' || string_agg(DISTINCT mode::text, ',') FROM \"Payment\"" "$S"
sql "SELECT 'roles=' || string_agg(DISTINCT role::text, ',') FROM \"User\"" "$S"
sql "SELECT 'enum Role=' || string_agg(enumlabel, ',' ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid = '\"Role\"'::regtype" "$S"

# ---------------- D. old state with data → upgrade
echo "== D. seed at $OLD_COMMIT, then upgrade"
OLDDIR="$API_DIR/qa-old-seed"; rm -rf "$OLDDIR"; mkdir -p "$OLDDIR/migrations"
trap 'rm -rf "$OLDDIR"' EXIT
for f in schema.prisma seed.ts seed-crm.ts seed-inventory.ts seed-platform.ts seed-service.ts; do git -C "$REPO" show "$OLD_COMMIT:apps/api/prisma/$f" > "$OLDDIR/$f"; done
for m in $(git -C "$REPO" ls-tree --name-only "$OLD_COMMIT" apps/api/prisma/migrations/ | xargs -n1 basename); do
  if [[ $m == migration_lock.toml ]]; then cp prisma/migrations/$m "$OLDDIR/migrations/"; else cp -R "$API_DIR/prisma/migrations/$m" "$OLDDIR/migrations/"; fi
done
# Old client generated into the scratch folder only (never node_modules/.prisma).
perl -pi -e 's|provider = "prisma-client-js"|provider = "prisma-client-js"\n  output   = "./client"|' "$OLDDIR/schema.prisma"
perl -pi -e 's|"\@prisma/client"|"./client"|' "$OLDDIR"/seed*.ts
npx prisma generate --schema "$OLDDIR/schema.prisma" > "$WORK/old-generate.log" 2>&1
O=${P}_old
recreate "$O"
DATABASE_URL="$(url "$O")" npx prisma migrate deploy --schema "$OLDDIR/schema.prisma" > "$WORK/old-deploy.log" 2>&1
echo "old DB at $(sql 'SELECT count(*) FROM _prisma_migrations' "$O") migrations"
DATABASE_URL="$(url "$O")" NODE_ENV=development npx tsx "$OLDDIR/seed.ts" > "$WORK/old-seed.log" 2>&1
counts "$O" > "$WORK/old-before.txt"; recon "$O" > "$WORK/old-before-recon.txt"
docker exec "$CONTAINER" pg_dump -U canavo -Fc -d "$O" -f /tmp/${O}.dump
echo "old DB: $(awk -F= '{s+=$2} END{print s}' "$WORK/old-before.txt") rows"
t0=$(date +%s); deploy_all "$O"; echo "upgrade of seeded DB: $(grep -c 'Applying migration' "$WORK/deploy-$O.log") migrations in $(( $(date +%s) - t0 ))s"
counts "$O" > "$WORK/old-after.txt"; recon "$O" > "$WORK/old-after-recon.txt"
echo "tables whose count changed (before → after), tables new in the upgrade excluded:"
join -t= -j1 <(sort "$WORK/old-before.txt") <(sort "$WORK/old-after.txt") | awk -F= '$2!=$3{print "  " $1 ": " $2 " → " $3; c++} END{if(!c) print "  none"}'
diff "$WORK/old-before-recon.txt" "$WORK/old-after-recon.txt" > /dev/null && echo "money/stock totals unchanged: $(cat "$WORK/old-after-recon.txt")" || { echo "TOTALS CHANGED"; cat "$WORK/old-before-recon.txt" "$WORK/old-after-recon.txt"; }
(cd "$API_DIR" && npx prisma migrate diff --from-url "$(url "$O")" --to-schema-datamodel prisma/schema.prisma --exit-code > /dev/null 2>&1) && echo "upgraded DB matches schema.prisma" || echo "UPGRADED DB DRIFTS from schema.prisma"
seed "$O" development after-upgrade && echo "current seed on upgraded DB: ok" || echo "current seed on upgraded DB FAILED (see $WORK/seed-$O-after-upgrade.log)"

# ---------------- E. pg_dump / pg_restore
echo "== E. pg_dump/pg_restore"
R=${P}_pgr
# E1: old dump → empty DB → migrate deploy (restore an old backup, then roll forward)
recreate "$R"
docker exec "$CONTAINER" pg_restore -U canavo -d "$R" --exit-on-error /tmp/${O}.dump
deploy_all "$R"
counts "$R" > "$WORK/pgr-old.txt"
diff -q "$WORK/old-after.txt" "$WORK/pgr-old.txt" > /dev/null && echo "old pg_dump → restore → migrate deploy: counts equal the upgraded DB" || { echo "FAIL old dump roll-forward"; diff "$WORK/old-after.txt" "$WORK/pgr-old.txt" || true; }
# E2: current dump (superuser) → new DB
docker exec "$CONTAINER" pg_dump -U canavo -Fc -d "$S" -f /tmp/${S}.dump
recreate "$R"
docker exec "$CONTAINER" pg_restore -U canavo -d "$R" --exit-on-error /tmp/${S}.dump
counts "$R" > "$WORK/pgr-cur.txt"
cat_sql="SELECT (SELECT count(*) FROM pg_policies WHERE schemaname='public') || ' policies, ' ||
  (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relforcerowsecurity) || ' FORCE-RLS tables, ' ||
  (SELECT count(*) FROM pg_type WHERE typnamespace='public'::regnamespace AND typtype='e') || ' enums, ' ||
  (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace) || ' functions, seq ' ||
  (SELECT coalesce(last_value,0) FROM pg_sequences WHERE sequencename='OutboxEvent_seq_seq') || ', migrations ' ||
  (SELECT count(*) FROM _prisma_migrations) || ', acl ' || md5(coalesce((SELECT string_agg(relname || ':' || coalesce(relacl::text,''), ',' ORDER BY relname) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','S')),''))"
a=$(sql "$cat_sql" "$S"); b=$(sql "$cat_sql" "$R")
diff -q "$WORK/seed1.txt" "$WORK/pgr-cur.txt" > /dev/null && echo "pg_dump → pg_restore: all table counts equal" || { echo "FAIL counts"; diff "$WORK/seed1.txt" "$WORK/pgr-cur.txt" || true; }
[[ "$(recon "$S")" == "$(recon "$R")" ]] && echo "totals equal: $(recon "$R")" || echo "FAIL totals"
[[ "$a" == "$b" ]] && echo "catalog equal: $b" || { echo "FAIL catalog"; echo " src $a"; echo " dst $b"; }
# E3: non-superuser table owner (Render/Neon-like): FORCE RLS binds the owner too.
OWN=${P}_own
sql "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$OWN') THEN CREATE ROLE $OWN LOGIN PASSWORD '$OWN' NOSUPERUSER NOBYPASSRLS; END IF; END \$\$"
recreate "$R" "$OWN"
docker exec "$CONTAINER" pg_restore -U canavo -d "$R" --no-owner --role="$OWN" --no-privileges /tmp/${S}.dump > "$WORK/pgr-own-restore.log" 2>&1 && echo "pg_restore as non-superuser owner: ok" || echo "pg_restore as non-superuser owner: FAILED ($(grep -m1 -o 'ERROR.*' "$WORK/pgr-own-restore.log"))"
echo "rows restored as owner: Order=$(sql 'SELECT count(*) FROM "Order"' "$R") (source $(sql 'SELECT count(*) FROM "Order"' "$S"))"
if docker exec -e PGPASSWORD=$OWN "$CONTAINER" pg_dump -h 127.0.0.1 -U "$OWN" -Fc -d "$R" -f /tmp/${R}-own.dump > "$WORK/own-dump.log" 2>&1; then echo "pg_dump as non-superuser owner: ok"; else echo "pg_dump as non-superuser owner: FAILS — $(grep -m1 -o 'error:.*' "$WORK/own-dump.log")"; fi
if docker exec -e PGPASSWORD=$OWN -e PGOPTIONS="-c app.bypass_rls=on" "$CONTAINER" pg_dump -h 127.0.0.1 -U "$OWN" -Fc --enable-row-security -d "$R" -f /tmp/${R}-own.dump > "$WORK/own-dump2.log" 2>&1; then
  recreate ${P}_pgr2
  docker exec "$CONTAINER" pg_restore -U canavo -d ${P}_pgr2 --exit-on-error /tmp/${R}-own.dump
  counts ${P}_pgr2 > "$WORK/pgr-own.txt"
  diff -q "$WORK/seed1.txt" "$WORK/pgr-own.txt" > /dev/null && echo "pg_dump --enable-row-security with PGOPTIONS='-c app.bypass_rls=on' as owner: all rows, counts equal" || { echo "owner dump with bypass: counts differ"; diff "$WORK/seed1.txt" "$WORK/pgr-own.txt" | head; }
else echo "owner dump with bypass FAILED: $(cat "$WORK/own-dump2.log")"; fi

# ---------------- F. seed as a non-superuser database owner (FORCE RLS binds the owner)
echo "== F. seed as non-superuser owner"
F=${P}_ownseed
recreate "$F" "$OWN"; sql "ALTER SCHEMA public OWNER TO $OWN" "$F"
FURL="postgresql://$OWN:$OWN@localhost:5433/$F?schema=public"
DATABASE_URL="$FURL" npx prisma migrate deploy > "$WORK/deploy-$F.log" 2>&1 && echo "migrate deploy as non-superuser owner: ok ($(sql 'SELECT count(*) FROM _prisma_migrations' "$F") migrations)"
if DATABASE_URL="$FURL" NODE_ENV=development npm run -s seed > "$WORK/seed-$F.log" 2>&1; then echo "seed as owner: ok — users $(sql 'SELECT count(*) FROM "User"' "$F"), orders $(sql 'SELECT count(*) FROM "Order"' "$F")"; else echo "seed as owner FAILED: $(grep -m1 -E 'Error|violates' "$WORK/seed-$F.log")"; fi
sql "DROP DATABASE IF EXISTS \"$F\" WITH (FORCE)"

# cleanup
docker exec "$CONTAINER" rm -f /tmp/${O}.dump /tmp/${S}.dump /tmp/${R}-own.dump
if [[ "${KEEP_SCRATCH:-0}" != 1 ]]; then for d in "$S" "$O" "$R" ${P}_pgr2; do sql "DROP DATABASE IF EXISTS \"$d\" WITH (FORCE)"; done; sql "DROP ROLE IF EXISTS $OWN"; fi
echo "work dir: $WORK"
