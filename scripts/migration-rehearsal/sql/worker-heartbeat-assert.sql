SET search_path TO "sto_info_worker", public;

\pset tuples_only on
\pset format unaligned

-- The same three helpers as the other suites. Temporary functions last only
-- for this session, so each suite file defines its own.
CREATE OR REPLACE FUNCTION pg_temp.expect_rejected(label text, stmt text, want text)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  got text;
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS got = RETURNED_SQLSTATE;
    IF got <> want THEN
      RAISE EXCEPTION 'FAIL % : rejected with %, expected %', label, got, want;
    END IF;
    RAISE NOTICE 'PASS % (%)', label, got;

    RETURN;
  END;
  RAISE EXCEPTION 'FAIL % : the database ACCEPTED it', label;
END;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.expect_accepted(label text, stmt text)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE stmt;
  RAISE NOTICE 'PASS % (accepted)', label;
END;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.expect_true(label text, query text)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  result boolean;
BEGIN
  EXECUTE query INTO result;
  IF result IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL % : expected true, got %', label, result;
  END IF;
  RAISE NOTICE 'PASS %', label;
END;
$fn$;


-- ===========================================================================
-- What a row may say
-- ===========================================================================

SELECT pg_temp.expect_rejected(
  'a state that is not one of the three',
  $$INSERT INTO worker_heartbeat ("workerId", "state", "startedAt", "beatAt")
    VALUES ('w-state', 'IDLE', now(), now())$$,
  '23514');

SELECT pg_temp.expect_rejected(
  'a paused row that does not say since when',
  $$INSERT INTO worker_heartbeat ("workerId", "state", "startedAt", "beatAt")
    VALUES ('w-since', 'PAUSED', now(), now())$$,
  '23514');

SELECT pg_temp.expect_rejected(
  'a running row that says it has been paused',
  $$INSERT INTO worker_heartbeat
      ("workerId", "state", "startedAt", "beatAt", "pausedSince")
    VALUES ('w-since', 'RUNNING', now(), now(), now())$$,
  '23514');

SELECT pg_temp.expect_rejected(
  'a stopping row that says it has been paused',
  $$INSERT INTO worker_heartbeat
      ("workerId", "state", "startedAt", "beatAt", "pausedSince")
    VALUES ('w-since', 'STOPPING', now(), now(), now())$$,
  '23514');

SELECT pg_temp.expect_rejected(
  'a pause reason on a row that is not paused',
  $$INSERT INTO worker_heartbeat
      ("workerId", "state", "pauseReason", "startedAt", "beatAt")
    VALUES ('w-reason', 'RUNNING', 'SCANNER_UNREACHABLE', now(), now())$$,
  '23514');

SELECT pg_temp.expect_rejected(
  'a pause reason that is a sentence rather than a code',
  $$INSERT INTO worker_heartbeat
      ("workerId", "state", "pauseReason", "startedAt", "beatAt", "pausedSince")
    VALUES ('w-reason', 'PAUSED', 'The scanner cannot be reached',
            now(), now(), now())$$,
  '23514');

SELECT pg_temp.expect_rejected(
  'a pause reason too long to be a code',
  $$INSERT INTO worker_heartbeat
      ("workerId", "state", "pauseReason", "startedAt", "beatAt", "pausedSince")
    VALUES ('w-reason', 'PAUSED', repeat('A', 65), now(), now(), now())$$,
  '23514');

SELECT pg_temp.expect_rejected(
  'fewer than no jobs in hand',
  $$INSERT INTO worker_heartbeat
      ("workerId", "state", "jobsInHand", "startedAt", "beatAt")
    VALUES ('w-jobs', 'RUNNING', -1, now(), now())$$,
  '23514');

SELECT pg_temp.expect_rejected(
  'an empty worker identifier',
  $$INSERT INTO worker_heartbeat ("workerId", "state", "startedAt", "beatAt")
    VALUES ('', 'RUNNING', now(), now())$$,
  '23514');

SELECT pg_temp.expect_rejected(
  'a worker identifier longer than the service ever makes',
  $$INSERT INTO worker_heartbeat ("workerId", "state", "startedAt", "beatAt")
    VALUES (repeat('w', 256), 'RUNNING', now(), now())$$,
  '23514');

