import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from './errors.js';
import { bindingSchema, instanceStatusSchema, jobRecordSchema, jobStatusSchema, jobLogsSchema, operationSchema, type Binding, type JobRecord, type ReleaseRecord } from './contracts.js';
import { Application, codeOf, releasePolicy } from './application.js';
import { ARCHIVE_LOG_LIMIT } from './archive.js';
import { discard, transferPath, verifyArtifact } from './artifacts.js';

export const PREPARE_LEASE_MS = 5 * 60_000;
const RECONCILE_AFTER_MS = 60_000;
const STOP_CONFIRM_MS = 120_000;
const MAX_ATTEMPTS = 5;
// About five minutes of failed rounds for one instance (e.g. it was deleted elsewhere): stop counting it as busy so
// this controller can exit; the next tool call that touches the binding starts a fresh one.
const MAX_CONSECUTIVE_FAILURES = 20;
// The instance (or GitHub) could not be reached: nothing can be concluded about any job, so the round is retried.
const UNREACHABLE = ['TRANSPORT_UNAVAILABLE', 'PROCESS_TIMEOUT', 'PROCESS_CLEANUP_UNCONFIRMED', 'GITHUB_REQUEST_FAILED', 'OUTPUT_LIMIT', 'GH_NOT_FOUND', 'AUTH_REQUIRED'];
const LOG_PAGE_BYTES = 1024 * 1024;
// Artifacts exported before a stop, per job. Larger ones stay on the instance (storage is retained when stopped).
export const EXPORT_ARTIFACT_LIMIT = 64 * 1024 * 1024;
const TRANSITIONAL = ['Queued', 'Provisioning', 'Awaiting', 'Created', 'Starting', 'Updating', 'Rebuilding', 'ShuttingDown'];
type Blocker = ReleaseRecord['blockers'][number];

/**
 * Local release controller (design §5.4). Driven by its own loop, not by tool calls: it exports settled jobs,
 * counts usage across every local record and the instance-wide remote registry, waits out the grace period, closes
 * remote intake atomically and stops the instance, and reports stopped only after GitHub confirms Shutdown.
 * It never holds the local state lock across a network call.
 */
export class Controller {
  private failures = new Map<string, number>();
  constructor(private app: Application, private now: () => number = () => Date.now(), private log: (line: string) => void = () => {}) {}

  async tick(): Promise<boolean> {
    const bindings = (await this.app.store.list('binding')).map(raw => {
      const b = bindingSchema.safeParse(raw); if (!b.success) throw new AppError('STATE_INVALID'); return b.data;
    });
    const groups = new Map<string, Binding[]>();
    for (const b of bindings) groups.set(b.codespaceName, [...groups.get(b.codespaceName) ?? [], b]);
    let busy = false;
    for (const [name, group] of groups) {
      if (!group.some(b => b.ownership === 'dedicated')) continue;
      try {
        if (await this.instance(name, group)) busy = true;
        this.failures.delete(name);
      } catch (e) {
        const failures = (this.failures.get(name) ?? 0) + 1;
        this.failures.set(name, failures);
        this.log(`${name}: ${codeOf(e)} (${failures} in a row)`);
        await this.save(name, group, r => ({ ...r, errorCode: codeOf(e) }));
        if (failures < MAX_CONSECUTIVE_FAILURES) busy = true;
      }
    }
    return busy;
  }

