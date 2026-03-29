import * as path from 'path';

import type { TowerWorktree } from '../types';
import { getWorktrees as gitGetWorktrees } from '../util/gitHelpers';

export class WorktreeScanner {
  /**
   * Get all git worktrees for a given project path.
   *
   * Runs `git worktree list --porcelain`, parses the output, and maps
   * each entry to a TowerWorktree. The first worktree is marked as isMain.
   * Sessions are left empty — they are populated later by TaskBuilder.
   *
   * @param projectPath     Absolute path to the git repository root
   * @param currentWindowPath  Optional path of the current VS Code window,
   *                           used to set isCurrentWindow
   */
  async getWorktrees(
    projectPath: string,
    currentWindowPath?: string,
  ): Promise<TowerWorktree[]> {
    const entries = await gitGetWorktrees(projectPath);

    const normalizedCurrentWindow = currentWindowPath
      ? normalizePath(currentWindowPath)
      : undefined;

    return entries.map((entry, index) => {
      const normalizedEntryPath = normalizePath(entry.path);
      const isCurrentWindow = normalizedCurrentWindow
        ? normalizedEntryPath === normalizedCurrentWindow
        : false;

      return {
        path: entry.path,
        branch: entry.branch,
        isMain: index === 0,
        isCurrentWindow,
        hasOpenWindow: false, // Will be updated externally if needed
        sessions: [],
      };
    });
  }
}

/**
 * Normalize a path for comparison: resolve and remove trailing slashes.
 */
function normalizePath(p: string): string {
  return path.resolve(p).replace(/\/+$/, '');
}
