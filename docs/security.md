# Security Documentation (Worker)

## File Scan Security

### Magic Byte Validation

The worker uses the `file-type` library to inspect the first few hundred KB of a file to determine its "real" MIME type based on magic bytes. This prevents "extension spoofing" attacks.

### Antivirus Scanning

All uploaded files are scanned at the bit-level using the Cloudmersive Virus API (or local ClamAV as configured). Files that contain viruses or malware are immediately flagged and prevented from reaching the production file system.

### R2 Access Control

The worker uses short-lived or scoped credentials (managed via AWS Secrets Manager) to access the R2 bucket. Access is restricted to the specific bucket used for uploads.

## Secret Management

All sensitive credentials (DB passwords, API keys) are retrieved at runtime from **AWS Secrets Manager**. No secrets are stored in the codebase or plain environment variables (except for the AWS access keys themselves).

## Database Security

- **Parameterization**: TypeORM is used for all database interactions to prevent SQL injection.
- **Least Privilege**: The worker's DB user should only have permissions on the specific tables it needs to modify (e.g., `upload_file`).

## Logging

Sensitive information (passwords, full API keys, raw file content) is **never** logged. The worker logs job IDs, file metadata, and high-level scan results.

## Rate Limiting (Queue Level)

While the worker doesn't have public API endpoints, BullMQ provides internal rate limiting and concurrency controls to prevent the worker from overwhelming third-party APIs (like Cloudmersive) or the database.
