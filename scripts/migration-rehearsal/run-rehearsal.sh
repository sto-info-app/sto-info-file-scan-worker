#!/usr/bin/env bash
#
# Rehearses this repository's migrations against a real, throwaway PostgreSQL.
#
# Everything a unit spec can prove about a migration is a property of its SQL
# text. Whether PostgreSQL accepts that SQL, and whether the constraints in it
# reject what they are supposed to reject, is a different question — and it is
# the one that matters on deploy day.
#
# Two things here can only be proved this way, and both are quiet failures:
#
#   * `UNIQUE NULLS NOT DISTINCT`. Every objectVersion in this table is null,
#     because R2 has no object versioning. Under PostgreSQL's default those
#     nulls differ from one another, so an ordinary unique constraint would
#     have matched nothing and every duplicate delivery would have inserted a
#     second attempt. The migration and the plain version are indistinguishable
#     by inspection.
#
#   * The cross-schema foreign key into `sto_info_app.file_asset`. ADR-0006
#     split schema ownership between two repositories; whether a key can
#     actually cross that line, and whether it still blocks a delete, is a
#     question about PostgreSQL rather than about either repository.
#
# It never touches a real database. It talks only to the container it started,
# over `docker exec`, and it reads no database environment variable — so a
# stray .env cannot point it at a developer or hosted database. The container
# is removed on exit, including on failure or interrupt.
#
# Usage:
#   bash scripts/migration-rehearsal/run-rehearsal.sh [<migration.ts>[,<migration.ts>...]] [<name>]
#
# Several migrations, separated by commas, are applied in order. The last one
# is the subject: only it is rolled back and re-applied, and the ones before it
# are the schema it was written against. A suite with its own
# `<name>-after-down.sql` checks the rollback itself; otherwise the rollback
# must leave `sto_info_worker` empty.
#
set -euo pipefail

MIGRATIONS="${1:-src/database/migrations/1792400000000-CreateFileScanAttempt.ts}"
SUITE="${2:-file-scan-attempt}"
IFS=',' read -r -a MIGRATION_LIST <<<"${MIGRATIONS}"
LAST=$((${#MIGRATION_LIST[@]} - 1))

# A migration that grants to the backend reads its role from here. The stub
# creates the role, and nothing outside the container is involved.
export BACKEND_DB_ROLE=rehearsal_backend

PG_IMAGE="${REHEARSAL_PG_IMAGE:-postgres:18-alpine}"
CONTAINER="worker-migration-rehearsal-$$"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"
WORK="$(mktemp -d)"

SEED="${HERE}/sql/${SUITE}-seed.sql"
ASSERT="${HERE}/sql/${SUITE}-assert.sql"
AFTER_DOWN="${HERE}/sql/${SUITE}-after-down.sql"
RACE="${HERE}/race-${SUITE}.sh"

cleanup() {
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  rm -rf "${WORK}"
}
trap cleanup EXIT INT TERM

step() { printf '\n=== %s ===\n' "$1"; }

# Runs a SQL file inside the container, aborting the rehearsal on any error.
psql_file() {
  docker exec -i -e PGPASSWORD=rehearsal "${CONTAINER}" \
    psql -v ON_ERROR_STOP=1 -U postgres -d rehearsal -q <"$1"
}

# Runs a single statement and prints only its result.
psql_value() {
  docker exec -i -e PGPASSWORD=rehearsal "${CONTAINER}" \
    psql -qtA -U postgres -d rehearsal -c "$1"
}

for file in "${MIGRATION_LIST[@]}" "${SEED}" "${ASSERT}"; do
  if [ ! -f "${REPO}/${file}" ] && [ ! -f "${file}" ]; then
    echo "Not found: ${file}" >&2
    exit 1
  fi
done

if ! docker version >/dev/null 2>&1; then
  echo 'Docker is not available; this rehearsal needs it.' >&2
  exit 1
fi

cd "${REPO}"

for index in "${!MIGRATION_LIST[@]}"; do
  step "Emitting SQL from ${MIGRATION_LIST[${index}]}"
  npx ts-node -r tsconfig-paths/register \
    "${HERE}/emit-migration-sql.ts" "${MIGRATION_LIST[${index}]}" \
    "${WORK}/up-${index}.sql" "${WORK}/down-${index}.sql"
done

step "Starting ${PG_IMAGE}"
docker run -d --name "${CONTAINER}" \
  -e POSTGRES_PASSWORD=rehearsal -e POSTGRES_DB=rehearsal \
  "${PG_IMAGE}" >/dev/null
ready=0
until [ "${ready}" -ge 3 ]; do
  if docker exec "${CONTAINER}" psql -U postgres -d rehearsal -c 'SELECT 1' >/dev/null 2>&1; then
    ready=$((ready + 1))
  else
    ready=0
  fi
  sleep 1
done

# The backend's schema, as a stand-in. This repository does not migrate it and
# must not: ADR-0006 gives each side its own tables. What it does need is
# something for the foreign key to point at, carrying only the column the key
# uses.
step 'Applying the backend stub the foreign key needs'
psql_file "${HERE}/sql/stubs.sql"

for index in "${!MIGRATION_LIST[@]}"; do
  step "Applying ${MIGRATION_LIST[${index}]} (up)"
  psql_file "${WORK}/up-${index}.sql"
done

step 'Seeding'
psql_file "${SEED}"

step 'Asserting — every statement below is meant to be rejected'
psql_file "${ASSERT}"

if [ -f "${RACE}" ]; then
  step 'Racing concurrent writers'
  bash "${RACE}" "${CONTAINER}"
fi

# Rolling back an empty schema proves very little. This rolls back over the
# rows the assertions left behind, which is the case that actually goes wrong.
step "Rolling back ${MIGRATION_LIST[${LAST}]} (down) with data present"
psql_file "${WORK}/down-${LAST}.sql"

if [ -f "${AFTER_DOWN}" ]; then
  step 'Asserting what the rollback left'
  psql_file "${AFTER_DOWN}"

  step 'Re-applying the migration to the same database'
  psql_file "${WORK}/up-${LAST}.sql"

  printf '\nREHEARSAL PASSED: up -> assert -> down (with data) -> up, on %s\n' "${PG_IMAGE}"
  exit 0
fi

remaining="$(psql_value "SELECT count(*) FROM information_schema.tables WHERE table_schema='sto_info_worker'")"
types="$(psql_value "SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='sto_info_worker' AND t.typtype='e'")"
backend_tables="$(psql_value "SELECT count(*) FROM information_schema.tables WHERE table_schema='sto_info_app'")"
expected_stubs="$(grep -c '^CREATE TABLE' "${HERE}/sql/stubs.sql")"

if [ "${types}" -ne 0 ]; then
  echo "FAIL: ${types} enum type(s) survived the rollback" >&2
  exit 1
fi
if [ "${remaining}" -ne 0 ]; then
  echo "FAIL: ${remaining} table(s) left in sto_info_worker after rollback" >&2
  exit 1
fi
# The point of the split is that neither side can touch the other's tables.
# A rollback that took the backend's schema with it would be exactly the
# accident ADR-0006 warned about.
if [ "${backend_tables}" -ne "${expected_stubs}" ]; then
  echo "FAIL: the rollback disturbed sto_info_app: ${backend_tables} tables" >&2
  exit 1
fi
echo "PASS: rollback emptied sto_info_worker and left sto_info_app alone"

step 'Re-applying the migration to the same database'
psql_file "${WORK}/up-${LAST}.sql"

printf '\nREHEARSAL PASSED: up -> assert -> down (with data) -> up, on %s\n' "${PG_IMAGE}"
