export const LOG_LEVEL_ERROR = 'error' as const;
export const LOG_LEVEL_WARN = 'warn' as const;
export const LOG_LEVEL_LOG = 'log' as const;
export const LOG_LEVEL_DEBUG = 'debug' as const;
export const LOG_LEVEL_VERBOSE = 'verbose' as const;

export const VALID_LOG_LEVELS = [
  LOG_LEVEL_ERROR,
  LOG_LEVEL_WARN,
  LOG_LEVEL_LOG,
  LOG_LEVEL_DEBUG,
  LOG_LEVEL_VERBOSE,
] as const;

export type LogLevel = (typeof VALID_LOG_LEVELS)[number];

export const DEFAULT_LOG_LEVEL: LogLevel = LOG_LEVEL_LOG;

export const ENVIRONMENT_LOG_LEVELS: Record<string, LogLevel[]> = {
  local: [
    LOG_LEVEL_ERROR,
    LOG_LEVEL_WARN,
    LOG_LEVEL_LOG,
    LOG_LEVEL_DEBUG,
    LOG_LEVEL_VERBOSE,
  ],
  dev: [LOG_LEVEL_ERROR, LOG_LEVEL_WARN, LOG_LEVEL_LOG, LOG_LEVEL_DEBUG],
  staging: [LOG_LEVEL_ERROR, LOG_LEVEL_WARN, LOG_LEVEL_LOG],
  prod: [LOG_LEVEL_ERROR, LOG_LEVEL_WARN],
};

export const DEFAULT_LOG_LEVELS: LogLevel[] = ENVIRONMENT_LOG_LEVELS.staging;

export function parseLogLevel(logLevel?: string): LogLevel[] {
  if (!logLevel) {
    return DEFAULT_LOG_LEVELS;
  }

  if (logLevel.includes(',')) {
    const levels = logLevel
      .split(',')
      .map(level => level.trim())
      .filter(level =>
        VALID_LOG_LEVELS.includes(level as LogLevel),
      ) as LogLevel[];

    return levels.length > 0 ? levels : DEFAULT_LOG_LEVELS;
  }

  const levelIndex = VALID_LOG_LEVELS.indexOf(logLevel as LogLevel);

  if (levelIndex >= 0) {
    return VALID_LOG_LEVELS.slice(0, levelIndex + 1);
  }

  return DEFAULT_LOG_LEVELS;
}

export function getLogLevelsForEnvironment(
  env: string = 'dev',
  logLevel?: string,
): LogLevel[] {
  if (logLevel) {
    return parseLogLevel(logLevel);
  }

  return ENVIRONMENT_LOG_LEVELS[env] || DEFAULT_LOG_LEVELS;
}
