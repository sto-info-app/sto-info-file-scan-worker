import { Inject, Injectable, Logger } from '@nestjs/common';

import { WORKER_SETTINGS, WorkerSettings } from '../../config/worker-settings';
import {
  ScanRejectionCode,
  ScanRequestMessage,
  ScanVerdictMessage,
} from '../../contract/file-scan-contract';
import {
  declarationHolds,
  sniffContentType,
} from '../../quarantine/content-sniff';
import {
  MeasuredStream,
  ObjectTooLargeError,
} from '../../quarantine/measured-stream';
import {
  QuarantineObjectMissingError,
  QuarantineObjectService,
} from '../../quarantine/quarantine-object.service';
import {
  EngineHealthService,
  EngineUnfitError,
} from '../../scanning/engine-health.service';
import {
  SCAN_ENGINE,
  ScanEngine,
  ScanEngineDescription,
} from '../../scanning/scan-engine.interface';
import { FileScanAttemptEntity } from '../entities/file-scan-attempt.entity';
import { FileScanAttemptState } from '../enums/file-scan-attempt-state.enum';
import { buildVerdictMessage } from '../verdict-from-attempt';
import {
  AttemptCompletion,
  FileScanAttemptService,
} from './file-scan-attempt.service';

/** What reading and scanning one object concluded, before it is recorded. */
interface ScanConclusion {
  /** The state the attempt should finish in. */
  readonly state: FileScanAttemptState;
  /** Why it refused, when it did. */
  readonly rejectionCode: ScanRejectionCode | null;
  /** What went wrong, for an administrator. */
  readonly failureReason: string | null;
  /** The hash of what was read, when it was read in full. */
  readonly observedSha256: string | null;
  /** How many bytes were read. */
  readonly byteSize: number | null;
  /** What the first bytes looked like. */
  readonly detectedContentType: string | null;
}

/**
 * Reads one object out of quarantine, scans it, and records what happened.
 *
 * The whole of the worker's job, and it is deliberately the only place that
 * knows the order of the steps. Everything it calls is narrow: the attempt
 * service knows about leases and knows nothing about scanners, the engine
 * knows about bytes and knows nothing about the database, and this reads as a
 * sequence because that is what it is.
 *
 * Three properties are worth reading the code for.
 *
 * **Nothing is published from here.** The most this service can do is write a
 * row and hand a verdict to the queue. `AVAILABLE` is not reachable from this
 * repository at all — ADR-0015 decision 3, and ADR-0006's "no public callback
 * can mark a file clean" expressed as an absence rather than as a check.
 *
 * **The hash decides, not the scanner.** An affirmative clean answer about
 * bytes that are not the bytes the registry recorded is refused. That covers
 * the case the second acceptance criterion is really about: an object
 * replaced between the request being queued and the object being read.
 *
 * **Every failure lands somewhere final or somewhere retryable, never
 * nowhere.** The one exception is a lost lease, where saying nothing is the
 * correct answer because another worker now owns the question.
 *
 * **A scanner that is not fit to judge is refused before anything is
 * claimed.** Stale signatures used to be recorded as a failed attempt, which
 * spent one of the asset's three tries on a fault that was ours; now the
 * whole job is turned away and waits — ADR-0020. Nothing here records a
 * verdict that a scanner did not actually reach.
 */
@Injectable()
export class FileScanService {
  private readonly _logger = new Logger(FileScanService.name);

  /**
   * Creates an instance of FileScanService.
   *
   * @param _attempts - The attempt record.
   * @param _quarantine - The private bucket.
   * @param _engine - The scanner.
   * @param _health - What the scanner last said about itself.
   * @param _settings - The worker's settings.
   */
  constructor(
    private readonly _attempts: FileScanAttemptService,
    private readonly _quarantine: QuarantineObjectService,
    @Inject(SCAN_ENGINE) private readonly _engine: ScanEngine,
    private readonly _health: EngineHealthService,
    @Inject(WORKER_SETTINGS) private readonly _settings: WorkerSettings,
  ) {}

