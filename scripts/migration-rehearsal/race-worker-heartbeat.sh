#!/usr/bin/env bash
#
# Runs the heartbeat service's own statements against the rehearsed table.
#
# The constraints are proved by the assert file. What they cannot prove is
# that the statements `WorkerHeartbeatService` actually sends are ones the
# table accepts, and that they keep `pausedSince` the way the backend's
# "paused for more than ten minutes" alert needs: set when a worker first
# pauses, kept however many beats it stays paused, cleared when it resumes
# or stops. A copy of the SQL here could drift from the service's without
# anybody noticing, so the statements are read out of the service itself and
# prepared in each session.
#
# Then ten workers beat at once, each on its own row and all on one shared
# row, which is what an upsert has to survive when two processes briefly
# share an identifier.
#
set -euo pipefail

CONTAINER="${1:?container name required}"
WRITERS="${REHEARSAL_WRITERS:-10}"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# The statements exactly as the service holds them, prepared under the names
# the checks below execute. On one line, because on Windows `npx` hands a
# script to `ts-node -e` only as far as its first line break, silently.
SERVICE="require('./src/heartbeat/worker-heartbeat.service')"
npx ts-node -r tsconfig-paths/register -e \
  "const s = ${SERVICE}; console.log('PREPARE beat(text, text, text, text, timestamptz, int, timestamptz) AS', s.HEARTBEAT_UPSERT + ';'); console.log('PREPARE prune AS', s.HEARTBEAT_PRUNE + ';');" \
  >"${WORK}/prepare.sql"

if ! grep -q 'PREPARE prune' "${WORK}/prepare.sql"; then
  echo 'Could not read the statements out of the heartbeat service' >&2
  exit 1
fi

# Runs statements in one session, after the prepared ones, and prints the
# last line of output.
session() {
  {
    echo 'SET search_path TO "sto_info_worker", public;'
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

# One worker, beat by beat. `startedAt` is passed as the service passes it,
# once, and a later beat offering a different one must not move it.
STARTED="'2026-09-30 08:00:00+00'"
ROW="FROM worker_heartbeat WHERE \"workerId\" = 'svc-a'"

expect 'a first beat writes a running row with no pause' \
  "EXECUTE beat('svc-a', 'RUNNING', NULL, '27412', now() - interval '1 hour', 0, ${STARTED});
   SELECT \"state\" || '|' || coalesce(\"pausedSince\"::text, 'none') || '|' ||
          (\"startedAt\" = ${STARTED}) || '|' || (\"beatAt\" > now() - interval '1 minute')
   ${ROW};" \
  'RUNNING|none|true|true'

expect 'a paused beat records when the pause began, and why' \
  "EXECUTE beat('svc-a', 'PAUSED', 'SCANNER_UNREACHABLE', NULL, NULL, 1, ${STARTED});
   SELECT \"state\" || '|' || \"pauseReason\" || '|' || (\"pausedSince\" = \"beatAt\") ||
          '|' || coalesce(\"definitionsVersion\", 'none') || '|' || \"jobsInHand\"
   ${ROW};" \
  'PAUSED|SCANNER_UNREACHABLE|true|none|1'

session "CREATE TABLE IF NOT EXISTS public.first_pause AS
           SELECT \"pausedSince\" ${ROW};" >/dev/null

expect 'a second paused beat keeps when the pause began' \
  "SELECT pg_sleep(0.2);
   EXECUTE beat('svc-a', 'PAUSED', 'SCANNER_UNREACHABLE', NULL, NULL, 0, ${STARTED});
   SELECT (h.\"pausedSince\" = f.\"pausedSince\") || '|' ||
          (h.\"pausedSince\" < h.\"beatAt\")
   FROM worker_heartbeat h, public.first_pause f WHERE h.\"workerId\" = 'svc-a';" \
  'true|true'

expect 'a running beat clears the pause and its reason' \
  "EXECUTE beat('svc-a', 'RUNNING', NULL, '27412', now(), 0, '2026-09-30 09:00:00+00');
   SELECT coalesce(\"pausedSince\"::text, 'none') || '|' ||
          coalesce(\"pauseReason\", 'none') || '|' || (\"startedAt\" = ${STARTED})
   ${ROW};" \
  'none|none|true'

expect 'pausing again starts a new pause rather than resuming the old one' \
  "EXECUTE beat('svc-a', 'PAUSED', 'SIGNATURES_TOO_OLD', '27400', now(), 0, ${STARTED});
   SELECT (h.\"pausedSince\" > f.\"pausedSince\")::text
   FROM worker_heartbeat h, public.first_pause f WHERE h.\"workerId\" = 'svc-a';" \
  'true'

expect 'stopping clears the pause' \
  "EXECUTE beat('svc-a', 'STOPPING', NULL, '27400', now(), 0, ${STARTED});
   SELECT \"state\" || '|' || coalesce(\"pausedSince\"::text, 'none') ${ROW};" \
  'STOPPING|none'

expect 'pruning removes only the row a day stale' \
  "EXECUTE prune;
   SELECT string_agg(\"workerId\", ',' ORDER BY \"workerId\") FROM worker_heartbeat;" \
  'svc-a,worker-paused,worker-running'

session 'DROP TABLE public.first_pause;' >/dev/null

# Every writer beats its own row and the shared one, at the same instant.
pids=()
for ((i = 1; i <= WRITERS; i++)); do
  state='RUNNING'
  pause='NULL'
  if [ $((i % 2)) -eq 0 ]; then
    state='PAUSED'
    pause="'SCANNER_UNREACHABLE'"
  fi

  session "BEGIN;
           SELECT pg_sleep(0.4);
           EXECUTE beat('svc-race', '${state}', ${pause}, '27412', now(), ${i}, now());
           EXECUTE beat('svc-${i}', '${state}', ${pause}, '27412', now(), ${i}, now());
           EXECUTE prune;
           COMMIT;" >"${WORK}/writer-${i}.log" 2>&1 &
  pids+=("$!")
done

failed=0
for pid in "${pids[@]}"; do
  wait "${pid}" || failed=$((failed + 1))
done
if [ "${failed}" -ne 0 ]; then
  echo "FAIL ${failed} of ${WRITERS} concurrent beats were refused" >&2
  cat "${WORK}"/writer-*.log >&2
  exit 1
fi
echo "PASS ${WRITERS} concurrent beats, none refused"

expect 'one shared row, whichever beat last' \
  "SELECT count(*) || '|' ||
          bool_and((\"state\" = 'PAUSED') = (\"pausedSince\" IS NOT NULL))
   FROM worker_heartbeat WHERE \"workerId\" = 'svc-race';" \
  '1|true'

expect 'one row for every writer' \
  "SELECT count(*) FROM worker_heartbeat WHERE \"workerId\" ~ '^svc-[0-9]+$';" \
  "${WRITERS}"
