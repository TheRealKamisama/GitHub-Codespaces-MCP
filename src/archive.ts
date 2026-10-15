import { mkdir, readFile, rename, rm, writeFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AppError, requireThat } from './errors.js';
import { archiveReceiptSchema, jobStatusSchema, type JobStatus } from './contracts.js';

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const ARCHIVE_LOG_LIMIT = 8 * 1024 * 1024;

// Local copy of a settled job's final status and log. Reads never contact or restart the Codespace.
export class Archive {
  constructor(readonly root: string) {}
  private dir(jobId: string) { requireThat(/^[a-f0-9]{64}$/.test(jobId), 'STATE_INVALID'); return join(this.root, jobId); }
  async write(status: JobStatus, log: Buffer, remoteLogBytes: number) {
    requireThat(status.settled, 'STATE_INVALID');
    const statusText = JSON.stringify(status);
    const receipt = archiveReceiptSchema.parse({ schemaVersion: 1, jobId: status.jobId, digest: status.digest, statusSha256: sha256(statusText),
      logSha256: sha256(log), logBytes: log.length, remoteLogBytes, truncated: log.length < remoteLogBytes, archivedAt: new Date().toISOString() });
    await mkdir(this.root, { recursive: true });
    // Assemble in a private directory and rename: a crash never leaves a half-written archive under the job id.
    const temp = join(this.root, `.tmp-${randomUUID()}`);
    try {
      await mkdir(temp, { mode: 0o700 });
      await writeFile(join(temp, 'status.json'), statusText, { mode: 0o600 });
      await writeFile(join(temp, 'job.log'), log, { mode: 0o600 });
      await writeFile(join(temp, 'receipt.json'), JSON.stringify(receipt), { mode: 0o600 });
      await rm(this.dir(status.jobId), { recursive: true, force: true });
      await rename(temp, this.dir(status.jobId));
    } finally { await rm(temp, { recursive: true, force: true }); }
    return receipt;
  }
  async read(jobId: string): Promise<{ status: JobStatus; receipt: ReturnType<typeof archiveReceiptSchema.parse> } | undefined> {
    let receiptText: string, statusText: string;
    try {
      receiptText = await readFile(join(this.dir(jobId), 'receipt.json'), 'utf8');
      statusText = await readFile(join(this.dir(jobId), 'status.json'), 'utf8');
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new AppError('STATE_INVALID'); }
    const receipt = archiveReceiptSchema.safeParse(JSON.parse(receiptText));
    requireThat(receipt.success && receipt.data.jobId === jobId && receipt.data.statusSha256 === sha256(statusText), 'ARCHIVE_CORRUPT');
    const status = jobStatusSchema.safeParse(JSON.parse(statusText));
    requireThat(status.success, 'ARCHIVE_CORRUPT');
    return { status: status.data, receipt: receipt.data };
  }
  async logs(jobId: string, cursor: string, maxBytes: number) {
    const archived = await this.read(jobId);
    requireThat(archived, 'JOB_NOT_FOUND');
    const offset = Number(/^v1:([0-9]{1,15})$/.exec(cursor)?.[1] ?? NaN);
    requireThat(Number.isSafeInteger(offset) && offset <= archived.receipt.logBytes, 'CURSOR_INVALID');
    const handle = await open(join(this.dir(jobId), 'job.log'), 'r');
    let data: Buffer;
    try {
      const buffer = Buffer.alloc(Math.min(maxBytes, archived.receipt.logBytes - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      data = buffer.subarray(0, bytesRead);
    } finally { await handle.close(); }
    // Same rule as the runner: never split a UTF-8 sequence across pages.
    let cut = 0;
    while (cut < Math.min(4, data.length) && !isCompleteUtf8(data.subarray(0, data.length - cut))) cut++;
    data = data.subarray(0, data.length - cut);
    const next = offset + data.length;
    return { jobId, cursor: `v1:${offset}`, nextCursor: `v1:${next}`, text: data.toString('utf8'), size: archived.receipt.logBytes, complete: next >= archived.receipt.logBytes };
  }
}
function isCompleteUtf8(data: Buffer) {
  try { new TextDecoder('utf-8', { fatal: true }).decode(data); return true; } catch { return false; }
}
