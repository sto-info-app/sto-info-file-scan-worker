# Database (PostgreSQL)

The worker shares one PostgreSQL database with the backend and owns **one
schema** inside it: `sto_info_worker`. It owns two tables in that schema —
`file_scan_attempt` and `worker_heartbeat` — and the views over them, and it
migrates nothing else.

Before FC-010 this document described an `UploadFileEntity` with a `status`
enum of `pending | passed | failed | virus_detected`, a `mimeType`, a
`bucket`, a `size` and a `scanResult` JSON column. **No such table ever
existed.** The entity in the code had different columns and different states,
and there were no migrations at all — the table, when it appeared, appeared
because `TYPEORM_SYNCHRONIZE` created it from whatever the entity said that
day. That is not a schema; it is a side effect.

## Ownership, and why there are two schemas

[ADR-0006](../../../Plans/Fleets/ADR/0006-worker-job-transport-and-ownership.md)
split schema ownership by table: the worker owns its own tables and migrates
them, the backend owns every Fleet Community domain table and migrates those,
and neither repository writes to the other's. It also warned that "two
migration owners against one database needs care: separate TypeORM migration
tables, no overlapping table names".

Both repositories had in fact named their migration table `_migrations`. In
one schema they would have shared it, and each would have read the other's
history as its own — refusing to apply migrations it had never run, and
offering to revert migrations whose files it does not have.

Separate schemas settle both problems for the price of a grant:

| | Schema | Migration table | Migrated by |
| --- | --- | --- | --- |
| Asset registry, Fleet domain | `sto_info_app` | `sto_info_app._migrations` | backend |
| Scan attempts | `sto_info_worker` | `sto_info_worker._migrations` | this repository |

`DB_SCHEMA` must be `sto_info_worker`. The migrations name the schema in
their SQL, so a datasource pointed anywhere else would create the table in
one place and read from another — a failure that looks like missing data
rather than like a misconfiguration. The worker checks the two agree at
startup and refuses to run if they do not.

**`TYPEORM_SYNCHRONIZE` is gone.** Not defaulted to false: the option is no
longer read, and the worker refuses to start if the variable is set to true.
Synchronise against a database shared with another application will drop that
application's columns to make the schema match these entities.

## `file_scan_attempt`

One attempt to scan one object. The successor to `upload_files`, renamed
because the old name was wrong: [ADR-0015](../../../Plans/Fleets/ADR/0015-asset-registry-ownership.md)
made `file_asset` in the backend the record of an upload and the only thing
that decides publication, and what is left here is the record of a scan.

Nothing in this table can make a byte serveable. The state enum has five
values — `CLAIMED`, `SCANNING`, `CLEAN`, `REJECTED`, `FAILED` — and
`AVAILABLE` is not among them, which is ADR-0015 decision 3 expressed as an
absence rather than as a rule.

### Identity and the request

| Column | Notes |
| --- | --- |
| `id` | The attempt, carried in the verdict. |
| `assetId` | Foreign key to `sto_info_app.file_asset`, `ON DELETE RESTRICT`. On PostgreSQL 18 a delete it blocks raises SQLSTATE `23001`, not `23503`. |
| `objectKey`, `objectVersion` | Where the bytes were. The version is null on R2. |
| `expectedSha256` | What the registry recorded when the bytes were stored. |
| `policyVersion`, `definitionEpoch` | Which policy and which signatures. |
| `campaignId`, `traceId` | Which rescan, and which upload to follow it by. |
| `requestedAt` | When the backend queued the request, from the job's own timestamp. Null on attempts made before FC-003 recorded it. |

All of these are write-once. `TR_file_scan_attempt_guard` refuses a change to
any of them at any point in the attempt's life, because they are the
question, not the answer.

### The answer

| Column | Notes |
| --- | --- |
| `state` | Where the attempt got to. |
| `observedSha256` | The hash of what was actually read. |
| `byteSize`, `detectedContentType` | What was read, and what it looked like. |
| `rejectionCode`, `failureReason` | Why it refused. **Administrator-only.** |
| `engine`, `engineVersion`, `signatureVersion` | Which scanner answered. |
| `definitionsBuiltAt` | When its signature database was built, as `clamd` reported it, or null when it did not say. |

A finished attempt is evidence, and the same trigger refuses every change to
a terminal row. The one exception is `verdictPublishedAt`, which may be set
once.

