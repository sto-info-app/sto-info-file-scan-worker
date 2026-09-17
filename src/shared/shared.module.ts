import { Module } from '@nestjs/common';
import { SecretsService } from './secrets/secrets.service';

@Module({
  providers: [SecretsService],
  exports: [SecretsService],
})
export class SharedModule {}
