import { z } from 'zod';
import { AppError, requireThat } from './errors.js';
import { execute, type Executor } from './transport/process.js';

const account = z.object({ login: z.string(), active: z.boolean(), state: z.string(), tokenSource: z.string().optional() });
const auth = z.object({ hosts: z.record(z.string(), z.array(account)) });
export const codespaceSchema = z.object({ name: z.string(), state: z.string(), repository: z.object({ full_name: z.string() }), owner: z.object({ login: z.string() }) });
export type Codespace = z.infer<typeof codespaceSchema>;
export class Github {
  constructor(private run: Executor = execute, private env: NodeJS.ProcessEnv = process.env) {}
  async command(args: string[], input?: string, limits: { timeoutMs?: number; maxBytes?: number } = {}) {
    try { return await this.run('gh', args, { input, ...limits, env: { ...this.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1' } }); }
    catch (e) { if (e instanceof AppError && e.code === 'EXECUTABLE_UNAVAILABLE') throw new AppError('GH_NOT_FOUND'); throw e; }
  }
  async json(args: string[]) {
    const r = await this.command(args);
    requireThat(r.exitCode === 0, 'GITHUB_REQUEST_FAILED');
    try { return JSON.parse(r.stdout) as unknown; } catch { throw new AppError('INVALID_GH_RESPONSE'); }
  }
  async identity(expected?: string) {
    const version = await this.command(['--version']);
    requireThat(version.exitCode === 0, 'GH_NOT_FOUND');
    const raw = await this.command(['auth', 'status', '--hostname', 'github.com', '--json', 'hosts']);
    let parsed;
    try { parsed = auth.parse(JSON.parse(raw.stdout)); } catch { throw new AppError('AUTH_REQUIRED'); }
    const active = parsed.hosts['github.com']?.filter(a => a.active);
    requireThat(raw.exitCode === 0 && active?.length === 1 && active[0]?.state === 'success', 'AUTH_REQUIRED');
    const user = z.object({ login: z.string() }).safeParse(await this.api('user'));
    requireThat(user.success, 'INVALID_GH_RESPONSE');
    const login = user.data.login;
    requireThat(login.toLowerCase() === active[0]!.login.toLowerCase(), 'AUTH_IDENTITY_MISMATCH');
    requireThat(!expected || login.toLowerCase() === expected.toLowerCase(), 'AUTH_IDENTITY_MISMATCH');
    return { account: login, host: 'github.com' as const, authSource: this.env.GH_TOKEN ? 'GH_TOKEN' : this.env.GITHUB_TOKEN ? 'GITHUB_TOKEN' : (active[0]!.tokenSource ?? 'stored'), ghVersion: version.stdout.split(/\r?\n/)[0] ?? 'unknown' };
  }
  api(endpoint: string) { return this.json(['api', '--hostname', 'github.com', '-H', 'X-GitHub-Api-Version: 2022-11-28', endpoint]); }
  // Official REST lifecycle endpoints; gh has no start subcommand. Acceptance is not completion: callers poll get().
  async post(endpoint: string) {
    const r = await this.command(['api', '--hostname', 'github.com', '--method', 'POST', '-H', 'X-GitHub-Api-Version: 2022-11-28', endpoint]);
    requireThat(r.exitCode === 0, 'GITHUB_REQUEST_FAILED');
  }
  start(name: string) { return this.post(`user/codespaces/${encodeURIComponent(name)}/start`); }
  stop(name: string) { return this.post(`user/codespaces/${encodeURIComponent(name)}/stop`); }
  async get(name: string): Promise<Codespace> {
    const parsed = codespaceSchema.safeParse(await this.api(`user/codespaces/${encodeURIComponent(name)}`));
    requireThat(parsed.success, 'INVALID_GH_RESPONSE'); return parsed.data;
  }
  async list(page: number) {
    const parsed = z.object({ codespaces: z.array(codespaceSchema), total_count: z.number().int().nonnegative() }).safeParse(await this.api(`user/codespaces?per_page=30&page=${page}`));
    requireThat(parsed.success, 'INVALID_GH_RESPONSE');
    return { codespaces: parsed.data.codespaces, nextPage: page * 30 < parsed.data.total_count ? page + 1 : null };
  }
}