Since `1797500000000-ReopenFailedScanAttempt` (FC-042), a `FAILED` row may
also move in exactly two ways, because a failure was a transient fault and
not an answer about the file. It may be **reopened** to `CLAIMED` as a fresh
claim — one more claim, a new lease, and nothing of the old answer left,
including `verdictPublishedAt` — or **refused** to `REJECTED` with
`RETRY_BUDGET_EXHAUSTED`, keeping its claims and everything it measured and
clearing `verdictPublishedAt` so the refusal is sent. The budget is a setting
the database cannot see, so the service's statements enforce it and the
trigger enforces the shape. `CLEAN` and `REJECTED` stay final.

### The lease

| Column | Notes |
| --- | --- |
| `attemptCount` | How many times this attempt has been claimed. |
| `leaseToken`, `leaseExpiresAt` | Who holds it, and until when. |
| `heartbeatAt` | When the holder last said it was still working. |

BullMQ has its own lock and it is not enough on its own: a lock says which
worker may process a job, not whose answer the database will accept. A worker
that stalls long enough for its lock to expire, then wakes and writes, would
otherwise overwrite the answer of the worker that replaced it. Every
completion is therefore a compare-and-set against `leaseToken`, and a stale
worker updates no rows and says nothing.

## What the backend may read: `scan_usage` and `scan_engine_status`

The backend has no `SELECT` on `file_scan_attempt`, which holds asset
identifiers, object keys and hashes. Its admin diagnostics page (FC-003)
reads two views instead, which carry only totals:

- **`scan_usage`** has one row for each window, `24h`, `7d` and `30d`, over
  the attempts a worker took within it. It gives initial scans and re-scans,
  retried scans and retries, each outcome and rejection code, attempts in
  progress, and the median, 95th percentile and maximum of scan time and
  wait.
- **`scan_engine_status`** has one row: the engine, versions and signature
  build time the latest attempt reported.

| Term | Meaning |
| --- | --- |
| Re-scan | An attempt that belongs to a campaign, or any attempt for an asset that already had one. |
| Retry | A claim beyond the first; an attempt claimed three times holds two. |
| Scan time | From the scanner getting the bytes to the answer. |
| Wait | From the request being queued (`requestedAt`) to the answer. |

The views are the contract, so the table can change underneath them. They
are granted to the role named by `BACKEND_DB_ROLE` when the migration runs,
and the migration refuses to run without it.

### Constraints worth knowing about

- **`UQ_file_scan_attempt_idempotency`** covers
  `(assetId, objectVersion, policyVersion, definitionEpoch)`, which is
  ADR-0006 decision 4 written as a constraint. It is declared
  `UNIQUE NULLS NOT DISTINCT`, and that is load-bearing: R2 has no object
  versioning, so every `objectVersion` here is null, and under PostgreSQL's
  default two nulls differ from each other. A plain `UNIQUE` would have
  matched nothing at all and every duplicate delivery would have inserted a
  second attempt — while looking, in the migration, exactly like this one.
- **`CHK_file_scan_attempt_clean_hash`** requires a `CLEAN` row to carry an
  observed hash equal to the expected one. The explicit `IS NOT NULL` in it
  is also load-bearing, for the same kind of reason: a null makes the
  comparison null rather than false, and a `CHECK` accepts null. Without it
  the constraint permitted the one row it exists to forbid. **The rehearsal
  found that, not review.**

## `worker_heartbeat` and `worker_heartbeat_status`

One row per running worker process, written by the process itself (FC-042).
Render never probes a background worker, so a worker that has paused itself
because its scanner is unfit looks exactly like one with nothing to do; this
row is how anyone outside the process tells them apart.

| Column | Notes |
| --- | --- |
| `workerId` | The process: host name, pid and a random suffix, made at start. Primary key. |
| `state` | `RUNNING`, `PAUSED` or `STOPPING`. |
| `pauseReason` | Why it is paused, as a short upper-case code, or null. Only a paused row may have one. |
| `definitionsVersion`, `definitionsBuiltAt` | The signatures `clamd` last reported, or null while it is not answering. |
| `jobsInHand` | How many jobs the process is working on. Never negative. |
| `startedAt` | When the process started, by its own clock. |
| `beatAt` | When it last wrote the row, by the database's clock. |
| `pausedSince` | When the current pause began, by the database's clock. Set exactly when `state` is `PAUSED`. |

