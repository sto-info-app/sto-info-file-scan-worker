import {
  FILE_SCAN_CONTRACT_VERSION,
  SUPPORTED_FILE_SCAN_CONTRACT_VERSIONS,
} from '../contract/file-scan-contract';

/**
 * The injection token for the worker's settings.
 *
 * A value provider rather than a service, because settings are read once at
 * startup and never change. A service would invite a read at the point of
 * use, and a configuration mistake discovered at the point of use is one
 * discovered while holding somebody's file.
 */
export const WORKER_SETTINGS = Symbol('WORKER_SETTINGS');

/**
 * The schema this repository's migrations write into.
 *
 * Hard-coded, matching how the backend hard-codes `sto_info_app`, and then
 * checked against `DB_SCHEMA` at startup. The migrations name the schema in
 * their SQL, so a datasource pointed somewhere else would create the tables
 * in one place and read them from another — which fails in a way that looks
 * like missing data rather than like a misconfiguration.
 */
export const WORKER_DATABASE_SCHEMA = 'sto_info_worker';

/** Everything the worker needs to know to run. */
export interface WorkerSettings {
  /** The contract version this process speaks. */
  readonly schemaVersion: number;
  /** The schema the worker's own tables live in. */
  readonly databaseSchema: string;
  /** The bucket uploaded bytes are quarantined in. */
  readonly quarantineBucket: string;
  /** The account endpoint the quarantine bucket is reached through. */
  readonly quarantineEndpoint: string;
  /** The AWS secret holding the database and object-store credentials. */
  readonly awsSecretName: string;
  /** How many objects this process will scan at once. */
  readonly concurrency: number;
  /** The largest object this worker will read. */
  readonly maxObjectBytes: number;
  /** How long a scan may take before it is abandoned as unanswered. */
  readonly scanTimeoutMs: number;
  /** How long a claim holds an attempt before another worker may take it. */
  readonly leaseMs: number;
  /** How often a holder says it is still working. */
  readonly heartbeatMs: number;
  /** How many times an attempt may be claimed before it is refused. */
  readonly maxAttempts: number;
  /** How old a signature database may be and still be trusted. */
  readonly maxDefinitionAgeMs: number;
  /** Where `clamd` is listening. */
  readonly clamdHost: string;
  /** Which port `clamd` is listening on. */
  readonly clamdPort: number;
}

/**
 * Raised when the environment cannot be turned into settings.
 *
 * Names the variable and never its value. A configuration error is logged at
 * startup, and a startup log is one of the least private places in a
 * deployment.
 */
export class WorkerSettingsError extends Error {
  /**
   * Creates an instance of WorkerSettingsError.
   *
   * @param variable - The environment variable at fault.
   * @param reason - What is wrong with it.
   */
  constructor(
    public readonly variable: string,
    reason: string,
  ) {
    super(`${variable} ${reason}`);
    this.name = 'WorkerSettingsError';
  }
}

/**
 * Reads a variable that must be present and non-empty.
 *
 * @param environment - The environment.
 * @param variable - The variable to read.
 * @returns Its value.
 * @throws WorkerSettingsError when it is absent or blank.
 */
function readRequired(
  environment: NodeJS.ProcessEnv,
  variable: string,
): string {
  const value = environment[variable];

  if (value === undefined || value.trim() === '') {
    throw new WorkerSettingsError(variable, 'must be set');
  }

  return value.trim();
}

/**
 * Reads a whole number within a range, falling back to a default.
 *
 * @param environment - The environment.
 * @param variable - The variable to read.
 * @param fallback - The value to use when it is absent.
 * @param minimum - The smallest acceptable value.
 * @param maximum - The largest acceptable value.
 * @returns The number.
 * @throws WorkerSettingsError when it is present and out of range.
 */
function readNumber(
  environment: NodeJS.ProcessEnv,
  variable: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[variable];

  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new WorkerSettingsError(
      variable,
      `must be a whole number between ${minimum} and ${maximum}`,
    );
  }

  return value;
}

