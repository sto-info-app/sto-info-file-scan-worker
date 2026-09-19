import { join } from 'node:path';

import { config as dotenvConfig } from 'dotenv';
import { DataSourceOptions } from 'typeorm';

import { WORKER_DATABASE_SCHEMA } from '../src/config/worker-settings';
import { SecretsService } from '../src/shared/secrets/secrets.service';

dotenvConfig({ path: './config/environments/.env' });

const secretsService = new SecretsService();

/**
 * Reads a variable that must be present.
 *
 * @param variable - The variable to read.
 * @returns Its value.
 * @throws Error when it is absent.
 */
function required(variable: string): string {
  const value = process.env[variable];

  if (value === undefined || value.trim() === '') {
    throw new Error(`${variable} must be set`);
  }

  return value.trim();
}

/**
 * Confirms the database engine is one this application supports.
 *
 * @returns The engine.
 * @throws Error when it is anything else.
 */
function getDbType(): 'postgres' {
  const dbType = (process.env.DB_TYPE ?? 'postgres').toLowerCase();

  if (dbType !== 'postgres') {
    throw new Error(`Unsupported DB_TYPE: ${dbType}`);
  }

  return 'postgres';
}

/**
 * Builds the worker's datasource.
 *
 * Two things here are not what they were, and both follow from ADR-0006's
 * split of schema ownership.
 *
 * **Synchronise is gone.** It is not merely defaulted to false; the option
 * is not read at all. The worker shares a database with the backend, and
 * synchronise against a shared database is a process that will drop another
 * application's columns to make the schema match its own entities. The one
 * table this repository owns now has a migration, so nothing is lost.
 *
 * **The migration table is namespaced by the schema.** Both repositories
 * call theirs `_migrations`, and before this they would have shared one:
 * each would have read the other's history as its own and refused to apply
 * migrations it had never run. Separate schemas settle it.
 *
 * @returns The datasource options.
 */
export async function getTypeOrmConfig(): Promise<DataSourceOptions> {
  const secretObject = await secretsService.getSecret(
    required('AWS_SECRET_NAME'),
  );

  const isLocalEnv = process.env.NODE_ENV === 'local';
  const rootDir = join(__dirname, '../');

  const entitiesPattern =
    process.env.TYPEORM_ENTITIES ?? 'src/**/*.entity.{js,ts}';
  const migrationsPattern =
    process.env.TYPEORM_MIGRATIONS ?? 'src/database/migrations/*.{js,ts}';

  return {
    type: getDbType(),
    host: required('DB_HOST'),
    port: Number.parseInt(process.env.DB_PORT ?? '', 10) || 5432,
    username: required('DB_USERNAME'),
    password: secretObject.dbPassword,
    database: required('DB_NAME'),
    schema: WORKER_DATABASE_SCHEMA,
    entities: [join(rootDir, entitiesPattern)],
    migrations: [join(rootDir, migrationsPattern)],
    migrationsTableName: '_migrations',
    synchronize: false,
    logging: process.env.TYPEORM_LOGGING === 'true',
    ssl: isLocalEnv
      ? false
      : {
          rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true',
        },
  };
}