  // Returns whether this instance still needs watching.
  private async instance(name: string, group: Binding[]): Promise<boolean> {
    const now = this.now();
    if (!group.every(b => b.ownership === 'dedicated')) {
      await this.save(name, group, r => ({ ...r, state: 'blocked', errorCode: 'BLOCKED_SHARED_USAGE', blockers: [{ kind: 'SHARED_BINDING', detail: 'a shared binding uses this instance' }] }));
      return false;
    }
    const graceMs = Math.max(...group.map(b => releasePolicy(b).graceSeconds)) * 1000;
    const exportMs = Math.max(...group.map(b => releasePolicy(b).exportTimeoutSeconds)) * 1000;
    const binding = group[0]!;
    const cs = await this.app.checked(binding);
    let record = await this.app.releaseRecord(name, 'stop_after_export');
    record = { ...record, lastGithubState: cs.state, errorCode: null };
    if (cs.state === 'Shutdown') {
      // Confirmed by GitHub, whether we requested it or the idle timeout did. Storage is always retained.
      const pending = record.exportStatus === 'PENDING' || (await this.unarchived(name, group)).length > 0;
      await this.save(name, group, () => ({ ...record, state: 'stopped', computeRelease: 'RELEASED', blockers: [], closeId: null, requested: false,
        graceStartedAt: null, nextAttemptAt: null, exportStatus: pending ? 'PENDING' : record.exportStatus }), true);
      return false;
    }
    if (cs.state !== 'Available') {
      await this.save(name, group, () => record);
      return TRANSITIONAL.includes(cs.state);
    }
    if (record.releaseId === null || record.state === 'stopped' || record.state === 'blocked') {
      record = { ...record, releaseId: randomBytes(8).toString('hex'), state: 'waiting_for_leases', computeRelease: 'NOT_RELEASED', attempts: 0,
        closeId: null, stopRequestedAt: null, graceStartedAt: null, nextAttemptAt: null, exportStatus: 'NONE', blockers: [] };
    }
    if (record.state === 'action_required' && !record.requested) { await this.save(name, group, () => record); return false; }
    if (record.state === 'retry_pending' && record.nextAttemptAt !== null && now < record.nextAttemptAt) { await this.save(name, group, () => record); return true; }
    if (record.state === 'stopping' && record.stopRequestedAt !== null && now - record.stopRequestedAt < STOP_CONFIRM_MS) { await this.save(name, group, () => record); return true; }
    if (record.state === 'stopping') {
      // GitHub accepted a stop that never took effect: that is a failed attempt, retried through the full sequence.
      record = { ...record, attempts: record.attempts + 1, state: 'retry_pending', closeId: null, stopRequestedAt: null };
      if (record.attempts >= MAX_ATTEMPTS) {
        await this.save(name, group, () => ({ ...record, state: 'action_required', errorCode: 'STOP_UNCONFIRMED' }), true);
        return false;
      }
    }

    // Usage first, then exports: a job that settles in between is exported now, and one still running blocks below,
    // so the instance never stops while a local job still needs exporting (within its window).
    const remote = instanceStatusSchema.parse(await this.app.runner.call(binding, 'instance_status'));
    const exports = await this.exportJobs(name, group, exportMs, new Set(remote.activeJobs.map(j => j.jobId)));
    const blockers = [...this.remoteBlockers(remote), ...await this.localBlockers(name, group, record.requested), ...exports.blockers];
    record.exportStatus = exports.overdue > 0 ? 'PENDING' : exports.archived > 0 ? 'COMPLETE' : record.exportStatus;
    if (blockers.length > 0) {
      await this.save(name, group, () => ({ ...record, state: 'waiting_for_leases', blockers, graceStartedAt: null }));
      return true;
    }
    record.blockers = [];
    if (!record.requested && graceMs > 0 && (record.graceStartedAt === null || now - record.graceStartedAt < graceMs)) {
      await this.save(name, group, () => ({ ...record, state: 'grace', graceStartedAt: record.graceStartedAt ?? now }));
      return true;
    }
    // Close intake and re-check usage in one remote transition; a job accepted just before this wins.
    const closeId = randomBytes(16).toString('hex');
    const closing = instanceStatusSchema.parse(await this.app.runner.call(binding, 'instance_close', { closeId }));
    if (!closing.closed) {
      await this.save(name, group, () => ({ ...record, state: 'waiting_for_leases', blockers: this.remoteBlockers(closing), graceStartedAt: null }));
      return true;
    }
    try {
      await this.app.gh.stop(name);
    } catch (e) {
      // Resume intake rather than leave a running instance refusing work.
      await this.app.runner.call(binding, 'instance_reopen', { closeId }).catch(() => {});
      const attempts = record.attempts + 1;
      const delay = Math.min(300_000, 10_000 * 2 ** attempts) + Math.floor(Math.random() * 5000);
      await this.save(name, group, () => ({ ...record, attempts, errorCode: codeOf(e), closeId: null,
        state: attempts >= MAX_ATTEMPTS ? 'action_required' : 'retry_pending', nextAttemptAt: attempts >= MAX_ATTEMPTS ? null : now + delay, requested: false }), attempts >= MAX_ATTEMPTS);
      return attempts < MAX_ATTEMPTS;
    }
    this.log(`${name}: stop requested (release ${record.releaseId})`);
    // A stop that GitHub accepted but never completed counts as a failed attempt on the next round.
    await this.save(name, group, () => ({ ...record, state: 'stopping', closeId, stopRequestedAt: now }));
    return true;
  }

