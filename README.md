# sto-info-file-scan-worker

A NestJS worker service that performs **file type/content validation first**, then **antivirus scanning (ClamAV)**.  
It updates scan status in PostgreSQL and can optionally enqueue the downstream import job after a clean scan.

## Responsibilities
- Download uploaded file from Cloudflare R2 to a temp path
- Validate that the file matches the expected type (e.g. `FLEET_CSV`)
- If validation passes, run ClamAV scan
- Persist scan results to PostgreSQL
- (Optional) enqueue the next job on `PASSED`

## Non-responsibilities
- **No deletion from R2** (handled by import worker or maintenance cleanup)
- No user-facing API beyond `/health`

## Setup
1. Copy `.env.example` to `.env` and fill in values
2. Install deps: `npm ci`
3. Build: `npm run build`
4. Run: `npm start`

## Notes
- This repo assumes an `upload_files` table exists. If you already store upload rows elsewhere (e.g. fleet_import_files),
  update the entity mapping accordingly.
- For production, prefer TypeORM migrations over `synchronize`.
