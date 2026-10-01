# Environment variables (Worker)

## Where they live

`config/environments/.env.example` is the template, and it is the only one.
There used to be two — a second at the repository root — and they disagreed:
the root file named `R2_ENDPOINT` and `DATABASE_URL`, this one named
`CLOUDFLARE_R2_ENDPOINT` and `DB_HOST`. The code read the first set and
`ConfigCheckService` validated the second, so the startup check passed on
variables nothing used while the ones that mattered went unchecked. A startup
probe that reports healthy while the R2 credentials it never looked at are
absent is worse than no probe. FC-010 removed the root file.

`config/environments/.env` is the active local file and is git-ignored. The
app reads it at startup via the `dotenv` call in `src/main.ts`.

Two things validate the environment, and they check different kinds of thing:

- **`ConfigCheckService`** checks that each required variable is present and
  the right shape.
- **`readWorkerSettings`** checks the relationships between them — that a
  heartbeat is shorter than a lease, that the schema matches the migrations,
  that the contract version is one this build supports.

Both run before anything connects to anything.

## Application

- `NODE_ENV`: `local` | `dev` | `staging` | `prod`
- `LOG_LEVEL`: `error` | `warn` | `log` | `debug` | `verbose`, optionally
  comma-separated
- `APP_PORT`: the port the health probes listen on (default `3000`)
- `APP_TITLE`

## Database

The same database as the backend, in a schema of this repository's own.

- `DB_TYPE`: `postgres`
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USERNAME`
- `DB_SCHEMA`: **must be `sto_info_worker`.** The migrations name the schema
  in their SQL and the worker refuses to start if the two disagree.
- `DB_SSL_REJECT_UNAUTHORIZED`: `true` | `false`
- `TYPEORM_LOGGING`: `true` | `false`
- `TYPEORM_ENTITIES`, `TYPEORM_MIGRATIONS`: globs relative to the built root

- `BACKEND_DB_ROLE`: the database role the **backend** connects as. Read
  only by the migrations, which grant it `SELECT` on the two scan usage views
  and the worker heartbeat view, and nothing else in this schema. A migration run without it refuses. The
  running worker does not read it.

**There is no `TYPEORM_SYNCHRONIZE`.** Synchronise against a database shared
with another application will drop that application's columns to make the
schema match these entities. The worker refuses to start when it is set.

## Redis and the contract

- `REDIS_URL`
- `QUEUE_PREFIX`: default `bull:sto-info:`
- `FILE_SCAN_SCHEMA_VERSION`: the contract version this process speaks.
  Default 2. It must be one the build supports, or the worker refuses to
  start — ADR-0006 decision 3. **Version 1 is no longer supported**: it
  carried no declared content type, so a version 1 message would be bytes
  with nothing to check them against (ADR-0020). Nothing has ever been
  deployed, so there are no version 1 messages anywhere to strand.

The queue names are fixed by the contract and are deliberately not
configurable. A name that differed between the two repositories would look
like an idle worker rather than a misconfiguration.

## AWS Secrets Manager

- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`
- `AWS_SECRET_NAME`

The secret is JSON and must carry exactly these three:

- `dbPassword`
- `cloudflareR2QuarantineReadKey`
- `cloudflareR2QuarantineReadSecret`

The R2 pair is named `Read` because that is all the token behind it may do.
See `security.md`.

## Cloudflare R2

- `CLOUDFLARE_R2_ENDPOINT`: the account's S3-compatible endpoint
- `CLOUDFLARE_R2_QUARANTINE_BUCKET_NAME`: the private quarantine bucket

One bucket serves every environment, with the environment as the first
segment of each key — [ADR-0017](../../../Plans/Fleets/ADR/0017-one-quarantine-bucket-with-environment-prefixes.md).
There is no variable for the delivery bucket, because the worker has no
credential for it.

## Scanning

- `SCAN_CONCURRENCY`: how many objects at once. Default 1; ClamAV's memory is
  the binding constraint, and ADR-0005 has the sizing.
