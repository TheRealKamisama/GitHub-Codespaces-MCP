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
  ownership: z.literal('shared'), preparePolicy: z.literal('reuse_only'),
  expectedVersion: z.number().int().nonnegative().default(0), locale,
});
export const bindingSchema = bindingInput.omit({ expectedVersion: true }).extend({ schemaVersion: z.literal(1), version: z.number().int().positive() });
export type Binding = z.infer<typeof bindingSchema>;
export const handshakeSchema = z.strictObject({
  protocolVersion: z.literal(1), runnerSha256: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.string(), gitSha: z.string().regex(/^[a-f0-9]{40}$/), dirty: z.boolean(),
  codespaceName: z.string(), generation: z.string().min(1), pythonVersion: z.string(),
  platform: z.literal('linux'), capabilities: z.array(z.enum(['handshake', 'bounded_diagnostic', 'revision_jobs'])),
});
export const diagnosticSchema = z.strictObject({
  probeId: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(['accepted', 'running', 'completed', 'interrupted', 'unknown']),
  generation: z.string(), startedAt: z.number(), updatedAt: z.number(),
});
export const prepareInput = z.strictObject({ projectId, requestId, operationId: z.string().regex(/^[a-f0-9]{64}$/).optional(), policy: z.literal('reuse_only').default('reuse_only'), locale });
export const operationSchema = z.strictObject({
  schemaVersion: z.literal(1), operationId: z.string(), digest: z.string(), projectId: z.string(),
  state: z.enum(['probing', 'ready', 'failed', 'unknown']), observation: z.enum(['reachable', 'unknown']),
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
export const jobSubmitInput = z.strictObject({
  projectId, requestId, source: revisionSource,
  steps: z.array(stepSchema).min(1).max(32).refine(steps => new Set(steps.map(s => s.id)).size === steps.length, 'Step ids must be unique'),
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
