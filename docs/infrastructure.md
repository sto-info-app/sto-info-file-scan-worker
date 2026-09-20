# Infrastructure and Hosting Documentation (Worker)

## Hosting (Render.com)

### Overview

The `sto-info-file-scan-worker` is hosted on Render.com as a **Background
Worker** service, built from this repository's `Dockerfile`. The service is
declared in [`render.yaml`](../render.yaml).

- **Type**: Background Worker
- **Runtime**: Docker (`./Dockerfile`)
- **Region**: Frankfurt — uploaded roster material is personal data about
  real people, and ADR-0001's position is easier to hold with it in the EU
- **Plan**: one with **2 GB** of memory; see *Sizing* below
- **Start Command**: none. The image's entrypoint is s6, which runs the
  migrations and then the worker beside `clamd` and `freshclam`

### What runs inside the container

Three processes, supervised by s6-overlay, plus one that runs and exits:

| Service | What it is |
| --- | --- |
| `clamd` | The scanner. Listens on loopback only; nothing outside the container can reach it. |
| `freshclam` | The signature updater. Twelve checks a day, and it tells `clamd` when new signatures land. |
| `migrate` | A oneshot. `npm run migration:run` before the worker starts; if it fails, the container stops rather than running a worker that cannot work. |
| `worker` | The application. If it exits, the container exits. |

**The worker does not wait for `clamd`.** It starts, finds the scanner
unfit and pauses its own queue until the health poll says otherwise, so
there is no readiness gate in the image — the application already has one.

**The signature database is baked into the image at build time.** It is
roughly a gigabyte and the first download takes minutes, during which a
worker can scan nothing; with it baked in, `clamd` is answering about seven
seconds after the container starts. `freshclam` updates it on start and on
its cadence regardless, and `CLAMAV_MAX_DEFINITION_AGE_HOURS` refuses to
scan with what is in the image if a deploy is old enough that no update has
landed.

### Environment Variables in Render

All variables from `config/environments/.env.example` must be configured in
Render's environment settings. `render.yaml` fixes the ones that are the
same everywhere and marks the rest `sync: false`.

There is no `DB_PASSWORD`: the database password and the quarantine keys
come from AWS Secrets Manager at start-up, so the only credentials the
platform holds are the two AWS keys that read the secret.

### Database

The worker connects to the same managed PostgreSQL instance as the backend
and owns one schema in it, `sto_info_worker`. It migrates that schema and
nothing else, and its role has no write access to the backend's — see
[database.md](database.md) for the split and [security.md](security.md) for
the grants.

**Deploy ordering matters.** The worker's foreign key points into
`sto_info_app.file_asset`, so the backend's migrations must run first. The
failure is loud rather than quiet: the migration will not apply.

### Redis (Managed)

- **Service Type**: Redis (Managed)
- **Usage**:
  - **BullMQ Orchestration**: Stores job data, state, and concurrency locks for the file scanning and import queues.

## Cloudflare

### R2 Storage

- **Purpose**: the private quarantine bucket holds uploaded bytes until
  something decides what to do with them. One bucket serves every
  environment, with the environment as the first segment of each key
  (ADR-0017).
- **Worker role**: **reads, and only reads.** It cannot write to quarantine,
  cannot delete from it, and holds no credential at all for the bucket the
  site delivers from. Moving and deleting objects belongs to the backend.

## Health Checks

The worker provides a lightweight HTTP server (port `3000` by default) for health monitoring:

- `GET /health`: liveness. Answers without asking the scanner anything, so
  an instance whose `clamd` is still loading is not restarted for it.
- `GET /health/ready`: readiness. **Fails while the scanner cannot be
  reached, while it will not say how old its signatures are, and while those
  signatures are older than `CLAMAV_MAX_DEFINITION_AGE_HOURS`** — ADR-0005.
  A worker in that state is perfectly alive and must not be given a file.

**Nothing on Render asks either of them.** Background workers are not
probed, so what enforces readiness in the deployment is the worker itself:
`EngineHealthService` polls the scanner every
`CLAMAV_HEALTH_POLL_MS` and the processor pauses and resumes its BullMQ
worker to match — ADR-0020. Jobs wait in the queue while the scanner is
unfit rather than failing in it, and the endpoints report the same answer
the pipeline is acting on, for a human reading them.

## Sizing

Measured against this repository's own image rather than taken from
ClamAV's general guidance (a 3 GiB minimum, 4 GiB preferred). ADR-0020 has
the method; these are the figures.

| State | Resident memory |
| --- | --- |
| Idle, signature database loaded | ~960 MiB |
| Scanning one 8 MiB object | ~985 MiB |
| Scanning four 8 MiB objects at once | ~995 MiB |
| Through a signature reload | ~1,068 MiB |

**The database is the cost; scanning barely adds to it.** Four concurrent
8 MiB scans cost about 35 MiB more than sitting still, which is why
`SCAN_CONCURRENCY` is not the sizing input it looks like.

**The reload figure is a choice.** `ConcurrentDatabaseReload` is `no` in
`docker/clamd.conf`. With `yes`, clamd holds both databases during a reload
and peaks at **2,022 MiB** — twice the steady state, twelve times a day,
which would mean paying for 4 GiB. With `no` it stays flat and scans wait
for the reload instead. One worker, nobody upstream waiting: the queue
holds.

## Scaling

- **Concurrency**: `SCAN_CONCURRENCY`, default 1. ClamAV's memory is the
  binding constraint rather than CPU, and see *Sizing* above for what
  raising it actually costs.
- **Instances**: several can run at once. Two workers handed the same job
  cannot both proceed — the claim is a single statement against a unique
  constraint, and the loser writes nothing. Scaling out does duplicate the
  signature database in memory per instance.

## Troubleshooting

### Logs

Logs are accessible via the Render dashboard. Key things to monitor:

- Job timeouts.
- `clamd` connection errors, and readiness failures on stale signatures.
- R2 access denials.
- BullMQ lock expiry warnings, and `Lease lost; saying nothing` in the
  worker's own log — the second is the durable one and means another worker
  took an attempt mid-scan.
- Attempts that finished but whose verdict never reached the queue. After a
  Redis loss these are the backlog, and `resendStrandedVerdicts` is what
  clears them. See [queues.md](queues.md).
