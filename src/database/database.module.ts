import { Logger, Module, OnModuleInit } from '@nestjs/common';

import { DatabaseService } from './database.service';

@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule implements OnModuleInit {
  constructor(private readonly _databaseService: DatabaseService) {}

  async onModuleInit() {
    try {
      await this._databaseService.setDatabaseTimezone();
      Logger.log('Database timezone set successfully.', 'DatabaseModule');
    } catch (error) {
      Logger.error('Failed to set database timezone:', error, 'DatabaseModule');
    }
  }
}
