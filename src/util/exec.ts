import * as cp from 'child_process';

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
}

const DEFAULT_TIMEOUT = 30_000;

/**
 * Escape a string for safe use inside single-quoted shell arguments.
 * On Unix: replaces `'` with `'\''`. On Windows (PowerShell): doubles `'` to `''`.
 */
export function shellQuote(value: string): string {
  if (process.platform === 'win32') {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Run a shell command and return stdout.
 * Uses `/bin/sh -c` on Unix and PowerShell on Windows. Rejects on non-zero exit with stderr.
 */
export function exec(
  command: string,
  options?: ExecOptions,
): Promise<string> {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
  const isWindows = process.platform === 'win32';
  const shell = isWindows ? 'powershell.exe' : '/bin/sh';
  const shellArgs = isWindows
    ? ['-NoProfile', '-NonInteractive', '-Command', command]
    : ['-c', command];

  return new Promise<string>((resolve, reject) => {
    const child = cp.execFile(
      shell,
      shellArgs,
      {
        cwd: options?.cwd,
        env: options?.env ? { ...process.env, ...options.env } : undefined,
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
      },
      (error, stdout, stderr) => {
        if (error) {
          const msg = stderr?.trim() || error.message;
          reject(new Error(msg));
          return;
        }
        resolve(stdout);
      },
    );

    // Ensure the child is killed on timeout (belt-and-suspenders)
    if (timeout > 0) {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
      }, timeout + 1000);
      child.on('exit', () => clearTimeout(timer));
    }
  });
}
