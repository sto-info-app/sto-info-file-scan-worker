import { Readable } from 'node:stream';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { WorkerSettings } from '../config/worker-settings';
import { ClamdScanEngineService } from './clamd-scan-engine.service';
import { ClamdSocket } from './clamd-socket';

const SETTINGS = {
  clamdHost: '127.0.0.1',
  clamdPort: 3310,
  scanTimeoutMs: 5_000,
} as WorkerSettings;

/** A `clamd` that can be told to behave badly. */
class FakeClamd implements ClamdSocket {
  readonly written: Buffer[] = [];
  private readonly _listeners = new Map<string, ((...args: any[]) => void)[]>();
  private _destroyed = false;

  /**
   * Creates a fake.
   *
   * @param backpressureAfter - Writes before the buffer reports itself full.
   */
  constructor(private readonly _backpressureAfter = Number.POSITIVE_INFINITY) {}

  /** Whether the client tore the connection down. */
  get destroyed(): boolean {
    return this._destroyed;
  }

  /**
   * Records a write, reporting a full buffer once the limit is passed.
   *
   * @param chunk - The bytes.
   * @returns False when the caller should wait for a drain.
   */
  write(chunk: Buffer): boolean {
    this.written.push(Buffer.from(chunk));

    return this.written.length <= this._backpressureAfter;
  }

  /** Half-closes the connection. */
  end(): void {
    // Nothing to do; the fake has no transport.
  }

  /** Tears the connection down. */
  destroy(): void {
    this._destroyed = true;
  }

  /** Accepts an idle timeout it never enforces by itself. */
  setTimeout(): void {
    // The tests drive 'timeout' explicitly instead.
  }

  /**
   * Subscribes to an event.
   *
   * @param event - The event.
   * @param listener - What to call.
   * @returns This.
   */
  on(event: string, listener: (...args: any[]) => void): this {
    const existing = this._listeners.get(event) ?? [];
    this._listeners.set(event, [...existing, listener]);

    return this;
  }

  /**
   * Subscribes to the next occurrence of an event only.
   *
   * Modelled on the real socket rather than on `on`: the listener goes when
   * it fires. Backpressure is waited on once per stalled write, so a client
   * that used `on` here would leave one behind for every stall.
   *
   * @param event - The event.
   * @param listener - What to call.
   * @returns This.
   */
  once(event: string, listener: (...args: any[]) => void): this {
    const wrapper = (...args: any[]): void => {
      this._listeners.set(
        event,
        (this._listeners.get(event) ?? []).filter(
          candidate => candidate !== wrapper,
        ),
      );
      listener(...args);
    };

    return this.on(event, wrapper);
  }

  /**
   * Removes every listener.
   *
   * @returns This.
   */
  removeAllListeners(): this {
    this._listeners.clear();

    return this;
  }

  /**
   * Fires an event at whoever is listening.
   *
   * @param event - The event.
   * @param args - What to pass.
   */
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this._listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  /** Everything written after the command, as one buffer. */
  body(): Buffer {
    return Buffer.concat(this.written.slice(1));
  }
}

/**
 * Builds an engine whose socket the test controls.
 *
 * @param socket - The fake.
 * @returns The engine.
 */
function engineWith(socket: ClamdSocket): ClamdScanEngineService {
  return new ClamdScanEngineService(SETTINGS, () => socket);
}

/**
 * Lets pending microtasks and timers run.
 */
