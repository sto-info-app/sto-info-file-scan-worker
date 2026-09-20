# Security (Worker)

## What this process can and cannot do

The short version, because it is the point of the design:

| | |
| --- | --- |
| Read one object from the quarantine bucket | **yes** |
| Write or delete in the quarantine bucket | no |
| Reach the bucket the site delivers from | no — it holds no credential for it |
| Write its own scan attempt rows | **yes** |
| Read or write `file_asset` | no |
| Make any byte serveable | **no, by any route** |

The last line is the one that matters. `AVAILABLE` does not appear in this
repository's vocabulary at all, and there is no code path from a scanner's
answer to a published file — [ADR-0015](../../../Plans/Fleets/ADR/0015-asset-registry-ownership.md)
decision 3, and plan section 6.2's "no public callback can mark a file
clean" expressed as an absence rather than as a check.

## No arbitrary fetches

A job message carries an asset identifier, an object key, an object version,
a hash, a policy version and two identifiers. **No URL, no bucket, no
endpoint and no credentials.** The worker resolves where to read from out of
its own configuration, so there is no code path in which a message can
influence where a request goes — the first acceptance criterion of FC-010,
and the reason there is no SSRF surface here to defend rather than a defence
against one.

The object key itself is built by the backend from the asset's own
identifier and never from a filename somebody typed.

## Least privilege

[ADR-0006](../../../Plans/Fleets/ADR/0006-worker-job-transport-and-ownership.md)
decision 5 retained AWS Secrets Manager and required the worker's database
and object-store credentials to be least-privilege. Concretely:

**R2.** A token scoped to the quarantine bucket with object-read permission
only. It appears in the secret as `cloudflareR2QuarantineReadKey` and
`cloudflareR2QuarantineReadSecret`, named `Read` so that the next person to
look at the secret can see what it is for. A scanner that could alter what it
scans, or publish what it cleared, is a scanner whose verdict proves nothing
about the bytes anybody will actually be served.

R2 cannot scope a token to a key prefix, only to a bucket, and one bucket
serves every environment — [ADR-0017](../../../Plans/Fleets/ADR/0017-one-quarantine-bucket-with-environment-prefixes.md).
**Every quarantine credential is therefore a production credential**,
whichever environment issued it.

**PostgreSQL.** A role of its own, with:

- full rights on `sto_info_worker` and nothing else there;
- `USAGE` on `sto_info_app` and `REFERENCES` on `sto_info_app.file_asset`,
  which is what the cross-schema foreign key needs;
- no `SELECT`, `INSERT`, `UPDATE` or `DELETE` anywhere in `sto_info_app`.

The registry is reached through the verdict queue, never through the
database.

**AWS.** The access key reaches one secret. Nothing else.

## Secrets

Everything sensitive comes from Secrets Manager at startup and is cached for
the life of the process. Nothing is committed, and a failure to read a secret
logs the secret's *name* and never its contents — a failure to read one is
exactly the moment somebody is tempted to print it.

## What is never logged

- A filename. It is text somebody supplied, and a log is a sink like any
  other. The backend's officer-canary sweep treats it as one.
- Any part of a file's contents.
- A signature name, or any scanner diagnostic. Those go on the attempt row,
  which is administrator-only, and a person whose upload is refused is told
  that it was refused and nothing else — ADR-0005 decision 6. A signature
  name tells an attacker which of their attempts got through.
- A credential, a token or a password.

## Failing closed

A timeout, an unreachable scanner, a reply in a shape the client does not
recognise, a signature database older than the policy allows, an unreadable
payload, an oversize object, an object that is not there, and a hash that
does not match what the registry recorded are all **not clean**. Only an
affirmative clean answer about bytes that hashed to the expected value can
lead anywhere, and even that leads only to `CLEAN` — never to a published
file.

The hash check is the one worth stating twice: it is applied even when the
scanner said the bytes were clean, because a clean answer about the wrong
object is worse than no answer, as it looks like one.

## No local storage

Objects are streamed from quarantine into `clamd` over `INSTREAM`. Nothing is
written to disk at any point, so there is no temporary file to bound, to
delete, or to be left behind by a crash — plan section 10's rule about
ephemeral services, held by construction rather than by a cleanup path.

## Magic bytes

The first sixty-four bytes of each object are matched against a short table
of container signatures and a test for whether the bytes are text at all.
The result is recorded on the attempt row, and since contract version 2 it
is also **enforced against what the upload claimed** — ADR-0020.

A declared container must be the container its signature says it is, so a
Windows executable declared as a profile picture is refused as
`CONTENT_TYPE_MISMATCH` even when the scanner found nothing in it. A
declared `text/*` is confirmed by the text test alone, because the
difference between a CSV and a plain text file is not in the bytes and
whether a roster export is well formed is settled at the backend's ingress.

A type the table cannot confirm does not hold. That is only workable
because the backend reduces what a browser sends into the small set this
can answer for before it is ever stored, which is why the normalisation
lives there and not here.

This replaces the `file-type` package, which this repository depended on and
could never have used — it is ESM-only with no CommonJS entry point, and this
application compiles to CommonJS, so the import would have failed the first
time the pipeline ran.

## Database

TypeORM and parameterised statements throughout. The raw SQL in
`FileScanAttemptService` is parameterised; the only interpolated values are
the schema and table names, which are compile-time constants.

## Concurrency

BullMQ's concurrency limit, and the lease. The lease is the one that matters
for safety: a worker that stalls long enough to lose it writes nothing,
because every completion is a compare-and-set against the token the claim
issued.
