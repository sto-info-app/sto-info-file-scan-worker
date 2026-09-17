import { Injectable } from '@nestjs/common';
import { plainToClass } from 'class-transformer';
import {
  IsBooleanString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsString,
  Matches,
  validateSync,
} from 'class-validator';

class EnvironmentVariables {
  @IsNotEmpty()
  @IsIn(['local', 'dev', 'staging', 'prod'])
  NODE_ENV: string;

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

  @IsNotEmpty()
  @IsNumber()
  APP_PORT: number;

  @IsNotEmpty()
  @IsString()
  @IsIn(['postgres'])
  DB_TYPE: string;

  @IsNotEmpty()
  @IsString()
  DB_HOST: string;

  @IsNotEmpty()
  @IsNumber()
  DB_PORT: number;

  @IsNotEmpty()
  @IsString()
  DB_NAME: string;

  @IsNotEmpty()
  @IsString()
  DB_SCHEMA: string;

  @IsNotEmpty()
  @IsString()
  DB_USERNAME: string;

  @IsNotEmpty()
  @IsBooleanString()
  DB_SSL_REJECT_UNAUTHORIZED: string;

  @IsNotEmpty()
  @IsBooleanString()
  TYPEORM_SYNCHRONIZE: string;

  @IsNotEmpty()
  @IsBooleanString()
  TYPEORM_LOGGING: string;

  @IsNotEmpty()
  @IsString()
  TYPEORM_ENTITIES: string;

  @IsNotEmpty()
  @IsString()
  TYPEORM_MIGRATIONS: string;

  @IsNotEmpty()
  @IsString()
  @Matches(/^rediss?:\/\/.+/, {
    message:
      'REDIS_URL must be a valid Redis connection string (redis:// or rediss://)',
  })
  REDIS_URL: string;

  @IsNotEmpty()
  @IsString()
  AWS_REGION: string;

  @IsNotEmpty()
  @IsString()
  AWS_SECRET_NAME: string;
}

@Injectable()
export class ConfigCheckService {
  constructor() {}

  validateInput(envConfig: Record<string, string>) {
    const config = plainToClass(EnvironmentVariables, envConfig, {
      enableImplicitConversion: true,
    });
    const errors = validateSync(config, { skipMissingProperties: false });

    if (errors.length > 0) {
      throw new Error(`Validation error: ${errors}`);
    }

    return config;
  }

  get(key: string): string {
    return process.env[key];
  }
}
