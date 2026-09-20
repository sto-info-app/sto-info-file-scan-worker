import { DataSource, DataSourceOptions } from 'typeorm';

import { WORKER_DATABASE_SCHEMA } from '../src/config/worker-settings';
import { getTypeOrmConfig } from './typeorm.config';

/**
 * Creates this repository's schema if it is absent.
 *
 * TypeORM writes its migrations table before it reads a single migration,
 * and that table lives in `sto_info_worker`. So the migration that creates
 * the schema cannot be the thing that creates it: against an empty database
 * the runner fails with `3F000 schema "sto_info_worker" does not exist`
 * before any migration is considered, and fails again on every retry.
 *
 * The migration rehearsal cannot catch this. It applies the migration's SQL
 * directly rather than through TypeORM, so it exercises the migration and
 * not the runner that has to go first.
 *
 * `CREATE SCHEMA IF NOT EXISTS` stays in the migration as well. This is the
 * bootstrap; that is still the statement of ownership, and it is what the
 * rehearsal proves.
 *
 * @param options - The datasource this runs ahead of.
 */
async function ensureSchemaExists(options: DataSourceOptions): Promise<void> {
  // Without a schema of its own, and with nothing to load: this connection
  // exists to run one statement, and pointing it at the schema it is about
  // to create would defeat the purpose.
  // DataSourceOptions is a union across every driver, and spreading one
  // widens it until `schema` belongs to none of them. getTypeOrmConfig
  // refuses anything but postgres, so the shape is known.
  const bootstrap = new DataSource({
    ...options,
    schema: undefined,
    entities: [],
    migrations: [],
  } as DataSourceOptions);

  await bootstrap.initialize();

  try {
    // WORKER_DATABASE_SCHEMA is a constant in this repository, not input.
    await bootstrap.query(
      `CREATE SCHEMA IF NOT EXISTS "${WORKER_DATABASE_SCHEMA}"`,
    );
  } finally {
    await bootstrap.destroy();
  }
}

export const connectionSourcePromise = getTypeOrmConfig().then(async config => {
  await ensureSchemaExists(config);

  return new DataSource(config);
});
