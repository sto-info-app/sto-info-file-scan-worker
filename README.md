# sto-info-file-scan-worker

## Security posture

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/sto-info-app/sto-info-file-scan-worker/badge)](https://scorecard.dev/viewer/?uri=github.com/sto-info-app/sto-info-file-scan-worker)
[![CodeQL](https://github.com/sto-info-app/sto-info-file-scan-worker/actions/workflows/codeql.yml/badge.svg?branch=development)](https://github.com/sto-info-app/sto-info-file-scan-worker/actions/workflows/codeql.yml)
[![npm audit](https://github.com/sto-info-app/sto-info-file-scan-worker/actions/workflows/audit.yml/badge.svg?branch=development)](https://github.com/sto-info-app/sto-info-file-scan-worker/actions/workflows/audit.yml)

## CI and delivery

[![Lint and Test](https://github.com/sto-info-app/sto-info-file-scan-worker/actions/workflows/lint-test.yml/badge.svg?branch=development)](https://github.com/sto-info-app/sto-info-file-scan-worker/actions/workflows/lint-test.yml)

## Quality and testing

[![Mutation Testing](https://github.com/sto-info-app/sto-info-file-scan-worker/actions/workflows/mutation-testing.yml/badge.svg)](https://github.com/sto-info-app/sto-info-file-scan-worker/actions/workflows/mutation-testing.yml)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=sto-info-app_sto-info-file-scan-worker&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=sto-info-app_sto-info-file-scan-worker)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=sto-info-app_sto-info-file-scan-worker&metric=coverage)](https://sonarcloud.io/summary/new_code?id=sto-info-app_sto-info-file-scan-worker)

## Release and project

[![Licence: MIT](https://img.shields.io/github/license/sto-info-app/sto-info-file-scan-worker?label=licence)](LICENSE)
[![Node](https://img.shields.io/badge/node-24.x-informational)](https://github.com/sto-info-app/sto-info-file-scan-worker/blob/development/package.json)

## Project Overview

The `sto-info-file-scan-worker` is a NestJS service that scans uploaded
files for malware. It takes an asset identifier off a queue, reads that
object out of the private quarantine bucket, asks ClamAV about it, and puts
an answer back on a second queue.

**It cannot publish anything.** The backend's asset registry decides whether
a byte may be served, and this repository has no credential, no table and no
code path that could reach that decision — ADR-0015.

## Features

- **Streamed scanning**: objects go from Cloudflare R2 into `clamd` over
  `INSTREAM` without touching disk.
- **ClamAV, failing closed**: a timeout, an unparseable reply or a stale
  signature database all mean *not clean* — never a pass.
- **It knows when it cannot scan**: the scanner's health is polled, and a
  worker whose `clamd` is unreachable or whose signatures are too old pauses
  its own queue rather than spending anybody's retries on it.
- **The bytes must be what the upload said they were**: a declared type
  travels with the request and is checked against the first bytes, so an
  executable declared as an image is refused even when the scanner is happy.
- **Leased attempts**: a lost lease writes nothing, so a stale worker cannot
  overwrite the answer of the one that replaced it.
- **A versioned, asset-only contract**: no URL, no credentials, no rows of
  anybody's data, and the worker refuses to start against a contract version
  it does not understand.
- **Idempotent delivery**: a repeated message finds the first attempt rather
  than making a second.
- **Health endpoints**: `/health` answers that the process is running, and
  `/health/ready` answers `503` while the scanner is unreachable or its
  signatures are too old. Neither talks to `clamd`: both report what the
  scanner's own health poll last found, the same answer the worker is taking
  or refusing files by.
- **A heartbeat row**: each worker process writes its row in
  `sto_info_worker.worker_heartbeat` every `WORKER_HEARTBEAT_INTERVAL_MS`
  (30 seconds by default), as soon as the scanner's health changes, and once
  more as it shuts down. The row says whether it is running, paused (and
  why) or stopping, and which signatures it has; the backend reads it to
  tell a silent worker from an idle one. Rows that have not beaten for a day
  are removed.
- **Stranded verdicts are resent**: a verdict that finished while Redis was
  away is still in PostgreSQL, so the worker sends it again once at start
  and then every `STRANDED_VERDICT_RESEND_INTERVAL_MS` (ten minutes by
  default). A resend is safe to repeat, and a failed sweep never stops the
  worker.

## Documentation

Documentation is in [docs/](docs/).

- [docs/environment-variables.md](docs/environment-variables.md)
- [docs/infrastructure.md](docs/infrastructure.md)
- [docs/security.md](docs/security.md)
- [docs/worker-architecture.md](docs/worker-architecture.md)
- [docs/queues.md](docs/queues.md)
- [docs/database.md](docs/database.md)
- The operations runbooks, for this worker and the backend together, are in the backend
  repository: [docs/operations/](https://github.com/sto-info-app/sto-info-backend/blob/development/docs/operations/README.md)
- [docs/github/](docs/github/) — how the CI, quality and security automation is
  wired up, and where to look when a check fails.

The security *policy* — reporting a vulnerability, supported versions, the
dependency overrides this repository carries — is in [SECURITY.md](SECURITY.md).

## Getting Started

### Prerequisites

- Node.js 24.22.3 or later 24.x (pinned in `.nvmrc`; 24.22.3 is the November 2026 security release)
- npm 11.x (bundled with Node.js 24)
- PostgreSQL 18, the same instance as the backend
- Redis 7, for BullMQ
- `clamd`, the ClamAV daemon (port 3310 locally)
- An S3-compatible quarantine bucket: Cloudflare R2 when deployed, MinIO
  locally
- AWS Secrets Manager
- Docker, for the rehearsals and the container build

### Installation

1. Clone the repository:

```sh
git clone https://github.com/sto-info-app/sto-info-file-scan-worker.git
```

2. Navigate to the project directory:

```sh
cd sto-info-file-scan-worker
```

3. Install the dependencies:

```sh
npm install
```

### Configuration

Environment files live in [config/environments/](config/environments/):

- `config/environments/.env.example`: the template, and the only one. There
  used to be a second at the repository root that disagreed with it; see
  [docs/environment-variables.md](docs/environment-variables.md). Note that
  the backend calls its equivalent `template.env` — this repository keeps
  `.env.example` deliberately, for the reason recorded in that document.
- `config/environments/.env`: the active local environment file (not
  committed).

**Local Setup:**

1. Copy `config/environments/.env.example` to `config/environments/.env`.
2. Fill in your local database (`DB_*`) and Redis (`REDIS_URL`) details,
   the scanner's address (`CLAMAV_*`) and the quarantine bucket
   (`CLOUDFLARE_R2_ENDPOINT` and `CLOUDFLARE_R2_QUARANTINE_BUCKET_NAME`;
   locally, point them at MinIO).
3. Set `BACKEND_DB_ROLE` to the database role the backend connects as. Only
   the migrations read it: they grant that role `SELECT` on the scan usage
   views and the worker heartbeat view, and nothing else in this schema. The
   migrations refuse to run without it. It is not in `.env.example`.
4. Provide your AWS credentials to allow the app to pull sensitive secrets
   (`dbPassword` and the read-only quarantine bucket keys) from AWS Secrets
   Manager. See [docs/security.md](docs/security.md) for what those
   credentials are permitted to do, and what they deliberately are not.

Every variable is described in
[docs/environment-variables.md](docs/environment-variables.md).

### Database

The worker keeps its own `sto_info_worker` schema in the backend's
PostgreSQL database. It holds the scan attempts (`file_scan_attempt`), the
scan usage views the backend reads (`scan_usage` and
`scan_engine_status`), and the worker heartbeat (`worker_heartbeat`, with
its `worker_heartbeat_status` view). See [docs/database.md](docs/database.md).
Schema changes are managed with TypeORM migrations, and the backend's
migrations must have run first.

Migration commands:

```sh
npm run migration:generate -- -n <NameOfMigration>
npm run migration:run
npm run migration:revert
npm run migration:show
```

### Running the Application

`start:dev` does not run migrations, so bring the schema up to date first:

```sh
npm run migration:run
npm run start:dev
```

The health endpoints listen on `APP_PORT` (3000 by default).

### Running Tests

```sh
npm test                           # the suite
npm run test:cov                   # the suite with coverage, as CI runs it
npm run lint                       # ESLint
npm run format                     # Prettier, over src/
npm run verify                     # audit, lint, format check, coverage and build
npm run test:mutation              # Stryker, over the whole of src/
npm run test:mutation:incremental  # Stryker, over what has changed only
```

Coverage is enforced at 100%. See
[docs/github/QUALITY-AUTOMATION.md](docs/github/QUALITY-AUTOMATION.md).

### Rehearsals

Two things this repository does cannot be proved by a unit spec, because
both are questions about somebody else's software. Each has a rehearsal
that starts a throwaway container, proves it, and removes the container
afterwards. Neither is part of the suite: they need Docker, they are slow,
and they must not dilute the coverage the suite enforces.

```sh
npm run rehearse:migration   # the schema, against a real PostgreSQL
npm run rehearse:scan        # the clamd client, against a real clamd
```

`rehearse:migration` runs every migration. Three narrower ones stop at the
migration they are named after:

```sh
npm run rehearse:migration:scan-usage
npm run rehearse:migration:worker-heartbeat
npm run rehearse:migration:reopen-failed-attempt
```

`rehearse:scan` checks clean, EICAR, oversize, refused, timed-out and
stale-signature scans, and last restarts the scanner while a scan is
streaming: that scan must come back not answered, never clean, and the
scanner must judge files correctly once it has loaded its database again.
It also feeds the scanner archives it cannot finish (FC-043): EICAR nested
past `MaxRecursion` or after the thousandth member must be refused, an
encrypted archive refused as unscannable, and it records the one limit
clamd never reports — a member inflated past `MaxFileSize` is read only up
to the limit — which the backend closes by re-encoding every picture.
And it reloads the signatures while a scan is streaming: the scan, and the
ones after it, must still judge correctly.
FC-043's acceptance evidence, which these results feed, is kept with the
Fleet Community plans.

`rehearse:scan` builds its scanner on the public ClamAV image by default.
Point it at this repository's own image to rehearse the exact container
that gets deployed:

```sh
docker build -t stoi-file-scan-worker .
REHEARSAL_CLAMAV_IMAGE=stoi-file-scan-worker npm run rehearse:scan
```

### Building the container

```sh
docker build -t stoi-file-scan-worker .
```

The build downloads ClamAV's signature database and bakes it in, so it
takes a few minutes and produces an image of about 1 GB. That is the
trade: a container that can scan seven seconds after it starts, rather
than one that is useless until `freshclam` has finished. See
[docs/infrastructure.md](docs/infrastructure.md).

## Deployment

The worker runs on Render as a background worker on the Docker runtime,
described by a Blueprint for each environment in [render/](render/):

- [render/development.yaml](render/development.yaml): Development, from the
  `development` branch
- [render/staging.yaml](render/staging.yaml): Staging, from the
  `sr/sc-1036-fleet-community` branch
- [render/production.yaml](render/production.yaml): Production, from the
  `production` branch

One container runs `clamd`, `freshclam` and the worker under s6-overlay.
Migrations run once as the container starts, in the
[docker/s6-rc.d/migrate](docker/s6-rc.d/migrate/) oneshot, and the worker
does not start until they have succeeded. The backend's migrations must be
deployed first. See [docs/infrastructure.md](docs/infrastructure.md).

## Contributing

We welcome contributions! Please read our [contributing guidelines](CONTRIBUTING.md) for more details.

Commits need a DCO sign-off (`git commit -s`) and a Conventional Commits
subject; both are checked locally by a git hook and again in CI.

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## Code Quality

We use SonarQube Cloud to ensure the code quality of this project. Its
quality gate and coverage badges are at the top of this file.

## Licence

This project is licensed under the MIT Licence. See the [LICENSE](LICENSE) file for more information.

## Contact

For any enquiries, please contact us at [support@startrekonline.info](mailto:support@startrekonline.info).
