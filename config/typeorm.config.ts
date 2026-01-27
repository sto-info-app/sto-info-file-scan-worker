import { config as dotenvConfig } from 'dotenv';
import { join } from 'node:path';
import { SecretsService } from 'src/shared/secrets/secrets.service';
import { DataSourceOptions } from 'typeorm';

dotenvConfig({ path: './config/environments/.env' });

const secretsService = new SecretsService();

function getDbType(): 'postgres' {
  const dbType = (process.env.DB_TYPE ?? 'postgres').toLowerCase();

  // This project currently supports Postgres only.
  if (dbType !== 'postgres') {
    throw new Error(`Unsupported DB_TYPE: ${dbType}`);
  }

  return 'postgres';
}

export async function getTypeOrmConfig(): Promise<DataSourceOptions> {
  const secretObject = await secretsService.getSecret(
    process.env.AWS_SECRET_NAME,
  );

  const isLocalEnv = process.env.NODE_ENV === 'local';

  // Note: Adjust the relative paths if necessary depending on where this file is run from
  const rootDir = join(__dirname, '../');

  // Use environment variables for paths if provided, otherwise defaults
  const entitiesPattern =
    process.env.TYPEORM_ENTITIES ?? 'src/**/*.entity.{js,ts}';
  const migrationsPattern =
    process.env.TYPEORM_MIGRATIONS ?? 'src/database/migrations/*.{js,ts}';

  const entitiesDir = join(rootDir, entitiesPattern);
  const migrationDir = join(rootDir, migrationsPattern);

  return {
    type: getDbType(),
    host: process.env.DB_HOST,
    port: Number.parseInt(process.env.DB_PORT, 10) || 5432,
    username: process.env.DB_USERNAME,
    password: secretObject.dbPassword, // Use the dbPassword from AWS Secrets Manager
    database: process.env.DB_NAME,
    schema: process.env.DB_SCHEMA,
    entities: [entitiesDir],
    migrations: [migrationDir],
    migrationsTableName: '_migrations',
    synchronize: process.env.TYPEORM_SYNCHRONIZE === 'true',
    logging: process.env.TYPEORM_LOGGING === 'true',
    ssl: isLocalEnv
      ? false
      : {
          rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true',
        },
  };
}
