-- The backend's schema, as a stand-in.
--
-- This repository does not migrate sto_info_app and must not: ADR-0006 gives
-- each side its own tables and forbids either from touching the other's. What
-- the rehearsal needs is something for the cross-schema foreign key to point
-- at, carrying only the column that key uses.
CREATE SCHEMA "sto_info_app";

CREATE TABLE "sto_info_app"."file_asset" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  CONSTRAINT "PK_file_asset" PRIMARY KEY ("id"));
