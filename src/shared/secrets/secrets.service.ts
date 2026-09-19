import { Injectable, Logger } from '@nestjs/common';

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

/**
 * What the worker expects to find in its secret.
 *
 * ADR-0006 decision 5 retained AWS Secrets Manager as the worker's mechanism
 * and required its database and object-store credentials to be
 * least-privilege. The two R2 values are named `Read` because that is all
 * the token behind them may do: the worker has no credential that can write
 * to quarantine, delete from it, or reach the bucket the site delivers from.
 */
export interface WorkerSecret {
  /** The password for the worker's own database role. */
  readonly dbPassword: string;
  /** A read-only key for the quarantine bucket. */
  readonly cloudflareR2QuarantineReadKey: string;
  /** Its secret. */
  readonly cloudflareR2QuarantineReadSecret: string;
}

/**
 * Fetches the worker's secret, once.
 *
 * Cached for the life of the process. The credentials do not change while it
 * runs, and asking Secrets Manager on every scan would put an external
 * dependency in the path of every upload.
 */
@Injectable()
export class SecretsService {
  private readonly _secretsManager: SecretsManagerClient;
  private readonly _cache = new Map<string, WorkerSecret>();
  private readonly _logger = new Logger(SecretsService.name);

  /** Creates an instance of SecretsService. */
  constructor() {
    this._secretsManager = new SecretsManagerClient({
      region: process.env.AWS_REGION,
    });
  }

  /**
   * Reads a secret.
   *
   * @param secretName - The secret to read.
   * @returns Its contents.
   * @throws Error when it cannot be read or holds no string.
   */
  async getSecret(secretName: string): Promise<WorkerSecret> {
    const cached = this._cache.get(secretName);

    if (cached !== undefined) {
      return cached;
    }

    try {
      const data = await this._secretsManager.send(
        new GetSecretValueCommand({ SecretId: secretName }),
      );

      if (data.SecretString === undefined) {
        throw new Error(`Secret holds no string: ${secretName}`);
      }

      const secret = JSON.parse(data.SecretString) as WorkerSecret;
      this._cache.set(secretName, secret);

      return secret;
    } catch (error) {
      // The name, never the contents. A secret that reaches a log has
      // stopped being a secret, and a failure to read one is exactly the
      // moment somebody is tempted to print it.
      this._logger.error(`[getSecret] Could not read secret: ${secretName}`);

      throw error;
    }
  }
}
