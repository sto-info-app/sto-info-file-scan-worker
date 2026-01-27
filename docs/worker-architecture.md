# Worker Architecture Documentation

## Core Workflow

The `sto-info-file-scan-worker` operates on a producer-consumer model using **BullMQ**.

1. **Producer (Main API)**: Receives a file upload, stores the original file in a temporary R2 location, and pushes a job to the `file-scan` queue.
2. **Consumer (Worker)**:
   - Picks up a job from Redis.
   - Downloads the file metadata from the database.
   - Performs **Magic Byte Validation** to verify the file type.
   - Sends the file to the **Antivirus Scanner**.
   - Updates the database with the scan result (`passed`, `failed`, `virus_detected`).
   - If configured (`ENQUEUE_NEXT_ON_PASSED`), triggers the next job (e.g., `fleet-import`).

## Technology Stack

- **Framework**: NestJS (v11)
- **Job Queue**: BullMQ (running on Redis)
- **Database**: TypeORM + PostgreSQL
- **Storage**: @aws-sdk/client-s3 (Cloudflare R2)
- **Validation**: `file-type`, `class-validator`
- **Secrets**: `AWS Secrets Manager`

## Module Structure

- `SharedModule`: Provides `SecretsService` for retrieving configuration from AWS.
- `R2Module`: Handles communication with Cloudflare R2 storage.
- `QueueModule`: Contains the BullMQ processors and listeners.
- `HealthModule`: Provides HTTP endpoints for infrastructure monitoring.
- `DatabaseModule`: Ensures database consistency (e.g. UTC timezone).

## Middleware & Interceptors

Since the worker is not a public-facing API, many standard web middlewares (CORS, Helmet) are omitted. However, it still uses:

- **ConfigCheckService**: Runs at bootstrap to ensure all required environment variables and secrets are present.
- **ValidationPipe**: Used for internal job payload validation (if applicable).

## Logging Strategy

The application uses NestJS's built-in `Logger`.

- **Log Levels**: Controlled via `LOG_LEVEL` env var.
- **Context**: Every log includes the class name and, where applicable, the Job ID for easy tracking in logs.

## Error Handling & Retries

BullMQ is configured to handle retries for transient failures (e.g., network blips to R2 or Cloudmersive).

- **Backoff**: Exponential backoff is used to avoid spamming failed services.
- **Dead Letter Queue**: Jobs that fail after the maximum number of retries are moved to a "failed" state in Redis for manual inspection.
