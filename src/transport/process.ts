import { spawn } from 'node:child_process';
import { AppError } from '../errors.js';

export interface ProcessResult { stdout: string; stderr: string; exitCode: number | null }
export type Executor = (file: string, args: string[], options?: { input?: string; timeoutMs?: number; maxBytes?: number; env?: NodeJS.ProcessEnv }) => Promise<ProcessResult>;

// No shell, inherited terminal or raw diagnostic output reaches the MCP transport.
export const execute: Executor = (file, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: 'pipe', env: options.env ?? process.env });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let bytes = 0, failure: AppError | undefined, cleanupTimer: NodeJS.Timeout | undefined;
  const terminate = () => {
    clearTimeout(timer);
    if (!child.pid) return;
    if (process.platform === 'win32') {
      // gh can own SSH/tunnel descendants that otherwise retain the stdio handles.
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      const fallback = () => { failure = new AppError('PROCESS_CLEANUP_UNCONFIRMED'); child.kill(); };
      killer.on('error', fallback);
      killer.on('close', code => { if (code !== 0 && child.exitCode === null) fallback(); });
      const killerTimer = setTimeout(() => { killer.kill(); fallback(); }, 2000);
      killer.on('close', () => clearTimeout(killerTimer));
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); }
    }
    // A descendant may retain handles if the OS denies tree termination. Never wait forever.
    cleanupTimer = setTimeout(() => {
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
      clearTimeout(timer); reject(new AppError('PROCESS_CLEANUP_UNCONFIRMED'));
    }, 3000);
  };
  const timer = setTimeout(() => { failure = new AppError('PROCESS_TIMEOUT', true); terminate(); }, options.timeoutMs ?? 12000);
  const collect = (target: Buffer[]) => (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > (options.maxBytes ?? 262144)) { if (!failure) { failure = new AppError('OUTPUT_LIMIT'); terminate(); } }
    else target.push(chunk);
  };
  child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
  child.stdin.on('error', () => { /* early exit is handled by close */ });
  child.on('error', () => { clearTimeout(timer); reject(new AppError('EXECUTABLE_UNAVAILABLE')); });
  child.on('close', exitCode => {
    clearTimeout(timer); clearTimeout(cleanupTimer);
    if (failure) reject(failure);
    else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode });
  });
  child.stdin.end(options.input);
});
