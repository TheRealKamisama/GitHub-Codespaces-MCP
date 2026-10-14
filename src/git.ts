import { isAbsolute } from 'node:path';
import { AppError, requireThat } from './errors.js';
import { execute, type Executor } from './transport/process.js';

// Accepts the common GitHub remote spellings; credentials embedded in URLs are never returned.
export function githubRepository(url: string): string | null {
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::22)?\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

export class LocalGit {
  constructor(private run: Executor = execute, private env: NodeJS.ProcessEnv = process.env) {}
  private async git(root: string, args: string[]) {
    try {
      // Read-only inspection of a possibly untrusted checkout: no prompts, no optional index writes, no fsmonitor hook.
      return await this.run('git', ['-C', root, '-c', 'core.fsmonitor=false', ...args], { env: { ...this.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
    } catch (e) { if (e instanceof AppError && e.code === 'EXECUTABLE_UNAVAILABLE') throw new AppError('GIT_NOT_FOUND'); throw e; }
  }
  async inspect(localProjectRoot: string) {
    requireThat(isAbsolute(localProjectRoot), 'INVALID_ARGUMENT');
    const top = await this.git(localProjectRoot, ['rev-parse', '--show-toplevel']);
    requireThat(top.exitCode === 0, 'NOT_A_GIT_REPOSITORY');
    const root = top.stdout.trim();
    const headResult = await this.git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
    const head = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
    const symbolic = await this.git(root, ['symbolic-ref', '-q', 'HEAD']);
    const branch = symbolic.exitCode === 0 ? symbolic.stdout.trim() : null;
    let upstream: { remote: string; ref: string; trackingRef: string; repository: string | null } | null = null;
    if (branch) {
      const configured = await this.git(root, ['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)', branch]);
      const [remote, ref, trackingRef] = configured.stdout.trim().split('\0');
      if (configured.exitCode === 0 && remote && ref && trackingRef) {
        const url = await this.git(root, ['remote', 'get-url', '--push', remote]);
        upstream = { remote, ref, trackingRef, repository: url.exitCode === 0 ? githubRepository(url.stdout) : null };
      }
    }
    const status = await this.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
    requireThat(status.exitCode === 0, 'NOT_A_GIT_REPOSITORY');
    const entries = status.stdout.split('\0').filter(Boolean), records: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      records.push(entries[i]!);
      // Rename/copy entries are followed by their original path as a separate field without a status prefix.
      if (/^(?:[RC].|.[RC])/.test(entries[i]!)) i++;
    }
    const dirty = { tracked: records.filter(e => !e.startsWith('??')).length, untracked: records.filter(e => e.startsWith('??')).length };
    let pushed: 'yes' | 'no' | 'unknown' = 'unknown';
    if (head && upstream) {
      // Evidence is the local tracking ref from the last fetch/push; the runner re-verifies reachability remotely.
      const ancestor = await this.git(root, ['merge-base', '--is-ancestor', head, upstream.trackingRef]);
      pushed = ancestor.exitCode === 0 ? 'yes' : ancestor.exitCode === 1 ? 'no' : 'unknown';
    }
    return { localProjectRoot: root, head, branch, upstream, dirty, pushed };
  }
}
