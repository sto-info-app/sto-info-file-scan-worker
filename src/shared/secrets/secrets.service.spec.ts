import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { SecretsService } from './secrets.service';

const SECRET = {
  dbPassword: 'not-a-real-password',
  cloudflareR2QuarantineReadKey: 'read-key',
  cloudflareR2QuarantineReadSecret: 'read-secret',
};

describe('SecretsService', () => {
  let send: jest.Mock;
  let service: SecretsService;

  beforeEach(() => {
    send = jest.fn(() =>
      Promise.resolve({ SecretString: JSON.stringify(SECRET) }),
    );

    service = new SecretsService();
    (service as unknown as { _secretsManager: SecretsManagerClient })[
      '_secretsManager'
    ] = { send } as unknown as SecretsManagerClient;
  });

  it('reads a secret', async () => {
    await expect(service.getSecret('sto-info/worker')).resolves.toEqual(SECRET);
  });

  it('reads it once and remembers it', async () => {
    // The credentials do not change while the process runs, and asking
    // Secrets Manager on every scan would put an external dependency in the
    // path of every upload.
    await service.getSecret('sto-info/worker');
    await service.getSecret('sto-info/worker');

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps separate secrets apart', async () => {
    send.mockImplementationOnce(() =>
      Promise.resolve({ SecretString: JSON.stringify({ dbPassword: 'one' }) }),
    );

    const first = await service.getSecret('one');
    const second = await service.getSecret('two');

    expect(first).not.toEqual(second);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('refuses a secret that holds no string', async () => {
    send.mockImplementationOnce(() => Promise.resolve({}));

    await expect(service.getSecret('sto-info/worker')).rejects.toThrow(
      'Secret holds no string: sto-info/worker',
    );
  });

  it('lets a failure through rather than carrying on without credentials', async () => {
    send.mockImplementationOnce(() =>
      Promise.reject(new Error('AccessDeniedException')),
    );

    await expect(service.getSecret('sto-info/worker')).rejects.toThrow(
      'AccessDeniedException',
    );
  });

  it('does not cache a failure', async () => {
    send.mockImplementationOnce(() => Promise.reject(new Error('throttled')));

    await expect(service.getSecret('sto-info/worker')).rejects.toThrow();
    await expect(service.getSecret('sto-info/worker')).resolves.toEqual(SECRET);
  });
});
