# Database Documentation (PostgreSQL)

## Schema Overview

The worker shares the main PostgreSQL database with the backend, but its primary focus is on the file management tables.

### Main Entities

- **UploadFileEntity**: Tracks the lifecycle of a file upload.
  - `id`: UUID (Primary Key)
  - `status`: Enum (`pending`, `passed`, `failed`, `virus_detected`)
  - `mimeType`: The actual MIME type detected by the worker.
  - `originalName`: Original filename.
  - `bucket`: R2 bucket name.
  - `key`: R2 object key.
  - `size`: File size in bytes.
  - `scanResult`: Detailed JSON output from the virus scanner.

## Migrations

All schema changes must be parity with the main backend. In this repository, we use migrations to manage any worker-specific tables or to ensure the local dev database matches production.

### Commands

```bash
npm run migration:generate -- -n MigrationName
npm run migration:run
npm run migration:revert
```

## Timezone

The worker sets the database timezone to **UTC** on startup to ensure consistency across all timestamps.

```typescript
await this.dataSource.query("SET TIME ZONE 'UTC'");
```

## Data Retention

Since the worker handles temporary file processing:

1. **Successful Scans**: Metadata is retained; the file may be moved to a permanent location.
2. **Failed/Virus Scans**: Metadata is retained for audit purposes; the file should be deleted from R2 immediately.

> TODO: Implement and document a cleanup job for orphaned R2 objects that failed the scan.
