import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readJsonlHead } from './jsonlReader';

/**
 * Returns the expanded path to `~/.claude/projects/`.
 */
export function getClaudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Decode a Claude-encoded project directory name back to an absolute path.
 *
 * The encoding replaces `/` with `-`, so `-Users-shahar-project` becomes
 * `/Users/shahar/project`. Since this is inherently ambiguous (a directory
 * name could contain a literal `-`), callers should verify the result with
 * `fs.existsSync`.
 */
export function decodeProjectPath(encoded: string): string {
  // Replace leading `-` with `/`, then remaining `-` with `/`
  let decoded = encoded;
  if (decoded.startsWith('-')) {
    decoded = '/' + decoded.slice(1);
  }
  decoded = decoded.replace(/-/g, '/');
  return decoded;
}

/**
 * Encode an absolute path to the Claude project directory name format.
 * Claude Code replaces both `/` and `.` with `-`.
 */
export function encodeProjectPath(absolutePath: string): string {
  return absolutePath.replace(/[/.]/g, '-');
}

/**
 * Returns the full path to the project metadata directory where JSONL session
 * files live. In Claude Code, session files are stored directly in the
 * encoded project directory (NOT in a sessions/ subdirectory).
 */
export function getSessionsDir(encodedProject: string): string {
  return path.join(getClaudeProjectsDir(), encodedProject);
}

/**
 * Try to resolve an encoded project directory name to an actual filesystem path.
 *
 * 1. Attempt naive decode and verify it exists.
 * 2. If that fails, look inside the sessions/ directory for any JSONL file
 *    and try to extract the project path from its first event.
 */
export async function resolveProjectPath(
  encodedDir: string,
): Promise<string | null> {
  // Strategy 1: naive decode
  const decoded = decodeProjectPath(encodedDir);
  if (fs.existsSync(decoded)) {
    return decoded;
  }

  // Strategy 2: read the first event from a session JSONL in the project dir
  const projectDir = getSessionsDir(encodedDir);
  try {
    const entries = await fs.promises.readdir(projectDir);
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) {
        continue;
      }
      const filePath = path.join(projectDir, entry);
      const events = await readJsonlHead(filePath, 2048);
      for (const event of events) {
        // Look for a cwd or projectPath field in early events
        const candidate =
          (event as any).cwd ??
          (event as any).projectPath ??
          (event as any).workingDirectory;
        if (candidate && typeof candidate === 'string' && fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }
  } catch {
    // project dir may not exist
  }

  return null;
}