  private remoteBlockers(status: ReturnType<typeof instanceStatusSchema.parse>): Blocker[] {
    return [
      ...status.activeJobs.map(j => ({ kind: 'JOB_ACTIVE' as const, detail: `${j.projectRoot} ${j.jobId.slice(0, 12)} ${j.state}` })),
      ...status.holds.map(h => ({ kind: 'HOLD' as const, detail: `${h.holdId} until ${new Date(h.expiresAt * 1000).toISOString()}` })),
    ];
  }

  private async jobs(name: string, group: Binding[]): Promise<JobRecord[]> {
    const projects = new Set(group.map(b => b.projectId));
    return (await this.app.store.list('job')).map(raw => jobRecordSchema.parse(raw)).filter(j => j.codespaceName === name && projects.has(j.projectId));
  }
  private async unarchived(name: string, group: Binding[]) {
    const result = [];
    for (const job of await this.jobs(name, group)) if (job.submission === 'accepted' && !await this.app.archive.read(job.jobId)) result.push(job);
    return result;
  }

  private async localBlockers(name: string, group: Binding[], requested: boolean): Promise<Blocker[]> {
    const blockers: Blocker[] = [];
    for (const job of await this.jobs(name, group)) {
      // Only while a submission may still be in flight. Afterwards anything that actually runs is in the remote
      // registry, and an unresolvable record must not keep the instance (and its cost) alive indefinitely.
      const inFlight = this.now() - Date.parse(job.submittedAt) <= RECONCILE_AFTER_MS;
      if ((job.submission === 'pending' || job.submission === 'unknown') && inFlight) blockers.push({ kind: 'SUBMISSION_UNCONFIRMED', detail: `${job.projectId} ${job.requestId}` });
    }
    // A recent prepare is a short lease so "prepare, then submit" is not raced by the release; an explicit request skips it.
    if (!requested) {
      const projects = new Set(group.map(b => b.projectId));
      for (const raw of await this.app.store.list('prepare')) {
        const op = operationSchema.parse(raw);
        if (projects.has(op.projectId) && op.state !== 'failed' && this.now() - Date.parse(op.updatedAt) < PREPARE_LEASE_MS) {
          blockers.push({ kind: 'PREPARE_LEASE', detail: `${op.projectId} until ${new Date(Date.parse(op.updatedAt) + PREPARE_LEASE_MS).toISOString()}` });
        }
      }
    }
    return blockers;
  }

  // Per-job calls go to where the job was submitted, which may differ from a binding that was moved since.
  private located(group: Binding[], job: JobRecord): Binding {
    return { ...group.find(b => b.projectId === job.projectId)!, remoteProjectRoot: job.remoteProjectRoot };
  }

