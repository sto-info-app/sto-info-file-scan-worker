import { Readable } from 'node:stream';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { WORKER_SETTINGS, WorkerSettings } from '../config/worker-settings';

/** The injection token for the quarantine bucket's own S3 client. */
export const QUARANTINE_S3_CLIENT = Symbol('QUARANTINE_S3_CLIENT');

/**
 * Raised when the object a message names is not in quarantine.
 *
 * A refusal rather than a retry. The key is built from the asset's own
 * identifier and never reused, so an object that is not there will not turn
 * up later — it was never written, or the retention cron has already taken
 * it. Retrying would mean asking the same question until a budget ran out.
 */
export class QuarantineObjectMissingError extends Error {
  /**
   * Creates an instance of QuarantineObjectMissingError.
   *
   * @param objectKey - The key that was asked for.
   */
  constructor(public readonly objectKey: string) {
    super(`No such object in quarantine: ${objectKey}`);
    this.name = 'QuarantineObjectMissingError';
  }
}

/** The S3 error codes that mean the object is not there. */
const MISSING_OBJECT_CODES: ReadonlySet<string> = new Set([
  'NoSuchKey',
  'NotFound',
]);

/**
 * Reads objects out of the private quarantine bucket.
 *
 * **The only way bytes enter this process.** A job message names an object
 * key and nothing else — no URL, no bucket, no endpoint, no credentials —
 * and this service resolves all of those from the worker's own configuration.
 * That is what the first acceptance criterion means by "never arbitrary URLs"
 * and it is why there is no SSRF surface to defend: there is no code path in
 * which a message can influence where a request goes.
 *
 * The bucket is the backend's quarantine bucket (ADR-0016, ADR-0017), reached
 * with the worker's own read-only credentials. It cannot write, it cannot
 * delete, and it cannot reach the delivery bucket at all. A scanner that
 * could modify what it scans is a scanner whose verdict means nothing.
 */
@Injectable()
export class QuarantineObjectService {
  private readonly _logger = new Logger(QuarantineObjectService.name);

  /**
   * Creates an instance of QuarantineObjectService.
   *
   * @param _s3Client - The quarantine bucket's own S3 client.
   * @param _settings - The worker's settings.
   */
  constructor(
    @Inject(QUARANTINE_S3_CLIENT) private readonly _s3Client: S3Client,
    @Inject(WORKER_SETTINGS) private readonly _settings: WorkerSettings,
  ) {}

  /**
   * Opens a stream of an object's bytes.
   *
   * @param objectKey - The key, taken from the registry's own record.
   * @param objectVersion - The store's version, when it has one.
   * @returns The object's bytes.
   * @throws QuarantineObjectMissingError when there is no such object.
   * @throws Error when the store could not be reached.
   */
  async getStream(
    objectKey: string,
    objectVersion: string | null,
  ): Promise<Readable> {
    try {
      const response = await this._s3Client.send(
        new GetObjectCommand({
          Bucket: this._settings.quarantineBucket,
          Key: objectKey,
          ...(objectVersion === null ? {} : { VersionId: objectVersion }),
        }),
      );

      if (!response.Body) {
        throw new QuarantineObjectMissingError(objectKey);
      }

      return response.Body as Readable;
    } catch (error) {
      if (isMissingObject(error)) {
        this._logger.warn(`[getStream] Object absent - Key: ${objectKey}`);

        throw new QuarantineObjectMissingError(objectKey);
      }

      throw error;
    }
  }
}

/**
 * Reports whether a failure means the object is not there.
 *
 * @param error - Whatever the store threw.
 * @returns True when the object is absent rather than unreachable.
 */
function isMissingObject(error: unknown): boolean {
  if (error instanceof QuarantineObjectMissingError) {
    return true;
  }

  const name = (error as { name?: string })?.name;
  const status = (error as { $metadata?: { httpStatusCode?: number } })
    ?.$metadata?.httpStatusCode;

  return (
    (typeof name === 'string' && MISSING_OBJECT_CODES.has(name)) ||
    status === 404
  );
}
