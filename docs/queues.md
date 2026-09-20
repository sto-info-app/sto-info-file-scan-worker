# Queues

Two queues, and the asymmetry between them is the whole design.

| Queue | This repository | The backend |
| --- | --- | --- |
| `file-scan` | consumes | produces |
| `file-scan-verdict` | produces | consumes |

Neither side has a processor on the other's queue. There is no code in this
repository that reads a verdict and no code in the backend that reads a scan
request, which is [ADR-0015](../../../Plans/Fleets/ADR/0015-asset-registry-ownership.md)'s
authority boundary expressed as an absence: the side that runs the scanner
cannot act on what it found.

Both names are fixed by the contract rather than configurable. A queue name
that differed between the two repositories would not fail; it would look
like an idle worker.

## The contract

`src/contract/file-scan-contract.ts` is **duplicated byte for byte** in the
backend, at `src/file-scanning/contract/file-scan-contract.ts`, along with
its fixture and its spec. There is no shared package, so the copies are held
together by `FILE_SCAN_CONTRACT_FIXTURE_DIGEST`: a SHA-256 of the fixture,
declared in the contract file and checked by a test on each side. Changing
the shape means changing the fixture, which changes the digest, which has to
be changed in both copies — or one repository's test fails.

The file imports nothing, deliberately. An import would tie it to one
repository's module layout and the copies could no longer be compared as
text.

### A scan request

```typescript
interface ScanRequestMessage {
  schemaVersion: number;
  assetId: string;
  objectKey: string;
  objectVersion: string | null;
  expectedSha256: string;
  declaredContentType: string;
  policyVersion: number;
  campaignId: string | null;
  traceId: string;
}
```

`declaredContentType` arrived in version 2 (ADR-0020). It is what the
upload claimed the bytes were, reduced by the backend to one lowercase,
parameter-free spelling, and the worker checks it against what the first
bytes look like. It is a claim to be tested, never an instruction — nothing
in the worker does anything differently because of what it says, beyond
refusing an object whose bytes contradict it. There is no null: an asset
nobody declared a type for cannot have the check applied, so the backend
refuses to queue one.

The rest is worth reading as a list of absences. **No URL, no bucket, no
endpoint, no credentials, no filename and no row of anybody's data.** The worker resolves
where to read from out of its own configuration, which is why there is no
SSRF surface to defend rather than a defence against one — ADR-0006 decision
4, and the first acceptance criterion of FC-010.

`objectKey` is built by the registry from the asset's own identifier and
never from anything a user supplied.

### A verdict

```typescript
interface ScanVerdictMessage {
  schemaVersion: number;
  assetId: string;
  attemptId: string;
  objectKey: string;
  objectVersion: string | null;
  expectedSha256: string;
  observedSha256: string | null;
  policyVersion: number;
  definitionEpoch: string;
  outcome: 'CLEAN' | 'REJECTED' | 'RETRY';
  rejectionCode: string | null;
  engine: string;
  engineVersion: string | null;
  signatureVersion: string | null;
  scannedAt: string;
  traceId: string;
}
```

Two rules are enforced by the parser rather than left to the reader, because
both are the difference between a safe file and an unsafe one:

- a `REJECTED` verdict must say why, and nothing else may;
- a `CLEAN` verdict must carry the hash of the bytes that were actually read.
  A clean answer about bytes nobody measured is not an answer at all.

It carries no byte count and no detected content type, although the worker
observes both. Those are answers to "what did a scanner see", which ADR-0015
puts in the scan record rather than in the registry, and the registry already
recorded a size of its own when the bytes were stored.

### Versioning

The worker refuses to **start** against a contract version it does not
support, rather than running against a shape it half-understands — ADR-0006
decision 3. `FILE_SCAN_SCHEMA_VERSION` names the version this process speaks,
and `SUPPORTED_FILE_SCAN_CONTRACT_VERSIONS` is what the build understands. A
message whose `schemaVersion` differs from the configured one is logged and
dropped.

## Delivery

Both queues are at-least-once, and nothing depends on their not being.

**A repeated request finds the first attempt.** The claim is a single
`INSERT ... ON CONFLICT DO UPDATE` against the idempotency constraint, so a
second delivery either finds a finished attempt — and repeats its verdict
unchanged, rather than scanning again — or finds a live lease and says
nothing.

**A repeated verdict is refused by the registry's state machine.** The
backend moves the asset out of `SCANNING` when it applies the first one, and
the second finds an asset that is no longer waiting.

**A verdict is sent before it is marked sent.** That order is deliberate and
is the wrong way round on purpose: a crash between the two leaves a verdict
that may be delivered twice, which is handled, rather than one lost outright,
which is an upload that never finishes for anybody.

## Recovering from a Redis loss

ADR-0006 accepted that Redis becomes load-bearing for file safety and named
this as the main new risk the decision introduces. Redis is not durable
message history: the authoritative state of every attempt is its row in
PostgreSQL.

`ScanVerdictPublisherService.resendStrandedVerdicts()` finds attempts that
finished but whose verdict never reached the queue — `completedAt` set,
`verdictPublishedAt` null, which has an index of its own — and sends them
again. Re-enqueuing lost *requests* is the backend's side of the same
problem: an asset sitting in `SCANNING` with no attempt row against it is one
whose request never arrived.

## Job options

| Option | Value | Why |
| --- | --- | --- |
| `jobId` (request) | `<assetId>:<policyVersion>` | Two requests for the same asset under the same policy collapse; a policy change is a new question. |
| `jobId` (verdict) | the attempt's identifier | BullMQ collapses a verdict offered twice. A convenience, not the guarantee. |
| `attempts` | 5 | With exponential backoff from one second. |
| `removeOnComplete` | true | Redis is not the audit trail; PostgreSQL is. |
| `removeOnFail` | false | A job in the failed set is visible. |
| concurrency | `SCAN_CONCURRENCY`, default 1 | ClamAV's memory is the binding constraint — see ADR-0005. |

## What used to be here

The `fleet-import` queue is gone. On a passed scan the old pipeline enqueued
a `fleet-import` job that nothing consumed. Under the new contract the worker
returns a verdict and the backend decides what happens next; a worker that
also triggered business processing would be the authority boundary leaking
back the other way. FC-016 and FC-017 trigger the import from the backend's
verdict handler, where the permissions and the Fleet context actually are.

`ENQUEUE_NEXT_ON_PASSED`, `FILE_SCAN_QUEUE` and `FLEET_IMPORT_QUEUE` have
gone with it.
