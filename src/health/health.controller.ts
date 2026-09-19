import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';

import { WORKER_SETTINGS, WorkerSettings } from '../config/worker-settings';
import { SCAN_ENGINE, ScanEngine } from '../scanning/scan-engine.interface';

/** What a liveness check answers with. */
interface LivenessReport {
  /** Always true; reaching this means the process is running. */
  readonly ok: boolean;
  /** The contract version this process speaks. */
  readonly schemaVersion: number;
}

/** What a readiness check answers with. */
interface ReadinessReport extends LivenessReport {
  /** The scanner's name. */
  readonly engine: string;
  /** Its version, as it reported it. */
  readonly engineVersion: string | null;
  /** Its signature database's version, as it reported it. */
  readonly signatureVersion: string | null;
}

/**
 * Two probes, which answer two different questions.
 *
 * `/health` asks whether the process is alive. `/health/ready` asks whether
 * it should be sent work, and those are not the same question: a worker with
 * an unreachable scanner, or one whose signature database is older than the
 * policy allows, is perfectly alive and must not be given a file.
 *
 * ADR-0005 put the second of those among FC-003's criteria — "the worker's
 * readiness probe fails while no supported signature database is loaded" —
 * and the probe itself is worker code, so it lives here. What FC-003 still
 * owns is proving it behaves that way against a real container.
 *
 * The probe reports the scanner's version and signature version because an
 * operator deciding whether an instance is healthy needs to see them, and
 * neither is a secret. It reports nothing about any file.
 */
@Controller('health')
export class HealthController {
  /**
   * Creates an instance of HealthController.
   *
   * @param _engine - The scanner.
   * @param _settings - The worker's settings.
   */
  constructor(
    @Inject(SCAN_ENGINE) private readonly _engine: ScanEngine,
    @Inject(WORKER_SETTINGS) private readonly _settings: WorkerSettings,
  ) {}

  /**
   * Reports that the process is running.
   *
   * @returns The report.
   */
  @Get()
  getHealth(): LivenessReport {
    return { ok: true, schemaVersion: this._settings.schemaVersion };
  }

  /**
   * Reports whether this worker should be sent files.
   *
   * @returns The report.
   * @throws ServiceUnavailableException when the scanner cannot be trusted.
   */
  @Get('ready')
  async getReadiness(): Promise<ReadinessReport> {
    let description;

    try {
      description = await this._engine.describe();
    } catch {
      throw new ServiceUnavailableException('The scanner cannot be reached');
    }

    if (description.definitionsBuiltAt === null) {
      throw new ServiceUnavailableException(
        'The scanner did not say how old its signatures are',
      );
    }

    const age = Date.now() - description.definitionsBuiltAt.getTime();

    if (age > this._settings.maxDefinitionAgeMs) {
      throw new ServiceUnavailableException(
        'The signature database is older than the policy allows',
      );
    }

    return {
      ok: true,
      schemaVersion: this._settings.schemaVersion,
      engine: description.engine,
      engineVersion: description.engineVersion,
      signatureVersion: description.signatureVersion,
    };
  }
}
