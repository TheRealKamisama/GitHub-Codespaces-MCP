import { z } from 'zod';
export const locale = z.enum(['en', 'zh-CN']).default('en');
export const projectId = z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/);
export const requestId = z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
export const remoteRoot = z.string().max(240).refine(p => p.startsWith('/workspaces/') && !p.includes('\\') && p.split('/').slice(2).every(s => s.length > 0 && s !== '.' && s !== '..' && !/[\x00-\x1f\x7f]/.test(s)), 'Use an absolute child of /workspaces without dot segments or control characters');
export const bindingInput = z.strictObject({
  projectId, expectedAccount: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),
  repository: z.string().max(200).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  codespaceName: z.string().max(100).regex(/^[a-z0-9][a-z0-9-]*$/),
  remoteProjectRoot: remoteRoot, githubHost: z.literal('github.com'),
  // dedicated: this tool may start the instance and must stop it after use; shared: never started or stopped here.
  ownership: z.enum(['shared', 'dedicated']), preparePolicy: z.enum(['reuse_only', 'start_existing']),
  resourcePolicy: z.strictObject({
    releaseMode: z.enum(['none', 'stop_after_export']),
    graceSeconds: z.number().int().min(0).max(3600).default(60),
    exportTimeoutSeconds: z.number().int().min(30).max(3600).default(300),
  }).optional(),
  expectedVersion: z.number().int().nonnegative().default(0), locale,
});
export const bindingSchema = bindingInput.omit({ expectedVersion: true }).extend({ schemaVersion: z.literal(1), version: z.number().int().positive() });
export type Binding = z.infer<typeof bindingSchema>;
export const handshakeSchema = z.strictObject({
  protocolVersion: z.literal(1), runnerSha256: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.string(), gitSha: z.string().regex(/^[a-f0-9]{40}$/), dirty: z.boolean(),
  codespaceName: z.string(), generation: z.string().min(1), pythonVersion: z.string(),
  platform: z.literal('linux'), capabilities: z.array(z.enum(['handshake', 'bounded_diagnostic', 'revision_jobs', 'instance_lifecycle'])),
});
export const diagnosticSchema = z.strictObject({
  probeId: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(['accepted', 'running', 'completed', 'interrupted', 'unknown']),
  generation: z.string(), startedAt: z.number(), updatedAt: z.number(),
});
// policy defaults to the binding's preparePolicy and may never exceed it.
export const prepareInput = z.strictObject({ projectId, requestId, operationId: z.string().regex(/^[a-f0-9]{64}$/).optional(), policy: z.enum(['reuse_only', 'start_existing']).optional(), locale });
export const operationSchema = z.strictObject({
  schemaVersion: z.literal(1), operationId: z.string(), digest: z.string(), projectId: z.string(),
  state: z.enum(['starting', 'probing', 'ready', 'failed', 'unknown']), observation: z.enum(['reachable', 'unknown']),
  errorCode: z.string().nullable(), handshake: handshakeSchema.nullable(), updatedAt: z.string(),
});
export type Operation = z.infer<typeof operationSchema>;
export const errorSchema = z.strictObject({ code: z.string(), message: z.string(), nextAction: z.string(), retryable: z.boolean() });
export function envelope(data: z.ZodType) {
  return z.union([
    z.strictObject({ schemaVersion: z.literal(1), ok: z.literal(true), data, error: z.null() }),
    z.strictObject({ schemaVersion: z.literal(1), ok: z.literal(false), data: z.null(), error: errorSchema }),
  ]);
}

