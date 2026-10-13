import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError, requireThat } from '../errors.js';
import { handshakeSchema, diagnosticSchema, type Binding } from '../contracts.js';
import { Github } from '../github.js';

export const buildSchema = z.strictObject({ version: z.string(), gitSha: z.string(), dirty: z.boolean(), runnerSha256: z.string(), runnerProtocol: z.literal(1) });
export type Build = z.infer<typeof buildSchema>;
export interface RunnerPort { call(binding: Binding, action: 'handshake' | 'diagnostic_start' | 'diagnostic_get', probeId?: string): Promise<unknown> }
export class Runner implements RunnerPort {
  constructor(private gh: Github, readonly build: Build) {}
  async call(binding: Binding, action: 'handshake' | 'diagnostic_start' | 'diagnostic_get', probeId?: string) {
    const source = await readFile(new URL('../runner/main.py', import.meta.url));
    requireThat(createHash('sha256').update(source).digest('hex') === this.build.runnerSha256, 'HASH_MISMATCH');
    const bootstrap = await readFile(new URL('../runner/bootstrap.py', import.meta.url));
    // The remote shell receives only a fixed trusted entry point; all dynamic data goes over stdin.
    const python = `python3 -c 'import base64;exec(base64.b64decode("${bootstrap.toString('base64')}"))'`;
    const command = `if command -v python3 >/dev/null 2>&1; then ${python}; else printf '%s\\n' '{"ok":false,"data":null,"error":"CAPABILITY_MISSING"}'; fi`;
    const response = await this.gh.command(['codespace', 'ssh', '-c', binding.codespaceName, '--', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', command], JSON.stringify({
      protocolVersion: 1, action, probeId, binding, build: this.build, source: source.toString('base64'),
    }));
    requireThat(response.exitCode === 0, 'TRANSPORT_UNAVAILABLE');
    let result;
    try { result = z.object({ ok: z.boolean(), data: z.unknown(), error: z.string().nullable() }).parse(JSON.parse(response.stdout)); }
    catch { throw new AppError('RUNNER_INVALID_RESPONSE'); }
    if (!result.ok) {
      const known = ['WORKSPACE_CONFLICT', 'PATH_INVALID', 'CODESPACE_IDENTITY_MISMATCH', 'CAPABILITY_MISSING', 'RUNNER_INCOMPATIBLE', 'HASH_MISMATCH', 'STATE_INVALID', 'PROBE_NOT_FOUND', 'PLATFORM_UNSUPPORTED'];
      throw new AppError(known.includes(result.error ?? '') ? result.error! : 'RUNNER_FAILED');
    }
    const parsed = (action === 'handshake' ? handshakeSchema : diagnosticSchema).safeParse(result.data);
    requireThat(parsed.success, 'RUNNER_INVALID_RESPONSE');
    if (action === 'handshake') {
      const h = handshakeSchema.parse(parsed.data);
      requireThat(h.runnerSha256 === this.build.runnerSha256 && h.version === this.build.version && h.gitSha === this.build.gitSha && h.dirty === this.build.dirty, 'RUNNER_INCOMPATIBLE');
      requireThat(h.codespaceName === binding.codespaceName, 'CODESPACE_IDENTITY_MISMATCH');
    }
    return parsed.data;
  }
}
