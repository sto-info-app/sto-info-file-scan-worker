-- Seven attempts spread over the three windows the usage view reports.
--
-- Every figure the assertions expect is worked out from these rows by hand,
-- so each row is annotated with what it contributes. Times are relative to
-- now(), because the view's windows are.
--
--   1  asset 1  24h  initial  CLEAN     scan 2 s   wait 13 s
--   2  asset 1  24h  re-scan  CLEAN     scan 1 s   wait 3 s    claimed 3 times
--   3  asset 2  24h  initial  INFECTED  scan 4 s   wait 4 s
--   4  asset 3  7d   initial  UNSUPPORTED_PAYLOAD  scan 0.5 s  wait 0.5 s
--   5  asset 4  30d  initial  FAILED    never started, queued before it was recorded
--   6  asset 5  24h  initial  SCANNING  the latest attempt, so the engine status
--   7  asset 6  30d  re-scan  CLEAN     a campaign's, and the asset's only attempt
SET search_path TO "sto_info_worker", "sto_info_app", public;

INSERT INTO "sto_info_app"."file_asset" ("id") VALUES
  ('10000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000003'),
  ('10000000-0000-4000-8000-000000000004'),
  ('10000000-0000-4000-8000-000000000005'),
  ('10000000-0000-4000-8000-000000000006');

INSERT INTO "sto_info_worker"."file_scan_attempt" (
  "id", "assetId", "objectKey", "expectedSha256", "observedSha256",
  "policyVersion", "definitionEpoch", "campaignId", "traceId", "state",
  "rejectionCode", "engine", "engineVersion", "signatureVersion",
  "definitionsBuiltAt", "attemptCount", "leaseToken", "leaseExpiresAt",
  "requestedAt", "createdAt", "startedAt", "completedAt"
) VALUES
  ('20000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000001', 'test/assets/1',
   repeat('a', 64), repeat('a', 64), 1, '100', NULL,
   gen_random_uuid(), 'CLEAN', NULL, 'clamav', '1.4.2', '100',
   now() - interval '1 day', 1, NULL, NULL,
   now() - interval '1 hour' - interval '10 seconds',
   now() - interval '1 hour',
   now() - interval '1 hour' + interval '1 second',
   now() - interval '1 hour' + interval '3 seconds'),
  ('20000000-0000-4000-8000-000000000002',
   '10000000-0000-4000-8000-000000000001', 'test/assets/1',
   repeat('a', 64), repeat('a', 64), 1, '101', NULL,
   gen_random_uuid(), 'CLEAN', NULL, 'clamav', '1.4.2', '101',
   now() - interval '12 hours', 3, NULL, NULL,
   now() - interval '30 minutes' - interval '2 seconds',
   now() - interval '30 minutes',
   now() - interval '30 minutes',
   now() - interval '30 minutes' + interval '1 second'),
  ('20000000-0000-4000-8000-000000000003',
   '10000000-0000-4000-8000-000000000002', 'test/assets/2',
   repeat('b', 64), repeat('b', 64), 1, '100', NULL,
   gen_random_uuid(), 'REJECTED', 'INFECTED', 'clamav', '1.4.2', '100',
   now() - interval '1 day', 1, NULL, NULL,
   now() - interval '2 hours',
   now() - interval '2 hours',
   now() - interval '2 hours',
   now() - interval '2 hours' + interval '4 seconds'),
  ('20000000-0000-4000-8000-000000000004',
   '10000000-0000-4000-8000-000000000003', 'test/assets/3',
   repeat('c', 64), repeat('c', 64), 1, '99', NULL,
   gen_random_uuid(), 'REJECTED', 'UNSUPPORTED_PAYLOAD', 'clamav', '1.4.2',
   '99', now() - interval '4 days', 1, NULL, NULL,
   now() - interval '3 days',
   now() - interval '3 days',
   now() - interval '3 days',
   now() - interval '3 days' + interval '500 milliseconds'),
  ('20000000-0000-4000-8000-000000000005',
   '10000000-0000-4000-8000-000000000004', 'test/assets/4',
   repeat('d', 64), NULL, 1, '98', NULL,
   gen_random_uuid(), 'FAILED', NULL, 'clamav', NULL, NULL,
   NULL, 1, NULL, NULL,
   NULL,
   now() - interval '10 days',
   NULL,
   now() - interval '10 days' + interval '1 minute'),
  ('20000000-0000-4000-8000-000000000006',
   '10000000-0000-4000-8000-000000000005', 'test/assets/5',
   repeat('e', 64), NULL, 1, '27500', NULL,
   gen_random_uuid(), 'SCANNING', NULL, 'clamav', '1.4.3', '27500',
   now() - interval '3 hours', 1,
   '30000000-0000-4000-8000-000000000006', now() + interval '5 minutes',
   now() - interval '5 minutes',
   now() - interval '5 minutes',
   now() - interval '5 minutes',
   NULL),
  ('20000000-0000-4000-8000-000000000007',
   '10000000-0000-4000-8000-000000000006', 'test/assets/6',
   repeat('f', 64), repeat('f', 64), 1, '90',
   '40000000-0000-4000-8000-000000000007',
   gen_random_uuid(), 'CLEAN', NULL, 'clamav', '1.4.1', '90',
   now() - interval '21 days', 1, NULL, NULL,
   now() - interval '20 days',
   now() - interval '20 days',
   now() - interval '20 days',
   now() - interval '20 days' + interval '2 seconds');