  /**
   * Handles one scan request.
   *
   * @param request - The message, already checked against the contract.
   * @returns The verdict to send, or null when there is nothing to say.
   * @throws Error when the scanner cannot be reached at all, so that the
   *   message is redelivered rather than answered.
   */
  async scan(request: ScanRequestMessage): Promise<ScanVerdictMessage | null> {
    const health = this._health.current();

    if (!health.healthy || health.description === null) {
      // Before the claim, and that is the whole point. An unfit scanner is
      // our fault, not the file's, and a file must not spend one of its
      // three attempts on it.
      throw new EngineUnfitError(
        health.reason ?? 'The scanner cannot be trusted',
      );
    }

    const description = health.description;
    const claim = await this._attempts.claim(request, description);

    switch (claim.kind) {
      case 'BUSY':
        this._logger.log(
          `[scan] Another worker holds this attempt - AssetId: ${request.assetId}`,
        );

        return null;

      case 'DUPLICATE':
        this._logger.log(
          `[scan] Repeating a finished verdict - AssetId: ${request.assetId}`,
        );

        return buildVerdictMessage(claim.attempt, request.traceId);

      case 'EXHAUSTED':
        return buildVerdictMessage(claim.attempt, request.traceId);

      default:
        return this.runAttempt(request, description, claim.attempt);
    }
  }

  /**
   * Reads the object, scans it and records the answer.
   *
   * @param request - The message.
   * @param description - What the scanner says it is.
   * @param attempt - The claimed attempt.
   * @returns The verdict to send, or null when the lease was lost.
   */
  private async runAttempt(
    request: ScanRequestMessage,
    description: ScanEngineDescription,
    attempt: FileScanAttemptEntity,
  ): Promise<ScanVerdictMessage | null> {
    const leaseToken = attempt.leaseToken as string;

    if (!(await this._attempts.markScanning(attempt.id, leaseToken))) {
      return null;
    }

    const conclusion = await this.readAndScan(request, attempt.id, leaseToken);

    const completion: AttemptCompletion = {
      ...conclusion,
      engineVersion: description.engineVersion,
      signatureVersion: description.signatureVersion,
    };

    const finished = await this._attempts.complete(
      attempt.id,
      leaseToken,
      completion,
    );

    if (finished === null) {
      return null;
    }

    return buildVerdictMessage(finished, request.traceId);
  }

  /**
   * Streams the object past a hash and into the scanner.
   *
   * @param request - The message.
   * @param attemptId - The attempt, for the heartbeat.
   * @param leaseToken - The token the claim issued.
   * @returns What the attempt concluded.
   */
  private async readAndScan(
    request: ScanRequestMessage,
    attemptId: string,
    leaseToken: string,
  ): Promise<ScanConclusion> {
    const measured = new MeasuredStream(this._settings.maxObjectBytes);
    const beating = this.startHeartbeat(attemptId, leaseToken, measured);

    try {
      const source = await this._quarantine.getStream(
        request.objectKey,
        request.objectVersion,
      );

      source.on('error', error => measured.destroy(error));
      source.pipe(measured);

      const result = await this._engine.scan(measured);

      return this.conclude(request, measured, result.outcome, result.detail);
    } catch (error) {
      return this.concludeFromFailure(error, measured);
    } finally {
      clearInterval(beating);
      measured.destroy();
    }
  }

  /**
   * Turns a scanner's answer into an attempt's outcome.
   *
   * @param request - The message.
   * @param measured - The stream that counted and hashed.
   * @param outcome - What the scanner said.
   * @param detail - What it said about it, for an administrator.
   * @returns What the attempt concluded.
   */
  private conclude(
    request: ScanRequestMessage,
    measured: MeasuredStream,
    outcome: string,
    detail: string | null,
  ): ScanConclusion {
    if (measured.exceeded) {
      return refuse(
        'SIZE_LIMIT_EXCEEDED',
        `Larger than ${this._settings.maxObjectBytes} bytes`,
        measured,
      );
    }

    if (outcome === 'UNAVAILABLE') {
      return {
        state: FileScanAttemptState.FAILED,
        rejectionCode: null,
        failureReason: detail,
        observedSha256: null,
        byteSize: measured.byteSize,
        detectedContentType: sniffContentType(measured.prefix),
      };
    }

    const observedSha256 = measured.digest();

    if (observedSha256 !== request.expectedSha256) {
      // Checked before the verdict is read, and checked even when the
      // scanner said the bytes were clean. A clean answer about the wrong
      // object is worse than no answer, because it looks like one.
      this._logger.warn(
        `[conclude] Bytes are not the ones recorded - AssetId: ${request.assetId}`,
      );

      return refuse(
        'HASH_MISMATCH',
        'The object did not hash to the value the registry recorded',
        measured,
        observedSha256,
      );
    }

    if (outcome === 'INFECTED') {
      return refuse('INFECTED', detail, measured, observedSha256);
    }

    if (outcome === 'UNSUPPORTED') {
      return refuse('UNSUPPORTED_PAYLOAD', detail, measured, observedSha256);
    }

    if (!declarationHolds(request.declaredContentType, measured.prefix)) {
      // Last of the refusals, and deliberately so: a file that is both
      // infected and misdescribed is reported as infected, because that is
      // the more useful thing for an administrator to be told. This one is
      // reached only by bytes a scanner was willing to call clean.
      this._logger.warn(
        `[conclude] Bytes are not what was declared - AssetId: ${request.assetId}`,
      );

      return refuse(
        'CONTENT_TYPE_MISMATCH',
        `Declared ${request.declaredContentType}; the bytes read as ` +
          `${sniffContentType(measured.prefix) ?? 'nothing recognised'}`,
        measured,
        observedSha256,
      );
    }

    return {
      state: FileScanAttemptState.CLEAN,
      rejectionCode: null,
      failureReason: null,
      observedSha256,
      byteSize: measured.byteSize,
      detectedContentType: sniffContentType(measured.prefix),
    };
  }

