import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from './database.service';

@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule implements OnModuleInit {
  constructor(private readonly databaseService: DatabaseService) {}

  async onModuleInit() {
    try {
      await this.databaseService.setDatabaseTimezone();
      Logger.log('Database timezone set successfully.', 'DatabaseModule');
    } catch (error) {
      Logger.error('Failed to set database timezone:', error, 'DatabaseModule');
    }
  }
}
