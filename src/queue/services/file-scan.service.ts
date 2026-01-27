import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { UploadFileEntity } from '../../db/entities/upload-file.entity';
import { Repository } from 'typeorm';
import { R2Service } from '../../r2/r2.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

import { createWriteStream, promises as fs } from 'fs';
import { pipeline } from 'stream/promises';
import { join } from 'path';
import { fileTypeFromFile } from 'file-type';
import { spawn } from 'child_process';

type ScanOneArgs = { env: string; fileId: string; jobId: string };

@Injectable()
export class FileScanService {
  private readonly logger = new Logger(FileScanService.name);

  constructor(
    @InjectRepository(UploadFileEntity) private readonly files: Repository<UploadFileEntity>,
    private readonly r2: R2Service,
    @InjectQueue(process.env.FLEET_IMPORT_QUEUE || 'fleet-import')
    private readonly fleetImportQueue: Queue,
  ) {}

  async scanOne(args: ScanOneArgs): Promise<void> {
    const { env, fileId } = args;

    const file = await this.files.findOne({ where: { id: fileId } });
    if (!file) {
      this.logger.warn(`File not found: ${fileId}`);
      return;
    }
    if (file.env !== env) {
      this.logger.warn(`Env mismatch for file ${fileId}: expected ${env}, got ${file.env}`);
      return;
    }

    // Avoid reprocessing terminal statuses
    if (['PASSED', 'INFECTED'].includes(file.scan_status)) return;

    file.attempt_count = (file.attempt_count || 0) + 1;
    await this.files.save(file);

    const tmpPath = join('/tmp', `upload-${fileId}`);

    try {
      await this.setStatus(file, 'VALIDATING', {
        validation_started_at: new Date(),
        scan_error: null,
      });

      await this.downloadToTemp(file.r2_key, tmpPath);

      const stat = await fs.stat(tmpPath);
      const maxBytes = Number(process.env.MAX_FILE_BYTES || 10 * 1024 * 1024);
      if (stat.size > maxBytes) {
        await this.failValidation(file, `File too large (${stat.size} bytes > ${maxBytes})`, 'too_large');
        return;
      }

      // Stage A: type/content validation
      const validation = await this.validateByExpectedType(file.expected_file_type, tmpPath);
      if (!validation.ok) {
        await this.failValidation(file, validation.reason, validation.detectedType ?? 'unknown');
        return;
      }

      await this.setStatus(file, 'SCANNING', {
        validation_completed_at: new Date(),
        scan_started_at: new Date(),
        file_type_detected: validation.detectedType ?? null,
        file_type_reason: validation.reasonSummary ?? null,
      });

      // Stage B: AV scan
      const av = await this.clamScan(tmpPath);

      if (!av.ok) {
        await this.setStatus(file, 'ERROR', {
          scan_completed_at: new Date(),
          scan_engine: av.engine,
          scan_engine_version: av.engineVersion,
          scan_signature_version: av.signatureVersion,
          scan_error: av.errorMessage,
        });
        return;
      }

      if (av.infected) {
        await this.setStatus(file, 'INFECTED', {
          scan_completed_at: new Date(),
          scan_engine: av.engine,
          scan_engine_version: av.engineVersion,
          scan_signature_version: av.signatureVersion,
          scan_error: av.infectedMessage ?? 'Infected',
        });
        return;
      }

      // Passed
      await this.setStatus(file, 'PASSED', {
        scan_completed_at: new Date(),
        scan_engine: av.engine,
        scan_engine_version: av.engineVersion,
        scan_signature_version: av.signatureVersion,
        scan_error: null,
      });

      // Optional: enqueue the next stage (no deletion here)
      const enqueueNext = (process.env.ENQUEUE_NEXT_ON_PASSED || 'true').toLowerCase() === 'true';
      if (enqueueNext && file.expected_file_type === 'FLEET_CSV') {
        await this.fleetImportQueue.add(
          'fleet-import-file',
          { env, fileId },
          { removeOnComplete: true, removeOnFail: false },
        );
      }
    } finally {
      // Always remove temp file
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    }
  }

  private async downloadToTemp(r2Key: string, tmpPath: string): Promise<void> {
    const stream = await this.r2.getObjectStream(r2Key);
    await pipeline(stream, createWriteStream(tmpPath));
  }

  private async validateByExpectedType(
    expected: string,
    filePath: string,
  ): Promise<{
    ok: boolean;
    detectedType?: string;
    reason: string;
    reasonSummary?: string;
  }> {
    // Detect common binaries
    const ft = await fileTypeFromFile(filePath);

    if (expected === 'FLEET_CSV') {
      if (ft?.mime && !ft.mime.startsWith('text/')) {
        return { ok: false, detectedType: ft.mime, reason: `Expected CSV/text but detected ${ft.mime}` };
      }
      return this.validateFleetCsv(filePath);
    }

    if (expected === 'IMAGE_UPLOAD') {
      if (!ft?.mime) return { ok: false, detectedType: 'unknown', reason: 'Could not detect file type' };
      if (!ft.mime.startsWith('image/')) return { ok: false, detectedType: ft.mime, reason: `Expected image but detected ${ft.mime}` };
      return { ok: true, detectedType: ft.mime, reason: 'Validated as image', reasonSummary: 'Magic bytes indicate image/*' };
    }

    return { ok: false, detectedType: ft?.mime ?? 'unknown', reason: `Unknown expected_file_type: ${expected}` };
  }

