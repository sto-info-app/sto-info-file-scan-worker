#!/usr/bin/env bash
#
# Runs the attempt service's own claim, refusal and mark statements against
# the reopening guard (FC-042).
#
# The assert file proves the guard refuses every wrong shape. This proves the
# right one is what the service actually sends: a request for an attempt that
# failed reopens it under its budget and refuses it once the budget is spent;
# a reopened attempt that then scans clean has its clean answer marked sent,
# and not by the late confirmation of the RETRY before it; and nothing
# reopens a clean attempt or lets a stale lease write over it. The statements
# are read out of the service, not copied, and prepared in each session.
#
# Then ten workers claim one failed attempt at once, and exactly one wins.
#
set -euo pipefail

CONTAINER="${1:?container name required}"
WRITERS="${REHEARSAL_WRITERS:-10}"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# On one line, because on Windows `npx` hands a script to `ts-node -e` only
# as far as its first line break, silently.
SERVICE="require('./src/scan/services/file-scan-attempt.service')"
npx ts-node -r tsconfig-paths/register -e \
  "const s = ${SERVICE}; console.log('PREPARE claim(uuid, text, text, text, int, text, uuid, uuid, text, text, text, uuid, text, int, timestamptz, timestamptz) AS', s.CLAIM_ATTEMPT + ';'); console.log('PREPARE refuse(uuid, text) AS', s.REFUSE_EXHAUSTED_ATTEMPT + ';'); console.log('PREPARE mark(uuid, timestamptz) AS', s.MARK_VERDICT_PUBLISHED + ';');" \
  >"${WORK}/prepare.sql"

if ! grep -q 'PREPARE mark' "${WORK}/prepare.sql"; then
  echo 'Could not read the statements out of the attempt service' >&2
  exit 1
fi

# Runs statements in one session, after the prepared ones, and prints the
# last line of output.
session() {
  {
    echo 'SET search_path TO "sto_info_worker", "sto_info_app", public;'
    cat "${WORK}/prepare.sql"
    echo "$1"
  } | docker exec -i -e PGPASSWORD=rehearsal "${CONTAINER}" \
    psql -v ON_ERROR_STOP=1 -qtA -U postgres -d rehearsal | tail -n 1
}

expect() {
  local label="$1" statements="$2" want="$3" got

  got="$(session "${statements}")"
  if [ "${got}" != "${want}" ]; then
    echo "FAIL ${label}: got '${got}', expected '${want}'" >&2
    exit 1
  fi
  echo "PASS ${label}"
}

# claim(asset, key, version, expected hash, policy, epoch, campaign, trace,
#       engine, engine version, signature version, lease token, lease ms,
#       budget, definitions built, requested at)
claim() {
  local asset="$1" key="$2" hash="$3" token="$4"

  echo "EXECUTE claim('${asset}', '${key}', NULL, repeat('${hash}', 64), 1,
          '27412', NULL, gen_random_uuid(), 'clamav', '1.4.4', '27413',
          '${token}', '300000', 3, now() - interval '1 hour', now());"
}

ONE='40000000-0000-4000-8000-000000000001'
TWO='40000000-0000-4000-8000-000000000002'
THREE='40000000-0000-4000-8000-000000000003'
FIVE='40000000-0000-4000-8000-000000000005'
TOKEN='50000000-0000-4000-8000-000000000001'
STALE='50000000-0000-4000-8000-0000000000ff'

session "CREATE TABLE public.first_answer AS
           SELECT \"completedAt\" FROM file_scan_attempt WHERE \"id\" = '${ONE}';" \
  >/dev/null

