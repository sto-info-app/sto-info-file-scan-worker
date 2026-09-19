# Infrastructure and Hosting Documentation (Worker)

## Hosting (Render.com)

### Overview

The `sto-info-file-scan-worker` is hosted on Render.com as a **Background Worker** service.

- **Type**: Background Worker
- **Build Command**: `npm install && npm run build`
- **Start Command**: `npm run start:prod`
- **Environment**: Node

### Environment Variables in Render

All variables from `config/environments/.env.example` must be configured in Render's environment settings.

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

## Scaling

- **Concurrency**: `SCAN_CONCURRENCY`, default 1. ClamAV's memory is the
  binding constraint rather than CPU; ADR-0005 records the sizing and notes
  that a small Render instance is not viable.
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
