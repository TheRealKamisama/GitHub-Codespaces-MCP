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
  platform: z.literal('linux'), capabilities: z.array(z.enum(['handshake', 'bounded_diagnostic'])),
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
