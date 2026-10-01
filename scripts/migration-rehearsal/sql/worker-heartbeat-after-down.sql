-- What rolling back RecordWorkerHeartbeat must leave: no heartbeat table or
-- view, and everything the earlier migrations made exactly as it was.
SET search_path TO "sto_info_worker", "sto_info_app", public;

\pset tuples_only on
\pset format unaligned

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
  'the table and the view are gone',
  $$SELECT to_regclass('sto_info_worker.worker_heartbeat') IS NULL
       AND to_regclass('sto_info_worker.worker_heartbeat_status') IS NULL$$);

SELECT pg_temp.expect_true(
  'the scan usage views are untouched',
  $$SELECT to_regclass('sto_info_worker.scan_usage') IS NOT NULL
       AND to_regclass('sto_info_worker.scan_engine_status') IS NOT NULL
       AND has_table_privilege('rehearsal_backend',
             'sto_info_worker.scan_usage', 'SELECT')$$);

SELECT pg_temp.expect_true(
  'the backend keeps the schema grant RecordScanUsage gave it',
  $$SELECT has_schema_privilege('rehearsal_backend', 'sto_info_worker',
             'USAGE')$$);

SELECT pg_temp.expect_true(
  'the attempt table is still there',
  $$SELECT to_regclass('sto_info_worker.file_scan_attempt') IS NOT NULL$$);
