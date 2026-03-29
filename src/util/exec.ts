import * as cp from 'child_process';

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
}

const DEFAULT_TIMEOUT = 30_000;

/**
 * Escape a string for safe use inside single-quoted shell arguments.
 * Replaces `'` with `'\''` (end quote, escaped quote, start quote).
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Run a shell command and return stdout.
 * Uses `/bin/sh -c` for safety. Rejects on non-zero exit with stderr.
 */
export function exec(
  command: string,
  options?: ExecOptions,
): Promise<string> {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;

  return new Promise<string>((resolve, reject) => {
    const child = cp.execFile(
      '/bin/sh',
      ['-c', command],
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