  private async exportJobs(name: string, group: Binding[], exportMs: number, remotelyActive: Set<string>) {
    const result = { archived: 0, overdue: 0, blockers: [] as Blocker[] };
    for (const job of await this.jobs(name, group)) {
      if (await this.app.archive.read(job.jobId)) continue;
      const binding = this.located(group, job);
      if ((job.submission === 'pending' || job.submission === 'unknown') && this.now() - Date.parse(job.submittedAt) > RECONCILE_AFTER_MS) {
        await this.reconcile(binding, job);
        continue;
      }
      if (job.submission !== 'accepted') continue;
      let status;
      try { status = jobStatusSchema.parse(await this.app.runner.call(binding, 'job_get', { jobId: job.jobId })); }
      catch (e) {
        if (UNREACHABLE.includes(codeOf(e))) throw e;
        // One unreadable job must not keep the whole instance running: its export stays pending, remote files remain.
        this.log(`${name}: cannot export ${job.jobId.slice(0, 12)}: ${codeOf(e)}`);
        result.overdue++;
        continue;
      }
      if (!status.settled) {
        if (!remotelyActive.has(job.jobId)) result.blockers.push({ kind: 'JOB_ACTIVE', detail: `${job.projectId} ${job.jobId.slice(0, 12)} ${status.state}` });
        continue;
      }
      try {
        const { log, remoteBytes } = await this.fetchLog(binding, job.jobId);
        const artifacts = await this.exportArtifacts(binding, status);
        try { await this.app.archive.write(status, log, remoteBytes, artifacts); }
        finally { if (artifacts) await discard(artifacts.dir); }
        result.archived++;
        this.log(`${name}: archived ${job.jobId.slice(0, 12)} (${status.state})`);
      } catch (e) {
        // Within the export window a failed export keeps the instance up; afterwards the stop proceeds and remote files remain.
        const settledAt = (status.endedAt ?? status.updatedAt) * 1000;
        if (this.now() - settledAt > exportMs) result.overdue++;
        else result.blockers.push({ kind: 'EXPORT_RUNNING', detail: `${job.jobId.slice(0, 12)} ${codeOf(e)}` });
      }
    }
    return result;
  }

  // Required artifacts first, within the export quota; every copy is verified against the frozen manifest.
  private async exportArtifacts(binding: Binding, status: ReturnType<typeof jobStatusSchema.parse>) {
    const collected = status.artifacts.filter(a => a.state === 'collected').sort((a, b) => Number(b.required) - Number(a.required));
    if (collected.length === 0) return null;
    // Jobs from runners without a transfer alias can never be copied: archive their status and log, skip artifacts.
    try { transferPath(status, collected[0]!.name); }
    catch {
      await mkdir(this.app.archive.root, { recursive: true });
      return { dir: await mkdtemp(join(this.app.archive.root, '.staging-')), exported: [], skipped: collected.map(a => a.name) };
    }
    const dir = join(this.app.archive.root, `.staging-${randomBytes(8).toString('hex')}`);
    await mkdir(dir, { recursive: true });
    const exported: string[] = [], skipped: string[] = [];
    let budget = EXPORT_ARTIFACT_LIMIT;
    try {
      for (const entry of collected) {
        if ((entry.size ?? 0) > budget) { skipped.push(entry.name); continue; }
        const target = join(dir, entry.name);
        await this.app.gh.copy(binding.codespaceName, transferPath(status, entry.name), target, entry.kind === 'directory');
        await verifyArtifact(target, entry);
        exported.push(entry.name); budget -= entry.size ?? 0;
      }
    } catch (e) { await discard(dir); throw e; }
    return { dir, exported, skipped };
  }

  private async fetchLog(binding: Binding, jobId: string) {
    const chunks: Buffer[] = [];
    let cursor = 'v1:0', bytes = 0, remoteBytes = 0;
    while (bytes < ARCHIVE_LOG_LIMIT) {
      const page = jobLogsSchema.parse(await this.app.runner.call(binding, 'job_logs', { jobId, cursor, maxBytes: Math.min(LOG_PAGE_BYTES, ARCHIVE_LOG_LIMIT - bytes) }));
      remoteBytes = page.size;
      const chunk = Buffer.from(page.text, 'utf8');
      chunks.push(chunk); bytes += chunk.length;
      if (page.nextCursor === cursor) break;
      cursor = page.nextCursor;
    }
    return { log: Buffer.concat(chunks), remoteBytes };
  }

