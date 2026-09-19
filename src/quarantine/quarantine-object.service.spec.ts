import { Readable } from 'node:stream';

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { WorkerSettings } from '../config/worker-settings';
import {
  QuarantineObjectMissingError,
  QuarantineObjectService,
} from './quarantine-object.service';

const SETTINGS = {
  quarantineBucket: 'sto-info-quarantine',
} as WorkerSettings;

const OBJECT_KEY = 'prod/assets/4f1a0e2c-8b3d-4a59-9c21-6f7e5d4c3b2a';

describe('QuarantineObjectService', () => {
  let send: jest.Mock;
  let service: QuarantineObjectService;

  beforeEach(() => {
    send = jest.fn(() =>
      Promise.resolve({ Body: Readable.from([Buffer.from('bytes')]) }),
    );

    service = new QuarantineObjectService(
      { send } as unknown as S3Client,
      SETTINGS,
    );
  });

  describe('reading an object', () => {
    it('reads from the bucket its own configuration names', async () => {
      // The first acceptance criterion. The key comes from the message; the
      // bucket never does, so no message can point this anywhere else.
      await service.getStream(OBJECT_KEY, null);

      const [[command]] = send.mock.calls as [[GetObjectCommand]];

      expect(command.input).toEqual({
        Bucket: 'sto-info-quarantine',
        Key: OBJECT_KEY,
      });
    });

    it('omits the version entirely when there is none', async () => {
      await service.getStream(OBJECT_KEY, null);

      const [[command]] = send.mock.calls as [[GetObjectCommand]];

      expect(command.input).not.toHaveProperty('VersionId');
    });

    it('asks for a version when the store has one', async () => {
      await service.getStream(OBJECT_KEY, 'v7');

      const [[command]] = send.mock.calls as [[GetObjectCommand]];

      expect(command.input).toEqual(
        expect.objectContaining({ VersionId: 'v7' }),
      );
    });

    it('hands back the body as a stream', async () => {
      const stream = await service.getStream(OBJECT_KEY, null);
      const chunks: Buffer[] = [];

      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }

      expect(Buffer.concat(chunks).toString('utf8')).toBe('bytes');
    });
  });

  describe('when the object is not there', () => {
    it.each([
      [
        'a NoSuchKey error',
        Object.assign(new Error('gone'), { name: 'NoSuchKey' }),
      ],
      [
        'a NotFound error',
        Object.assign(new Error('gone'), { name: 'NotFound' }),
      ],
      [
        'a 404 with no useful name',
        Object.assign(new Error('gone'), {
          $metadata: { httpStatusCode: 404 },
        }),
      ],
    ])('refuses on %s', async (_description, thrown) => {
      send.mockImplementationOnce(() => Promise.reject(thrown));

      await expect(service.getStream(OBJECT_KEY, null)).rejects.toBeInstanceOf(
        QuarantineObjectMissingError,
      );
    });

    it('refuses a response that carries no body', async () => {
      send.mockImplementationOnce(() => Promise.resolve({}));

      await expect(service.getStream(OBJECT_KEY, null)).rejects.toBeInstanceOf(
        QuarantineObjectMissingError,
      );
    });

    it('names the key it could not find', async () => {
      const error = new QuarantineObjectMissingError(OBJECT_KEY);

      expect(error.name).toBe('QuarantineObjectMissingError');
      expect(error.objectKey).toBe(OBJECT_KEY);
    });
  });

  describe('when the store itself is the problem', () => {
    it('lets the failure through as itself', async () => {
      // A refusal and an outage are different answers: the first is final
      // and the second is worth retrying, and the pipeline tells them apart
      // by type. Turning every failure into "missing" would make an R2
      // outage look like a bucket full of deleted files.
      const outage = Object.assign(new Error('connection reset'), {
        $metadata: { httpStatusCode: 503 },
      });

      send.mockImplementationOnce(() => Promise.reject(outage));

      await expect(service.getStream(OBJECT_KEY, null)).rejects.toBe(outage);
    });

    it('lets a thrown non-error through', async () => {
      send.mockImplementationOnce(() => Promise.reject('nope'));

      await expect(service.getStream(OBJECT_KEY, null)).rejects.toBe('nope');
    });
  });
});