- `MAX_FILE_BYTES`: default 10 MiB. Larger objects are refused, not truncated.
- `SCAN_TIMEOUT_MS`: default 120,000.
- `SCAN_LEASE_MS`: default 300,000. How long a claim holds an attempt before
  another worker may take it.
- `SCAN_HEARTBEAT_MS`: default 30,000.
- `SCAN_MAX_ATTEMPTS`: default 3. Beyond this an attempt is refused with
  `RETRY_BUDGET_EXHAUSTED`, so the backend hears a final answer rather than
  leaving an upload in limbo.

`SCAN_HEARTBEAT_MS` and `SCAN_TIMEOUT_MS` must both be shorter than
`SCAN_LEASE_MS`. A heartbeat slower than the lease renews nothing, and a scan
that outlasts its own claim will have its answer discarded. The worker checks
both at startup.

## ClamAV

- `CLAMAV_HOST`: default `127.0.0.1`
- `CLAMAV_PORT`: default `3310`
- `CLAMAV_MAX_DEFINITION_AGE_HOURS`: default 48
- `CLAMAV_HEALTH_POLL_MS`: default 30000
- `SCAN_UNHEALTHY_RETRY_MS`: default 60000

Signatures older than the maximum age never produce a clean verdict, and the
readiness probe fails while they are — ADR-0005 decision 4. A scanner that
will not say how old its signatures are counts as too old.

`CLAMAV_HEALTH_POLL_MS` is how often the scanner is asked about itself.
Everything else reads that answer rather than asking again, so this is also
how long it can take the worker to notice that `clamd` has come back — and,
within the definition-age policy, how stale the recorded signature version
on an attempt can be. Shortening it costs one `VERSION` conversation each
time; there is no per-scan cost either way.

`SCAN_UNHEALTHY_RETRY_MS` is how long a job waits when it reaches a worker
whose scanner is unfit. The queue is normally paused in that state, so this
covers the job that was already in hand when the answer changed: it is moved
to BullMQ's delayed set rather than failed, because five failures during an
outage that ends on its own would empty the queue into the failed set —
ADR-0020.

`CLAMAV_MODE` and `CLAMAV_PATH` are gone: the worker speaks to `clamd` over
its socket rather than running a binary.

## Operations

- `WORKER_HEARTBEAT_INTERVAL_MS`: default 30000, between 5000 and 60000.
  How often each worker process writes its row in
  `sto_info_worker.worker_heartbeat`. It also writes one as soon as the
  scanner's health changes, and a last one as it shuts down. The ceiling is
  a minute because the backend calls a worker silent after two, and one
  missed beat should not be enough to raise that.
- `STRANDED_VERDICT_RESEND_INTERVAL_MS`: default 600000 (ten minutes),
  between 60000 and 86400000. How often verdicts that finished but never
  reached the queue are sent again. They are also sent once at every start.
  See `queues.md`.

Not to be confused with `SCAN_HEARTBEAT_MS`, which renews the lease on one
attempt; this heartbeat is the whole process's.

## Optional

- `STARTUP_DIAGNOSTICS`: `true` | `false`, default false. Logs memory at
  startup.
- `TRUST_PROXY_HOPS`

## Gone since FC-010

| Variable | Why |
| --- | --- |
| `TYPEORM_SYNCHRONIZE` | Refused outright; the database is shared. |
| `FILE_SCAN_QUEUE`, `FLEET_IMPORT_QUEUE` | Queue names are fixed by the contract. |
| `ENQUEUE_NEXT_ON_PASSED` | The worker no longer triggers the import. |
| `CLOUDFLARE_R2_BUCKET_NAME` | Replaced by the quarantine bucket. |
| `VALIDATION_READ_BYTES` | CSV validation moved to the backend ingress — ADR-0001. |
| `CLAMAV_MODE`, `CLAMAV_PATH` | No subprocess; `clamd` over a socket. |
| `cloudmersiveApiKey` in the secret | Cloudmersive is not used in v1 — ADR-0005. |
