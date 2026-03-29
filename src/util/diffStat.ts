import type { DiffStat } from '../types';
import { exec, shellQuote } from './exec';
import { getMainBranchName } from './gitHelpers';

/**
 * Compute diff statistics for a branch relative to the main branch.
 * Returns undefined if required parameters are missing or the diff fails.
 */
export async function computeDiffStat(
  worktreePath: string,
  projectPath: string | undefined,
  branch: string | undefined,
): Promise<DiffStat | undefined> {
  if (!worktreePath || !branch) {
    return undefined;
  }

  const repoPath = projectPath ?? worktreePath;

  try {
    const mainBranch = await getMainBranchName(repoPath);

    const output = await exec(
      `git -C ${shellQuote(worktreePath)} diff --stat ${shellQuote(mainBranch)}...${shellQuote(branch)}`,
      { timeout: 10_000 },
    );

    return parseDiffStatOutput(output);
  } catch {
    return undefined;
  }
}

function parseDiffStatOutput(output: string): DiffStat | undefined {
  const lines = output.trim().split('\n');
  const lastLine = lines[lines.length - 1];
  if (!lastLine) {
    return undefined;
  }

  const filesMatch = lastLine.match(/(\d+)\s+files?\s+changed/);
  const insertionsMatch = lastLine.match(/(\d+)\s+insertions?\(\+\)/);
  const deletionsMatch = lastLine.match(/(\d+)\s+deletions?\(-\)/);

  if (!filesMatch) {
    return undefined;
  }

  return {
    filesChanged: parseInt(filesMatch[1], 10),
    insertions: insertionsMatch ? parseInt(insertionsMatch[1], 10) : 0,
    deletions: deletionsMatch ? parseInt(deletionsMatch[1], 10) : 0,
  };
}
