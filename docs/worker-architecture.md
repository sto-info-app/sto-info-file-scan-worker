# Worker architecture

The worker does one thing: it takes an asset identifier off a queue, reads
that object out of the private quarantine bucket, asks a scanner about it,
and puts an answer back on another queue. It cannot publish anything, and the
absence of that ability is the design rather than a restriction on it.

## What happens to one job

1. **Read what the scanner is.** From the health poll rather than by asking
   `clamd` again: the signature database's identity is part of the attempt's
   idempotency key, so it has to be known before anything is written. **If
   the scanner is not fit to judge a file — unreachable, silent about the
   age of its signatures, or holding signatures older than the policy allows
   — the job is refused here, before an attempt exists.** It is moved to
   BullMQ's delayed set and tried again later, so an outage of ours costs the
   asset nothing. ADR-0020.
2. **Claim the attempt.** One `INSERT ... ON CONFLICT DO UPDATE` either
   creates it or takes over one whose lease has lapsed. A finished attempt is
   a duplicate delivery and its verdict is repeated unchanged. **A live
   lease means another worker has it, and the job is put back in the
   delayed set until a little after that lease lapses** rather than
   finished. By then the holder has answered, and the next delivery repeats
   its verdict, or it has gone, and the next delivery takes the attempt
   over.
3. **Mark it scanning**, if this worker still holds the lease.
4. **Stream the object.** Out of quarantine, through a transform that hashes
   it, counts it, keeps its first sixty-four bytes and stops at the size
   limit, and straight into `clamd` over `INSTREAM`. Nothing touches disk.
   A heartbeat extends the lease while this runs.
5. **Decide.** The hash is checked against what the registry recorded, and it
   is checked even when the scanner said the bytes were clean. So is the
   declared type: a would-be-clean object whose bytes are not the kind of
   thing the upload claimed is refused as `CONTENT_TYPE_MISMATCH`. A
   detection is reported as a detection, because an infected file that is
   also misdescribed is more usefully reported as infected.
6. **Complete**, as a compare-and-set against the lease token. If that
   matches nothing, another worker owns the question and this one says
   nothing at all.
7. **Send the verdict**, then record that it was sent.

Steps 1 to 3 and step 6 are each a single statement. **No transaction is open
across step 5**, which is FC-010's third acceptance criterion: a
`SELECT ... FOR UPDATE` around the attempt would hold a row lock for as long
as ClamAV takes on a ten-megabyte file, and with a pool sized for a web
application that is an exhaustion waiting for a slow upload.

## Bytes never touch disk

The old pipeline downloaded each object to `/tmp/upload-<fileId>` and read it
whole. [ADR-0006](../../../Plans/Fleets/ADR/0006-worker-job-transport-and-ownership.md)
recorded that as an open follow-up against plan section 10's rule that
ephemeral services keep no local upload storage, and FC-010 closes it by
removing the file rather than by bounding it: `clamd`'s `INSTREAM` command
takes the bytes as they arrive, so there is nothing to bound, nothing to
delete and nothing left behind by a crash.

That matters because "guaranteed deletion" is a promise a crashing container
cannot keep. A rule about crashes has to hold by construction.

## Modules

| Module | What it knows |
| --- | --- |
| `WorkerConfigModule` | The settings, read once at startup. Global. |
| `ScanningModule` | The scanner, behind `SCAN_ENGINE`. Nothing about the database. |
| `QuarantineModule` | Read-only access to one bucket. Nothing about scanning. |
| `ScanModule` | The pipeline, the attempt record and the two queues. |
| `HealthModule` | The probes. They report what the health poll last established and never open a connection of their own. |
| `SharedModule` | AWS Secrets Manager. |
| `DatabaseModule` | Puts the session in UTC. |

`ClsModule` has gone with the request-scoped context it was mounting, which
nothing read. This process handles queue jobs, not requests, and a
correlation identifier travels in the message as `traceId` instead.

## The engine boundary

[ADR-0005](../../../Plans/Fleets/ADR/0005-malware-scanning-engine.md) selected
ClamAV, chose to run it as `clamd` in the worker container, and required the
engine to sit behind a neutral interface "so this remains revisitable". That
interface is `ScanEngine`, with two methods:

- `describe()` — what the scanner is, and how old its signatures are;
- `scan(stream)` — one of `CLEAN`, `INFECTED`, `UNSUPPORTED`, `UNAVAILABLE`.

Everything fails closed. A timeout, a dropped connection, a reply in a shape
the client does not recognise, and a signature database older than the policy
allows are all *not clean*, and there is no path through the client that
turns silence into a pass.

