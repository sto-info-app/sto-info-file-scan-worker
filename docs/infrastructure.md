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

The worker connects to the same managed PostgreSQL instance as the main backend to update file scan results and metadata.

### Redis (Managed)

- **Service Type**: Redis (Managed)
- **Usage**:
  - **BullMQ Orchestration**: Stores job data, state, and concurrency locks for the file scanning and import queues.

## Cloudflare

### R2 Storage

- **Purpose**: Stores the actual uploaded files.
- **Worker Role**: Downloads files from R2 for scanning and moves/deletes them based on scan results.

## Health Checks

The worker provides a lightweight HTTP server (port `3000` by default) for health monitoring:

- `GET /health/ready`: Readiness check (checks database and Redis connectivity).
- `GET /health/live`: Liveness check.

## Scaling

- **Concurrency**: The worker is configured (via BullMQ) to handle a specific number of concurrent jobs.
- **Instances**: Multiple instances can be deployed to scale out processing power, as BullMQ handles job distribution across multiple workers.

## Troubleshooting

### Logs

Logs are accessible via the Render dashboard. Key things to monitor:

- Job timeouts.
- Cloudmersive API connection errors.
- R2 access denials.
- BullMQ lock expiration warnings.