  private async reconcile(binding: Binding, job: JobRecord) {
    try {
      const status = jobStatusSchema.parse(await this.app.runner.call(binding, 'job_get', { jobId: job.jobId }));
      if (status.digest !== job.digest) return;
      await this.update('job', job.jobId, current => ({ ...current, submission: 'accepted', errorCode: null, status, observedAt: new Date(this.now()).toISOString() }));
    } catch (e) {
      // The accepted record is written before anything runs, so "not found" long after submission means it never ran.
      if (codeOf(e) === 'JOB_NOT_FOUND') await this.update('job', job.jobId, current => current.submission === 'accepted' ? current : { ...current, submission: 'not_sent', errorCode: 'RECONCILED_NOT_FOUND' });
    }
  }

  private async update(kind: 'job', id: string, fn: (current: JobRecord) => JobRecord) {
    await this.locked(async () => {
      const raw = await this.app.store.read(kind, id);
      if (raw !== undefined) await this.app.store.write(kind, id, fn(jobRecordSchema.parse(raw)));
    });
  }

  // Merges with whatever the MCP wrote meanwhile: an explicit release request is never lost unless consumed.
  private async save(name: string, group: Binding[], fn: (r: ReleaseRecord) => ReleaseRecord, consumeRequest = false) {
    await this.locked(async () => {
      const latest = await this.app.releaseRecord(name, releasePolicy(group[0]!).releaseMode);
      const next = fn(latest);
      await this.app.store.write('release', name, { ...next, requested: consumeRequest ? false : next.requested || latest.requested, updatedAt: this.now() });
    });
  }

  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.app.store.locked(fn); }
      catch (e) { if (codeOf(e) !== 'STATE_BUSY' || attempt >= 40) throw e; await new Promise(r => setTimeout(r, 250)); }
    }
  }
}

// One controller per state directory. A lock left by a dead process is taken over.
async function acquire(lockDir: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(lockDir);
      await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid }));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let pid = NaN;
      try { pid = JSON.parse(await readFile(join(lockDir, 'owner.json'), 'utf8')).pid; } catch { /* owner not written yet or corrupt */ }
      try { if (Number.isInteger(pid)) { process.kill(pid, 0); return false; } } catch { /* owner is gone */ }
      if (!Number.isInteger(pid)) {
        // A lock being created right now has no owner file yet; only a stale one is older than a few seconds.
        try { if (Date.now() - (await stat(lockDir)).mtimeMs < 5000) return false; } catch { continue; }
      }
      await rm(lockDir, { recursive: true, force: true });
    }
  }
  return false;
}

export async function runController(app: Application, options: { intervalMs?: number; idleTicks?: number } = {}) {
  const lockDir = join(app.store.root, 'controller.lock');
  await mkdir(app.store.root, { recursive: true });
  if (!await acquire(lockDir)) return false;
  const logPath = join(app.store.root, 'controller.log');
  const log = (line: string) => { void appendFile(logPath, `${new Date().toISOString()} ${line}\n`).catch(() => {}); };
  try {
    try { if ((await stat(logPath)).size > 1024 * 1024) await writeFile(logPath, ''); } catch { /* no log yet */ }
    log(`controller ${process.pid} started`);
    const controller = new Controller(app, () => Date.now(), log);
    let idle = 0;
    const idleTicks = options.idleTicks ?? 3;
    while (idle < idleTicks) {
      let busy = true;
      try { busy = await controller.tick(); } catch (e) { log(`tick failed: ${codeOf(e)}`); }
      idle = busy ? 0 : idle + 1;
      if (idle < idleTicks) await new Promise(r => setTimeout(r, options.intervalMs ?? 15000));
    }
    log(`controller ${process.pid} idle, exiting`);
    return true;
  } finally { await rm(lockDir, { recursive: true, force: true }); }
}

// Hidden background process that outlives the MCP server; a second one exits at once on the lock.
export function controllerLauncher(stateDir: string) {
  let last = 0;
  return () => {
    if (Date.now() - last < 10_000) return;
    last = Date.now();
    const child = spawn(process.execPath, [fileURLToPath(new URL('./cli.js', import.meta.url)), 'controller'], {
      detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, CODESPACE_MCP_STATE_DIR: stateDir },
    });
    child.on('error', () => {});
    child.unref();
  };
}
