import { z } from 'zod';
import { AppError, requireThat } from './errors.js';
import { bindingSchema, bindingInput, prepareInput, operationSchema, handshakeSchema, jobSubmitInput, jobRecordSchema, jobStatusSchema, jobGetInput, jobLogsInput, jobLogsSchema, jobRef, inspectInput, type Binding, type Operation, type JobRecord, type JobStatus } from './contracts.js';
import { Github } from './github.js';
import { LocalGit } from './git.js';
import { Store, digest } from './storage.js';
import type { RunnerPort } from './transport/runner.js';

// Failures after which the remote may or may not have acted: reconcile with the same request, never replay with a new one.
const AMBIGUOUS = ['TRANSPORT_UNAVAILABLE', 'PROCESS_TIMEOUT', 'PROCESS_CLEANUP_UNCONFIRMED', 'GITHUB_REQUEST_FAILED', 'OUTPUT_LIMIT', 'RUNNER_INVALID_RESPONSE', 'RUNNER_FAILED', 'INTERNAL_ERROR'];
const codeOf = (e: unknown) => e instanceof AppError ? e.code : 'INTERNAL_ERROR';

export class Application {
  constructor(readonly store: Store, readonly gh: Github, readonly runner: RunnerPort, readonly git = new LocalGit()) {}
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
      const binding = bindingSchema.parse({ ...fields, version: expectedVersion + 1, schemaVersion: 1 });
      await this.store.write('binding', input.projectId, binding); return binding;
    });
  }
  async available(binding: Binding) {
    await this.gh.identity(binding.expectedAccount);
    const cs = await this.gh.get(binding.codespaceName);
    requireThat(cs.repository.full_name.toLowerCase() === binding.repository.toLowerCase(), 'REPOSITORY_MISMATCH');
    requireThat(cs.owner.login.toLowerCase() === binding.expectedAccount.toLowerCase(), 'AUTH_IDENTITY_MISMATCH');
    requireThat(cs.state === 'Available', 'CODESPACE_NOT_READY');
  }
  async prepare(raw: z.input<typeof prepareInput>) {
    const input = prepareInput.parse(raw);
    return this.store.locked(async () => {
      const binding = await this.binding(input.projectId);
      const operationId = digest([input.projectId, input.requestId]);
      requireThat(!input.operationId || input.operationId === operationId, 'OPERATION_MISMATCH');
      const { locale: ignoredLocale, ...executionBinding } = binding;
      const planDigest = digest([executionBinding, input.policy]);
      const stored = await this.store.read('prepare', operationId);
      const old = stored === undefined ? undefined : operationSchema.parse(stored);
      requireThat(!old || old.digest === planDigest, 'IDEMPOTENCY_CONFLICT');
      const operation: Operation = { schemaVersion: 1, operationId, digest: planDigest, projectId: input.projectId, state: 'probing', observation: 'unknown', errorCode: null, handshake: null, updatedAt: new Date().toISOString() };
      await this.store.write('prepare', operationId, operation);
      try {
        await this.available(binding);
        operation.handshake = handshakeSchema.parse(await this.runner.call(binding, 'handshake'));
        operation.state = 'ready'; operation.observation = 'reachable';
      } catch (e) {
        const code = codeOf(e);
        operation.state = ['TRANSPORT_UNAVAILABLE', 'PROCESS_TIMEOUT', 'PROCESS_CLEANUP_UNCONFIRMED', 'GITHUB_REQUEST_FAILED', 'OUTPUT_LIMIT'].includes(code) ? 'unknown' : 'failed';
        operation.errorCode = code;
      }
      operation.updatedAt = new Date().toISOString();
      await this.store.write('prepare', operationId, operation); return operation;
    });
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
    return this.store.locked(async () => {
      const binding = await this.binding(input.projectId);
      // Idempotency scope: account, repository, project and requestId. The plan digest excludes presentation locale.
      const jobId = digest([binding.expectedAccount.toLowerCase(), binding.repository.toLowerCase(), input.projectId, input.requestId]);
      const planDigest = digest({ projectId: input.projectId, repository: binding.repository.toLowerCase(), codespaceName: binding.codespaceName,
        remoteProjectRoot: binding.remoteProjectRoot, source: input.source, steps: input.steps, timeoutSeconds: input.timeoutSeconds });
      const old = await this.jobRecord(jobId);
      requireThat(!old || old.digest === planDigest, 'IDEMPOTENCY_CONFLICT');
      const record: JobRecord = old ?? { schemaVersion: 1, jobId, requestId: input.requestId, projectId: input.projectId, digest: planDigest,
        codespaceName: binding.codespaceName, remoteProjectRoot: binding.remoteProjectRoot, bindingVersion: binding.version,
        submission: 'pending', errorCode: null, submittedAt: new Date().toISOString(), observedAt: null, status: null };
      if (!old) await this.store.write('job', jobId, record);
      let sent = false;
      try {
        await this.available(binding);
        sent = true;
        const job = { schemaVersion: 1, jobId, digest: planDigest, projectId: input.projectId, requestId: input.requestId, timeoutSeconds: input.timeoutSeconds,
          source: { ...input.source, repository: binding.repository }, steps: input.steps };
        const status = jobStatusSchema.parse(await this.runner.call(binding, 'job_submit', { job }));
        requireThat(status.jobId === jobId && status.digest === planDigest, 'RUNNER_INVALID_RESPONSE');
        Object.assign(record, { submission: 'accepted', errorCode: null, status, observedAt: new Date().toISOString() });
      } catch (e) {
        // Never downgrade an earlier ambiguous or accepted submission: only a never-sent request is known not to run.
        if (!sent) { if (record.submission === 'pending') record.submission = 'not_sent'; }
        else if (record.submission !== 'accepted') record.submission = AMBIGUOUS.includes(codeOf(e)) ? 'unknown' : 'rejected';
        record.errorCode = codeOf(e);
      }
      await this.store.write('job', jobId, record); return record;
    });
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
  async getJob(raw: z.input<typeof jobGetInput>) {
    const input = jobGetInput.parse(raw);
    const binding = await this.jobBinding(input.projectId, input.jobId);
    const status = jobStatusSchema.parse(await this.runner.call(binding, 'job_get', { jobId: input.jobId, waitSeconds: input.waitSeconds }));
    requireThat(status.projectId === input.projectId, 'JOB_NOT_FOUND');
    await this.observe(status); return status;
  }
  async cancelJob(raw: z.input<typeof jobRef>) {
    const input = jobRef.parse(raw);
    const binding = await this.jobBinding(input.projectId, input.jobId);
    const status = jobStatusSchema.parse(await this.runner.call(binding, 'job_cancel', { jobId: input.jobId }));
    requireThat(status.projectId === input.projectId, 'JOB_NOT_FOUND');
    await this.observe(status); return status;
  }
  async jobLogs(raw: z.input<typeof jobLogsInput>) {
    const input = jobLogsInput.parse(raw);
    const binding = await this.jobBinding(input.projectId, input.jobId);
    return jobLogsSchema.parse(await this.runner.call(binding, 'job_logs', { jobId: input.jobId, cursor: input.cursor, maxBytes: input.maxBytes }));
  }
}
