import { exec } from './exec';

export interface WorktreeEntry {
  path: string;
  branch: string;
  isMain: boolean;
}

/**
 * Parse the porcelain output of `git worktree list --porcelain`.
 *
 * Format: blocks separated by blank lines, each block contains:
 *   worktree <path>
 *   HEAD <sha>
 *   branch refs/heads/<name>   (or "detached")
 */
export function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  const blocks = output.trim().split(/\n\n+/);

  for (const block of blocks) {
    if (!block.trim()) {
      continue;
    }

    const lines = block.split('\n');
    let worktreePath = '';
    let branch = '';
    let isBare = false;

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        worktreePath = line.slice('worktree '.length);
      } else if (line.startsWith('branch refs/heads/')) {
        branch = line.slice('branch refs/heads/'.length);
      } else if (line === 'detached') {
        branch = '(detached)';
      } else if (line === 'bare') {
        isBare = true;
      }
    }

    if (!worktreePath || isBare) {
      continue;
    }

    const isMain = branch === 'main' || branch === 'master';
    entries.push({ path: worktreePath, branch, isMain });
  }

  return entries;
}

/**
 * Run `git worktree list --porcelain` and return parsed entries.
 */
export async function getWorktrees(
  repoPath: string,
): Promise<WorktreeEntry[]> {
  const output = await exec(`git -C ${quote(repoPath)} worktree list --porcelain`);
  return parseWorktreeList(output);
}

/**
 * Determine the main branch name for a repository.
 * Tries 'main', falls back to 'master', falls back to first branch.
 */
export async function getMainBranchName(repoPath: string): Promise<string> {
  try {
    // Check if 'main' exists
    await exec(
      `git -C ${quote(repoPath)} rev-parse --verify refs/heads/main`,
      { timeout: 5000 },
    );
    return 'main';
  } catch {
    // ignore
  }

  try {
    // Check if 'master' exists
    await exec(
      `git -C ${quote(repoPath)} rev-parse --verify refs/heads/master`,
      { timeout: 5000 },
    );
    return 'master';
  } catch {
    // ignore
  }

  // Fall back to first branch
  try {
    const output = await exec(
      `git -C ${quote(repoPath)} branch --format='%(refname:short)'`,
      { timeout: 5000 },
    );
    const first = output.trim().split('\n')[0]?.trim();
    if (first) {
      return first;
    }
  } catch {
    // ignore
  }

  return 'main'; // ultimate fallback
}

/**
 * Extract a Linear-style issue ID from a branch name.
 * Matches patterns like TEN-42, PROJ-123.
 */
export function extractLinearId(branch: string): string | null {
  const match = branch.match(/([A-Z]+-\d+)/);
  return match ? match[1] : null;
}

/**
 * Get diff statistics between two branches.
 * Returns null if the diff cannot be computed.
 */
export async function getDiffStat(
  cwd: string,
  baseBranch: string,
  branch: string,
): Promise<{ filesChanged: number; insertions: number; deletions: number } | null> {
  try {
    const output = await exec(
      `git -C ${quote(cwd)} diff --stat ${quote(baseBranch)}...${quote(branch)}`,
      { timeout: 10000 },
    );

    return parseDiffStatSummary(output);
  } catch {
    return null;
  }
}

/**
 * Parse the summary line from `git diff --stat` output.
 * Example: " 5 files changed, 120 insertions(+), 30 deletions(-)"
 */
function parseDiffStatSummary(
  output: string,
): { filesChanged: number; insertions: number; deletions: number } | null {
  const lines = output.trim().split('\n');
  const lastLine = lines[lines.length - 1];
  if (!lastLine) {
    return null;
  }

  const filesMatch = lastLine.match(/(\d+)\s+files?\s+changed/);
  const insertionsMatch = lastLine.match(/(\d+)\s+insertions?\(\+\)/);
  const deletionsMatch = lastLine.match(/(\d+)\s+deletions?\(-\)/);

  if (!filesMatch) {
    return null;
  }

  return {
    filesChanged: parseInt(filesMatch[1], 10),
    insertions: insertionsMatch ? parseInt(insertionsMatch[1], 10) : 0,
    deletions: deletionsMatch ? parseInt(deletionsMatch[1], 10) : 0,
  };
}

/** Shell-quote a string for safe interpolation. */
function quote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
