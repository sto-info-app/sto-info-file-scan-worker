# sto-info-file-scan-worker

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

## Documentation

Documentation is in [docs/](docs/).

- [docs/environment-variables.md](docs/environment-variables.md)
- [docs/infrastructure.md](docs/infrastructure.md)
- [docs/security.md](docs/security.md)
- [docs/worker-architecture.md](docs/worker-architecture.md)
- [docs/queues.md](docs/queues.md)
- [docs/database.md](docs/database.md)
- [docs/github/](docs/github/) — how the CI, quality and security automation is
  wired up, and where to look when a check fails.

The security *policy* — reporting a vulnerability, supported versions, the
dependency override this repository carries — is in [SECURITY.md](SECURITY.md).

## Getting Started

### Prerequisites

- Node.js (version 24.x)
- npm (version 10.x or higher)
- PostgreSQL database (version 14.x or higher)
- Redis (version 6.x or higher) - Required for BullMQ
- Amazon Secrets Manager

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
2. Fill in your local database and Redis details.
3. Provide your AWS credentials to allow the app to pull sensitive secrets
   (`dbPassword` and the read-only quarantine bucket keys) from AWS Secrets
   Manager. See [docs/security.md](docs/security.md) for what those
   credentials are permitted to do, and what they deliberately are not.

### Database

This application uses PostgreSQL for tracking file metadata. Schema changes are managed with TypeORM migrations.

Migration commands:

```sh
npm run migration:generate -- -n <NameOfMigration>
npm run migration:run
npm run migration:revert
npm run migration:show
```

### Running the Application

Start the worker in development mode:

```sh
npm run start:dev
```

### Running Tests

```sh
npm test           # the suite
npm run test:cov   # the suite with coverage, as CI runs it
npm run verify     # audit, lint, format check, coverage and build
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

`rehearse:scan` checks clean, EICAR, oversize, refused, timed-out and
stale-signature scans, and last restarts the scanner while a scan is
streaming: that scan must come back not answered, never clean, and the
scanner must judge files correctly once it has loaded its database again.

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

## Contributing

We welcome contributions! Please read our [contributing guidelines](CONTRIBUTING.md) for more details.

Commits need a DCO sign-off (`git commit -s`) and a Conventional Commits
subject; both are checked locally by a git hook and again in CI.

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## Code Quality

We use SonarQube Cloud to ensure the code quality of this project.

[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=sto-info-app_sto-info-file-scan-worker&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=sto-info-app_sto-info-file-scan-worker)

## Licence

This project is licensed under the MIT Licence. See the [LICENSE](LICENSE) file for more information.

## Contact

For any enquiries, please contact us at [support@startrekonline.info](mailto:support@startrekonline.info).
