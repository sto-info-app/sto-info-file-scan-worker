import { AddressInfo, createServer, Server } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { ClamdSocket, createClamdSocket } from './clamd-socket';

describe('createClamdSocket', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    server = createServer(socket => socket.end('stream: OK\0'));

    await new Promise<void>(resolve =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );

    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('opens a connection that speaks to whatever is listening', async () => {
    // A thin wrapper, tested against a real socket rather than mocked away.
    // What it wraps is the one part of the client that cannot be proved by
    // the protocol tests, and it is also the part that would break silently
    // if the narrow interface and net.Socket ever stopped agreeing.
    const socket: ClamdSocket = createClamdSocket('127.0.0.1', port);

    const reply = await new Promise<string>((resolve, reject) => {
      socket.on('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
      socket.on('error', reject);
    });

    socket.setTimeout(1_000);
    socket.removeAllListeners();
    socket.destroy();

    expect(reply).toBe('stream: OK\0');
  });
});
