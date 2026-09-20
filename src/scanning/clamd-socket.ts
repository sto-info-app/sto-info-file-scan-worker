import { createConnection } from 'node:net';

/**
 * The injection token for whatever opens a connection to `clamd`.
 *
 * A factory rather than a socket, because a connection is per-scan: `clamd`
 * closes the stream once it has answered, and reusing one would mean holding
 * a file descriptor open between uploads for no benefit.
 *
 * It is injected rather than called directly so that the protocol can be
 * tested against a scanner that does the wrong thing. A dropped connection
 * mid-upload, a reply that never terminates and a version string in an
 * unexpected shape are the cases that decide whether the engine fails closed,
 * and none of them can be produced by a working `clamd`.
 */
export const CLAMD_SOCKET_FACTORY = Symbol('CLAMD_SOCKET_FACTORY');

/**
 * The part of a socket the `clamd` client uses.
 *
 * Narrower than `net.Socket`, which a real socket satisfies structurally.
 * Naming only what is used keeps a test double small enough to be obviously
 * correct, and stops the client quietly growing a dependency on some other
 * corner of the socket API.
 */
export interface ClamdSocket {
  /** Writes bytes, returning false when the buffer is full. */
  write(chunk: Buffer): boolean;
  /** Half-closes the connection. */
  end(): void;
  /** Tears the connection down. */
  destroy(error?: Error): void;
  /** Sets the idle timeout, in milliseconds. */
  setTimeout(milliseconds: number): void;
  /** Subscribes to a socket event. */
  on(event: string, listener: (...args: any[]) => void): this;
  /**
   * Subscribes to the next occurrence of a socket event only.
   *
   * Distinct from `on` because backpressure is waited on once per stalled
   * write, and a large object stalls many times: subscribing with `on` left
   * a listener behind for each one, which Node reports as a leak after ten
   * and which the scan rehearsal duly printed while streaming 64 MiB.
   */
  once(event: string, listener: (...args: any[]) => void): this;
  /** Removes every listener this client added. */
  removeAllListeners(): this;
}

/** Opens a connection to `clamd`. */
export type ClamdSocketFactory = (host: string, port: number) => ClamdSocket;

/**
 * Opens a real TCP connection.
 *
 * @param host - Where `clamd` is listening.
 * @param port - Which port it is listening on.
 * @returns The connection.
 */
export const createClamdSocket: ClamdSocketFactory = (host, port) =>
  createConnection({ host, port }) as unknown as ClamdSocket;
