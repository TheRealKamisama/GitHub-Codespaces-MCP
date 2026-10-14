import { z } from 'zod';
import { AppError, requireThat } from './errors.js';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { bindingSchema, bindingInput, prepareInput, operationSchema, handshakeSchema, jobSubmitInput, jobRecordSchema, jobStatusSchema, jobGetInput, jobLogsInput, jobLogsSchema, jobRef, inspectInput, releaseInput, releaseRecordSchema, instanceStatusSchema, type Binding, type Operation, type JobRecord, type JobStatus, type ReleaseRecord } from './contracts.js';
import { Github } from './github.js';
import { Archive } from './archive.js';
import { LocalGit } from './git.js';
import { Store, digest } from './storage.js';
import type { RunnerPort } from './transport/runner.js';

// Failures after which the remote may or may not have acted: reconcile with the same request, never replay with a new one.
const AMBIGUOUS = ['TRANSPORT_UNAVAILABLE', 'PROCESS_TIMEOUT', 'PROCESS_CLEANUP_UNCONFIRMED', 'GITHUB_REQUEST_FAILED', 'OUTPUT_LIMIT', 'RUNNER_INVALID_RESPONSE', 'RUNNER_FAILED', 'INTERNAL_ERROR'];
export const codeOf = (e: unknown) => e instanceof AppError ? e.code : 'INTERNAL_ERROR';
// States from which an instance is on its way to Available without another start request.
const TRANSITIONAL = ['Queued', 'Provisioning', 'Awaiting', 'Created', 'Starting', 'Updating', 'Rebuilding', 'ShuttingDown'];

// Bindings stored before resource policies existed are shared and never released by this tool.
export function releasePolicy(b: Binding) {
  return b.resourcePolicy ?? { releaseMode: b.ownership === 'dedicated' ? 'stop_after_export' as const : 'none' as const, graceSeconds: 60, exportTimeoutSeconds: 300 };
}
export function newReleaseRecord(codespaceName: string, requestedPolicy: ReleaseRecord['requestedPolicy']): ReleaseRecord {
  return { schemaVersion: 1, codespaceName, releaseId: null, requestedPolicy, state: 'idle', blockers: [], requested: false, graceStartedAt: null, closeId: null,
    stopRequestedAt: null, attempts: 0, nextAttemptAt: null, errorCode: null, lastGithubState: null, computeRelease: 'NOT_RELEASED', storageRelease: 'RETAINED',
    exportStatus: 'NONE', updatedAt: Date.now() };
}

export interface ApplicationOptions {
  archive?: Archive;
  // Starts the local release controller; a no-op unless wired by the CLI.
  wake?: () => void;
  sleep?: (ms: number) => Promise<void>;
  startWaitMs?: number;
}

