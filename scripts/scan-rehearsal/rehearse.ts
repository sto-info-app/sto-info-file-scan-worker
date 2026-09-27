/**
 * Puts the `clamd` client in front of a real `clamd`.
 *
 * Every failure path in `ClamdScanEngineService` is covered by unit specs
 * driven through a fake socket that misbehaves in ways a working scanner
 * cannot. **The happy path was covered by nothing at all** — the client had
 * never spoken to `clamd` in its life, and the shape of a real `VERSION`
 * reply, the behaviour of `INSTREAM` at its size limit and what an actual
 * detection looks like were all assumptions. FC-010 recorded that as an open
 * question; this answers it.
 *
 * It is not a Jest spec, for the same reason the migration rehearsal is not:
 * it needs a container, it is slow, and it must not be part of a suite that
 * enforces one hundred per cent coverage on code it does not exercise.
 *
 * Run it through `npm run rehearse:scan`, which starts the container for it.
 */
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';

import { WorkerSettings } from '../../src/config/worker-settings';
import { ClamdScanEngineService } from '../../src/scanning/clamd-scan-engine.service';
import { createClamdSocket } from '../../src/scanning/clamd-socket';
import { EngineHealthService } from '../../src/scanning/engine-health.service';
import { ScanEngineOutcome } from '../../src/scanning/scan-engine.interface';

/** Where the rehearsal's `clamd` is listening. */
const HOST = process.env.REHEARSAL_CLAMAV_HOST ?? '127.0.0.1';
const PORT = Number(process.env.REHEARSAL_CLAMAV_PORT ?? '3390');

/** The container the rehearsal's `clamd` runs in, which it restarts. */
const CONTAINER = process.env.REHEARSAL_CLAMAV_CONTAINER ?? '';

/** How long to let a scan run before restarting the scanner under it. */
const RESTART_AFTER_MS = 2_000;

/** How long a restarted scanner may take to load its database again. */
const RELOAD_LIMIT_MS = 300_000;

const run = promisify(execFile);

/** What `clamd.conf` sets `StreamMaxLength` to, in bytes. */
const STREAM_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The EICAR test string, assembled at run time.
 *
 * Deliberately not written out as one literal. EICAR is harmless by design
 * and every scanner in the world detects it — including the one running on
 * the machine this repository is checked out on, which would quarantine
 * **this file** and take the working tree with it. Three fragments joined
 * after the file is read are the same bytes to `clamd` and nothing at all to
 * a scanner reading the source.
 */
const EICAR = Buffer.from(
  [
    'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-',
    'ANTIVIRUS-TEST-FILE',
    '!$H+H*',
  ].join(''),
  'ascii',
);

/** One byte, kept as a constant so no source line carries a bare escape. */
const NEWLINE = Buffer.from([0x0a]);

/** A sanitised roster export, as the backend would have written one. */
const CSV = Buffer.from(
  '"Character Name","Account Handle","Rank","Join Date"\n' +
    '"Ambassador Sorvak","@sorvak","Fleet Admiral","2024-01-01"\n',
  'utf8',
);

let failures = 0;

/**
 * Records whether one expectation held.
 *
 * @param what - What was being checked.
 * @param held - Whether it held.
 * @param detail - What was seen, for the log.
 */
function check(what: string, held: boolean, detail: string): void {
  if (held) {
    console.log(`  PASS  ${what} — ${detail}`);

    return;
  }

  failures += 1;
  console.error(`  FAIL  ${what} — ${detail}`);
}

/**
 * Builds settings for a client pointed at the rehearsal's scanner.
 *
 * @param changes - Fields to override.
 * @returns The settings.
 */
function settings(changes: Partial<WorkerSettings> = {}): WorkerSettings {
  return {
    clamdHost: HOST,
    clamdPort: PORT,
    scanTimeoutMs: 120_000,
    maxDefinitionAgeMs: 30 * 24 * 60 * 60 * 1000,
    healthPollMs: 30_000,
    ...changes,
  } as WorkerSettings;
}

/**
 * Builds a client pointed at the rehearsal's scanner.
 *
 * @param changes - Settings to override.
 * @returns The client.
 */
function engine(changes: Partial<WorkerSettings> = {}): ClamdScanEngineService {
  return new ClamdScanEngineService(settings(changes), createClamdSocket);
}

/**
 * Streams bytes without holding them all at once.
 *
 * @param total - How many bytes to produce.
 * @returns The stream.
 */
function bytes(total: number): Readable {
  const chunk = Buffer.alloc(64 * 1024, 0x41);
  let sent = 0;

  return new Readable({
    read(): void {
      if (sent >= total) {
        this.push(null);

        return;
      }

      const size = Math.min(chunk.length, total - sent);
      sent += size;
      this.push(chunk.subarray(0, size));
    },
  });
}

/**
 * Streams bytes slowly, so a scan is still in flight when something happens.
 *
 * @param total - How many bytes to produce.
 * @param pauseMs - How long to wait before each chunk.
 * @returns The stream.
 */
