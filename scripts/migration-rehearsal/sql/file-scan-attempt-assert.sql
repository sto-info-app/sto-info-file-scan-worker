SET search_path TO "sto_info_worker", "sto_info_app", public;

-- Quiet: every helper returns void, so the result tables carry no information.
\pset tuples_only on
\pset format unaligned


-- Every assertion below is a deliberate attempt to break a rule the migration
-- claims the database enforces. `expect_rejected` fails the run if it gets
-- through, and it names the SQLSTATE it expects rather than accepting any
-- failure — a test that passes because the statement had a typo in it is
-- worse than no test.
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
-- The idempotency key
-- ===========================================================================

-- ADR-0006 decision 4, written as a constraint. This is the assertion the
-- whole suite exists for: with an ordinary UNIQUE the two null objectVersions
-- would be different from each other and this insert would be accepted, and
-- nothing about the migration text would look wrong.
SELECT pg_temp.expect_rejected(
  'a second attempt for the same asset, version, policy and epoch',
  $$INSERT INTO "file_scan_attempt" (
      "assetId", "objectKey", "expectedSha256", "policyVersion",
      "definitionEpoch", "traceId", "state", "engine")
    VALUES ('4f1a0e2c-8b3d-4a59-9c21-6f7e5d4c3b2a', 'prod/assets/other',
            repeat('b', 64), 1, '27412',
            '0b5d4f6a-1c2e-4d3b-8a7f-9e8d7c6b5a40', 'CLAIMED', 'clamav')$$,
  '23505');

-- A signature update is a new question, not a duplicate of the old one.
SELECT pg_temp.expect_accepted(
  'the same asset again after the signatures moved on',
  $$INSERT INTO "file_scan_attempt" (
      "assetId", "objectKey", "expectedSha256", "policyVersion",
      "definitionEpoch", "traceId", "state", "engine")
    VALUES ('4f1a0e2c-8b3d-4a59-9c21-6f7e5d4c3b2a',
            'prod/assets/4f1a0e2c-8b3d-4a59-9c21-6f7e5d4c3b2a',
            repeat('a', 64), 1, '27413',
            '0b5d4f6a-1c2e-4d3b-8a7f-9e8d7c6b5a40', 'CLAIMED', 'clamav')$$);

-- So is a policy change.
SELECT pg_temp.expect_accepted(
  'the same asset again under a new policy',
  $$INSERT INTO "file_scan_attempt" (
      "assetId", "objectKey", "expectedSha256", "policyVersion",
      "definitionEpoch", "traceId", "state", "engine")
    VALUES ('4f1a0e2c-8b3d-4a59-9c21-6f7e5d4c3b2a',
            'prod/assets/4f1a0e2c-8b3d-4a59-9c21-6f7e5d4c3b2a',
            repeat('a', 64), 2, '27412',
            '0b5d4f6a-1c2e-4d3b-8a7f-9e8d7c6b5a40', 'CLAIMED', 'clamav')$$);


-- ===========================================================================
-- What a row is allowed to say
-- ===========================================================================

-- Written as an insert rather than an update: the write-once trigger refuses
-- to let the expected hash change at all, so an update would be rejected by
-- the trigger and would prove nothing about the check constraint.
SELECT pg_temp.expect_rejected(
  'an expected hash that is not lowercase hexadecimal',
  $$INSERT INTO "file_scan_attempt" (
      "assetId", "objectKey", "expectedSha256", "policyVersion",
      "definitionEpoch", "traceId", "state", "engine")
    VALUES ('4f1a0e2c-8b3d-4a59-9c21-6f7e5d4c3b2a', 'prod/assets/uppercase',
            repeat('A', 64), 9, '27412',
            '0b5d4f6a-1c2e-4d3b-8a7f-9e8d7c6b5a40', 'CLAIMED', 'clamav')$$,
  '23514');

SELECT pg_temp.expect_rejected(
  'an observed hash that is not lowercase hexadecimal',
  $$UPDATE "file_scan_attempt" SET "observedSha256" = 'not a hash'
    WHERE "id" = '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f'$$,
  '23514');

-- The one that matters most. A clean attempt must have measured the bytes it
-- was asked about; service code could check this, and a constraint means no
-- future code path can forget to.
SELECT pg_temp.expect_rejected(
  'a clean attempt whose observed hash is not the expected one',
  $$UPDATE "file_scan_attempt"
    SET "state" = 'CLEAN', "observedSha256" = repeat('c', 64),
        "completedAt" = now(), "leaseToken" = NULL, "leaseExpiresAt" = NULL
    WHERE "id" = '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f'$$,
  '23514');

