-- What rolling back ReopenFailedScanAttempt must leave: the guard as
-- RecordScanUsage wrote it, which refuses every change to a finished attempt,
-- and every attempt still there.
SET search_path TO "sto_info_worker", "sto_info_app", public;

\pset tuples_only on
\pset format unaligned

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

SELECT pg_temp.expect_true(
  'every attempt survived the rollback',
  $$SELECT count(*) >= 5 FROM file_scan_attempt$$);

-- Attempt 5 is the one ten workers raced: whichever won it is still open, so
-- this finds a failed one to try instead.
INSERT INTO "sto_info_app"."file_asset" ("id")
VALUES ('30000000-0000-4000-8000-000000000009');
INSERT INTO file_scan_attempt (
  "id", "assetId", "objectKey", "expectedSha256", "policyVersion",
  "definitionEpoch", "traceId", "state", "engine", "attemptCount",
  "completedAt", "verdictPublishedAt"
) VALUES (
  '40000000-0000-4000-8000-000000000009',
  '30000000-0000-4000-8000-000000000009', 'prod/assets/nine', repeat('f', 64),
  1, '27412', gen_random_uuid(), 'FAILED', 'clamav', 1, now(), now());

SELECT pg_temp.expect_rejected(
  'the restored guard refuses to reopen a failed attempt',
  $$UPDATE file_scan_attempt SET "state" = 'CLAIMED', "attemptCount" = 2,
      "leaseToken" = gen_random_uuid(), "leaseExpiresAt" = now() + interval '5 minutes',
      "completedAt" = NULL, "verdictPublishedAt" = NULL
    WHERE "id" = '40000000-0000-4000-8000-000000000009'$$,
  'P0001');

SELECT pg_temp.expect_rejected(
  'the restored guard refuses to close a failed attempt',
  $$UPDATE file_scan_attempt SET "state" = 'REJECTED',
      "rejectionCode" = 'RETRY_BUDGET_EXHAUSTED', "completedAt" = now(),
      "verdictPublishedAt" = NULL
    WHERE "id" = '40000000-0000-4000-8000-000000000009'$$,
  'P0001');

SELECT pg_temp.expect_rejected(
  'the restored guard still guards requestedAt',
  $$UPDATE file_scan_attempt SET "requestedAt" = now()
    WHERE "id" = '40000000-0000-4000-8000-000000000009'$$,
  'P0001');
