# Queue Overview

The `sto-info-file-scan-worker` processes jobs from the following queues.

## 1. File Scan Queue (`file-scan`)

This is the primary queue for verifying the safety and integrity of uploaded files.

**Job Data Payload:**

```typescript
interface FileScanJob {
  fileId: string; // UUID of the upload_file record
  bucket: string; // R2 bucket name
  key: string; // R2 object key
  originalName: string;
}
```

**Processor Logic:**

1. Fetch `upload_file` record.
2. Verify magic bytes match expected categories (image, text, csv).
3. Scan for viruses.
4. Update `status` in database.

## 2. Fleet Import Queue (`fleet-import`)

Triggered after a fleet CSV file passes the scan.

**Job Data Payload:**

```typescript
interface FleetImportJob {
  fileId: string;
  fleetId: string;
}
```

**Processor Logic:**

1. Parse the CSV file from R2.
2. Map rows to fleet member entities.
3. Update fleet roster in the database.

## Queue Configuration (Redis)

All queues share a prefix configured via `QUEUE_PREFIX` (default `bull:sto-info:`).

- **Concurrency**: Configured per processor (default is 1).
- **Default Job Options**:
  - `attempts`: 3
  - `backoff`: { type: 'exponential', delay: 1000 }
  - `removeOnComplete`: true (to keep Redis memory usage low)
  - `removeOnFail`: false (for debugging)

## Monitoring Jobs

The jobs can be monitored using tools like **Bull Board** (if implemented/integrated) or by querying the Redis keys directly using `redis-cli`.