Each process upserts its row on start, every `WORKER_HEARTBEAT_INTERVAL_MS`,
whenever the scanner's health changes and once more as `STOPPING` on the way
out, and deletes any row whose `beatAt` is more than a day old. The pause
reason codes are listed in [infrastructure.md](infrastructure.md#is-the-worker-paused-idle-or-gone).

**The view is a contract.** The backend's alerts read
`worker_heartbeat_status` by column name — a heartbeat more than two minutes
old, or a pause more than ten — so its nine columns are exactly the table's,
and renaming one is a change to both repositories. It is granted to the role
named by `BACKEND_DB_ROLE`, and the backend has no `SELECT` on the table
itself. `USAGE` on the schema is the grant `RecordScanUsage` already made.

## Deploy ordering

The foreign key crosses into the backend's schema, so **the backend's
migrations must run before this repository's**. The worker's role also needs
`REFERENCES` on `sto_info_app.file_asset` and `USAGE` on that schema, and
nothing else there: it does not read the registry and must not write it.

The other way round, `1794800000000-RecordScanUsage` grants the backend's
role `USAGE` on `sto_info_worker` and `SELECT` on the two usage views, and
`1797400000000-RecordWorkerHeartbeat` grants it `SELECT` on
`worker_heartbeat_status`, and nothing else. It reads the role from `BACKEND_DB_ROLE`, so that variable must
be set wherever the worker's migrations run.

This is an ordering the worker cannot check for itself, and the failure is
loud — the migration will not apply — rather than quiet.

## Commands

```bash
npm run migration:run
npm run migration:revert
npm run migration:show
```

## Rehearsing a migration

Everything a unit spec can prove about a migration is a property of its SQL
text. Whether PostgreSQL accepts that SQL, and whether the constraints reject
what they are meant to reject, is the question that matters on deploy day.

```bash
npm run rehearse:migration
```

This starts a throwaway `postgres:18-alpine` container, stubs the one backend
table the foreign key points at, replays every migration in order, and then
deliberately tries to break every rule the attempt table claims to enforce,
including a ten-writer race on the claim statement and a second race on the
reclaim path. The races run the service's own claim statement, read out of
`FileScanAttemptService` rather than copied — the copy they used to carry had
fallen behind the service — which is why the whole chain is applied: the
statement is written against the schema as it is now. It then rolls the
whole chain back over the data, last migration first, checks that leaves
`sto_info_worker` empty and `sto_info_app` untouched, and re-applies it. It
reads no database environment variable, so a stray `.env` cannot point it at
anything real, and the container is removed on exit.

```bash
npm run rehearse:migration:scan-usage
```

This applies both migrations in order and rehearses the second. It seeds
seven attempts across the three windows and checks every figure the usage
view gives against values worked out by hand. It also reads the views as the
backend's role and proves that role cannot read the table. Finally it rolls
back over the data, checks the guard trigger is restored, and re-applies.

```bash
npm run rehearse:migration:reopen-failed-attempt
```

This applies all four migrations and rehearses the reopening guard. It tries
every wrong way to reopen or refuse a failed attempt, and to reopen a clean or
rejected one, then runs the attempt service's own claim, refusal and mark
statements — read out of the service, not copied: a failed attempt under
budget reopens, scans clean under its new lease, and has the clean answer
marked sent by its own time and not by the old `RETRY`'s; a stale lease and a
late request change nothing; a failed attempt with its budget spent is
refused. Ten workers then claim one failed attempt at once and exactly one
reopens it. It rolls back over the data and checks the strict guard is back.

```bash
npm run rehearse:migration:worker-heartbeat
```

This applies all three migrations and rehearses the heartbeat. It tries to
break every constraint on the table, checks the view has exactly the nine
columns the backend reads and that the backend's role can read the view but
not the table, then runs the heartbeat service's own upsert and prune —
read out of the service, not copied — beat by beat: a pause records when it
began, a second paused beat keeps it, resuming or stopping clears it, and
only a day-stale row is pruned. Ten workers then beat at once. Finally it
rolls back over the data, checks the scan usage views and the backend's
schema grant are untouched, and re-applies.

## Timezone

The worker sets the session to UTC on startup. Every instant it writes is a
`timestamptz`, and the one way to get a wrong answer out of one is a session
in a local zone.

## Retention

An attempt row outlives the object it describes, deliberately. When the
retention cron removes a quarantined object the registry row stays as
evidence, and so does the attempt: it is the only record of what a scanner
said about bytes that no longer exist. Removing attempt rows is W09's to
decide, alongside the registry's own retention.