/**
 * Turns the environment into settings, or refuses to start.
 *
 * Three of these checks are worth naming.
 *
 * **The contract version is checked here**, which is ADR-0006 decision 3:
 * the worker refuses to start against a version it does not support rather
 * than running against a shape it half-understands. Refusing at startup is
 * the whole point — the alternative is discovering it one message at a time,
 * with files already in the queue.
 *
 * **`TYPEORM_SYNCHRONIZE` is refused outright.** The worker shares a database
 * with the backend, and synchronise against a shared database is a process
 * that will happily drop another application's columns to make the schema
 * match its own entities. The one table this repository owns now has a
 * migration, so there is no remaining reason to allow it.
 *
 * **`DB_SCHEMA` must be the schema the migrations write.** They name it in
 * their SQL, so a datasource pointed elsewhere writes in one place and reads
 * from another.
 *
 * @param environment - The environment to read.
 * @returns The settings.
 * @throws WorkerSettingsError when the environment is unusable.
 */
export function readWorkerSettings(
  environment: NodeJS.ProcessEnv,
): WorkerSettings {
  if ((environment.TYPEORM_SYNCHRONIZE ?? '').toLowerCase() === 'true') {
    throw new WorkerSettingsError(
      'TYPEORM_SYNCHRONIZE',
      'must be false: this worker shares a database with the backend',
    );
  }

  const databaseSchema = readRequired(environment, 'DB_SCHEMA');

  if (databaseSchema !== WORKER_DATABASE_SCHEMA) {
    throw new WorkerSettingsError(
      'DB_SCHEMA',
      `must be ${WORKER_DATABASE_SCHEMA}, which is what the migrations write`,
    );
  }

  const schemaVersion = readNumber(
    environment,
    'FILE_SCAN_SCHEMA_VERSION',
    FILE_SCAN_CONTRACT_VERSION,
    0,
    Number.MAX_SAFE_INTEGER,
  );

  if (!SUPPORTED_FILE_SCAN_CONTRACT_VERSIONS.includes(schemaVersion)) {
    throw new WorkerSettingsError(
      'FILE_SCAN_SCHEMA_VERSION',
      `names a contract version this build does not support: ${schemaVersion}`,
    );
  }

  const leaseMs = readNumber(
    environment,
    'SCAN_LEASE_MS',
    300_000,
    10_000,
    3_600_000,
  );
  const heartbeatMs = readNumber(
    environment,
    'SCAN_HEARTBEAT_MS',
    30_000,
    1_000,
    600_000,
  );

  if (heartbeatMs >= leaseMs) {
    throw new WorkerSettingsError(
      'SCAN_HEARTBEAT_MS',
      'must be shorter than SCAN_LEASE_MS, or a lease expires unrenewed',
    );
  }

  const scanTimeoutMs = readNumber(
    environment,
    'SCAN_TIMEOUT_MS',
    120_000,
    1_000,
    3_600_000,
  );

  if (scanTimeoutMs >= leaseMs) {
    throw new WorkerSettingsError(
      'SCAN_TIMEOUT_MS',
      'must be shorter than SCAN_LEASE_MS, or a scan outlives its own claim',
    );
  }

  return {
    schemaVersion,
    databaseSchema,
    quarantineBucket: readRequired(
      environment,
      'CLOUDFLARE_R2_QUARANTINE_BUCKET_NAME',
    ),
    quarantineEndpoint: readRequired(environment, 'CLOUDFLARE_R2_ENDPOINT'),
    awsSecretName: readRequired(environment, 'AWS_SECRET_NAME'),
    concurrency: readNumber(environment, 'SCAN_CONCURRENCY', 1, 1, 32),
    maxObjectBytes: readNumber(
      environment,
      'MAX_FILE_BYTES',
      10 * 1024 * 1024,
      1,
      1024 * 1024 * 1024,
    ),
    scanTimeoutMs,
    leaseMs,
    heartbeatMs,
    maxAttempts: readNumber(environment, 'SCAN_MAX_ATTEMPTS', 3, 1, 20),
    maxDefinitionAgeMs:
      readNumber(environment, 'CLAMAV_MAX_DEFINITION_AGE_HOURS', 48, 1, 720) *
      60 *
      60 *
      1000,
    clamdHost: environment.CLAMAV_HOST?.trim() || '127.0.0.1',
    clamdPort: readNumber(environment, 'CLAMAV_PORT', 3310, 1, 65_535),
  };
}
