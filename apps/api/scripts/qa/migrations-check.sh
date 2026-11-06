#!/usr/bin/env bash
# QA Phase 7 — migration checks (scratch databases only; never the dev DB).
#   apps/api/scripts/qa/migrations-check.sh            # full run
#   PREFIX=canavo_dbc STEP_FROM=0 STEP_TO=55 …          # options
#
# 1. From-scratch: empty DB → `prisma migrate deploy` (all migrations).
# 2. Schema drift: `prisma migrate diff --from-url <scratch> --to-schema-datamodel` must be empty.
# 3. Idempotency: a second deploy on the same DB applies nothing and leaves the schema unchanged.
# 4. Stepwise: for every k = 0..N, a DB at migration k (built incrementally, cloned with
#    CREATE DATABASE … TEMPLATE) gets the remaining migrations deployed; its normalised
#    `pg_dump --schema-only` must equal the from-scratch one.
# Uses the Postgres container's own pg_dump (server is 16; Homebrew pg_dump may be older).
set -euo pipefail
export PRISMA_HIDE_UPDATE_MESSAGE=1

CONTAINER=${CONTAINER:-canavo-postgres-1}
PGUSER_=${PGUSER_:-canavo}
HOSTURL=${HOSTURL:-postgresql://canavo:canavo@localhost:5433}
PREFIX=${PREFIX:-canavo_dbc}
API_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
WORK=${WORK:-$(mktemp -d)}
OUT=${OUT:-$WORK/out}
mkdir -p "$OUT"

case "$PREFIX" in canavo|canavo_it|canavo_shadow) echo "refusing PREFIX=$PREFIX"; exit 2;; esac

sql() { docker exec -i "$CONTAINER" psql -U "$PGUSER_" -d "${2:-postgres}" -v ON_ERROR_STOP=1 -qAt -c "$1"; }
recreate() { sql "DROP DATABASE IF EXISTS \"$1\" WITH (FORCE)"; sql "CREATE DATABASE \"$1\"${2:+ TEMPLATE \"$2\"}"; }
drop() { sql "DROP DATABASE IF EXISTS \"$1\" WITH (FORCE)"; }
url() { echo "$HOSTURL/$1?schema=public"; }
# Normalised schema dump: no comments/SET/\restrict lines, no blank lines.
dump() {
  docker exec "$CONTAINER" pg_dump -U "$PGUSER_" -d "$1" --schema-only --no-owner --no-privileges \
    | grep -v -E '^(--|SET |SELECT pg_catalog.set_config|\\restrict|\\unrestrict)' | sed '/^\s*$/d'
}
deploy() { # deploy <db> <schema-file>
  (cd "$API_DIR" && DATABASE_URL="$(url "$1")" npx prisma migrate deploy --schema "$2" 2>&1)
}

MIGS=($(cd "$API_DIR/prisma/migrations" && ls -d */ | tr -d / | sort))
N=${#MIGS[@]}
echo "migrations: $N  work: $WORK"

# A schema dir holding only the first k migrations (copies: Prisma skips symlinked migration dirs).
partial_schema() {
  local k=$1 d="$WORK/partial-$1"
  rm -rf "$d"; mkdir -p "$d/migrations"
  cp "$API_DIR/prisma/schema.prisma" "$d/schema.prisma"
  cp "$API_DIR/prisma/migrations/migration_lock.toml" "$d/migrations/"
  for ((i = 0; i < k; i++)); do cp -R "$API_DIR/prisma/migrations/${MIGS[$i]}" "$d/migrations/"; done
  echo "$d/schema.prisma"
}
FULL_SCHEMA="$API_DIR/prisma/schema.prisma"

# ---- 1. from scratch
SCRATCH=${PREFIX}_scratch
recreate "$SCRATCH"
t0=$(date +%s)
deploy "$SCRATCH" "$FULL_SCHEMA" > "$OUT/scratch-deploy.log"
echo "from-scratch deploy: $(( $(date +%s) - t0 ))s, applied $(sql 'select count(*) from _prisma_migrations where finished_at is not null' "$SCRATCH")"
dump "$SCRATCH" > "$OUT/scratch.sql"

# ---- 2. drift vs schema.prisma
(cd "$API_DIR" && npx prisma migrate diff --from-url "$(url "$SCRATCH")" --to-schema-datamodel prisma/schema.prisma --script) > "$OUT/drift.sql"
if grep -v -E '^\s*(--.*)?$' "$OUT/drift.sql" | grep -q .; then echo "DRIFT: schema.prisma differs from migrated DB (see $OUT/drift.sql)"; DRIFT=1; else echo "drift: none (empty migration)"; DRIFT=0; fi

# ---- 3. idempotency: deploy again
deploy "$SCRATCH" "$FULL_SCHEMA" > "$OUT/redeploy.log"
grep -q "No pending migrations" "$OUT/redeploy.log" && echo "re-deploy: no pending migrations" || { echo "re-deploy applied something!"; cat "$OUT/redeploy.log"; }
dump "$SCRATCH" > "$OUT/scratch-again.sql"
cmp -s "$OUT/scratch.sql" "$OUT/scratch-again.sql" && echo "re-deploy: schema unchanged" || echo "re-deploy: SCHEMA CHANGED"

# ---- 4. stepwise
BASE=${PREFIX}_base
STEP=${PREFIX}_step
recreate "$BASE"
FAIL=0
echo "k,migration_at_k,deploy_rest_s,result" > "$OUT/stepwise.csv"
for ((k = ${STEP_FROM:-0}; k <= ${STEP_TO:-$N}; k++)); do
  if ((k > 0)); then deploy "$BASE" "$(partial_schema "$k")" > "$OUT/base-$k.log" || { echo "k=$k: deploying prefix failed"; cat "$OUT/base-$k.log"; exit 1; }; fi
  applied=$(sql 'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL' "$BASE" 2>/dev/null || echo 0)
  ((applied == k)) || { echo "k=$k: base DB has $applied migrations applied, expected $k"; exit 1; }
  recreate "$STEP" "$BASE"
  rm -rf "$WORK/partial-$((k-1))"
  at="<empty>"; ((k > 0)) && at=${MIGS[$((k-1))]}
  t0=$(date +%s)
  if ! deploy "$STEP" "$FULL_SCHEMA" > "$OUT/step-$k.log"; then
    echo "$k,$at,,DEPLOY FAILED" >> "$OUT/stepwise.csv"; FAIL=$((FAIL+1)); cat "$OUT/step-$k.log"; continue
  fi
  dt=$(( $(date +%s) - t0 ))
  n_applied=$(grep -c "Applying migration" "$OUT/step-$k.log" || true)
  ((n_applied == N - k)) || { echo "k=$k: deploy applied $n_applied migrations, expected $((N - k))"; FAIL=$((FAIL+1)); }
  dump "$STEP" > "$OUT/step-$k.sql"
  if cmp -s "$OUT/scratch.sql" "$OUT/step-$k.sql"; then r=same; rm "$OUT/step-$k.sql"; else r=DIFFERENT; FAIL=$((FAIL+1)); diff "$OUT/scratch.sql" "$OUT/step-$k.sql" > "$OUT/step-$k.diff" || true; fi
  echo "$k,$at,$dt,$r" >> "$OUT/stepwise.csv"
  echo "k=$k ($at) → rest deployed in ${dt}s: $r"
done
drop "$STEP"; drop "$BASE"
[[ "${KEEP_SCRATCH:-0}" == 1 ]] || drop "$SCRATCH"
echo "stepwise failures: $FAIL; drift: $DRIFT; results: $OUT/stepwise.csv"
((FAIL == 0 && DRIFT == 0))
