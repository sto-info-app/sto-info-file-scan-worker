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
# The claim is the exact statement the service issues: an insert that falls
# back to taking over an expired lease. Each writer offers a different lease
# token, so the survivor is whichever arrived first rather than whichever the
# test preferred.
#
set -euo pipefail

CONTAINER="${1:?container name required}"
WRITERS="${REHEARSAL_WRITERS:-10}"
SCHEMA='SET search_path TO "sto_info_worker", "sto_info_app", public;'

sql() {
  docker exec -i -e PGPASSWORD=rehearsal "${CONTAINER}" \
    psql -qtA -U postgres -d rehearsal -c "$1"
}

race() {
  local label="$1" statement="$2"
  local i

  for ((i = 1; i <= WRITERS; i++)); do
    docker exec -i -e PGPASSWORD=rehearsal "${CONTAINER}" \
      psql -qtA -U postgres -d rehearsal -c "
        ${SCHEMA}
        BEGIN;
        SELECT pg_sleep(0.4);
        ${statement}
        COMMIT;" >/dev/null 2>&1 &
  done
  wait

  echo "${label}: ${WRITERS} concurrent writers"
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
     VALUES ('00000000-0000-4000-8000-0000000000a1')
     ON CONFLICT DO NOTHING;" >/dev/null

race 'ten workers claiming one job' \
  "INSERT INTO \"file_scan_attempt\"
     (\"assetId\",\"objectKey\",\"expectedSha256\",\"policyVersion\",
      \"definitionEpoch\",\"traceId\",\"state\",\"engine\",\"attemptCount\",
      \"leaseToken\",\"leaseExpiresAt\")
   VALUES ('00000000-0000-4000-8000-0000000000a1','prod/assets/contested',
           repeat('a', 64), 1, '27412', gen_random_uuid(), 'CLAIMED',
           'clamav', 1, gen_random_uuid(), now() + interval '5 minutes')
   ON CONFLICT ON CONSTRAINT \"UQ_file_scan_attempt_idempotency\"
   DO UPDATE SET
     \"leaseToken\" = EXCLUDED.\"leaseToken\",
     \"leaseExpiresAt\" = EXCLUDED.\"leaseExpiresAt\",
     \"attemptCount\" = \"file_scan_attempt\".\"attemptCount\" + 1
   WHERE \"file_scan_attempt\".\"state\" IN ('CLAIMED','SCANNING')
     AND (\"file_scan_attempt\".\"leaseExpiresAt\" IS NULL
          OR \"file_scan_attempt\".\"leaseExpiresAt\" < now());"

expect_count 'one attempt, not ten' \
  "SELECT count(*) FROM \"file_scan_attempt\"
    WHERE \"assetId\" = '00000000-0000-4000-8000-0000000000a1'" '1'

# The nine that lost took nothing over, because the lease the winner wrote had
# not expired. Without the expiry clause each one would have stolen the attempt
# from the last, and ten workers would have read the same object at once.
expect_count 'nine claims refused rather than queued behind each other' \
  "SELECT \"attemptCount\" FROM \"file_scan_attempt\"
    WHERE \"assetId\" = '00000000-0000-4000-8000-0000000000a1'" '1'

expect_count 'one lease token, held by one worker' \
  "SELECT count(DISTINCT \"leaseToken\") FROM \"file_scan_attempt\"
    WHERE \"assetId\" = '00000000-0000-4000-8000-0000000000a1'" '1'

# Now let the lease lapse and race again. This is the reclaim path, and it
# must also produce exactly one winner — a crashed worker's job being picked
# up by two replacements would be the same failure a second time.
sql "${SCHEMA}
     UPDATE \"file_scan_attempt\"
     SET \"leaseExpiresAt\" = now() - interval '1 minute'
     WHERE \"assetId\" = '00000000-0000-4000-8000-0000000000a1';" >/dev/null

race 'ten workers reclaiming one lapsed lease' \
  "INSERT INTO \"file_scan_attempt\"
     (\"assetId\",\"objectKey\",\"expectedSha256\",\"policyVersion\",
      \"definitionEpoch\",\"traceId\",\"state\",\"engine\",\"attemptCount\",
      \"leaseToken\",\"leaseExpiresAt\")
   VALUES ('00000000-0000-4000-8000-0000000000a1','prod/assets/contested',
           repeat('a', 64), 1, '27412', gen_random_uuid(), 'CLAIMED',
           'clamav', 1, gen_random_uuid(), now() + interval '5 minutes')
   ON CONFLICT ON CONSTRAINT \"UQ_file_scan_attempt_idempotency\"
   DO UPDATE SET
     \"leaseToken\" = EXCLUDED.\"leaseToken\",
     \"leaseExpiresAt\" = EXCLUDED.\"leaseExpiresAt\",
     \"attemptCount\" = \"file_scan_attempt\".\"attemptCount\" + 1
   WHERE \"file_scan_attempt\".\"state\" IN ('CLAIMED','SCANNING')
     AND (\"file_scan_attempt\".\"leaseExpiresAt\" IS NULL
          OR \"file_scan_attempt\".\"leaseExpiresAt\" < now());"

expect_count 'still one attempt after the reclaim' \
  "SELECT count(*) FROM \"file_scan_attempt\"
    WHERE \"assetId\" = '00000000-0000-4000-8000-0000000000a1'" '1'

# Exactly one reclaim happened. The first writer to commit extends the lease,
# and the rest find it live and take nothing.
expect_count 'exactly one worker reclaimed it' \
  "SELECT \"attemptCount\" FROM \"file_scan_attempt\"
    WHERE \"assetId\" = '00000000-0000-4000-8000-0000000000a1'" '2'
