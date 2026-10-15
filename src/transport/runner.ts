import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError, requireThat } from '../errors.js';
import { handshakeSchema, diagnosticSchema, jobStatusSchema, jobLogsSchema, instanceStatusSchema, type Binding } from '../contracts.js';
import { Github } from '../github.js';

export const buildSchema = z.strictObject({ version: z.string(), gitSha: z.string(), dirty: z.boolean(), runnerSha256: z.string(), runnerProtocol: z.literal(1) });
export type Build = z.infer<typeof buildSchema>;
export type RunnerAction = 'handshake' | 'diagnostic_start' | 'diagnostic_get' | 'job_submit' | 'job_get' | 'job_cancel' | 'job_logs'
  | 'instance_status' | 'instance_close' | 'instance_reopen' | 'hold_set' | 'hold_clear';
export interface RunnerFields { probeId?: string; job?: unknown; jobId?: string; cursor?: string; maxBytes?: number; waitSeconds?: number; closeId?: string; holdId?: string; holdSeconds?: number }
export interface RunnerPort { call(binding: Binding, action: RunnerAction, fields?: RunnerFields): Promise<unknown> }
const responses: Record<RunnerAction, z.ZodType> = {
  handshake: handshakeSchema, diagnostic_start: diagnosticSchema, diagnostic_get: diagnosticSchema,
  job_submit: jobStatusSchema, job_get: jobStatusSchema, job_cancel: jobStatusSchema, job_logs: jobLogsSchema,
  instance_status: instanceStatusSchema, instance_close: instanceStatusSchema, instance_reopen: instanceStatusSchema, hold_set: instanceStatusSchema, hold_clear: instanceStatusSchema,
};
const known = ['WORKSPACE_CONFLICT', 'PATH_INVALID', 'CODESPACE_IDENTITY_MISMATCH', 'CAPABILITY_MISSING', 'RUNNER_INCOMPATIBLE', 'HASH_MISMATCH', 'STATE_INVALID', 'PROBE_NOT_FOUND', 'PLATFORM_UNSUPPORTED',
  'CONFIG_INVALID', 'REPOSITORY_MISMATCH', 'IDEMPOTENCY_CONFLICT', 'JOB_NOT_FOUND', 'CURSOR_INVALID', 'CODESPACE_RELEASING'];
export class Runner implements RunnerPort {
  constructor(private gh: Github, readonly build: Build) {}
  async call(binding: Binding, action: RunnerAction, fields: RunnerFields = {}) {
    const source = await readFile(new URL('../runner/main.py', import.meta.url));
    requireThat(createHash('sha256').update(source).digest('hex') === this.build.runnerSha256, 'HASH_MISMATCH');
    const bootstrap = await readFile(new URL('../runner/bootstrap.py', import.meta.url));
    // The remote shell receives only a fixed trusted entry point; all dynamic data goes over stdin.
    const python = `python3 -c 'import base64;exec(base64.b64decode("${bootstrap.toString('base64')}"))'`;
    const command = `if command -v python3 >/dev/null 2>&1; then ${python}; else printf '%s\\n' '{"ok":false,"data":null,"error":"CAPABILITY_MISSING"}'; fi`;
    // Log pages are at most 1 MiB of text (export); JSON escaping can expand control characters several times.
    const response = await this.gh.command(['codespace', 'ssh', '-c', binding.codespaceName, '--', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', command], JSON.stringify({
      ...fields, protocolVersion: 1, action, binding, build: this.build, source: source.toString('base64'),
    }), { timeoutMs: 15000 + (fields.waitSeconds ?? 0) * 1000, maxBytes: 8 * 1024 * 1024 });
    requireThat(response.exitCode === 0, 'TRANSPORT_UNAVAILABLE');
    let result;
    try { result = z.object({ ok: z.boolean(), data: z.unknown(), error: z.string().nullable() }).parse(JSON.parse(response.stdout)); }
    catch { throw new AppError('RUNNER_INVALID_RESPONSE'); }
    if (!result.ok) throw new AppError(known.includes(result.error ?? '') ? result.error! : 'RUNNER_FAILED');
    const parsed = responses[action].safeParse(result.data);
    requireThat(parsed.success, 'RUNNER_INVALID_RESPONSE');
    if (action === 'handshake') {
      const h = handshakeSchema.parse(parsed.data);
      requireThat(h.runnerSha256 === this.build.runnerSha256 && h.version === this.build.version && h.gitSha === this.build.gitSha && h.dirty === this.build.dirty, 'RUNNER_INCOMPATIBLE');
      requireThat(h.codespaceName === binding.codespaceName, 'CODESPACE_IDENTITY_MISMATCH');
    }
    return parsed.data;
  }
}