SELECT pg_temp.expect_rejected(
  'a clean attempt that measured nothing at all',
  $$UPDATE "file_scan_attempt"
    SET "state" = 'CLEAN', "completedAt" = now(),
        "leaseToken" = NULL, "leaseExpiresAt" = NULL
    WHERE "id" = '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f'$$,
  '23514');

SELECT pg_temp.expect_rejected(
  'a refusal with no reason',
  $$UPDATE "file_scan_attempt"
    SET "state" = 'REJECTED', "completedAt" = now(),
        "leaseToken" = NULL, "leaseExpiresAt" = NULL
    WHERE "id" = '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f'$$,
  '23514');

SELECT pg_temp.expect_rejected(
  'a reason on an attempt that did not refuse',
  $$UPDATE "file_scan_attempt" SET "rejectionCode" = 'INFECTED'
    WHERE "id" = '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f'$$,
  '23514');

SELECT pg_temp.expect_rejected(
  'a negative byte count',
  $$UPDATE "file_scan_attempt" SET "byteSize" = -1
    WHERE "id" = '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f'$$,
  '23514');

SELECT pg_temp.expect_rejected(
  'a negative attempt count',
  $$UPDATE "file_scan_attempt" SET "attemptCount" = -1
    WHERE "id" = '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f'$$,
  '23514');

-- Half a lease is not a lease. A token with no expiry would never lapse, so
-- the attempt could never be reclaimed by anybody.
SELECT pg_temp.expect_rejected(
  'a lease token with no expiry',
  $$UPDATE "file_scan_attempt" SET "leaseExpiresAt" = NULL
    WHERE "id" = '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f'$$,
  '23514');

SELECT pg_temp.expect_rejected(
  'an expiry with no lease token',
  $$UPDATE "file_scan_attempt" SET "leaseToken" = NULL
    WHERE "id" = '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f'$$,
  '23514');

SELECT pg_temp.expect_rejected(
  'an unfinished attempt with a completion time',
  $$UPDATE "file_scan_attempt" SET "completedAt" = now()
    WHERE "id" = '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f'$$,
  '23514');

SELECT pg_temp.expect_rejected(
  'a published verdict for an attempt that never finished',
  $$UPDATE "file_scan_attempt" SET "verdictPublishedAt" = now()
    WHERE "id" = '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f'$$,
  '23514');


-- ===========================================================================
-- The referential rules
-- ===========================================================================

SELECT pg_temp.expect_rejected(
  'an attempt against an asset that does not exist',
  $$INSERT INTO "file_scan_attempt" (
      "assetId", "objectKey", "expectedSha256", "policyVersion",
      "definitionEpoch", "traceId", "state", "engine")
    VALUES ('99999999-9999-4999-8999-999999999999', 'prod/assets/nowhere',
            repeat('a', 64), 1, '27412',
            '0b5d4f6a-1c2e-4d3b-8a7f-9e8d7c6b5a40', 'CLAIMED', 'clamav')$$,
  '23503');

-- ADR-0015's main new risk, closed. Until FC-010 the two tables were
-- unrelated and nothing enforced the relationship at all.
SELECT pg_temp.expect_rejected(
  'deleting an asset that an attempt still points at',
  $$DELETE FROM "sto_info_app"."file_asset"
    WHERE "id" = '4f1a0e2c-8b3d-4a59-9c21-6f7e5d4c3b2a'$$,
  '23503');

SELECT pg_temp.expect_accepted(
  'deleting an asset nothing points at',
  $$DELETE FROM "sto_info_app"."file_asset"
    WHERE "id" = '5a2b1c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'$$);


-- ===========================================================================
-- A finished attempt is evidence
-- ===========================================================================

-- Finish it honestly first, so the write-once rules have something to guard.
SELECT pg_temp.expect_accepted(
  'completing the attempt as clean',
  $$UPDATE "file_scan_attempt"
    SET "state" = 'CLEAN', "observedSha256" = repeat('a', 64),
        "byteSize" = 128, "detectedContentType" = 'image/png',
        "completedAt" = now(), "leaseToken" = NULL, "leaseExpiresAt" = NULL
    WHERE "id" = '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f'$$);

SELECT pg_temp.expect_rejected(
  'changing the verdict afterwards',
  $$UPDATE "file_scan_attempt" SET "state" = 'REJECTED'
    WHERE "id" = '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f'$$,
  'P0001');