SELECT pg_temp.expect_rejected(
  'two rows for one worker',
  $$INSERT INTO worker_heartbeat ("workerId", "state", "startedAt", "beatAt")
    VALUES ('worker-running', 'RUNNING', now(), now())$$,
  '23505');

SELECT pg_temp.expect_rejected(
  'a row with no beat',
  $$INSERT INTO worker_heartbeat ("workerId", "state", "startedAt")
    VALUES ('w-beat', 'RUNNING', now())$$,
  '23502');

BEGIN;
SELECT pg_temp.expect_accepted(
  'a paused row with a code and a start',
  $$INSERT INTO worker_heartbeat
      ("workerId", "state", "pauseReason", "startedAt", "beatAt", "pausedSince")
    VALUES ('w-ok', 'PAUSED', 'SIGNATURES_TOO_OLD', now(), now(), now())$$);
SELECT pg_temp.expect_accepted(
  'a paused row with no reason, as a resume Redis refused leaves one',
  $$INSERT INTO worker_heartbeat
      ("workerId", "state", "startedAt", "beatAt", "pausedSince")
    VALUES ('w-ok-2', 'PAUSED', now(), now(), now())$$);
SELECT pg_temp.expect_true(
  'jobs in hand default to none',
  $$SELECT "jobsInHand" = 0 FROM worker_heartbeat WHERE "workerId" = 'w-ok'$$);
ROLLBACK;


-- ===========================================================================
-- The view is the contract with the backend
-- ===========================================================================

SELECT pg_temp.expect_true(
  'the view has exactly the columns the backend reads, in order',
  $$SELECT array_agg(column_name::text ORDER BY ordinal_position)
         = ARRAY['workerId', 'state', 'pauseReason', 'definitionsVersion',
                 'definitionsBuiltAt', 'jobsInHand', 'startedAt', 'beatAt',
                 'pausedSince']
      FROM information_schema.columns
      WHERE table_schema = 'sto_info_worker'
        AND table_name = 'worker_heartbeat_status'$$);

SELECT pg_temp.expect_true(
  'every instant in it is a timestamptz',
  $$SELECT bool_and(data_type = 'timestamp with time zone')
      FROM information_schema.columns
      WHERE table_schema = 'sto_info_worker'
        AND table_name = 'worker_heartbeat_status'
        AND column_name IN ('definitionsBuiltAt', 'startedAt', 'beatAt',
                            'pausedSince')$$);

SELECT pg_temp.expect_true(
  'the view shows every row the table holds',
  $$SELECT count(*) = 3 FROM worker_heartbeat_status$$);

SELECT pg_temp.expect_true(
  'the backend may read the view',
  $$SELECT has_table_privilege('rehearsal_backend',
             'sto_info_worker.worker_heartbeat_status', 'SELECT')$$);

SELECT pg_temp.expect_true(
  'the backend may not read the table',
  $$SELECT NOT has_table_privilege('rehearsal_backend',
             'sto_info_worker.worker_heartbeat', 'SELECT')$$);

SELECT pg_temp.expect_true(
  'the backend may not write the view',
  $$SELECT NOT has_table_privilege('rehearsal_backend',
             'sto_info_worker.worker_heartbeat_status',
             'INSERT, UPDATE, DELETE')$$);

SELECT pg_temp.expect_true(
  'the backend still may not read the attempts',
  $$SELECT NOT has_table_privilege('rehearsal_backend',
             'sto_info_worker.file_scan_attempt', 'SELECT')$$);

-- Read through the role itself, not only asked about. The helpers belong to
-- this session's owner, so these fail by dividing by zero instead.
SET ROLE "rehearsal_backend";
SELECT 1 / (count(*) = 3)::int FROM "sto_info_worker"."worker_heartbeat_status";
SELECT 1 / (count(*) = 1)::int FROM "sto_info_worker"."worker_heartbeat_status"
  WHERE "state" = 'PAUSED'
    AND "pausedSince" < now() - interval '10 minutes';
SELECT 1 / (count(*) = 1)::int FROM "sto_info_worker"."worker_heartbeat_status"
  WHERE "beatAt" < now() - interval '2 minutes';
RESET ROLE;