// M1 exact-revision jobs. Limits mirror runner/main.py validate_job, which re-checks everything remotely.
const noNul = (s: string) => !s.includes('\0');
const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
export const jobId = hex64;
const relativeDir = z.string().max(240).refine(p => !p.startsWith('/') && !p.includes('\\') && !/[\x00-\x1f\x7f]/.test(p) && p.split('/').every(s => s !== '..'), 'Use a relative directory inside the checked-out source without .. segments').default('.');
const stepBase = {
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
  role: z.enum(['setup', 'build', 'test', 'analysis', 'cleanup']),
  cwd: relativeDir,
  timeoutSeconds: z.number().int().min(1).max(21600).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string().max(4096).refine(noNul)).default({}),
  optional: z.boolean().default(false),
};
export const stepSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...stepBase, kind: z.literal('command'), argv: z.array(z.string().max(8192).refine(noNul)).min(1).max(256) }),
  z.strictObject({ ...stepBase, kind: z.literal('shell'), shell: z.enum(['bash', 'sh']), script: z.string().min(1).max(65536).refine(noNul) }),
]);
export const revisionSource = z.strictObject({
  mode: z.literal('revision').default('revision'),
  ref: z.string().max(211).regex(/^refs\/(heads|tags)\/[A-Za-z0-9._/-]{1,200}$/).refine(r => !r.includes('..') && !r.endsWith('/') && !r.endsWith('.lock'), 'Use a full branch or tag ref'),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
});
// Declared outputs are frozen on the runner after the main steps (before cleanup) and downloaded by name.
export const artifactSpec = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
  path: relativeDir.refine(p => p.split('/').some(s => s !== '' && s !== '.'), 'Name a file or directory inside the source, not the source root'),
  required: z.boolean().default(true),
});
export const jobSubmitInput = z.strictObject({
  projectId, requestId, source: revisionSource,
  steps: z.array(stepSchema).min(1).max(32).refine(steps => new Set(steps.map(s => s.id)).size === steps.length, 'Step ids must be unique'),
  artifacts: z.array(artifactSpec).max(32).refine(a => new Set(a.map(x => x.name)).size === a.length, 'Artifact names must be unique').default([]),
  timeoutSeconds: z.number().int().min(1).max(21600).default(3600), locale,
}).refine(input => JSON.stringify(input).length <= 131072, 'Job plan exceeds 128 KiB');
const outcome = z.enum(['PASS', 'FAIL', 'NOT_RUN', 'NOT_CONFIGURED']);
export const jobStatusSchema = z.strictObject({
  jobId: hex64, projectId: z.string(), digest: hex64,
  state: z.enum(['accepted', 'preparing', 'queued', 'running', 'succeeded', 'failed', 'timed_out', 'cancel_requested', 'cancelled', 'interrupted']),
  settled: z.boolean(), observation: z.enum(['reachable', 'stale']), errorCode: z.string().nullable(), cancelRequested: z.boolean(),
  generation: z.string(), acceptedAt: z.number(), startedAt: z.number().nullable(), endedAt: z.number().nullable(), updatedAt: z.number(),
  source: z.strictObject({
    mode: z.literal('revision'), repository: z.string(), ref: z.string(), requestedCommit: z.string(),
    resolvedCommit: z.string().nullable(), sourceModified: z.boolean().nullable(), workdir: z.string().nullable(),
  }),
  steps: z.array(z.strictObject({
    id: z.string(), role: z.string(), optional: z.boolean(),
    state: z.enum(['pending', 'running', 'passed', 'failed', 'timed_out', 'cancelled', 'interrupted', 'not_run']),
    exitCode: z.number().int().nullable(), signal: z.string().nullable(), errorCode: z.string().nullable(),
    startedAt: z.number().nullable(), endedAt: z.number().nullable(),
  })),
  summary: z.strictObject({ execution: z.enum(['PASS', 'FAIL', 'NOT_RUN', 'INCOMPLETE']), verification: outcome, cleanup: outcome }),
  // Absent in jobs and archives created before artifacts existed.
  artifacts: z.array(z.strictObject({
    name: z.string(), path: z.string(), required: z.boolean(), kind: z.enum(['file', 'directory']).nullable(),
    state: z.enum(['pending', 'collected', 'missing', 'rejected', 'too_large', 'not_collected']),
    size: z.number().int().nonnegative().nullable(), sha256: hex64.nullable(),
    files: z.array(z.strictObject({ path: z.string(), size: z.number().int().nonnegative(), sha256: hex64 })), errorCode: z.string().nullable(),
  })).default([]),
});
export type JobStatus = z.infer<typeof jobStatusSchema>;
// Local locator: persisted before the remote call so a lost response is reconciled with the same requestId.
export const jobRecordSchema = z.strictObject({
  schemaVersion: z.literal(1), jobId: hex64, requestId: z.string(), projectId: z.string(), digest: hex64,
  codespaceName: z.string(), remoteProjectRoot: z.string(), bindingVersion: z.number().int().positive(),
  submission: z.enum(['pending', 'not_sent', 'accepted', 'unknown', 'rejected']), errorCode: z.string().nullable(),
  submittedAt: z.string(), observedAt: z.string().nullable(), status: jobStatusSchema.nullable(),
});
export type JobRecord = z.infer<typeof jobRecordSchema>;
export const jobRef = z.strictObject({ projectId, jobId, locale });
export const jobGetInput = z.strictObject({ projectId, jobId, waitSeconds: z.number().int().min(0).max(20).default(0), locale });
export const jobLogsInput = z.strictObject({ projectId, jobId, cursor: z.string().regex(/^v1:[0-9]{1,15}$/).default('v1:0'), maxBytes: z.number().int().min(1).max(262144).default(32768), locale });
export const jobLogsSchema = z.strictObject({ jobId: hex64, cursor: z.string(), nextCursor: z.string(), text: z.string(), size: z.number().int().nonnegative(), complete: z.boolean() });
export const inspectInput = z.strictObject({ localProjectRoot: z.string().min(1).max(4096), projectId: projectId.optional(), locale });
export const inspectSchema = z.strictObject({
  localProjectRoot: z.string(), head: z.string().nullable(), branch: z.string().nullable(),
  upstream: z.strictObject({ remote: z.string(), ref: z.string(), trackingRef: z.string(), repository: z.string().nullable() }).nullable(),
  dirty: z.strictObject({ tracked: z.number().int().nonnegative(), untracked: z.number().int().nonnegative() }),
  pushed: z.enum(['yes', 'no', 'unknown']),
  binding: z.strictObject({ projectId: z.string(), repository: z.string(), matches: z.boolean() }).nullable(),
  suggestedSource: z.strictObject({ mode: z.literal('revision'), ref: z.string(), commit: z.string() }).nullable(),
  warnings: z.array(z.enum(['DETACHED_HEAD', 'NO_UPSTREAM', 'NOT_PUSHED', 'PUSH_STATUS_UNKNOWN', 'WORKTREE_DIRTY', 'NOT_GITHUB_REMOTE', 'REPOSITORY_MISMATCH', 'NO_COMMITS'])),
});

