-- What rolling back RecordScanUsage must leave: the attempt table as the first
-- migration made it, with every row still in it and its guard still working.
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
  'both views are gone',
  $$SELECT to_regclass('sto_info_worker.scan_usage') IS NULL
       AND to_regclass('sto_info_worker.scan_engine_status') IS NULL$$);

SELECT pg_temp.expect_true(
  'both columns are gone',
  $$SELECT NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'sto_info_worker'
        AND table_name = 'file_scan_attempt'
        AND column_name IN ('requestedAt', 'definitionsBuiltAt'))$$);

SELECT pg_temp.expect_true(
  'the backend no longer has the schema grant',
  $$SELECT NOT has_schema_privilege('rehearsal_backend', 'sto_info_worker',
             'USAGE')$$);

SELECT pg_temp.expect_true(
  'every attempt survived the rollback',
  $$SELECT count(*) = 7 FROM file_scan_attempt$$);

SELECT pg_temp.expect_rejected(
  'the restored guard still refuses a change to what was asked',
  $$UPDATE file_scan_attempt SET "traceId" = gen_random_uuid()
    WHERE "id" = '20000000-0000-4000-8000-000000000006'$$,
  'P0001');

SELECT pg_temp.expect_rejected(
  'the restored guard still refuses a change to a finished answer',
  $$UPDATE file_scan_attempt SET "engineVersion" = 'forged'
    WHERE "id" = '20000000-0000-4000-8000-000000000001'$$,
  'P0001');
