SET search_path TO "sto_info_worker", "sto_info_app", public;

\pset tuples_only on
\pset format unaligned

-- The same helpers as the other suites. Temporary functions last only for
-- this session, so each suite file defines its own.
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


-- A reopening that is not exactly a fresh claim. Each starts from the
-- reopening the service makes and gets one thing wrong.

SELECT pg_temp.expect_rejected(
  'reopening without counting the claim',
  $$UPDATE file_scan_attempt SET "state" = 'CLAIMED',
      "leaseToken" = gen_random_uuid(), "leaseExpiresAt" = now() + interval '5 minutes',
      "completedAt" = NULL, "startedAt" = NULL, "verdictPublishedAt" = NULL,
      "failureReason" = NULL
    WHERE "id" = '40000000-0000-4000-8000-000000000001'$$,
  'P0001');

SELECT pg_temp.expect_rejected(
  'reopening that keeps the record of the RETRY being sent',
  $$UPDATE file_scan_attempt SET "state" = 'CLAIMED', "attemptCount" = 2,
      "leaseToken" = gen_random_uuid(), "leaseExpiresAt" = now() + interval '5 minutes',
      "completedAt" = NULL, "startedAt" = NULL, "failureReason" = NULL
    WHERE "id" = '40000000-0000-4000-8000-000000000001'$$,
  'P0001');

SELECT pg_temp.expect_rejected(
  'reopening that keeps the old failure reason',
  $$UPDATE file_scan_attempt SET "state" = 'CLAIMED', "attemptCount" = 2,
      "leaseToken" = gen_random_uuid(), "leaseExpiresAt" = now() + interval '5 minutes',
      "completedAt" = NULL, "startedAt" = NULL, "verdictPublishedAt" = NULL
    WHERE "id" = '40000000-0000-4000-8000-000000000001'$$,
  'P0001');

SELECT pg_temp.expect_rejected(
  'reopening that keeps the old start',
  $$UPDATE file_scan_attempt SET "state" = 'CLAIMED', "attemptCount" = 2,
      "leaseToken" = gen_random_uuid(), "leaseExpiresAt" = now() + interval '5 minutes',
      "completedAt" = NULL, "verdictPublishedAt" = NULL, "failureReason" = NULL
    WHERE "id" = '40000000-0000-4000-8000-000000000001'$$,
  'P0001');

SELECT pg_temp.expect_rejected(
  'reopening with no lease',
  $$UPDATE file_scan_attempt SET "state" = 'CLAIMED', "attemptCount" = 2,
      "completedAt" = NULL, "startedAt" = NULL, "verdictPublishedAt" = NULL,
      "failureReason" = NULL
    WHERE "id" = '40000000-0000-4000-8000-000000000001'$$,
  'P0001');

SELECT pg_temp.expect_rejected(
  'reopening that changes what was asked',
  $$UPDATE file_scan_attempt SET "state" = 'CLAIMED', "attemptCount" = 2,
      "leaseToken" = gen_random_uuid(), "leaseExpiresAt" = now() + interval '5 minutes',
      "completedAt" = NULL, "startedAt" = NULL, "verdictPublishedAt" = NULL,
      "failureReason" = NULL, "objectKey" = 'prod/assets/elsewhere'
    WHERE "id" = '40000000-0000-4000-8000-000000000001'$$,
  'P0001');


-- A refusal that is not exactly the spent-budget refusal.

SELECT pg_temp.expect_rejected(
  'refusing a failed attempt for anything but its spent budget',
  $$UPDATE file_scan_attempt SET "state" = 'REJECTED', "rejectionCode" = 'INFECTED',
      "completedAt" = now(), "verdictPublishedAt" = NULL
    WHERE "id" = '40000000-0000-4000-8000-000000000002'$$,
  'P0001');

SELECT pg_temp.expect_rejected(
  'refusing while keeping the record of the RETRY being sent',
  $$UPDATE file_scan_attempt SET "state" = 'REJECTED',
      "rejectionCode" = 'RETRY_BUDGET_EXHAUSTED', "completedAt" = now()
    WHERE "id" = '40000000-0000-4000-8000-000000000002'$$,
  'P0001');

SELECT pg_temp.expect_rejected(
  'refusing and inventing a measured hash',
  $$UPDATE file_scan_attempt SET "state" = 'REJECTED',
      "rejectionCode" = 'RETRY_BUDGET_EXHAUSTED', "completedAt" = now(),
      "verdictPublishedAt" = NULL, "observedSha256" = repeat('b', 64)
    WHERE "id" = '40000000-0000-4000-8000-000000000002'$$,
  'P0001');

SELECT pg_temp.expect_rejected(
  'refusing and changing the claim count',
  $$UPDATE file_scan_attempt SET "state" = 'REJECTED',
      "rejectionCode" = 'RETRY_BUDGET_EXHAUSTED', "completedAt" = now(),
      "verdictPublishedAt" = NULL, "attemptCount" = 4
    WHERE "id" = '40000000-0000-4000-8000-000000000002'$$,
  'P0001');


-- Nothing else about a finished attempt has changed.

SELECT pg_temp.expect_rejected(
  'a failed attempt cannot be turned clean',
  $$UPDATE file_scan_attempt SET "state" = 'CLEAN', "observedSha256" = repeat('a', 64)
    WHERE "id" = '40000000-0000-4000-8000-000000000001'$$,
  'P0001');

SELECT pg_temp.expect_rejected(
  'a clean attempt cannot be reopened',
  $$UPDATE file_scan_attempt SET "state" = 'CLAIMED', "attemptCount" = 2,
      "leaseToken" = gen_random_uuid(), "leaseExpiresAt" = now() + interval '5 minutes',
      "completedAt" = NULL, "startedAt" = NULL, "verdictPublishedAt" = NULL,
      "observedSha256" = NULL
    WHERE "id" = '40000000-0000-4000-8000-000000000003'$$,
  'P0001');

SELECT pg_temp.expect_rejected(
  'a rejected attempt cannot be reopened',
  $$UPDATE file_scan_attempt SET "state" = 'CLAIMED', "attemptCount" = 2,
      "leaseToken" = gen_random_uuid(), "leaseExpiresAt" = now() + interval '5 minutes',
      "completedAt" = NULL, "startedAt" = NULL, "verdictPublishedAt" = NULL,
      "observedSha256" = NULL, "rejectionCode" = NULL, "failureReason" = NULL
    WHERE "id" = '40000000-0000-4000-8000-000000000004'$$,
  'P0001');

SELECT pg_temp.expect_rejected(
  'a failed attempt still cannot be published twice',
  $$UPDATE file_scan_attempt SET "verdictPublishedAt" = now()
    WHERE "id" = '40000000-0000-4000-8000-000000000001'$$,
  'P0001');

-- The one shape that is allowed, by hand, and undone: the service's own
-- statement is run by race-reopen-failed-attempt.sh.
BEGIN;
SELECT pg_temp.expect_accepted(
  'a fresh claim on a failed attempt',
  $$UPDATE file_scan_attempt SET "state" = 'CLAIMED', "attemptCount" = 2,
      "leaseToken" = gen_random_uuid(), "leaseExpiresAt" = now() + interval '5 minutes',
      "completedAt" = NULL, "startedAt" = NULL, "verdictPublishedAt" = NULL,
      "failureReason" = NULL
    WHERE "id" = '40000000-0000-4000-8000-000000000001'$$);
ROLLBACK;
