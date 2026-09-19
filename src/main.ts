import { performance } from 'node:perf_hooks';

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { config } from 'dotenv';

import { AppModule } from './app.module';
import { ConfigCheckService } from './config-check/config-check.service';
import { readWorkerSettings } from './config/worker-settings';
import { getLogLevelsForEnvironment } from './shared/constants/logging.constants';

config({ path: 'config/environments/.env' });

function toMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function formatStartupMemory(message: string) {
  const mem = process.memoryUsage();
  return `[startup] ${message} | rss=${toMb(mem.rss)} heapUsed=${toMb(mem.heapUsed)} heapTotal=${toMb(mem.heapTotal)} external=${toMb(mem.external)} arrayBuffers=${toMb(mem.arrayBuffers)}`;
}

async function bootstrap() {
  const startupDiagnosticsEnabled =
    (process.env.STARTUP_DIAGNOSTICS ?? '').toLowerCase() === 'true';
  const startTime = performance.now();
  const startupLogger = new Logger('Startup');

  if (startupDiagnosticsEnabled) {
    console.log(formatStartupMemory('bootstrap:start'));
  }

  const configCheckService = new ConfigCheckService();
  configCheckService.validateInput(process.env);
  readWorkerSettings(process.env);

  const logLevels = getLogLevelsForEnvironment(
    process.env.NODE_ENV,
    process.env.LOG_LEVEL,
  );

  const shouldUseNestLoggerForStartup = logLevels.includes('log');
  const logStartup = (message: string) => {
    const line = formatStartupMemory(message);
    if (shouldUseNestLoggerForStartup) {
      startupLogger.log(line);
    } else {
      console.log(line);
    }
  };

  const app = await NestFactory.create(AppModule, {
    logger: logLevels,
  });

  if (startupDiagnosticsEnabled) {
    logStartup(
      `after NestFactory.create (+${(performance.now() - startTime).toFixed(0)}ms)`,
    );
  }

  // Graceful shutdown. BullMQ's Nest integration closes its workers on
  // the shutdown signal, which finishes the job in hand before the
  // process exits; without this the container would be killed mid-scan
  // and the attempt would wait out its whole lease before anybody could
  // pick it up again.
  app.enableShutdownHooks();

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      validationError: { target: false },
    }),
  );

  await app.init();

  if (startupDiagnosticsEnabled) {
    logStartup(
      `after app.init (+${(performance.now() - startTime).toFixed(0)}ms)`,
    );
  }

  const port = process.env.APP_PORT ? Number(process.env.APP_PORT) : 3000;
  await app.listen(port);

  if (startupDiagnosticsEnabled) {
    logStartup(
      `listening on port ${port} (+${(performance.now() - startTime).toFixed(0)}ms)`,
    );
  }
}

bootstrap();