export class Application {
  readonly archive: Archive;
  readonly wake: () => void;
  private sleep: (ms: number) => Promise<void>;
  private startWaitMs: number;
  constructor(readonly store: Store, readonly gh: Github, readonly runner: RunnerPort, readonly git = new LocalGit(), options: ApplicationOptions = {}) {
    this.archive = options.archive ?? new Archive(join(store.root, 'archive'));
    this.wake = options.wake ?? (() => {});
    this.sleep = options.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    this.startWaitMs = options.startWaitMs ?? 20000;
  }
  async binding(id: string): Promise<Binding> {
    const raw = await this.store.read('binding', id);
    requireThat(raw !== undefined, 'PROJECT_NOT_BOUND');
    const b = bindingSchema.safeParse(raw); requireThat(b.success, 'STATE_INVALID'); return b.data;
  }
  async bind(raw: z.input<typeof bindingInput>) {
    const input = bindingInput.parse(raw);
    return this.store.locked(async () => {
      await this.gh.identity(input.expectedAccount);
      const cs = await this.gh.get(input.codespaceName);
      requireThat(cs.repository.full_name.toLowerCase() === input.repository.toLowerCase(), 'REPOSITORY_MISMATCH');
      requireThat(cs.owner.login.toLowerCase() === input.expectedAccount.toLowerCase(), 'AUTH_IDENTITY_MISMATCH');
      const old = await this.store.read('binding', input.projectId);
      const current = old === undefined ? undefined : bindingSchema.parse(old);
      requireThat(input.expectedVersion === (current?.version ?? 0), 'BINDING_VERSION_CONFLICT');
      const { expectedVersion, ...fields } = input;
      // Only a dedicated binding may start an instance, and it must then be released after use.
      const dedicated = fields.ownership === 'dedicated';
      const releaseMode = fields.resourcePolicy?.releaseMode ?? (dedicated ? 'stop_after_export' : 'none');
      requireThat(dedicated ? releaseMode === 'stop_after_export' : releaseMode === 'none' && fields.preparePolicy === 'reuse_only', 'CONFIG_INVALID');
      // Ownership is per instance: two projects must not disagree about whether this tool may stop it.
      for (const other of await this.store.list('binding')) {
        const b = bindingSchema.safeParse(other); requireThat(b.success, 'STATE_INVALID');
        if (b.data.projectId !== fields.projectId && b.data.codespaceName === fields.codespaceName) requireThat(b.data.ownership === fields.ownership, 'CONFIG_INVALID');
      }
      const binding = bindingSchema.parse({ ...fields, resourcePolicy: { ...fields.resourcePolicy, releaseMode }, version: expectedVersion + 1, schemaVersion: 1 });
      await this.store.write('binding', input.projectId, binding);
      if (dedicated) this.wake();
      return binding;
    });
  }
  async checked(binding: Binding) {
    await this.gh.identity(binding.expectedAccount);
    const cs = await this.gh.get(binding.codespaceName);
    requireThat(cs.repository.full_name.toLowerCase() === binding.repository.toLowerCase(), 'REPOSITORY_MISMATCH');
    requireThat(cs.owner.login.toLowerCase() === binding.expectedAccount.toLowerCase(), 'AUTH_IDENTITY_MISMATCH');
    return cs;
  }
  async available(binding: Binding) {
    requireThat((await this.checked(binding)).state === 'Available', 'CODESPACE_NOT_READY');
  }
  // The state lock guards short local read-modify-writes only; it is never held across network calls, so the
  // controller and other tools are not blocked for the length of an SSH call or an instance start.
  async briefly<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.store.locked(fn); }
      catch (e) { if (codeOf(e) !== 'STATE_BUSY' || attempt >= 20) throw e; await new Promise(r => setTimeout(r, 100)); }
    }
  }
  async prepare(raw: z.input<typeof prepareInput>) {
    const input = prepareInput.parse(raw);
    const { binding, policy, operation } = await this.briefly(async () => {
      const binding = await this.binding(input.projectId);
      const operationId = digest([input.projectId, input.requestId]);
      requireThat(!input.operationId || input.operationId === operationId, 'OPERATION_MISMATCH');
      const policy = input.policy ?? binding.preparePolicy;
      requireThat(policy === 'reuse_only' || binding.preparePolicy === 'start_existing', 'POLICY_NOT_ALLOWED');
      const { locale: ignoredLocale, ...executionBinding } = binding;
      const planDigest = digest([executionBinding, policy]);
      const stored = await this.store.read('prepare', operationId);
      const old = stored === undefined ? undefined : operationSchema.parse(stored);
      requireThat(!old || old.digest === planDigest, 'IDEMPOTENCY_CONFLICT');
      const operation: Operation = { schemaVersion: 1, operationId, digest: planDigest, projectId: input.projectId, state: 'probing', observation: 'unknown', errorCode: null, handshake: null, updatedAt: new Date().toISOString() };
      await this.store.write('prepare', operationId, operation);
      return { binding, policy, operation };
    });
    const operationId = operation.operationId;
      try {
        let cs = await this.checked(binding);
        if (cs.state !== 'Available' && policy === 'start_existing') {
          if (cs.state === 'Shutdown') await this.gh.start(binding.codespaceName);
          else requireThat(TRANSITIONAL.includes(cs.state), 'CODESPACE_NOT_READY');
          // Bounded wait inside one call; callers resume the same requestId while the instance is still starting.
          const deadline = Date.now() + this.startWaitMs;
          while (cs.state !== 'Available' && Date.now() < deadline) { await this.sleep(3000); cs = await this.gh.get(binding.codespaceName); }
          if (cs.state !== 'Available') {
            operation.state = 'starting'; operation.updatedAt = new Date().toISOString();
            await this.briefly(() => this.store.write('prepare', operationId, operation)); this.wake(); return operation;
          }
        }
        requireThat(cs.state === 'Available', 'CODESPACE_NOT_READY');
        operation.handshake = handshakeSchema.parse(await this.runner.call(binding, 'handshake'));
        operation.state = 'ready'; operation.observation = 'reachable';
      } catch (e) {
        const code = codeOf(e);
        operation.state = ['TRANSPORT_UNAVAILABLE', 'PROCESS_TIMEOUT', 'PROCESS_CLEANUP_UNCONFIRMED', 'GITHUB_REQUEST_FAILED', 'OUTPUT_LIMIT'].includes(code) ? 'unknown' : 'failed';
        operation.errorCode = code;
      }
      operation.updatedAt = new Date().toISOString();
      await this.briefly(() => this.store.write('prepare', operationId, operation));
      if (binding.ownership === 'dedicated') this.wake();
      return operation;
  }
  async probe(project: string, request: string, action: 'start' | 'status') {
    return this.store.locked(async () => {
      const b = await this.binding(project); await this.available(b);
      const id = digest([b.expectedAccount.toLowerCase(), b.repository.toLowerCase(), b.codespaceName, b.remoteProjectRoot, request]);
      return this.runner.call(b, action === 'start' ? 'diagnostic_start' : 'diagnostic_get', { probeId: id });
    });
  }
  async inspect(raw: z.input<typeof inspectInput>) {
    const input = inspectInput.parse(raw);
    const local = await this.git.inspect(input.localProjectRoot);
    let binding = null;
    if (input.projectId) {
      const stored = await this.store.read('binding', input.projectId);
      if (stored !== undefined) {
        const b = bindingSchema.safeParse(stored); requireThat(b.success, 'STATE_INVALID');
        binding = { projectId: input.projectId, repository: b.data.repository, matches: local.upstream?.repository?.toLowerCase() === b.data.repository.toLowerCase() };
      }
    }
    const warnings = [
      !local.head && 'NO_COMMITS', local.head && !local.branch && 'DETACHED_HEAD', local.branch && !local.upstream && 'NO_UPSTREAM',
      local.pushed === 'no' && 'NOT_PUSHED', local.upstream && local.pushed === 'unknown' && 'PUSH_STATUS_UNKNOWN',
      local.dirty.tracked + local.dirty.untracked > 0 && 'WORKTREE_DIRTY', local.upstream && !local.upstream.repository && 'NOT_GITHUB_REMOTE',
      binding && !binding.matches && 'REPOSITORY_MISMATCH',
    ].filter((w): w is string => typeof w === 'string');
    // Only a commit already contained in the upstream branch is offered; uncommitted changes are never part of it.
    const suggestedSource = local.head && local.upstream && local.pushed === 'yes' && local.upstream.ref.startsWith('refs/heads/')
      ? { mode: 'revision' as const, ref: local.upstream.ref, commit: local.head } : null;
    return { ...local, binding, suggestedSource, warnings };
  }
  private async jobRecord(jobId: string): Promise<JobRecord | undefined> {
    const stored = await this.store.read('job', jobId);
    if (stored === undefined) return undefined;
    const record = jobRecordSchema.safeParse(stored); requireThat(record.success, 'STATE_INVALID'); return record.data;
  }
  async submitJob(raw: z.input<typeof jobSubmitInput>) {
    const input = jobSubmitInput.parse(raw);
    // Phase 1: idempotency check and a persisted pending record, before anything can run remotely.
    const { binding, jobId, planDigest } = await this.briefly(async () => {
      const binding = await this.binding(input.projectId);
      // Idempotency scope: account, repository, project and requestId. The plan digest excludes presentation locale.
      const jobId = digest([binding.expectedAccount.toLowerCase(), binding.repository.toLowerCase(), input.projectId, input.requestId]);
      const planDigest = digest({ projectId: input.projectId, repository: binding.repository.toLowerCase(), codespaceName: binding.codespaceName,
        remoteProjectRoot: binding.remoteProjectRoot, source: input.source, steps: input.steps, timeoutSeconds: input.timeoutSeconds });
      const old = await this.jobRecord(jobId);
      requireThat(!old || old.digest === planDigest, 'IDEMPOTENCY_CONFLICT');
      if (!old || old.submission === 'not_sent') {
        await this.store.write('job', jobId, old ? { ...old, submission: 'pending' } : { schemaVersion: 1, jobId, requestId: input.requestId, projectId: input.projectId,
          digest: planDigest, codespaceName: binding.codespaceName, remoteProjectRoot: binding.remoteProjectRoot, bindingVersion: binding.version,
          submission: 'pending', errorCode: null, submittedAt: new Date().toISOString(), observedAt: null, status: null });
      }
      return { binding, jobId, planDigest };
    });
    // Phase 2: the remote call, without holding the local state lock.
    let sent = false, status: JobStatus | undefined, failure: string | undefined;
    try {
      await this.available(binding);
      sent = true;
      const job = { schemaVersion: 1, jobId, digest: planDigest, projectId: input.projectId, requestId: input.requestId, timeoutSeconds: input.timeoutSeconds,
        source: { ...input.source, repository: binding.repository }, steps: input.steps };
      status = jobStatusSchema.parse(await this.runner.call(binding, 'job_submit', { job }));
      requireThat(status.jobId === jobId && status.digest === planDigest, 'RUNNER_INVALID_RESPONSE');
    } catch (e) { status = undefined; failure = codeOf(e); }
    // Phase 3: merge into the latest record; the controller may have reconciled it meanwhile.
    const record = await this.briefly(async () => {
      const latest = await this.jobRecord(jobId);
      requireThat(latest, 'STATE_INVALID');
      let next: JobRecord;
      if (status) next = { ...latest, submission: 'accepted', errorCode: null, status, observedAt: new Date().toISOString() };
      else {
        next = { ...latest, errorCode: failure! };
        // Never downgrade an earlier ambiguous or accepted submission: only a never-sent request is known not to run.
        if (!sent) { if (latest.submission === 'pending') next.submission = 'not_sent'; }
        else if (latest.submission !== 'accepted') next.submission = AMBIGUOUS.includes(failure!) ? 'unknown' : 'rejected';
      }
      await this.store.write('job', jobId, next);
      return next;
    });
    if (binding.ownership === 'dedicated') this.wake();
    return record;
  }
  private async jobBinding(projectId: string, jobId: string) {
    const binding = await this.binding(projectId);
    const record = await this.jobRecord(jobId);
    if (record) {
      requireThat(record.projectId === projectId, 'JOB_NOT_FOUND');
      requireThat(record.codespaceName === binding.codespaceName && record.remoteProjectRoot === binding.remoteProjectRoot, 'JOB_LOCATION_CHANGED');
    }
    await this.available(binding);
    return binding;
  }
  private async observe(status: JobStatus) {
    // The remote runner is authoritative; the local mirror is best effort and never blocks an observation.
    try {
      await this.store.locked(async () => {
        const record = await this.jobRecord(status.jobId);
        if (!record || record.digest !== status.digest) return;
        await this.store.write('job', status.jobId, { ...record, submission: 'accepted', errorCode: null, status, observedAt: new Date().toISOString() });
      });
    } catch (e) { if (codeOf(e) !== 'STATE_BUSY') throw e; }
  }
  // A settled job archived locally is final: read it without contacting (or restarting) the Codespace.
  private async archived(projectId: string, jobId: string) {
    const archived = await this.archive.read(jobId);
    if (archived) requireThat(archived.status.projectId === projectId, 'JOB_NOT_FOUND');
    return archived;
  }
  async getJob(raw: z.input<typeof jobGetInput>) {
    const input = jobGetInput.parse(raw);
    const archived = await this.archived(input.projectId, input.jobId);
    if (archived) return archived.status;
    const binding = await this.jobBinding(input.projectId, input.jobId);
    const status = jobStatusSchema.parse(await this.runner.call(binding, 'job_get', { jobId: input.jobId, waitSeconds: input.waitSeconds }));
    requireThat(status.projectId === input.projectId, 'JOB_NOT_FOUND');
    await this.observe(status); return status;
  }
  async cancelJob(raw: z.input<typeof jobRef>) {
    const input = jobRef.parse(raw);
    const archived = await this.archived(input.projectId, input.jobId);
    if (archived) return archived.status;
    const binding = await this.jobBinding(input.projectId, input.jobId);
    const status = jobStatusSchema.parse(await this.runner.call(binding, 'job_cancel', { jobId: input.jobId }));
    requireThat(status.projectId === input.projectId, 'JOB_NOT_FOUND');
    await this.observe(status); return status;
  }
  async jobLogs(raw: z.input<typeof jobLogsInput>) {
    const input = jobLogsInput.parse(raw);
    const archived = await this.archived(input.projectId, input.jobId);
    // A truncated archive still has the full log remotely; read it there while the instance is running.
    if (archived && !archived.receipt.truncated) return this.archive.logs(input.jobId, input.cursor, input.maxBytes);
    const binding = await this.jobBinding(input.projectId, input.jobId);
    return jobLogsSchema.parse(await this.runner.call(binding, 'job_logs', { jobId: input.jobId, cursor: input.cursor, maxBytes: input.maxBytes }));
  }
  async releaseRecord(codespaceName: string, requestedPolicy: ReleaseRecord['requestedPolicy']) {
    const stored = await this.store.read('release', codespaceName);
    if (stored === undefined) return newReleaseRecord(codespaceName, requestedPolicy);
    const r = releaseRecordSchema.safeParse(stored); requireThat(r.success, 'STATE_INVALID'); return r.data;
  }
  async release(raw: z.input<typeof releaseInput>) {
    const input = releaseInput.parse(raw);
    const binding = await this.binding(input.projectId);
    const policy = releasePolicy(binding).releaseMode;
    if (input.action === 'status') return { release: await this.releaseRecord(binding.codespaceName, policy), hold: null };
    if (input.action === 'request') {
      requireThat(binding.ownership === 'dedicated', 'BLOCKED_SHARED_USAGE');
      const release = await this.store.locked(async () => {
        const record = { ...await this.releaseRecord(binding.codespaceName, policy), requested: true, updatedAt: Date.now() };
        await this.store.write('release', binding.codespaceName, record); return record;
      });
      this.wake();
      return { release, hold: null };
    }
    // Holds keep any instance open for bounded debugging; they live remotely so every client sees them.
    await this.available(binding);
    if (input.action === 'hold') {
      const holdId = randomBytes(16).toString('hex');
      const status = instanceStatusSchema.parse(await this.runner.call(binding, 'hold_set', { holdId, holdSeconds: input.holdSeconds ?? 3600 }));
      const hold = status.holds.find(h => h.holdId === holdId);
      requireThat(hold, 'RUNNER_INVALID_RESPONSE');
      this.wake();
      return { release: await this.releaseRecord(binding.codespaceName, policy), hold };
    }
    requireThat(input.holdId, 'INVALID_ARGUMENT');
    instanceStatusSchema.parse(await this.runner.call(binding, 'hold_clear', { holdId: input.holdId }));
    this.wake();
    return { release: await this.releaseRecord(binding.codespaceName, policy), hold: null };
  }
}
