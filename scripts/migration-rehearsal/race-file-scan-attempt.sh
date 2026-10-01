#!/usr/bin/env bash
#
# Proves that ten workers handed the same job end up with one attempt, and
# that exactly one of them wins the lease.
#
# This is the rule the whole design rests on and the one a single session
# cannot demonstrate. Inserting twice in a row only shows a constraint exists;
# what has to hold is that two workers claiming at the same instant cannot both
# decide they have won, because the loser would go on to read the object, scan
# it, and write an answer over the winner's.
#
# The claim is the exact statement the service issues, read out of
# `FileScanAttemptService` and prepared in each session — not a copy, which
# had already fallen behind the service once (FC-042). It therefore needs
# the schema the service is written against, which is why
# `npm run rehearse:migration` applies every migration rather than the first
# alone. Each writer offers a different lease token, so the survivor is
# whichever arrived first rather than whichever the test preferred.
#
set -euo pipefail

CONTAINER="${1:?container name required}"
WRITERS="${REHEARSAL_WRITERS:-10}"
SCHEMA='SET search_path TO "sto_info_worker", "sto_info_app", public;'
ASSET='00000000-0000-4000-8000-0000000000a1'
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# On one line, because on Windows `npx` hands a script to `ts-node -e` only
# as far as its first line break, silently.
SERVICE="require('./src/scan/services/file-scan-attempt.service')"
npx ts-node -r tsconfig-paths/register -e \
  "const s = ${SERVICE}; console.log('PREPARE claim(uuid, text, text, text, int, text, uuid, uuid, text, text, text, uuid, text, int, timestamptz, timestamptz) AS', s.CLAIM_ATTEMPT + ';');" \
  >"${WORK}/prepare.sql"

if ! grep -q 'PREPARE claim' "${WORK}/prepare.sql"; then
  echo 'Could not read the claim statement out of the attempt service' >&2
  exit 1
fi

# The claim as one worker makes it: a fresh lease token, a five-minute
# lease and the default budget of three.
CLAIM="EXECUTE claim('${ASSET}', 'prod/assets/contested', NULL, repeat('a', 64),
         1, '27412', NULL, gen_random_uuid(), 'clamav', '1.4.3', '27412',
         gen_random_uuid(), '300000', 3, now() - interval '1 hour', now());"

sql() {
  docker exec -i -e PGPASSWORD=rehearsal "${CONTAINER}" \
    psql -qtA -U postgres -d rehearsal -c "$1"
}

race() {
  local label="$1"
  local i pids=() failed=0

  for ((i = 1; i <= WRITERS; i++)); do
    {
      echo "${SCHEMA}"
      cat "${WORK}/prepare.sql"
      echo "BEGIN; SELECT pg_sleep(0.4); ${CLAIM} COMMIT;"
    } | docker exec -i -e PGPASSWORD=rehearsal "${CONTAINER}" \
      psql -v ON_ERROR_STOP=1 -qtA -U postgres -d rehearsal \
      >"${WORK}/writer-${i}.log" 2>&1 &
    pids+=("$!")
  done

  for pid in "${pids[@]}"; do
    wait "${pid}" || failed=$((failed + 1))
  done

  # A losing writer takes nothing and says nothing; it does not error. One
  # that errors has found something the service would have thrown on.
  if [ "${failed}" -ne 0 ]; then
    echo "FAIL ${label}: ${failed} of ${WRITERS} writers errored" >&2
    cat "${WORK}"/writer-*.log >&2
    exit 1
  fi

  echo "${label}: ${WRITERS} concurrent writers, none errored"
}

expect_count() {
  local label="$1" query="$2" want="$3" got

  got="$(sql "${SCHEMA} ${query}")"
  if [ "${got}" != "${want}" ]; then
    echo "FAIL ${label}: got ${got}, expected ${want}" >&2
    exit 1
  fi
  echo "PASS ${label}"
}

sql "${SCHEMA}
     INSERT INTO \"sto_info_app\".\"file_asset\" (\"id\")
     VALUES ('${ASSET}')
     ON CONFLICT DO NOTHING;" >/dev/null

race 'ten workers claiming one job'

expect_count 'one attempt, not ten' \
  "SELECT count(*) FROM \"file_scan_attempt\" WHERE \"assetId\" = '${ASSET}'" '1'

# The nine that lost took nothing over, because the lease the winner wrote had
# not expired. Without the expiry clause each one would have stolen the attempt
# from the last, and ten workers would have read the same object at once.
expect_count 'nine claims refused rather than queued behind each other' \
  "SELECT \"attemptCount\" FROM \"file_scan_attempt\" WHERE \"assetId\" = '${ASSET}'" '1'

expect_count 'one lease token, held by one worker' \
  "SELECT count(DISTINCT \"leaseToken\") FROM \"file_scan_attempt\"
    WHERE \"assetId\" = '${ASSET}'" '1'

# Now let the lease lapse and race again. This is the reclaim path, and it
# must also produce exactly one winner — a crashed worker's job being picked
# up by two replacements would be the same failure a second time.
sql "${SCHEMA}
     UPDATE \"file_scan_attempt\"
     SET \"leaseExpiresAt\" = now() - interval '1 minute'
     WHERE \"assetId\" = '${ASSET}';" >/dev/null

race 'ten workers reclaiming one lapsed lease'

expect_count 'still one attempt after the reclaim' \
  "SELECT count(*) FROM \"file_scan_attempt\" WHERE \"assetId\" = '${ASSET}'" '1'

# Exactly one reclaim happened. The first writer to commit extends the lease,
# and the rest find it live and take nothing.
expect_count 'exactly one worker reclaimed it' \
  "SELECT \"attemptCount\" FROM \"file_scan_attempt\" WHERE \"assetId\" = '${ASSET}'" '2'
