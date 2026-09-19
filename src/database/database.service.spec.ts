import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { DataSource } from 'typeorm';

import { DatabaseService } from './database.service';

describe('DatabaseService', () => {
  let query: jest.Mock;
  let service: DatabaseService;

  beforeEach(() => {
    query = jest.fn(() => Promise.resolve([]));
    service = new DatabaseService({ query } as unknown as DataSource);
  });

  it('puts the session in UTC', async () => {
    // Every instant this repository writes is a timestamptz, and the one
    // way to get a wrong answer out of one is a session in a local zone.
    await service.setDatabaseTimezone();

    expect(query).toHaveBeenCalledWith("SET TIME ZONE 'UTC'");
  });

  it('lets a failure through rather than running in an unknown zone', async () => {
    query.mockImplementationOnce(() => Promise.reject(new Error('no session')));

    await expect(service.setDatabaseTimezone()).rejects.toThrow('no session');
  });
});
