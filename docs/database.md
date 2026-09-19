# Database (PostgreSQL)

The worker shares one PostgreSQL database with the backend and owns **one
schema** inside it: `sto_info_worker`. It owns one table in that schema, and
it migrates nothing else.

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
| `assetId` | Foreign key to `sto_info_app.file_asset`, `ON DELETE RESTRICT`. |
| `objectKey`, `objectVersion` | Where the bytes were. The version is null on R2. |
| `expectedSha256` | What the registry recorded when the bytes were stored. |
| `policyVersion`, `definitionEpoch` | Which policy and which signatures. |
| `campaignId`, `traceId` | Which rescan, and which upload to follow it by. |

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

A finished attempt is evidence, and the same trigger refuses every change to
a terminal row. The one exception is `verdictPublishedAt`, which may be set
once.

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

## Deploy ordering

The foreign key crosses into the backend's schema, so **the backend's
migrations must run before this repository's**. The worker's role also needs
`REFERENCES` on `sto_info_app.file_asset` and `USAGE` on that schema, and
nothing else there: it does not read the registry and must not write it.

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

This starts a throwaway `postgres:17-alpine` container, stubs the one backend
table the foreign key points at, replays the migration, and then deliberately
tries to break every rule it claims to enforce — forty-two assertions,
including a ten-writer race on the claim statement and a second race on the
reclaim path. It reads no database environment variable, so a stray `.env`
cannot point it at anything real, and the container is removed on exit.

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
