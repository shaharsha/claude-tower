import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { TowerTask, TowerConfig } from '../types';
import { exec, shellQuote } from '../util/exec';

const HOOK_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Copy configured files and create symlinks for configured directories
 * from the project root into a new worktree.
 */
export async function copyConfiguredFiles(
  projectPath: string,
  worktreePath: string,
  config: TowerConfig | null,
  progress?: vscode.Progress<{ message: string }>,
): Promise<void> {
  // Copy files from copyFiles config
  const filesToCopy = config?.copyFiles ?? [];
  for (const file of filesToCopy) {
    const src = path.join(projectPath, file);
    const dest = path.join(worktreePath, file);

    try {
      // Ensure destination directory exists
      const destDir = path.dirname(dest);
      await fs.promises.mkdir(destDir, { recursive: true });

      // Copy file
      await fs.promises.copyFile(src, dest);
      progress?.report({ message: `Copied ${file}` });
    } catch (err) {
      console.warn(`[claude-tower] Failed to copy ${file}:`, err);
    }
  }

  // Create symlinks from symlinkDirs config
  const dirsToSymlink = config?.symlinkDirs ?? [];
  for (const dir of dirsToSymlink) {
    const src = path.join(projectPath, dir);
    const dest = path.join(worktreePath, dir);

    try {
      // Ensure parent directory of symlink exists
      const destParent = path.dirname(dest);
      await fs.promises.mkdir(destParent, { recursive: true });

      // Remove destination if it already exists (e.g., empty dir from git)
      try {
        const stat = await fs.promises.lstat(dest);
        if (stat.isDirectory()) {
          await fs.promises.rm(dest, { recursive: true });
        } else {
          await fs.promises.unlink(dest);
        }
      } catch {
        // Destination doesn't exist, which is fine
      }

      // Create symlink
      await fs.promises.symlink(src, dest, 'dir');
      progress?.report({ message: `Symlinked ${dir}` });
    } catch (err) {
      console.warn(`[claude-tower] Failed to symlink ${dir}:`, err);
    }
  }
}

/**
 * Run a lifecycle hook script (postCreate or preArchive) with
 * TOWER_* environment variables set. Times out after 2 minutes.
 * Shows a warning on failure but does not throw.
 */
export async function runHook(
  hookType: 'postCreate' | 'preArchive',
  task: TowerTask,
  config: TowerConfig | null,
  progress?: vscode.Progress<{ message: string }>,
): Promise<void> {
  const hookScript = config?.hooks?.[hookType];
  if (!hookScript) {
    return;
  }

  const cwd = task.worktreePath || task.projectPath;
  if (!cwd) {
    return;
  }

  // Resolve hook script path relative to the project root
  const projectRoot = task.projectPath || cwd;
  const fullHookPath = path.resolve(projectRoot, hookScript);

  if (!fs.existsSync(fullHookPath)) {
    console.warn(`[claude-tower] Hook script not found: ${fullHookPath}`);
    return;
  }

  const hookName = hookType === 'postCreate' ? 'setup' : 'teardown';
  progress?.report({ message: `Running ${hookName} script...` });

  // Build TOWER_* environment variables
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    TOWER_WORKTREE_PATH: task.worktreePath || '',
    TOWER_BRANCH: task.branch || '',
    TOWER_PROJECT_PATH: task.projectPath || '',
    TOWER_LINEAR_ID: task.linearIssueId || '',
    TOWER_TASK_TITLE: task.title,
  };

  try {
    await exec(`bash ${shellQuote(fullHookPath)}`, {
      cwd,
      env,
      timeout: HOOK_TIMEOUT_MS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showWarningMessage(
      `Hook "${hookType}" failed: ${message}`,
    );
    console.warn(`[claude-tower] Hook "${hookType}" failed:`, err);
    // Continue execution — do not throw
  }
}
