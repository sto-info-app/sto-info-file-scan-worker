import { Injectable } from '@nestjs/common';

import { DataSource } from 'typeorm';

/**
 * Small things the connection needs doing to it once.
 */
@Injectable()
export class DatabaseService {
  /**
   * Creates an instance of DatabaseService.
   *
   * @param _dataSource - The connection.
   */
  constructor(private readonly _dataSource: DataSource) {}

  /**
   * Puts the session in UTC.
   *
   * Every instant this repository writes is a `timestamptz`, and the one way
   * to get a wrong answer out of one is a session in a local zone.
   */
  async setDatabaseTimezone(): Promise<void> {
    await this._dataSource.query("SET TIME ZONE 'UTC'");
  }
}