SELECT pg_temp.expect_rejected(
  'changing the hash it cleared',
  $$UPDATE "file_scan_attempt" SET "observedSha256" = repeat('d', 64)
    WHERE "id" = '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f'$$,
  'P0001');

SELECT pg_temp.expect_rejected(
  'changing which scanner answered',
  $$UPDATE "file_scan_attempt" SET "engine" = 'something-else'
    WHERE "id" = '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f'$$,
  'P0001');

SELECT pg_temp.expect_rejected(
  'changing when it finished',
  $$UPDATE "file_scan_attempt" SET "completedAt" = now() + interval '1 day'
    WHERE "id" = '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f'$$,
  'P0001');

-- Giving a finished attempt a lease would let a stale worker present a token
-- and overwrite the answer, which is the whole thing the lease guards against.
SELECT pg_temp.expect_rejected(
  'giving a finished attempt a lease again',
  $$UPDATE "file_scan_attempt"
    SET "leaseToken" = '22222222-2222-4222-8222-222222222222',
        "leaseExpiresAt" = now() + interval '5 minutes'
    WHERE "id" = '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f'$$,
  'P0001');


-- ===========================================================================
-- What the request said cannot change, finished or not
-- ===========================================================================

SELECT pg_temp.expect_rejected(
  'moving an attempt to a different asset',
  $$UPDATE "file_scan_attempt"
    SET "assetId" = '5a2b1c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
    WHERE "id" = '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f'$$,
  'P0001');

SELECT pg_temp.expect_rejected(
  'changing which object was asked about',
  $$UPDATE "file_scan_attempt" SET "objectKey" = 'prod/assets/elsewhere'
    WHERE "id" = '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f'$$,
  'P0001');

SELECT pg_temp.expect_rejected(
  'changing which signatures the attempt is keyed on',
  $$UPDATE "file_scan_attempt" SET "definitionEpoch" = '1'
    WHERE "id" = '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f'$$,
  'P0001');

SELECT pg_temp.expect_rejected(
  'changing the trace the request carried',
  $$UPDATE "file_scan_attempt"
    SET "traceId" = '33333333-3333-4333-8333-333333333333'
    WHERE "id" = '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f'$$,
  'P0001');


-- ===========================================================================
-- Publishing a verdict, once
-- ===========================================================================

SELECT pg_temp.expect_accepted(
  'recording that the verdict reached the queue',
  $$UPDATE "file_scan_attempt" SET "verdictPublishedAt" = now()
    WHERE "id" = '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f'$$);

SELECT pg_temp.expect_rejected(
  'recording it a second time',
  $$UPDATE "file_scan_attempt"
    SET "verdictPublishedAt" = now() + interval '1 minute'
    WHERE "id" = '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f'$$,
  'P0001');


-- ===========================================================================
-- Properties of the whole table
-- ===========================================================================

-- The recovery ADR-0006 asks for reads exactly this, so it has an index of
-- its own rather than a sequential scan over every attempt ever made.
SELECT pg_temp.expect_true(
  'unpublished finished verdicts are findable',
  $$SELECT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'sto_info_worker'
        AND indexname = 'IDX_file_scan_attempt_unpublished')$$);

SELECT pg_temp.expect_true(
  'no attempt claims to be clean about bytes it did not measure',
  $$SELECT NOT EXISTS (
      SELECT 1 FROM "file_scan_attempt"
      WHERE "state" = 'CLEAN' AND "observedSha256" IS DISTINCT FROM "expectedSha256")$$);

SELECT pg_temp.expect_true(
  'no finished attempt is still holding a lease',
  $$SELECT NOT EXISTS (
      SELECT 1 FROM "file_scan_attempt"
      WHERE "completedAt" IS NOT NULL AND "leaseToken" IS NOT NULL)$$);

-- The worker's whole vocabulary. AVAILABLE is not in it, and this is the
-- assertion that says so: ADR-0015 decision 3 as a property of the schema
-- rather than as a rule somebody has to remember.
SELECT pg_temp.expect_true(
  'the attempt states include nothing that could publish anything',
  $$SELECT NOT EXISTS (
      SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'sto_info_worker'
        AND t.typname = 'file_scan_attempt_state_enum'
        AND e.enumlabel IN ('AVAILABLE', 'PUBLISHED'))$$);

SELECT pg_temp.expect_true(
  'this repository created nothing in the backend schema',
  $$SELECT (
      SELECT count(*) FROM information_schema.tables
      WHERE table_schema = 'sto_info_app') = 1$$);
