# Environment variables (Worker)

This document lists the environment variables used by the `sto-info-file-scan-worker` at runtime.

## Environment files

- `config/environments/template.env`: The master template for local development.
- `config/environments/.env`: The active local environment file (use for `local` development; git-ignored).
- `config/environments/.env.example`: A safe example for hosted/production environments like Render.com.

The app reads `config/environments/.env` at startup via the `dotenv` call in `src/main.ts`.

## Required

### Application

- `NODE_ENV`: `local` | `dev` | `staging` | `prod`
- `LOG_LEVEL`: `error` | `warn` | `log` | `debug` | `verbose` (optionally comma-separated)
- `APP_PORT`: Port the internal health check server listens on (default is `3000`)
- `APP_TITLE`: "Star Trek Online Info File Scan Worker"

### Database (TypeORM)

- `DB_TYPE`: `postgres`
- `DB_HOST`: Hostname
- `DB_PORT`: Port (usually `5432`)
- `DB_NAME`: Database name
- `DB_SCHEMA`: Schema name
- `DB_USERNAME`: Database username
- `DB_SSL_REJECT_UNAUTHORIZED`: `true` | `false`
- `TYPEORM_SYNCHRONIZE`: `true` | `false` (should be `false` in production)
- `TYPEORM_LOGGING`: `true` | `false`
- `TYPEORM_ENTITIES`: Glob relative to the built root (e.g. `src/**/*.entity.{js,ts}`)
- `TYPEORM_MIGRATIONS`: Glob relative to the built root (e.g. `src/database/migrations/*.{js,ts}`)

### Redis (BullMQ)

- `REDIS_URL`: Full connection string for Redis (e.g. `redis://localhost:6379`).
- `QUEUE_PREFIX`: Prefix for BullMQ keys (default: `bull:sto-info:`)
- `FILE_SCAN_QUEUE`: Name of the file scan queue (default: `file-scan`)
- `FLEET_IMPORT_QUEUE`: Name of the fleet import queue (default: `fleet-import`)
- `ENQUEUE_NEXT_ON_PASSED`: `true` | `false` (whether to trigger the next job in the sequence)

### AWS Secrets Manager

- `AWS_ACCESS_KEY_ID`: Used to access Secrets Manager
- `AWS_SECRET_ACCESS_KEY`: Used to access Secrets Manager
- `AWS_REGION`: Region for Secrets Manager
- `AWS_SECRET_NAME`: Name/ARN of the secret containing application secrets

### Cloudflare R2 (S3 compatible)

- `CLOUDFLARE_R2_ENDPOINT`: R2 S3-compatible endpoint URL
- `CLOUDFLARE_R2_BUCKET_NAME`: R2 bucket name

### Limits & Scanning

- `MAX_FILE_BYTES`: Maximum file size to process (defaults to 10MB)
- `SCAN_TIMEOUT_MS`: Timeout for AV scanning (e.g. 120000ms)
- `VALIDATION_READ_BYTES`: How many bytes to read for magic-byte validation (e.g. 262144)
- `CLAMAV_MODE`: `clamscan` or `instream` (if using local ClamAV)
- `CLAMAV_PATH`: Path to clamscan binary

## Optional

- `TRUST_PROXY_HOPS`: Express trust proxy hops (default is `1`)
- `STARTUP_DIAGNOSTICS`: `true` | `false` (default `false`). Logs memory usage at startup.

## AWS Secrets Manager secret shape

The secret referenced by `AWS_SECRET_NAME` is expected to be JSON with at least:

- `dbPassword`: Used for the PostgreSQL password
- `cloudflareR2AccessKey`: Used to access R2
- `cloudflareR2Secret`: Used to access R2
- `cloudmersiveApiKey`: Used for virus scanning (if using Cloudmersive integration)

## Validation

- Startup validation runs via `ConfigCheckService`; missing or invalid required values will prevent the worker from starting.
