import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { FileScanService } from '../services/file-scan.service';

type FileScanJob = {
  env: string;
  fileId: string;
};

@Processor(process.env.FILE_SCAN_QUEUE || 'file-scan')
export class FileScanProcessor extends WorkerHost {
  constructor(private readonly fileScan: FileScanService) {
    super();
  }

  async process(job: Job<FileScanJob>): Promise<{ ok: boolean }> {
    const { env, fileId } = job.data;
    await this.fileScan.scanOne({ env, fileId, jobId: String(job.id) });
    return { ok: true };
  }
}
