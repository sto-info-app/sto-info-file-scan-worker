import { Readable } from 'node:stream';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { WORKER_SETTINGS, WorkerSettings } from '../config/worker-settings';
import {
  CLAMD_SOCKET_FACTORY,
  ClamdSocket,
  ClamdSocketFactory,
} from './clamd-socket';
import {
  ScanEngine,
  ScanEngineDescription,
  ScanEngineResult,
} from './scan-engine.interface';

/** The scanner's name, as recorded on every attempt. */
const ENGINE_NAME = 'clamav';

/**
 * What is recorded when `clamd` will not say which signatures it holds.
 *
 * A placeholder and not a guess. It has to be something, because the
 * signature database's identity is part of an attempt's idempotency key and
 * a null there would make every delivery a new attempt. It is deliberately
 * not a plausible-looking number — ADR-0005 decision 5 — so that a row
 * carrying it reads as "the scanner did not say" rather than as a version.
 */
const UNKNOWN_DEFINITION_EPOCH = 'unknown';

/** How long to wait for a version string before giving up. */
const DESCRIBE_TIMEOUT_MS = 10_000;

/** The largest chunk `INSTREAM` will accept, well under clamd's own limit. */
const INSTREAM_CHUNK_BYTES = 64 * 1024;

/** The four zero bytes that tell `clamd` the stream has finished. */
const INSTREAM_TERMINATOR = Buffer.alloc(4);

/**
 * The detections that mean "could not look", not "found something".
 *
 * `Heuristics.Limits.Exceeded.*` is what `AlertExceedsMax` reports for each
 * of `MaxRecursion`, `MaxFiles`, `MaxFileSize`, `MaxScanSize` and
 * `MaxScanTime`; `Heuristics.Encrypted.*` is what the `AlertEncrypted*`
 * options report for an archive or document it cannot decrypt.
 */
const UNSCANNABLE_HEURISTIC =
  /:\s*Heuristics\.(?:Limits\.Exceeded|Encrypted)\.\S+ FOUND$/;

/**
 * ClamAV, spoken to over the `clamd` socket protocol.
 *
 * ADR-0005 selected ClamAV and chose to run it as `clamd` inside the worker
 * container. This client uses `INSTREAM` rather than handing `clamd` a path,
 * and that choice closes a follow-up rather than being a matter of taste:
 * ADR-0006 recorded that the worker "writes uploads to `/tmp` and reads the
 * whole buffer", against plan section 10's rule that ephemeral services keep
 * no local upload storage. Streaming the object from quarantine straight into
 * the scanner means there is no file to bound, no file to delete and no file
 * left behind by a crash. The rule holds by construction rather than by a
 * cleanup path, which is the only way a rule about crashes can hold.
 *
 * Everything here fails closed. `clamd` answers `OK`, `FOUND` or `ERROR`, and
 * anything that is not a recognised `OK` — a timeout, a dropped connection, a
 * reply in a shape this client does not know — is reported as not clean.
 * There is no path through this file that turns silence into a pass.
 */
@Injectable()
export class ClamdScanEngineService implements ScanEngine {
  private readonly _logger = new Logger(ClamdScanEngineService.name);

  /**
   * Creates an instance of ClamdScanEngineService.
   *
   * @param _settings - The worker's settings.
   * @param _connect - Opens a connection to `clamd`.
   */
  constructor(
    @Inject(WORKER_SETTINGS) private readonly _settings: WorkerSettings,
    @Inject(CLAMD_SOCKET_FACTORY) private readonly _connect: ClamdSocketFactory,
  ) {}

  /**
   * Asks `clamd` for its version and signature database.
   *
   * @returns The scanner's account of itself.
   * @throws Error when `clamd` cannot be reached.
   */
  async describe(): Promise<ScanEngineDescription> {
    const reply = await this.converse(
      Buffer.from('zVERSION\0', 'ascii'),
      DESCRIBE_TIMEOUT_MS,
    );

    return this.parseVersion(reply);
  }

  /**
   * Streams bytes into `clamd` and reads its answer.
   *
   * @param source - The bytes. Consumed exactly once.
   * @returns What the scanner concluded.
   */
  async scan(source: Readable): Promise<ScanEngineResult> {
    let reply: string;

    try {
      reply = await this.converse(
        Buffer.from('zINSTREAM\0', 'ascii'),
        this._settings.scanTimeoutMs,
        source,
      );
    } catch (error) {
      this._logger.warn(
        `[scan] The scanner did not answer - Reason: ${describeError(error)}`,
      );

      return { outcome: 'UNAVAILABLE', detail: describeError(error) };
    }

    return this.interpret(reply);
  }

  /**
   * Turns a reply from `clamd` into an outcome.
   *
   * The order matters. `FOUND` is checked before `ERROR` because `clamd`
   * reports some detections with both words present, and a detection read as
   * an error would become a retry and then, eventually, a second chance.
   *
   * @param reply - What `clamd` said.
   * @returns What it meant.
   */
  private interpret(reply: string): ScanEngineResult {
    const answer = reply.trim();

    if (/\bFOUND$/.test(answer)) {
      // Two heuristics report what the scanner could not look at rather
      // than anything it found: a limit it reached before finishing (with
      // `AlertExceedsMax`, without which it answers OK for the unread
      // remainder) and encryption it cannot see through. Neither is a clean
      // answer and neither is malware, so the uploader is told the file
      // cannot be scanned rather than that it is infected (FC-043).
      if (UNSCANNABLE_HEURISTIC.test(answer)) {
        return { outcome: 'UNSUPPORTED', detail: answer };
      }

      return { outcome: 'INFECTED', detail: answer };
    }

    if (/\bOK$/.test(answer)) {
      return { outcome: 'CLEAN', detail: null };
    }

    if (/\bERROR$/.test(answer)) {
      // clamd reports an archive it cannot open, an encrypted payload and a
      // size limit it enforces itself all as errors. None of them is a clean
      // answer and none of them will become one on a second attempt, so they
      // are refused rather than retried.
      return { outcome: 'UNSUPPORTED', detail: answer };
    }

    this._logger.warn('[interpret] The scanner replied in an unknown shape');

    return { outcome: 'UNAVAILABLE', detail: 'Unrecognised scanner reply' };
  }

