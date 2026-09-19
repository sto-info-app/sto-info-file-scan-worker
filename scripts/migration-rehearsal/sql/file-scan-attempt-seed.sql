-- Two assets and one attempt against the first of them.
--
-- The second exists so that the foreign key can be shown to accept a real
-- asset as well as reject an invented one; a test that only ever proves a
-- rejection cannot tell a working key from a broken table.
SET search_path TO "sto_info_worker", "sto_info_app", public;

INSERT INTO "sto_info_app"."file_asset" ("id") VALUES
  ('4f1a0e2c-8b3d-4a59-9c21-6f7e5d4c3b2a'),
  ('5a2b1c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d');

INSERT INTO "sto_info_worker"."file_scan_attempt" (
  "id", "assetId", "objectKey", "expectedSha256", "policyVersion",
  "definitionEpoch", "traceId", "state", "engine", "attemptCount",
  "leaseToken", "leaseExpiresAt"
) VALUES (
  '7c9e1b2d-3a4f-4e5b-9c8d-1a2b3c4d5e6f',
  '4f1a0e2c-8b3d-4a59-9c21-6f7e5d4c3b2a',
  'prod/assets/4f1a0e2c-8b3d-4a59-9c21-6f7e5d4c3b2a',
  repeat('a', 64), 1, '27412',
  '0b5d4f6a-1c2e-4d3b-8a7f-9e8d7c6b5a40',
  'SCANNING', 'clamav', 1,
  '11111111-1111-4111-8111-111111111111', now() + interval '5 minutes'
);