function slowBytes(total: number, pauseMs: number): Readable {
  const chunk = Buffer.alloc(64 * 1024, 0x41);
  let sent = 0;

  return new Readable({
    read(): void {
      if (sent >= total) {
        this.push(null);

        return;
      }

      const size = Math.min(chunk.length, total - sent);
      sent += size;
      setTimeout(() => this.push(chunk.subarray(0, size)), pauseMs);
    },
  });
}

/**
 * Waits.
 *
 * @param ms - For how long.
 * @returns When the time is up.
 */
function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Waits for the scanner to answer three times in a row, as the runner does
 * before the rehearsal starts: one answer can come from a daemon that then
 * stops to finish loading.
 *
 * @returns How long it took, in milliseconds.
 */
async function waitForTheScanner(): Promise<number> {
  const started = Date.now();
  let answered = 0;

  while (answered < 3) {
    if (Date.now() - started > RELOAD_LIMIT_MS) {
      throw new Error('The restarted scanner never answered');
    }

    answered = await engine()
      .describe()
      .then(() => answered + 1)
      .catch(() => 0);
    await pause(1_000);
  }

  return Date.now() - started;
}

/** Asks a real clamd what it is, and checks the client understood it. */
async function describesTheScanner(): Promise<void> {
  console.log('\n=== What the scanner says it is ===');

  const described = await engine().describe();

  check('the engine is named', described.engine === 'clamav', described.engine);
  check(
    'the version parsed',
    described.engineVersion !== null &&
      /^\d+\.\d+/.test(described.engineVersion),
    String(described.engineVersion),
  );
  check(
    'the signature version parsed',
    described.signatureVersion !== null &&
      /^\d+$/.test(described.signatureVersion),
    String(described.signatureVersion),
  );
  // The one that had never been proved. `definitionsBuiltAt` decides whether
  // this worker will scan at all, and it comes from `Date.parse` of the
  // third field of a reply nothing had ever read.
  check(
    'the build date parsed',
    described.definitionsBuiltAt instanceof Date &&
      !Number.isNaN(described.definitionsBuiltAt.getTime()),
    String(described.definitionsBuiltAt),
  );
  check(
    'the build date is not in the future',
    described.definitionsBuiltAt !== null &&
      described.definitionsBuiltAt.getTime() <= Date.now(),
    String(described.definitionsBuiltAt),
  );
  check(
    'the definition epoch is usable as an idempotency key',
    described.definitionEpoch.length > 0 &&
      described.definitionEpoch !== 'unknown',
    described.definitionEpoch,
  );
}

/** Scans things, and checks what came back. */
async function reachesTheRightVerdicts(): Promise<void> {
  console.log('\n=== What it concludes ===');

  const expectations: [string, () => Readable, ScanEngineOutcome][] = [
    ['a sanitised roster export is clean', () => Readable.from([CSV]), 'CLEAN'],
    [
      'an empty object is clean',
      () => Readable.from([Buffer.alloc(0)]),
      'CLEAN',
    ],
    ['EICAR is a detection', () => Readable.from([EICAR]), 'INFECTED'],
    [
      'EICAR with a trailing newline is still a detection',
      () => Readable.from([Buffer.concat([EICAR, NEWLINE])]),
      'INFECTED',
    ],
    [
      'an object past the stream limit does not pass',
      () => bytes(STREAM_MAX_BYTES + 1024 * 1024),
      'UNSUPPORTED',
    ],
    [
      // Twice the limit, where the scanner stops reading and hangs up
      // while the client is still writing. Worth its own case because the
      // client could plausibly have surfaced the broken pipe instead: it
      // reads the refusal that arrives first, so an object nobody could
      // finish sending is refused for the reason it was refused rather
      // than reported as a network fault and retried.
      'an object far past the limit is refused, not reported as a network fault',
      () => bytes(STREAM_MAX_BYTES * 2),
      'UNSUPPORTED',
    ],
  ];

  for (const [what, source, expected] of expectations) {
    const result = await engine().scan(source());

    check(
      what,
      result.outcome === expected,
      `${result.outcome}${result.detail === null ? '' : ` (${result.detail})`}`,
    );
  }

  const detection = await engine().scan(Readable.from([EICAR]));
  check(
    'a detection names its signature, for an administrator',
    (detection.detail ?? '').includes('FOUND'),
    String(detection.detail),
  );

  // Recorded because it is a trap rather than a fault. EICAR is matched as
  // a whole file: wrap it in anything and ClamAV calls the result clean,
  // which is correct behaviour and completely unlike a real detection.
  // Anybody testing this pipeline by pasting EICAR into a roster CSV will
  // get a clean verdict and conclude the scanner is broken, or worse,
  // conclude the pipeline is proved when nothing has been detected.
  const wrapped = await engine().scan(
    Readable.from([Buffer.concat([CSV, EICAR, CSV])]),
  );
  check(
    'EICAR embedded in other content is NOT detected, by design',
    wrapped.outcome === 'CLEAN',
    wrapped.outcome,
  );
}