async function settle(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

describe('ClamdScanEngineService', () => {
  let socket: FakeClamd;

  beforeEach(() => {
    socket = new FakeClamd();
  });

  describe('asking what it is', () => {
    /**
     * Drives a version exchange.
     *
     * @param reply - What clamd says, without its terminator.
     * @returns The description.
     */
    async function describeWith(reply: string) {
      const engine = engineWith(socket);
      const answer = engine.describe();

      socket.emit('connect');
      socket.emit('data', Buffer.from(`${reply}\0`, 'utf8'));

      return answer;
    }

    it('sends the null-terminated form of the command', async () => {
      await describeWith('ClamAV 1.4.2/27412/Thu Sep 18 09:15:22 2026');

      expect(socket.written[0].toString('ascii')).toBe('zVERSION\0');
    });

    it('reads the engine, the signatures and the build date', async () => {
      const description = await describeWith(
        'ClamAV 1.4.2/27412/Thu Sep 18 09:15:22 2026',
      );

      expect(description).toEqual({
        engine: 'clamav',
        engineVersion: '1.4.2',
        signatureVersion: '27412',
        definitionEpoch: '27412',
        definitionsBuiltAt: new Date('Thu Sep 18 09:15:22 2026'),
      });
    });

    it('records a missing signature version rather than inventing one', async () => {
      // ADR-0005 decision 5. A plausible-looking number would be a lie that
      // reads exactly like the truth.
      const description = await describeWith('ClamAV 1.4.2');

      expect(description.signatureVersion).toBeNull();
      expect(description.definitionEpoch).toBe('unknown');
      expect(description.definitionsBuiltAt).toBeNull();
    });

    it('records an unparseable build date as no date at all', async () => {
      const description = await describeWith('ClamAV 1.4.2/27412/sometime');

      expect(description.definitionsBuiltAt).toBeNull();
    });

    it('records an empty version string as knowing nothing', async () => {
      const description = await describeWith('');

      expect(description).toEqual(
        expect.objectContaining({
          engineVersion: null,
          signatureVersion: null,
          definitionEpoch: 'unknown',
        }),
      );
    });

    it('fails when the scanner cannot be reached', async () => {
      const engine = engineWith(socket);
      const answer = engine.describe();

      socket.emit('error', new Error('ECONNREFUSED'));

      await expect(answer).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('scanning', () => {
    /**
     * Drives a scan.
     *
     * @param body - The bytes to stream.
     * @param reply - What clamd says, or null to say nothing.
     * @returns The result.
     */
    async function scanWith(body: Buffer[], reply: string | null) {
      const engine = engineWith(socket);
      const result = engine.scan(Readable.from(body));

      socket.emit('connect');
      await settle();
      await settle();

      if (reply !== null) {
        socket.emit('data', Buffer.from(`${reply}\0`, 'utf8'));
      }

      return result;
    }

    it('sends the streaming command first', async () => {
      await scanWith([Buffer.from('hello')], 'stream: OK');

      expect(socket.written[0].toString('ascii')).toBe('zINSTREAM\0');
    });

    it('frames the bytes with a big-endian length and terminates them', async () => {
      await scanWith([Buffer.from('hello')], 'stream: OK');

      const body = socket.body();

      expect(body.readUInt32BE(0)).toBe(5);
      expect(body.subarray(4, 9).toString('utf8')).toBe('hello');
      expect(body.subarray(9)).toEqual(Buffer.alloc(4));
    });

    it('re-cuts a large chunk into frames the protocol accepts', async () => {
      await scanWith([Buffer.alloc(70 * 1024, 0x41)], 'stream: OK');

      const frames = socket.written.slice(1, -1);

      expect(frames).toHaveLength(2);
      expect(frames[0].readUInt32BE(0)).toBe(64 * 1024);
      expect(frames[1].readUInt32BE(0)).toBe(6 * 1024);
    });

    it('frames a stream that yields text rather than buffers', async () => {
      // A Readable is allowed to produce strings, and concatenating one
      // into a Buffer throws. The object store yields buffers today; the
      // guard is there because the type does not promise it.
      const engine = engineWith(socket);
      const result = engine.scan(
        Readable.from(['hello'], { objectMode: true }),
      );

      socket.emit('connect');
      await settle();
      await settle();
      socket.emit('data', Buffer.from('stream: OK\u0000', 'utf8'));

      await expect(result).resolves.toEqual({ outcome: 'CLEAN', detail: null });
      expect(socket.body().subarray(4, 9).toString('utf8')).toBe('hello');
    });

    it('waits for a drain when the socket says it is full', async () => {
      // Ignoring backpressure would buffer the whole object in the one
      // process that is meant to be handling untrusted bytes without doing
      // exactly that.
      socket = new FakeClamd(1);

      const engine = engineWith(socket);
      const result = engine.scan(
        Readable.from([Buffer.alloc(8), Buffer.alloc(8)]),
      );

      socket.emit('connect');
      await settle();

      const beforeDrain = socket.written.length;
      socket.emit('drain');
      await settle();
      await settle();

      socket.emit('data', Buffer.from('stream: OK\0', 'utf8'));

      expect(beforeDrain).toBe(2);
      await expect(result).resolves.toEqual({ outcome: 'CLEAN', detail: null });
    });

    it.each([
      ['a clean answer', 'stream: OK', 'CLEAN', null],
      [
        'a detection',
        'stream: Eicar-Signature FOUND',
        'INFECTED',
        'stream: Eicar-Signature FOUND',
      ],
      [
        'a payload it cannot open',
        'stream: Encrypted.Zip ERROR',
        'UNSUPPORTED',
        'stream: Encrypted.Zip ERROR',
      ],
      [
        'a limit it reached before finishing',
        'stream: Heuristics.Limits.Exceeded.MaxRecursion FOUND',
        'UNSUPPORTED',
        'stream: Heuristics.Limits.Exceeded.MaxRecursion FOUND',
      ],
      [
        'its time limit',
        'stream: Heuristics.Limits.Exceeded.MaxScanTime FOUND',
        'UNSUPPORTED',
        'stream: Heuristics.Limits.Exceeded.MaxScanTime FOUND',
      ],
      [
        'an encrypted archive',
        'stream: Heuristics.Encrypted.Zip FOUND',
        'UNSUPPORTED',
        'stream: Heuristics.Encrypted.Zip FOUND',
      ],
      [
        'an encrypted document',
        'stream: Heuristics.Encrypted.PDF FOUND',
        'UNSUPPORTED',
        'stream: Heuristics.Encrypted.PDF FOUND',
      ],
      [
        'any other heuristic as a detection',
        'stream: Heuristics.Broken.Executable FOUND',
        'INFECTED',
        'stream: Heuristics.Broken.Executable FOUND',
      ],
    ])('reads %s', async (_description, reply, outcome, detail) => {
      await expect(scanWith([Buffer.from('x')], reply)).resolves.toEqual({
        outcome,
        detail,
      });
    });

    it('reads a detection reported with the word error in it as a detection', async () => {
      // Order matters in the interpreter. A detection read as an error
      // becomes a retry, and a retry eventually becomes another chance.
      await expect(
        scanWith([Buffer.from('x')], 'stream: Win.Error.Trojan FOUND'),
      ).resolves.toEqual(expect.objectContaining({ outcome: 'INFECTED' }));
    });

    it('refuses to read an unrecognised reply as clean', async () => {
      await expect(
        scanWith([Buffer.from('x')], 'stream: probably fine'),
      ).resolves.toEqual({
        outcome: 'UNAVAILABLE',
        detail: 'Unrecognised scanner reply',
      });
    });

    it('reassembles a reply that arrives in pieces', async () => {
      const engine = engineWith(socket);
      const result = engine.scan(Readable.from([Buffer.from('x')]));

      socket.emit('connect');
      await settle();
      await settle();
      socket.emit('data', Buffer.from('stre', 'utf8'));
      socket.emit('data', Buffer.from('am: OK\0', 'utf8'));

      await expect(result).resolves.toEqual({ outcome: 'CLEAN', detail: null });
    });

    it('does not read a clean answer out of a connection that dropped', async () => {
      const engine = engineWith(socket);
      const result = engine.scan(Readable.from([Buffer.from('x')]));

      socket.emit('connect');
      await settle();
      await settle();
      socket.emit('close');

      await expect(result).resolves.toEqual({
        outcome: 'UNAVAILABLE',
        detail: 'The scanner closed the connection unanswered',
      });
    });

    it('does not read a clean answer out of silence', async () => {
      const engine = engineWith(socket);
      const result = engine.scan(Readable.from([Buffer.from('x')]));

      socket.emit('connect');
      await settle();
      socket.emit('timeout');

      await expect(result).resolves.toEqual({
        outcome: 'UNAVAILABLE',
        detail: 'The scanner went quiet for 5000ms',
      });
    });

    it('does not read a clean answer out of a refused connection', async () => {
      const engine = engineWith(socket);
      const result = engine.scan(Readable.from([Buffer.from('x')]));

      socket.emit('error', new Error('ECONNREFUSED'));

      await expect(result).resolves.toEqual({
        outcome: 'UNAVAILABLE',
        detail: 'ECONNREFUSED',
      });
    });

    it('gives up when the bytes it was handed fail part way', async () => {
      const failing = new Readable({
        read() {
          this.destroy(new Error('the object went away'));
        },
      });

      const engine = engineWith(socket);
      const result = engine.scan(failing);

      socket.emit('connect');

      await expect(result).resolves.toEqual({
        outcome: 'UNAVAILABLE',
        detail: 'the object went away',
      });
    });

    it('tears the connection down whatever happened', async () => {
      await scanWith([Buffer.from('x')], 'stream: OK');

      expect(socket.destroyed).toBe(true);
    });

    it('takes the first answer and ignores whatever follows', async () => {
      const engine = engineWith(socket);
      const result = engine.scan(Readable.from([Buffer.from('x')]));

      socket.emit('connect');
      await settle();
      await settle();
      socket.emit('data', Buffer.from('stream: OK\0', 'utf8'));
      socket.emit('error', new Error('too late'));

      await expect(result).resolves.toEqual({ outcome: 'CLEAN', detail: null });
    });

    it('settles once when the connection fails mid-upload', async () => {
      // Two paths reach the same conclusion here: the socket's own error,
      // and the upload noticing that the body it was reading has been torn
      // down. Settling twice would reject a promise that had already
      // resolved, which Node reports as an unhandled rejection rather than
      // as a test failure.
      const slow = new Readable({
        read() {
          // Produces nothing until it is destroyed.
        },
      });

      const engine = engineWith(socket);
      const result = engine.scan(slow);

      socket.emit('connect');
      await settle();
      socket.emit('error', new Error('EPIPE'));
      await settle();
      await settle();

      await expect(result).resolves.toEqual({
        outcome: 'UNAVAILABLE',
        detail: 'EPIPE',
      });
    });

    it('gives up when the deadline passes with nothing said', async () => {
      jest.useFakeTimers();

      try {
        const engine = engineWith(socket);
        const result = engine.scan(Readable.from([Buffer.from('x')]));

        jest.advanceTimersByTime(5_000);

        await expect(result).resolves.toEqual({
          outcome: 'UNAVAILABLE',
          detail: 'The scanner did not answer within 5000ms',
        });
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
