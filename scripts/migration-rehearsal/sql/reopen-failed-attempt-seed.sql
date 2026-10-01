-- Five finished attempts, one of each kind the reopening rules care about.
--
--   1  asset 1  FAILED    claimed once, RETRY sent        -> may be reopened
--   2  asset 2  FAILED    claimed three times, RETRY sent -> budget spent, refused
--   3  asset 3  CLEAN     sent                            -> final
--   4  asset 4  REJECTED  INFECTED, sent                  -> final
--   5  asset 5  FAILED    claimed once, RETRY sent        -> raced by ten workers
SET search_path TO "sto_info_worker", "sto_info_app", public;

INSERT INTO "sto_info_app"."file_asset" ("id") VALUES
  ('30000000-0000-4000-8000-000000000001'),
  ('30000000-0000-4000-8000-000000000002'),
  ('30000000-0000-4000-8000-000000000003'),
  ('30000000-0000-4000-8000-000000000004'),
  ('30000000-0000-4000-8000-000000000005');

INSERT INTO "file_scan_attempt" (
  "id", "assetId", "objectKey", "expectedSha256", "observedSha256",
  "policyVersion", "definitionEpoch", "traceId", "state", "rejectionCode",
  "failureReason", "engine", "engineVersion", "signatureVersion",
  "attemptCount", "requestedAt", "startedAt", "completedAt",
  "verdictPublishedAt"
) VALUES
  ('40000000-0000-4000-8000-000000000001',
   '30000000-0000-4000-8000-000000000001', 'prod/assets/one',
   repeat('a', 64), NULL, 1, '27412', gen_random_uuid(), 'FAILED', NULL,
   'The scanner closed the connection unanswered', 'clamav', '1.4.3', '27412',
   1, now() - interval '10 minutes', now() - interval '9 minutes',
   now() - interval '8 minutes', now() - interval '8 minutes'),
  ('40000000-0000-4000-8000-000000000002',
   '30000000-0000-4000-8000-000000000002', 'prod/assets/two',
   repeat('b', 64), NULL, 1, '27412', gen_random_uuid(), 'FAILED', NULL,
   'The scanner closed the connection unanswered', 'clamav', '1.4.3', '27412',
   3, now() - interval '30 minutes', now() - interval '6 minutes',
   now() - interval '5 minutes', now() - interval '5 minutes'),
  ('40000000-0000-4000-8000-000000000003',
   '30000000-0000-4000-8000-000000000003', 'prod/assets/three',
   repeat('c', 64), repeat('c', 64), 1, '27412', gen_random_uuid(), 'CLEAN',
   NULL, NULL, 'clamav', '1.4.3', '27412',
   1, now() - interval '10 minutes', now() - interval '9 minutes',
   now() - interval '8 minutes', now() - interval '8 minutes'),
  ('40000000-0000-4000-8000-000000000004',
   '30000000-0000-4000-8000-000000000004', 'prod/assets/four',
   repeat('d', 64), repeat('d', 64), 1, '27412', gen_random_uuid(), 'REJECTED',
   'INFECTED', 'Eicar-Test-Signature FOUND', 'clamav', '1.4.3', '27412',
   1, now() - interval '10 minutes', now() - interval '9 minutes',
   now() - interval '8 minutes', now() - interval '8 minutes'),
  ('40000000-0000-4000-8000-000000000005',
   '30000000-0000-4000-8000-000000000005', 'prod/assets/five',
   repeat('e', 64), NULL, 1, '27412', gen_random_uuid(), 'FAILED', NULL,
   'The scanner closed the connection unanswered', 'clamav', '1.4.3', '27412',
   1, now() - interval '10 minutes', now() - interval '9 minutes',
   now() - interval '8 minutes', now() - interval '8 minutes');