The escalation ADR-0005 names — moving `clamd` out into its own Render
private service — changes the socket factory and nothing else.

## Knowing whether the scanner is fit

`EngineHealthService` asks `describe()` on a timer
(`CLAMAV_HEALTH_POLL_MS`, default thirty seconds) and everything else reads
the answer rather than asking for one. Three things follow, and
[ADR-0020](../../../Plans/Fleets/ADR/0020-scanner-health-and-declared-types.md)
records why each is worth having.

**The queue pauses while the scanner is unfit.** The processor is told when
the answer changes and pauses or resumes its BullMQ worker to match, so
during a `freshclam` outage jobs wait in the queue instead of failing in it.
A job already in hand runs to its end, which is right: it has a scanner that
was fit when it started.

**A job that slips through the gap costs the asset nothing.** The pipeline
checks fitness before it claims anything, throws, and the processor moves the
job to the delayed set. Before this, a stale database was recorded as a
failed attempt — three deliveries during an outage and a perfectly good
upload was rejected for good, by us.

**The probe and the pipeline agree.** `/health/ready` reports the same answer
the pipeline is acting on. A probe that opened its own connection would also
be a way for anything that can reach the port to make the worker talk to
`clamd` as often as it liked.

Render's background workers are not probed, so in the deployment it is the
pause that enforces readiness; the endpoint is for a human and for local use.

## What the bytes are allowed to be

Contract version 2 carries `declaredContentType`: what the upload claimed,
normalised by the backend into one spelling. The worker checks it against
what the first bytes look like, and the rule has two halves.

**A declared container must be the container its signature says it is.** A
PNG declared as a JPEG is refused, and so is an executable declared as an
image.

**A declared `text/*` is confirmed by a text test** — no NUL bytes, no
control bytes — because the difference between a CSV and a plain text file
is not in the bytes, and whether a roster export is *well formed* is decided
at the backend's ingress where ADR-0001 puts it.

Silence is refusal rather than permission: a declared type the ten-signature
table cannot confirm does not hold. That is workable only because the
backend reduces what a browser sends into the small set this can answer for
— `application/vnd.ms-excel` becomes `text/csv` before it is ever stored.

## Recoverable restart

**Graceful shutdown** drains what is in hand. `app.enableShutdownHooks()` lets
BullMQ's Nest integration close its workers on the signal, so the job being
processed finishes before the process exits.

**A crash leaves work reclaimable.** The lease has an expiry rather than a
holder, so an attempt whose worker went away is free for the next one as soon
as the lease lapses — `SCAN_LEASE_MS`, five minutes by default. The state the
row is left in is whatever the last holder reached, which is the truth about
how far it got.

**Reclaiming depends on the job coming back after the lease lapses, and
BullMQ alone would not bring it back.** It hands a crashed worker's job on
within its own lock duration, about thirty seconds, while the lease still
has minutes to run. The worker that receives it finds a live lease. Until
FC-003 it finished the job there and said nothing, and nothing ever
delivered it again: the upload waited in `SCANNING` until the backend's
nightly sweep abandoned it. Now the job is put back until the lease lapses,
and a restart during a scan costs the upload that wait and nothing else.

**Nothing unscanned is published by a restart**, because nothing in this
repository can publish anything at all.

## Logging

NestJS's own logger, at the levels `LOG_LEVEL` allows. Every line carries the
class name and the identifiers — asset, attempt, trace. No line carries a
filename, a signature name, or any part of a file's contents: a log is a sink
like any other, and the backend's officer-canary sweep treats it as one.

## Errors and retries

| Situation | What happens |
| --- | --- |
| A message that violates the contract | Logged and dropped. It will violate it identically every time. |
| The scanner unreachable before an attempt exists | Rethrown, so BullMQ retries and then keeps the job in its failed set. |
| The scanner unreachable during a scan | `FAILED` → a `RETRY` verdict → the asset waits for another go. |
| Signatures too old | The same. The file has done nothing wrong; `freshclam` has. |
| An infection, an unreadable payload, a hash mismatch, an oversize or missing object | `REJECTED`, final. |
| The retry budget spent | `REJECTED` with `RETRY_BUDGET_EXHAUSTED`, so the backend hears a final answer rather than leaving an upload in limbo. |
| The lease lost | Nothing is said. Another worker owns the question. |
| Another worker holds a live lease | The job is put back until a little after it lapses, then either repeats the holder's verdict or takes the attempt over. |