/** Takes the scanner away, and checks nothing turns into a pass. */
async function failsClosed(): Promise<void> {
  console.log('\n=== What it does when the scanner will not answer ===');

  const unreachable = engine({ clamdPort: 1 });

  const refused = await unreachable.scan(Readable.from([CSV]));
  check(
    'a refused connection is not clean',
    refused.outcome === 'UNAVAILABLE',
    refused.outcome,
  );

  await unreachable
    .describe()
    .then(() =>
      check('describe fails when nothing is listening', false, 'it resolved'),
    )
    .catch((error: Error) =>
      check('describe fails when nothing is listening', true, error.message),
    );

  // One millisecond is not enough for any real scan, so this exercises the
  // deadline rather than a slow scanner. What matters is which side of
  // clean it lands on.
  const impatient = engine({ scanTimeoutMs: 1 });
  const timedOut = await impatient.scan(bytes(8 * 1024 * 1024));
  check(
    'a deadline that expires is not clean',
    timedOut.outcome === 'UNAVAILABLE',
    timedOut.outcome,
  );
}

/** Runs the health policy against the real scanner's real answer. */
async function judgesTheScanner(): Promise<void> {
  console.log('\n=== What the health policy makes of it ===');

  const fit = new EngineHealthService(engine(), settings());
  await fit.check();

  check(
    'a scanner with current signatures is fit',
    fit.current().healthy,
    String(fit.current().reason ?? 'fit'),
  );

  // The policy, against a real build date rather than a fixture: one
  // millisecond of tolerance means today's database is too old.
  const strict = new EngineHealthService(
    engine({ maxDefinitionAgeMs: 1 }),
    settings({ maxDefinitionAgeMs: 1 }),
  );
  await strict.check();

  check(
    'signatures older than the policy make it unfit',
    !strict.current().healthy &&
      strict.current().reason ===
        'The signature database is older than the policy allows',
    String(strict.current().reason),
  );

  const unreachable = new EngineHealthService(
    engine({ clamdPort: 1 }),
    settings({ clamdPort: 1 }),
  );
  await unreachable.check();

  check(
    'a scanner that is not there makes it unfit',
    !unreachable.current().healthy,
    String(unreachable.current().reason),
  );

  fit.onModuleDestroy();
  strict.onModuleDestroy();
  unreachable.onModuleDestroy();
}

/**
 * Restarts the scanner while a scan is streaming, and checks the scan is not
 * clean and the next one is.
 *
 * The worker's side of a restart, when the process scanning is the one that
 * goes, is covered by the attempt lease and the job retry, and the deployed
 * container's by FC-052. This is the scanner going from under a scan that is
 * part way through: the socket closes on a client still writing, and the only
 * acceptable reading of that is "not answered", which the worker retries.
 */
async function survivesARestart(): Promise<void> {
  console.log('\n=== What happens when the scanner restarts mid-scan ===');

  if (CONTAINER === '') {
    throw new Error(
      'REHEARSAL_CLAMAV_CONTAINER is not set; run this through npm run rehearse:scan',
    );
  }

  // 32 MiB, inside the stream limit, at a pace that takes about ten seconds:
  // long enough to be certainly in flight when the restart lands, and short
  // of the deadline, so the deadline cannot be what ends it.
  const scanning = engine().scan(slowBytes(32 * 1024 * 1024, 20));

  await pause(RESTART_AFTER_MS);
  // No grace period: a scanner that is killed is the case worth proving, and
  // one given time to finish might answer before it goes.
  await run('docker', ['restart', '--time', '0', CONTAINER]);

  const interrupted = await scanning;
  check(
    'a scan the scanner restarted under is not clean',
    interrupted.outcome !== 'CLEAN',
    `${interrupted.outcome}${interrupted.detail === null ? '' : ` (${interrupted.detail})`}`,
  );
  check(
    'it is reported as not answered, so the worker asks again',
    interrupted.outcome === 'UNAVAILABLE',
    interrupted.outcome,
  );

  const tookMs = await waitForTheScanner();
  console.log(
    `  The scanner answered again after ${Math.round(tookMs / 1000)}s`,
  );

  const after = await engine().scan(Readable.from([CSV]));
  check(
    'once it is back, the same export scans clean',
    after.outcome === 'CLEAN',
    after.outcome,
  );

  const detected = await engine().scan(Readable.from([EICAR]));
  check(
    'and a detection is still a detection',
    detected.outcome === 'INFECTED',
    detected.outcome,
  );
}

/**
 * Runs the rehearsal.
 */
async function main(): Promise<void> {
  console.log(`Rehearsing against clamd at ${HOST}:${PORT}`);

  await describesTheScanner();
  await reachesTheRightVerdicts();
  await failsClosed();
  await judgesTheScanner();
  // Last, because it takes the scanner away for as long as it takes to load
  // its database again.
  await survivesARestart();

  if (failures > 0) {
    console.error(
      `\nSCAN REHEARSAL FAILED: ${failures} expectation(s) did not hold`,
    );
    process.exitCode = 1;

    return;
  }

  console.log('\nSCAN REHEARSAL PASSED');
}

void main().catch((error: unknown) => {
  console.error('\nSCAN REHEARSAL ERRORED');
  console.error(error);
  process.exitCode = 1;
});
