# sto-info-file-scan-worker

## Project Overview

The `sto-info-file-scan-worker` is a specialized NestJS service responsible for asynchronous processing of file uploads in the STO Info ecosystem. It handles file type validation, antivirus scanning (via Cloudmersive), and interactions with Cloudflare R2 storage. It utilizes BullMQ for job orchestration.

## Features

- **Asynchronous File Scanning**: Offloads processing from the main API.
- **Antivirus Integration**: Scans files using Cloudmersive Virus API.
- **File Type Validation**: Uses `file-type` to verify magic bytes.
- **Queue-based Architecture**: Built on BullMQ and Redis for reliability.
- **R2 Storage Integration**: Manages file storage and metadata.

## Documentation

Documentation is in [docs/](docs/).

- [docs/environment-variables.md](docs/environment-variables.md)
- [docs/infrastructure.md](docs/infrastructure.md)
- [docs/security.md](docs/security.md)
- [docs/worker-architecture.md](docs/worker-architecture.md)
- [docs/queues.md](docs/queues.md)

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
git clone https://github.com/steverobertsuk/sto-info-file-scan-worker.git
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

- `config/environments/template.env`: A template containing all required keys for local development.
- `config/environments/.env`: The active local environment file (not committed).
- `config/environments/.env.example`: A safe example for hosted/production environments.

**Local Setup:**

1. Copy `config/environments/template.env` to `config/environments/.env`.
2. Fill in your local database and Redis details.
3. Provide your AWS credentials to allow the app to pull sensitive secrets (dbPassword, API keys).

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
npm test
```

## Contributing

We welcome contributions! Please read our [contributing guidelines](CONTRIBUTING.md) for more details.

## Code Quality

We use SonarQube Cloud to ensure the code quality of this project.

[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=sto-info-app_sto-info-file-scan-worker&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=sto-info-app_sto-info-file-scan-worker)

## Licence

This project is licensed under the MIT Licence. See the [LICENSE](LICENSE) file for more information.

## Contact

For any enquiries, please contact us at [support@startrekonline.info](mailto:support@startrekonline.info).
