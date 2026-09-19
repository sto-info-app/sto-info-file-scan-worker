import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from '@jest/globals';

import { ConfigCheckService } from './config-check.service';

/** Comments, which say what used to be true and are not code. */
const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/.*$/gm;

/**
 * A complete environment.
 *
 * @param changes - Variables to override. An explicit undefined removes one.
 * @returns The environment.
 */
function environment(
  changes: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const base: Record<string, string> = {
    NODE_ENV: 'local',
    LOG_LEVEL: 'log',
    APP_PORT: '3000',
    DB_TYPE: 'postgres',
    DB_HOST: 'localhost',
    DB_PORT: '5432',
    DB_NAME: 'sto_info_app_local',
    DB_SCHEMA: 'sto_info_worker',
    DB_USERNAME: 'sto_info_worker',
    DB_SSL_REJECT_UNAUTHORIZED: 'false',
    REDIS_URL: 'redis://localhost:6379',
    CLOUDFLARE_R2_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
    CLOUDFLARE_R2_QUARANTINE_BUCKET_NAME: 'sto-info-quarantine',
    AWS_REGION: 'eu-west-2',
    AWS_SECRET_NAME: 'sto-info/worker',
  };

  const merged: NodeJS.ProcessEnv = { ...base };

  for (const [name, value] of Object.entries(changes)) {
    if (value === undefined) {
      delete merged[name];
    } else {
      merged[name] = value;
    }
  }

  return merged;
}

describe('ConfigCheckService', () => {
  let service: ConfigCheckService;

  beforeEach(() => {
    service = new ConfigCheckService();
  });

  describe('a usable environment', () => {
    it('is accepted', () => {
      expect(() => service.validateInput(environment())).not.toThrow();
    });

    it('converts the numbers it is given', () => {
      expect(service.validateInput(environment()).APP_PORT).toBe(3000);
    });

    it('accepts several log levels at once', () => {
      expect(() =>
        service.validateInput(environment({ LOG_LEVEL: 'error,warn,log' })),
      ).not.toThrow();
    });
  });

  describe('an environment it will not start on', () => {
    it.each([
      ['NODE_ENV'],
      ['LOG_LEVEL'],
      ['APP_PORT'],
      ['DB_TYPE'],
      ['DB_HOST'],
      ['DB_PORT'],
      ['DB_NAME'],
      ['DB_SCHEMA'],
      ['DB_USERNAME'],
      ['DB_SSL_REJECT_UNAUTHORIZED'],
      ['REDIS_URL'],
      ['CLOUDFLARE_R2_ENDPOINT'],
      ['CLOUDFLARE_R2_QUARANTINE_BUCKET_NAME'],
      ['AWS_REGION'],
      ['AWS_SECRET_NAME'],
    ])('refuses a missing %s', variable => {
      expect(() =>
        service.validateInput(environment({ [variable]: undefined })),
      ).toThrow(variable);
    });

    it('refuses an environment name it does not recognise', () => {
      expect(() =>
        service.validateInput(environment({ NODE_ENV: 'production' })),
      ).toThrow('NODE_ENV');
    });

    it('refuses a log level it does not recognise', () => {
      expect(() =>
        service.validateInput(environment({ LOG_LEVEL: 'shout' })),
      ).toThrow('LOG_LEVEL');
    });

    it('refuses a database engine it does not support', () => {
      expect(() =>
        service.validateInput(environment({ DB_TYPE: 'mysql' })),
      ).toThrow('DB_TYPE');
    });
  });

  describe('checking the variables the code actually reads', () => {
    it('names no variable the repository no longer uses', () => {
      // This check had drifted: it validated CLOUDFLARE_R2_BUCKET_NAME while
      // the object store client read R2_BUCKET_NAME, because there were two
      // environment examples that disagreed. It therefore reported healthy
      // on an environment whose R2 credentials were absent.
      const source = readFileSync(
        join(__dirname, 'config-check.service.ts'),
        'utf8',
      ).replace(COMMENTS, '');

      expect(source).not.toContain('CLOUDFLARE_R2_BUCKET_NAME');
      expect(source).not.toContain('R2_ENDPOINT=');
      expect(source).not.toContain('TYPEORM_SYNCHRONIZE');
    });

    it('names every variable the single environment example sets', () => {
      const example = readFileSync(
        join(__dirname, '..', '..', 'config', 'environments', '.env.example'),
        'utf8',
      );
      const declared = new Set(
        [...example.matchAll(/^([A-Z0-9_]+)=/gm)].map(match => match[1]),
      );
      const checked = readFileSync(
        join(__dirname, 'config-check.service.ts'),
        'utf8',
      );

      for (const variable of [
        'REDIS_URL',
        'CLOUDFLARE_R2_ENDPOINT',
        'CLOUDFLARE_R2_QUARANTINE_BUCKET_NAME',
        'AWS_SECRET_NAME',
      ]) {
        expect(declared.has(variable)).toBe(true);
        expect(checked).toContain(variable);
      }
    });
  });
});
