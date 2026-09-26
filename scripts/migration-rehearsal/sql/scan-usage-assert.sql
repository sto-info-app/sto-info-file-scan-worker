SET search_path TO "sto_info_worker", "sto_info_app", public;

\pset tuples_only on
\pset format unaligned

-- The same three helpers as the attempt suite. Temporary functions last only
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
-- The usage figures, worked out by hand from the seed
-- ===========================================================================

SELECT pg_temp.expect_true(
  'one row for each window, and only three',
  $$SELECT array_agg("window" ORDER BY "position") = ARRAY['24h', '7d', '30d']
      FROM scan_usage$$);

SELECT pg_temp.expect_true(
  'the last 24 hours: counts',
  $$SELECT ("initialScans", "rescans", "retriedScans", "retries", "clean",
            "infected", "unsupported", "failed", "inProgress")
         = (3, 1, 1, 2, 2, 1, 0, 0, 1)
      FROM scan_usage WHERE "window" = '24h'$$);

SELECT pg_temp.expect_true(
  'the last 24 hours: scan time, which the unfinished attempt is not part of',
  $$SELECT ("scanMedianMs", "scanP95Ms", "scanMaxMs") = (2000, 3800, 4000)
      FROM scan_usage WHERE "window" = '24h'$$);

SELECT pg_temp.expect_true(
  'the last 24 hours: wait runs from the request, not from the claim',
  $$SELECT ("waitMedianMs", "waitP95Ms", "waitMaxMs") = (4000, 12100, 13000)
      FROM scan_usage WHERE "window" = '24h'$$);

SELECT pg_temp.expect_true(
  'the last 7 days add the unsupported payload',
  $$SELECT ("initialScans", "rescans", "unsupported", "scanMedianMs",
            "waitMedianMs") = (4, 1, 1, 1500, 3500)
      FROM scan_usage WHERE "window" = '7d'$$);

SELECT pg_temp.expect_true(
  'the last 30 days add the failure and count a campaign attempt as a re-scan',
  $$SELECT ("initialScans", "rescans", "clean", "failed", "scanMedianMs",
            "waitMedianMs") = (5, 2, 3, 1, 2000, 3000)
      FROM scan_usage WHERE "window" = '30d'$$);

SELECT pg_temp.expect_true(
  'an attempt queued before requestedAt existed has no wait, rather than a wrong one',
  $$SELECT "waitMaxMs" = 13000 FROM scan_usage WHERE "window" = '30d'$$);

-- A window with nothing in it still has a row, and counts nothing rather than
-- one. A LEFT JOIN with count(*) would have counted the empty row it makes.
BEGIN;
DELETE FROM "sto_info_worker"."file_scan_attempt";
SELECT pg_temp.expect_true(
  'an empty table gives three rows of zeros, and no latency',
  $$SELECT count(*) = 3
           AND bool_and("initialScans" = 0 AND "rescans" = 0
                        AND "inProgress" = 0 AND "retries" = 0)
           AND bool_and("scanMedianMs" IS NULL AND "waitMaxMs" IS NULL)
      FROM scan_usage$$);
SELECT pg_temp.expect_true(
  'an empty table has no engine status',
  $$SELECT count(*) = 0 FROM scan_engine_status$$);
ROLLBACK;


-- ===========================================================================
-- The engine status
-- ===========================================================================

SELECT pg_temp.expect_true(
  'the engine status is what the latest attempt reported',
  $$SELECT ("engine", "engineVersion", "signatureVersion")
         = ('clamav', '1.4.3', '27500')
           AND "definitionsBuiltAt" < now() - interval '2 hours'
      FROM scan_engine_status$$);


-- ===========================================================================
-- What the backend can see
-- ===========================================================================

SELECT pg_temp.expect_true(
  'the backend may read both views',
  $$SELECT has_table_privilege('rehearsal_backend',
             'sto_info_worker.scan_usage', 'SELECT')
       AND has_table_privilege('rehearsal_backend',
             'sto_info_worker.scan_engine_status', 'SELECT')
       AND has_schema_privilege('rehearsal_backend', 'sto_info_worker', 'USAGE')$$);

SELECT pg_temp.expect_true(
  'the backend may not read the attempts themselves',
  $$SELECT NOT has_table_privilege('rehearsal_backend',
             'sto_info_worker.file_scan_attempt', 'SELECT')$$);

SELECT pg_temp.expect_true(
  'the backend may not write the views',
  $$SELECT NOT has_table_privilege('rehearsal_backend',
             'sto_info_worker.scan_usage', 'INSERT, UPDATE, DELETE')$$);

SELECT pg_temp.expect_true(
  'neither view carries anything that identifies an asset, a file or an upload',
  $$SELECT NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'sto_info_worker'
        AND table_name IN ('scan_usage', 'scan_engine_status')
        AND column_name IN ('id', 'assetId', 'objectKey', 'objectVersion',
                            'expectedSha256', 'observedSha256', 'traceId',
                            'campaignId', 'failureReason',
                            'detectedContentType'))$$);

-- Read through the role itself, not only asked about. A privilege check that
-- passes while the read fails would be the check lying. The helpers above
-- belong to this session's owner, so these fail by dividing by zero instead:
-- a wrong count stops the run as surely as a refused read does.
SET ROLE "rehearsal_backend";
SELECT 1 / (count(*) = 3)::int FROM "sto_info_worker"."scan_usage";
SELECT 1 / (count(*) = 1)::int FROM "sto_info_worker"."scan_engine_status";
RESET ROLE;


-- ===========================================================================
-- The two new columns are evidence
-- ===========================================================================

SELECT pg_temp.expect_rejected(
  'requestedAt cannot change, even on an open attempt',
  $$UPDATE file_scan_attempt SET "requestedAt" = now()
    WHERE "id" = '20000000-0000-4000-8000-000000000006'$$,
  'P0001');

SELECT pg_temp.expect_rejected(
  'definitionsBuiltAt cannot change once the attempt has finished',
  $$UPDATE file_scan_attempt SET "definitionsBuiltAt" = now()
    WHERE "id" = '20000000-0000-4000-8000-000000000001'$$,
  'P0001');

SELECT pg_temp.expect_accepted(
  'definitionsBuiltAt may change while the attempt is open, as a re-claim does',
  $$UPDATE file_scan_attempt SET "definitionsBuiltAt" = now() - interval '3 hours'
    WHERE "id" = '20000000-0000-4000-8000-000000000006'$$);

SELECT pg_temp.expect_rejected(
  'the fields guarded before this migration are still guarded',
  $$UPDATE file_scan_attempt SET "signatureVersion" = 'forged'
    WHERE "id" = '20000000-0000-4000-8000-000000000001'$$,
  'P0001');