  private async validateFleetCsv(
    filePath: string,
  ): Promise<{ ok: boolean; detectedType?: string; reason: string; reasonSummary?: string }> {
    const readBytes = Number(process.env.VALIDATION_READ_BYTES || 256 * 1024);

    const buf = await fs.readFile(filePath);
    const slice = buf.subarray(0, Math.min(buf.length, readBytes));

    if (slice.includes(0)) {
      return { ok: false, detectedType: 'binary', reason: 'File contains NUL bytes; not text/csv' };
    }

    const text = slice.toString('utf8');

    // Printable ratio heuristic
    const printable = text.split('').filter((c) => {
      const code = c.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126) || code >= 160;
    }).length;

    const ratio = printable / Math.max(1, text.length);
    if (ratio < 0.85) {
      return { ok: false, detectedType: 'text/unknown', reason: `Text looks suspicious (printable ratio ${ratio.toFixed(2)})` };
    }

    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      return { ok: false, detectedType: 'text/csv?', reason: 'File is empty' };
    }

    const headerLine = lines[0];
    const headers = headerLine.split(',').map((h) => h.trim().replace(/^"|"$/g, ''));

    const normalised = new Set(headers.map((h) => h.replace(/\s+/g, ' ').trim().toLowerCase()));
    const required = ['account handle', 'character'];

    const missing = required.filter((r) => !normalised.has(r));
    if (missing.length) {
      return {
        ok: false,
        detectedType: 'text/csv?',
        reason: `Missing required headers: ${missing.join(', ')}`,
        reasonSummary: `Headers found: ${headers.slice(0, 10).join(', ')}${headers.length > 10 ? '…' : ''}`,
      };
    }

    return { ok: true, detectedType: 'text/csv', reason: 'Validated as fleet CSV', reasonSummary: 'Required headers present' };
  }

  private async clamScan(filePath: string): Promise<{
    ok: boolean;
    infected: boolean;
    infectedMessage?: string;
    engine: string;
    engineVersion?: string;
    signatureVersion?: string;
    errorMessage?: string;
  }> {
    const mode = process.env.CLAMAV_MODE || 'clamscan';
    const bin = process.env.CLAMAV_PATH || (mode === 'clamdscan' ? 'clamdscan' : 'clamscan');
    const timeoutMs = Number(process.env.SCAN_TIMEOUT_MS || 120_000);

    const args = ['--no-summary', filePath];

    const engine = 'clamav';
    const versionInfo = await this.getClamVersion(bin).catch(() => undefined);

    const { code, stdout, stderr, timedOut } = await this.execWithTimeout(bin, args, timeoutMs);

    if (timedOut) {
      return {
        ok: false,
        infected: false,
        engine,
        engineVersion: versionInfo?.engineVersion,
        signatureVersion: versionInfo?.signatureVersion,
        errorMessage: `Scan timed out after ${timeoutMs}ms`,
      };
    }

    // 0 = clean, 1 = infected, 2 = error
    if (code === 0) {
      return {
        ok: true,
        infected: false,
        engine,
        engineVersion: versionInfo?.engineVersion,
        signatureVersion: versionInfo?.signatureVersion,
      };
    }

    if (code === 1) {
      const msg = (stdout || stderr || '').trim();
      return {
        ok: true,
        infected: true,
        infectedMessage: msg || 'Virus detected',
        engine,
        engineVersion: versionInfo?.engineVersion,
        signatureVersion: versionInfo?.signatureVersion,
      };
    }

    const errMsg = (stderr || stdout || '').trim();
    return {
      ok: false,
      infected: false,
      engine,
      engineVersion: versionInfo?.engineVersion,
      signatureVersion: versionInfo?.signatureVersion,
      errorMessage: errMsg || `ClamAV returned error code ${code ?? 'null'}`,
    };
  }

  private async getClamVersion(bin: string): Promise<{ engineVersion?: string; signatureVersion?: string }> {
    const { code, stdout } = await this.execWithTimeout(bin, ['--version'], 10_000);
    if (code !== 0) return {};
    const line = (stdout || '').trim();
    const parts = line.split('/');
    const engineVersion = parts[0]?.replace('ClamAV', '').trim();
    const signatureVersion = parts[1]?.trim();
    return { engineVersion, signatureVersion };
  }

  private execWithTimeout(
    cmd: string,
    args: string[],
    timeoutMs: number,
  ): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ code: 2, stdout, stderr: `${stderr}\n${String(err)}`, timedOut });
      });
    });
  }

  private async setStatus(
    file: UploadFileEntity,
    status: UploadFileEntity['scan_status'],
    patch: Partial<UploadFileEntity>,
  ): Promise<void> {
    file.scan_status = status;
    Object.assign(file, patch);
    await this.files.save(file);
  }

  private async failValidation(file: UploadFileEntity, reason: string, detected: string): Promise<void> {
    await this.setStatus(file, 'VALIDATION_FAILED', {
      validation_completed_at: new Date(),
      file_type_detected: detected,
      file_type_reason: reason,
      scan_error: reason,
    });
  }
}
