import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';

import { WORKER_SETTINGS, WorkerSettings } from '../config/worker-settings';
import { EngineHealthService } from '../scanning/engine-health.service';

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
  /** When the scanner was last asked, as an ISO 8601 instant in UTC. */
  readonly checkedAt: string;
}

/**
 * Two probes, which answer two different questions.
 *
 * `/health` asks whether the process is alive. `/health/ready` asks whether
 * it should be sent work, and those are not the same question: a worker with
 * an unreachable scanner, or one whose signature database is older than the
 * policy allows, is perfectly alive and must not be given a file.
 *
 * Neither probe talks to the scanner. `EngineHealthService` does that on a
 * timer and both read what it last established — ADR-0020. A probe that
 * opened its own connection would be a way for anything that can reach this
 * port to make the worker talk to `clamd` as often as it liked, and it would
 * report a health this worker was not acting on. The answer here is the same
 * answer the pipeline is refusing or accepting files by, which is the only
 * thing worth reporting.
 *
 * ADR-0005 put readiness among FC-003's criteria — "the worker's readiness
 * probe fails while no supported signature database is loaded". Render's
 * background workers do not probe anything, so what enforces that in the
 * deployment is the worker pausing its own queue; this endpoint is for a
 * human, for local use, and for whatever this service is one day deployed
 * as instead.
 *
 * It reports the scanner's version and signature version because an operator
 * deciding whether an instance is healthy needs to see them, and neither is
 * a secret. It reports nothing about any file.
 */
@Controller('health')
export class HealthController {
  /**
   * Creates an instance of HealthController.
   *
   * @param _health - What the scanner last said about itself.
   * @param _settings - The worker's settings.
   */
  constructor(
    private readonly _health: EngineHealthService,
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
  getReadiness(): ReadinessReport {
    const health = this._health.current();

    if (!health.healthy || health.description === null) {
      throw new ServiceUnavailableException(
        health.reason ?? 'The scanner cannot be trusted',
      );
    }

    return {
      ok: true,
      schemaVersion: this._settings.schemaVersion,
      engine: health.description.engine,
      engineVersion: health.description.engineVersion,
      signatureVersion: health.description.signatureVersion,
      checkedAt: health.checkedAt.toISOString(),
    };
  }
}
