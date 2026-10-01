-- Three workers, as the heartbeat table would hold them.
--
--   worker-running   beat a moment ago, consuming, one job in hand
--   worker-paused    beat a moment ago, paused for twelve minutes, scanner gone
--   worker-gone      last beat a day and a half ago, and never said STOPPING
--
-- The last is what the prune statement exists for; the service statements in
-- race-worker-heartbeat.sh remove it and must leave the other two.
SET search_path TO "sto_info_worker", public;

INSERT INTO "worker_heartbeat" (
  "workerId", "state", "pauseReason", "definitionsVersion",
  "definitionsBuiltAt", "jobsInHand", "startedAt", "beatAt", "pausedSince"
) VALUES
  ('worker-running', 'RUNNING', NULL, '27412', now() - interval '6 hours',
   1, now() - interval '2 hours', now() - interval '5 seconds', NULL),
  ('worker-paused', 'PAUSED', 'SCANNER_UNREACHABLE', NULL, NULL,
   0, now() - interval '3 hours', now() - interval '10 seconds',
   now() - interval '12 minutes'),
  ('worker-gone', 'RUNNING', NULL, '27400', now() - interval '3 days',
   0, now() - interval '4 days', now() - interval '36 hours', NULL);