// Instance lifecycle (M1 slice 2). One release record per Codespace, written by the local controller.
export const instanceStatusSchema = z.strictObject({
  generation: z.string(), closed: z.boolean(),
  activeJobs: z.array(z.strictObject({ projectRoot: z.string(), jobId: hex64, state: z.string() })),
  holds: z.array(z.strictObject({ holdId: z.string().regex(/^[a-f0-9]{32}$/), expiresAt: z.number() })),
  closing: z.strictObject({ closeId: z.string(), generation: z.string(), createdAt: z.number(), expiresAt: z.number() }).nullable(),
});
export type InstanceStatus = z.infer<typeof instanceStatusSchema>;
export const releaseRecordSchema = z.strictObject({
  schemaVersion: z.literal(1), codespaceName: z.string(), releaseId: z.string().nullable(),
  requestedPolicy: z.enum(['none', 'stop_after_export']),
  state: z.enum(['idle', 'waiting_for_leases', 'grace', 'stopping', 'stopped', 'blocked', 'retry_pending', 'action_required']),
  blockers: z.array(z.strictObject({ kind: z.enum(['JOB_ACTIVE', 'HOLD', 'SUBMISSION_UNCONFIRMED', 'PREPARE_LEASE', 'EXPORT_RUNNING', 'SHARED_BINDING']), detail: z.string() })),
  requested: z.boolean(), graceStartedAt: z.number().nullable(), closeId: z.string().nullable(),
  stopRequestedAt: z.number().nullable(), attempts: z.number().int().nonnegative(), nextAttemptAt: z.number().nullable(),
  errorCode: z.string().nullable(), lastGithubState: z.string().nullable(),
  computeRelease: z.enum(['NOT_RELEASED', 'RELEASED', 'UNKNOWN']), storageRelease: z.literal('RETAINED'),
  exportStatus: z.enum(['NONE', 'COMPLETE', 'PENDING']), updatedAt: z.number(),
});
export type ReleaseRecord = z.infer<typeof releaseRecordSchema>;
export const releaseInput = z.strictObject({
  projectId, action: z.enum(['status', 'request', 'hold', 'unhold']),
  holdSeconds: z.number().int().min(60).max(14400).optional(), holdId: z.string().regex(/^[a-f0-9]{32}$/).optional(), locale,
});
export const releaseOutputSchema = z.strictObject({
  release: releaseRecordSchema, hold: z.strictObject({ holdId: z.string(), expiresAt: z.number() }).nullable(),
});
export const archiveReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1), jobId: hex64, digest: hex64, statusSha256: hex64, logSha256: hex64,
  logBytes: z.number().int().nonnegative(), remoteLogBytes: z.number().int().nonnegative(), truncated: z.boolean(), archivedAt: z.string(),
  // Exported artifacts are verified against the manifest; skipped ones exceeded the export quota and stay remote.
  artifactsExported: z.array(z.string()).default([]), artifactsSkipped: z.array(z.string()).default([]),
});
export const artifactDownloadInput = z.strictObject({ projectId, jobId, artifact: artifactSpec.shape.name, localDestination: z.string().min(1).max(4096), locale });
export const artifactDownloadSchema = z.strictObject({
  artifact: z.string(), kind: z.enum(['file', 'directory']), localPath: z.string(), size: z.number().int().nonnegative(),
  sha256: hex64.nullable(), files: z.number().int().nonnegative(), source: z.enum(['archive', 'codespace']), verified: z.literal(true),
});