expect 'a request for a failed attempt under budget reopens it' \
  "$(claim 30000000-0000-4000-8000-000000000001 prod/assets/one a "${TOKEN}")
   SELECT \"state\" || '|' || \"attemptCount\" || '|' ||
          coalesce(\"completedAt\"::text, 'open') || '|' ||
          coalesce(\"verdictPublishedAt\"::text, 'unsent') || '|' ||
          coalesce(\"failureReason\", 'none') || '|' || \"signatureVersion\"
   FROM file_scan_attempt WHERE \"id\" = '${ONE}';" \
  'CLAIMED|2|open|unsent|none|27413'

expect 'the reopened attempt scans clean under its new lease' \
  "UPDATE file_scan_attempt SET \"state\" = 'SCANNING', \"startedAt\" = now()
     WHERE \"id\" = '${ONE}' AND \"leaseToken\" = '${TOKEN}';
   UPDATE file_scan_attempt SET \"state\" = 'CLEAN',
       \"observedSha256\" = repeat('a', 64), \"completedAt\" = now(),
       \"leaseToken\" = NULL, \"leaseExpiresAt\" = NULL
     WHERE \"id\" = '${ONE}' AND \"leaseToken\" = '${TOKEN}'
       AND \"state\" IN ('CLAIMED', 'SCANNING');
   SELECT \"state\" FROM file_scan_attempt WHERE \"id\" = '${ONE}';" \
  'CLEAN'

expect 'the late confirmation of the old RETRY does not mark the clean answer sent' \
  "SELECT \"completedAt\" AS answered FROM public.first_answer \gset
   EXECUTE mark('${ONE}', :'answered');
   SELECT coalesce(\"verdictPublishedAt\"::text, 'unsent')
   FROM file_scan_attempt WHERE \"id\" = '${ONE}';" \
  'unsent'

expect 'the clean answer is marked sent by its own time, to the millisecond' \
  "SELECT date_trunc('milliseconds', \"completedAt\") AS answered
   FROM file_scan_attempt WHERE \"id\" = '${ONE}' \gset
   EXECUTE mark('${ONE}', :'answered');
   SELECT (\"verdictPublishedAt\" IS NOT NULL)::text
   FROM file_scan_attempt WHERE \"id\" = '${ONE}';" \
  'true'

expect 'a stale lease from before the failure cannot write over the answer' \
  "UPDATE file_scan_attempt SET \"state\" = 'FAILED', \"completedAt\" = now()
     WHERE \"id\" = '${ONE}' AND \"leaseToken\" = '${STALE}'
       AND \"state\" IN ('CLAIMED', 'SCANNING');
   SELECT \"state\" FROM file_scan_attempt WHERE \"id\" = '${ONE}';" \
  'CLEAN'

expect 'a late request for the clean attempt does not reopen it' \
  "$(claim 30000000-0000-4000-8000-000000000001 prod/assets/one a "${STALE}")
   SELECT \"state\" || '|' || \"attemptCount\"
   FROM file_scan_attempt WHERE \"id\" = '${ONE}';" \
  'CLEAN|2'

expect 'nor a request for any other clean attempt' \
  "$(claim 30000000-0000-4000-8000-000000000003 prod/assets/three c "${STALE}")
   SELECT \"state\" || '|' || \"attemptCount\"
   FROM file_scan_attempt WHERE \"id\" = '${THREE}';" \
  'CLEAN|1'

expect 'a request for a failed attempt whose budget is spent claims nothing' \
  "$(claim 30000000-0000-4000-8000-000000000002 prod/assets/two b "${STALE}")
   SELECT \"state\" || '|' || \"attemptCount\"
   FROM file_scan_attempt WHERE \"id\" = '${TWO}';" \
  'FAILED|3'

expect 'and the refusal closes it for good, to be sent as a new answer' \
  "EXECUTE refuse('${TWO}', 'Failed on all 3 claims');
   SELECT \"state\" || '|' || \"rejectionCode\" || '|' || \"attemptCount\" || '|' ||
          coalesce(\"verdictPublishedAt\"::text, 'unsent')
   FROM file_scan_attempt WHERE \"id\" = '${TWO}';" \
  'REJECTED|RETRY_BUDGET_EXHAUSTED|3|unsent'

expect 'the refusal touches no clean attempt' \
  "EXECUTE refuse('${THREE}', 'Failed on all 3 claims');
   SELECT \"state\" FROM file_scan_attempt WHERE \"id\" = '${THREE}';" \
  'CLEAN'

session 'DROP TABLE public.first_answer;' >/dev/null

# Ten workers handed the same failed attempt at the same instant.
pids=()
for ((i = 1; i <= WRITERS; i++)); do
  session "BEGIN;
           SELECT pg_sleep(0.4);
           $(claim 30000000-0000-4000-8000-000000000005 prod/assets/five e \
             "$(printf '60000000-0000-4000-8000-%012d' "${i}")")
           COMMIT;" >"${WORK}/writer-${i}.log" 2>&1 &
  pids+=("$!")
done

failed=0
for pid in "${pids[@]}"; do
  wait "${pid}" || failed=$((failed + 1))
done
if [ "${failed}" -ne 0 ]; then
  echo "FAIL ${failed} of ${WRITERS} concurrent claims errored" >&2
  cat "${WORK}"/writer-*.log >&2
  exit 1
fi
echo "PASS ${WRITERS} concurrent claims, none errored"

expect 'exactly one of ten workers reopened it' \
  "SELECT \"state\" || '|' || \"attemptCount\" || '|' ||
          (\"leaseToken\"::text LIKE '60000000-%')::text
   FROM file_scan_attempt WHERE \"id\" = '${FIVE}';" \
  'CLAIMED|2|true'