  /**
   * Turns a failure part way through into an attempt's outcome.
   *
   * The three causes are told apart by type rather than by message, because
   * two of them are final and one is not. An object that is not there will
   * not appear later and an object that is too large will not shrink, so both
   * are refusals; anything else is the store or the network having a bad
   * moment, and that is worth asking again.
   *
   * @param error - Whatever went wrong.
   * @param measured - The stream that counted what arrived.
   * @returns What the attempt concluded.
   */
  private concludeFromFailure(
    error: unknown,
    measured: MeasuredStream,
  ): ScanConclusion {
    if (error instanceof QuarantineObjectMissingError) {
      return refuse('OBJECT_MISSING', 'Not present in quarantine', null);
    }

    if (error instanceof ObjectTooLargeError || measured.exceeded) {
      return refuse(
        'SIZE_LIMIT_EXCEEDED',
        `Larger than ${this._settings.maxObjectBytes} bytes`,
        measured,
      );
    }

    const reason = error instanceof Error ? error.message : 'Unknown failure';

    this._logger.warn(`[concludeFromFailure] Attempt failed - ${reason}`);

    return {
      state: FileScanAttemptState.FAILED,
      rejectionCode: null,
      failureReason: reason,
      observedSha256: null,
      byteSize: measured.byteSize,
      detectedContentType: sniffContentType(measured.prefix),
    };
  }

  /**
   * Keeps the lease alive while the scanner works, and gives up when it
   * cannot.
   *
   * A heartbeat that fails means another worker has taken the attempt. The
   * read is torn down at that point rather than allowed to finish: the answer
   * would be discarded by the compare-and-set anyway, and finishing it would
   * mean two workers reading the same object at once for no reason.
   *
   * @param attemptId - The attempt.
   * @param leaseToken - The token the claim issued.
   * @param measured - The stream to tear down if the lease goes.
   * @returns The timer, for the caller to clear.
   */
  private startHeartbeat(
    attemptId: string,
    leaseToken: string,
    measured: MeasuredStream,
  ): NodeJS.Timeout {
    const timer = setInterval(() => {
      void this._attempts
        .heartbeat(attemptId, leaseToken)
        .then(held => {
          if (!held) {
            this._logger.warn(
              `[startHeartbeat] Lease gone; stopping - AttemptId: ${attemptId}`,
            );
            measured.destroy(new Error('The lease was taken'));
          }
        })
        .catch(() =>
          measured.destroy(new Error('The lease could not be held')),
        );
    }, this._settings.heartbeatMs);

    timer.unref?.();

    return timer;
  }
}

/**
 * Builds a refusal.
 *
 * @param rejectionCode - Why, for an administrator.
 * @param failureReason - What the scanner or the store said.
 * @param byteSize - How many bytes were read, when any were.
 * @param observedSha256 - The hash of what was read, when it was read in full.
 * @returns The conclusion.
 */
function refuse(
  rejectionCode: ScanRejectionCode,
  failureReason: string | null,
  measured: MeasuredStream | null,
  observedSha256: string | null = null,
): ScanConclusion {
  return {
    state: FileScanAttemptState.REJECTED,
    rejectionCode,
    failureReason,
    observedSha256,
    byteSize: measured === null ? null : measured.byteSize,
    detectedContentType:
      measured === null ? null : sniffContentType(measured.prefix),
  };
}