  /**
   * Reads a `clamd` version string.
   *
   * The documented shape is `ClamAV <engine>/<signatures>/<built>`, and every
   * part after the first is optional in practice. Each one that is missing is
   * recorded as missing.
   *
   * @param reply - What `clamd` said.
   * @returns The scanner's account of itself.
   */
  private parseVersion(reply: string): ScanEngineDescription {
    const [engineField, signatureField, builtField] = reply.trim().split('/');
    const engineVersion =
      engineField?.replace(/^ClamAV\s*/i, '').trim() || null;
    const signatureVersion = signatureField?.trim() || null;
    const builtAt = builtField === undefined ? NaN : Date.parse(builtField);

    return {
      engine: ENGINE_NAME,
      engineVersion,
      signatureVersion,
      definitionEpoch: signatureVersion ?? UNKNOWN_DEFINITION_EPOCH,
      definitionsBuiltAt: Number.isNaN(builtAt) ? null : new Date(builtAt),
    };
  }

  /**
   * Sends one command and reads one reply.
   *
   * `clamd` terminates a reply with a NUL when the command was sent in its
   * `z` form, which is why every command here carries that prefix: a reply
   * read to end-of-stream would be indistinguishable from a connection that
   * dropped half way through one.
   *
   * @param command - The command, already NUL-terminated.
   * @param timeoutMs - How long to wait, in total.
   * @param body - Bytes to stream after the command, for `INSTREAM`.
   * @returns The reply, without its terminator.
   * @throws Error when the connection fails, times out or closes unanswered.
   */
  private converse(
    command: Buffer,
    timeoutMs: number,
    body?: Readable,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const socket = this._connect(
        this._settings.clamdHost,
        this._settings.clamdPort,
      );

      let received = '';
      let settled = false;

      const finish = (error: Error | null, reply?: string): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(deadline);
        socket.removeAllListeners();
        socket.destroy();
        body?.destroy();

        if (error === null) {
          resolve(reply as string);
        } else {
          reject(error);
        }
      };

      const deadline = setTimeout(() => {
        finish(new Error(`The scanner did not answer within ${timeoutMs}ms`));
      }, timeoutMs);

      socket.setTimeout(timeoutMs);

      socket.on('connect', () => {
        socket.write(command);

        if (body === undefined) {
          return;
        }

        this.streamInto(socket, body).then(
          () => socket.write(INSTREAM_TERMINATOR),
          (error: unknown) =>
            finish(
              error instanceof Error ? error : new Error(describeError(error)),
            ),
        );
      });

      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8');

        const terminator = received.indexOf('\0');

        if (terminator !== -1) {
          finish(null, received.slice(0, terminator));
        }
      });

      socket.on('timeout', () => {
        finish(new Error(`The scanner went quiet for ${timeoutMs}ms`));
      });

      socket.on('error', (error: Error) => {
        finish(error);
      });

      socket.on('close', () => {
        finish(new Error('The scanner closed the connection unanswered'));
      });
    });
  }

  /**
   * Writes a stream to `clamd` in `INSTREAM` frames.
   *
   * Each frame is a four-byte big-endian length followed by that many bytes,
   * and the chunks a stream produces are not the chunks the protocol wants,
   * so they are re-cut here. Backpressure is respected: a socket that says
   * its buffer is full is waited on rather than written through, because
   * ignoring it is how a large upload turns into a memory spike in the one
   * process that is meant to be handling untrusted bytes.
   *
   * @param socket - The connection.
   * @param body - The bytes.
   */
  private async streamInto(socket: ClamdSocket, body: Readable): Promise<void> {
    for await (const chunk of body) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

      for (
        let offset = 0;
        offset < bytes.length;
        offset += INSTREAM_CHUNK_BYTES
      ) {
        const frame = bytes.subarray(offset, offset + INSTREAM_CHUNK_BYTES);
        const header = Buffer.alloc(4);
        header.writeUInt32BE(frame.length, 0);

        if (!socket.write(Buffer.concat([header, frame]))) {
          await nextEvent(socket, 'drain');
        }
      }
    }
  }
}

/**
 * Waits for one socket event.
 *
 * `events.once` would do this, but it takes an `EventEmitter` and the socket
 * is deliberately typed as the narrow interface the client actually uses.
 *
 * It subscribes with `once` and not `on`, which is not a detail: a stream
 * large enough to fill the socket's buffer waits here repeatedly, and a
 * listener left behind each time is a leak Node starts warning about after
 * ten of them.
 *
 * @param socket - The connection.
 * @param event - The event to wait for.
 */
function nextEvent(socket: ClamdSocket, event: string): Promise<void> {
  return new Promise<void>(resolve => {
    socket.once(event, () => resolve());
  });
}

/**
 * Describes a thrown value without assuming it is an error.
 *
 * @param error - Whatever was thrown.
 * @returns A short description.
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown scanner failure';
}
