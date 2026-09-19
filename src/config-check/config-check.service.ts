import { Injectable } from '@nestjs/common';

import { plainToInstance } from 'class-transformer';
import {
  IsBooleanString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsString,
  Matches,
  validateSync,
} from 'class-validator';

/**
 * Every environment variable the worker refuses to start without.
 *
 * This class had drifted away from the code it was meant to protect. It
 * validated `CLOUDFLARE_R2_ENDPOINT` and `CLOUDFLARE_R2_BUCKET_NAME` while
 * the object store client read `R2_ENDPOINT` and `R2_BUCKET_NAME`, because
 * the repository carried two environment examples that disagreed with each
 * other. The check therefore passed on variables nothing used, and the ones
 * that mattered were never checked at all — a startup probe that reported
 * healthy while the credentials it had never looked at were absent.
 *
 * There is now one example file, one set of names, and this list. FC-010's
 * fourth acceptance criterion is about credentials and recoverable restart
 * behaviour, and neither claim survives a startup check that validates the
 * wrong thing.
 */
export class EnvironmentVariables {
  /** Which environment this is. */
  @IsNotEmpty()
  @IsIn(['local', 'dev', 'staging', 'prod'])
  NODE_ENV: string;

  /** Which levels are logged. */
  @IsNotEmpty()
  @IsString()
  @Matches(
    /^(error|warn|log|debug|verbose)(,(error|warn|log|debug|verbose))*$/,
    {
      message:
        'LOG_LEVEL must be one of error,warn,log,debug,verbose (optionally comma-separated)',
    },
  )
  LOG_LEVEL: string;

  /** The port the health probes listen on. */
  @IsNotEmpty()
  @IsNumber()
  APP_PORT: number;

  /** The database engine. Postgres, and only Postgres. */
  @IsNotEmpty()
  @IsString()
  @IsIn(['postgres'])
  DB_TYPE: string;

  /** Where the database is. */
  @IsNotEmpty()
  @IsString()
  DB_HOST: string;

  /** Which port it listens on. */
  @IsNotEmpty()
  @IsNumber()
  DB_PORT: number;

  /** The database, which is shared with the backend. */
  @IsNotEmpty()
  @IsString()
  DB_NAME: string;

  /** The schema this repository owns. Checked again against the migrations. */
  @IsNotEmpty()
  @IsString()
  DB_SCHEMA: string;

  /** The worker's own least-privilege role. */
  @IsNotEmpty()
  @IsString()
  DB_USERNAME: string;

  /** Whether to verify the database's certificate. */
  @IsNotEmpty()
  @IsBooleanString()
  DB_SSL_REJECT_UNAUTHORIZED: string;

  /** Where Redis is, for the two queues. */
  @IsNotEmpty()
  @IsString()
  REDIS_URL: string;

  /** The account endpoint the quarantine bucket is reached through. */
  @IsNotEmpty()
  @IsString()
  CLOUDFLARE_R2_ENDPOINT: string;

  /** The private bucket uploaded bytes are quarantined in. */
  @IsNotEmpty()
  @IsString()
  CLOUDFLARE_R2_QUARANTINE_BUCKET_NAME: string;

  /** The region the secret lives in. */
  @IsNotEmpty()
  @IsString()
  AWS_REGION: string;

  /** The secret holding the database password and the R2 read credentials. */
  @IsNotEmpty()
  @IsString()
  AWS_SECRET_NAME: string;
}

/**
 * Refuses to let the worker start on an environment it cannot work in.
 *
 * Deliberately separate from {@link readWorkerSettings}, which checks the
 * relationships between values — that a heartbeat is shorter than a lease,
 * that the schema matches the migrations. This checks that the values exist
 * and are the right shape. Both run before anything connects to anything.
 */
@Injectable()
export class ConfigCheckService {
  /**
   * Validates the environment.
   *
   * @param environment - The environment to check.
   * @returns The checked environment.
   * @throws Error naming every variable that is wrong.
   */
  validateInput(environment: NodeJS.ProcessEnv): EnvironmentVariables {
    const validated = plainToInstance(EnvironmentVariables, environment, {
      enableImplicitConversion: true,
    });

    const errors = validateSync(validated, {
      skipMissingProperties: false,
    });

    if (errors.length > 0) {
      throw new Error(errors.map(error => error.toString()).join('\n'));
    }

    return validated;
  }
}
